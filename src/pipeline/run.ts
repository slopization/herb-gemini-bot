import type { Message } from "grammy/types";
import type { AiCommandSpec } from "../commands/specs.ts";
import type { Config } from "../config.ts";
import type { Repo } from "../db/repo.ts";
import type { GeminiClient, GenRequest } from "../gemini/client.ts";
import { log } from "../log.ts";
import { renderResponseHtml } from "../render/parts.ts";
import { CAPTION_MAX_LENGTH, MAX_LENGTH, splitHtml } from "../render/split.ts";
import { strings } from "../strings.ts";
import type { FileCache } from "../telegram/files.ts";
import type { Sender } from "../telegram/sender.ts";
import { buildHistory } from "./history.ts";
import { buildContents } from "./prompt.ts";

export interface Deps {
  cfg: Config;
  repo: Repo;
  gemini: GeminiClient;
  sender: Sender;
  files: FileCache;
  botId: number;
  botUsername: string;
  shutdownSignal: AbortSignal;
}

export interface AiJob {
  spec: AiCommandSpec;
  msg: Message;
  args: Record<string, string>;
  /** Retry placeholder id — deleted on success, re-edited to the error on failure. */
  retryPlaceholderId?: number;
}

/** The single AI execution path — every AI command goes through here. */
export async function runAiCommand(deps: Deps, job: AiJob): Promise<void> {
  const { spec, msg } = job;
  const chatId = msg.chat.id;
  const jobLog = log.child({ chatId, messageId: msg.message_id, command: spec.name });

  await deps.sender.react(chatId, msg.message_id, "👍");
  try {
    const turns = buildHistory(deps.repo, msg, deps.botId);
    const built = await buildContents(deps.files, spec, turns);
    if (!built.ok) {
      // validation-class errors get a plain reply without a retry button
      if (job.retryPlaceholderId !== undefined) {
        await deps.sender.delete(chatId, job.retryPlaceholderId);
      }
      await deps.sender.sendHtml(chatId, built.userMessage, msg.message_id);
      return;
    }

    const request: GenRequest = {
      model: deps.cfg.models[spec.modelKey],
      contents: built.contents,
      config: {
        tools: spec.tools,
        ...(spec.thinkingBudget !== undefined
          ? { thinkingConfig: { thinkingBudget: spec.thinkingBudget } }
          : {}),
        ...(spec.systemInstruction !== undefined
          ? { systemInstruction: spec.systemInstruction }
          : {}),
        ...(spec.temperature !== undefined ? { temperature: spec.temperature } : {}),
        ...(spec.requestOverrides ? spec.requestOverrides(job.args) : {}),
      },
    };

    jobLog.debug({ turns: turns.length }, "gemini 요청");
    const result = await deps.gemini.generate(request);
    if (!result.ok) {
      await sendErrorAndMark(deps, job, result.userMessage);
      return;
    }

    const html = renderResponseHtml({
      parts: result.parts,
      ...(result.text !== undefined ? { text: result.text } : {}),
      ...(result.groundingMetadata !== undefined
        ? { groundingMetadata: result.groundingMetadata }
        : {}),
      ...(result.usageMetadata !== undefined ? { usageMetadata: result.usageMetadata } : {}),
    });
    const chunks = splitHtml(html, result.images.length > 0 ? CAPTION_MAX_LENGTH : MAX_LENGTH);
    if (chunks.length === 0 && result.images.length === 0) {
      // parts existed but none of them render — never leave the user with silence
      await sendErrorAndMark(deps, job, strings.errors.emptyResponse);
      return;
    }

    // every chunk gets command_type (drives implicit continuation); parts on the first, linked ids
    // after. Written as each message lands so a partial send still leaves continuable state.
    // Generated images are replayed from their Telegram copies, not from the stored parts.
    const modelParts = result.parts.filter((part) => !part.inlineData);
    let rootId: number | undefined;
    const recordMeta = (message: Message): void => {
      if (rootId === undefined) {
        rootId = message.message_id;
        deps.repo.setMeta(chatId, rootId, { commandType: spec.name, modelParts });
        return;
      }
      deps.repo.setMeta(chatId, message.message_id, {
        commandType: spec.name,
        linkedMessageId: rootId,
      });
    };

    await deps.sender.replyChunked({
      chatId,
      replyTo: msg.message_id,
      chunks,
      images: result.images,
      onSent: recordMeta,
      ...(job.retryPlaceholderId !== undefined ? { placeholderId: job.retryPlaceholderId } : {}),
    });

    jobLog.info({ chunks: chunks.length, images: result.images.length }, "응답 전송 완료");
  } catch (error) {
    jobLog.error({ err: error }, "파이프라인 예외");
    await sendErrorAndMark(deps, job, strings.errors.unexpected);
  } finally {
    await deps.sender.react(chatId, msg.message_id, null);
  }
}

async function sendErrorAndMark(deps: Deps, job: AiJob, text: string): Promise<void> {
  if (deps.shutdownSignal.aborted) return; // shutdown-aborted requests get no error reply
  const errorMessageId = await deps.sender.sendError({
    chatId: job.msg.chat.id,
    replyTo: job.msg.message_id,
    text,
    retryTargetId: job.msg.message_id,
    ...(job.retryPlaceholderId !== undefined ? { placeholderId: job.retryPlaceholderId } : {}),
  });
  if (errorMessageId !== undefined) {
    deps.repo.setMeta(job.msg.chat.id, errorMessageId, { commandType: "error" });
  }
}
