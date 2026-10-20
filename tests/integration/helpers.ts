import type { GenerateContentParameters, GenerateContentResponse, Part } from "@google/genai";
import type { CallbackQuery, Message } from "grammy/types";
import type { Config } from "../../src/config.ts";
import { openDb } from "../../src/db/database.ts";
import { Repo } from "../../src/db/repo.ts";
import type { GeminiPort } from "../../src/gemini/client.ts";
import { GeminiClient } from "../../src/gemini/client.ts";
import type { Deps } from "../../src/pipeline/run.ts";
import { FileCache } from "../../src/telegram/files.ts";
import type { Handlers } from "../../src/telegram/handlers.ts";
import { createHandlers } from "../../src/telegram/handlers.ts";
import type { TelegramPort } from "../../src/telegram/sender.ts";
import { Sender } from "../../src/telegram/sender.ts";

export const CHAT = 10;
export const USER = 42;
export const BOT_ID = 999;

// biome-ignore lint/suspicious/noExplicitAny: recorded fake-call payload
export interface PortCall extends Record<string, any> {
  method: string;
}

export interface FakeTelegram {
  port: TelegramPort;
  calls: PortCall[];
  callsOf(method: string): PortCall[];
  lastMessageId(): number;
}

export function createFakeTelegram(): FakeTelegram {
  let nextId = 1000;
  const calls: PortCall[] = [];

  // biome-ignore lint/suspicious/noExplicitAny: synthetic Message built by the fake
  const mkMsg = (chatId: number, extra: Record<string, any> = {}): any => ({
    message_id: nextId++,
    date: 1,
    chat: { id: chatId, type: "private", first_name: "chat" },
    from: { id: BOT_ID, is_bot: true, first_name: "bot", username: "TestBot" },
    ...extra,
  });

  // biome-ignore lint/suspicious/noExplicitAny: echoes reply_parameters like the real Bot API
  const replyEcho = (chatId: number, other: any): Record<string, any> =>
    other?.reply_parameters
      ? {
          reply_to_message: {
            message_id: other.reply_parameters.message_id,
            date: 1,
            chat: { id: chatId, type: "private" },
          },
        }
      : {};

  const raw = {
    // biome-ignore lint/suspicious/noExplicitAny: relaxed grammY Other<> signature
    async sendMessage(chatId: number, text: string, other?: any) {
      const message = mkMsg(chatId, { text, ...replyEcho(chatId, other) });
      calls.push({ method: "sendMessage", chatId, text, other, message });
      return message;
    },
    // biome-ignore lint/suspicious/noExplicitAny: same as above
    async sendPhoto(chatId: number, _photo: unknown, other?: any) {
      const message = mkMsg(chatId, {
        photo: [{ file_id: `p${nextId}`, file_unique_id: `up${nextId}`, width: 1, height: 1 }],
        ...(other?.caption ? { caption: other.caption } : {}),
        ...replyEcho(chatId, other),
      });
      calls.push({ method: "sendPhoto", chatId, other, message });
      return message;
    },
    // biome-ignore lint/suspicious/noExplicitAny: same as above
    async sendMediaGroup(chatId: number, media: any[], other?: any) {
      const messages = media.map((item) =>
        mkMsg(chatId, {
          ...(item.type === "photo"
            ? {
                photo: [
                  { file_id: `p${nextId}`, file_unique_id: `up${nextId}`, width: 1, height: 1 },
                ],
              }
            : { document: { file_id: `d${nextId}`, file_unique_id: `ud${nextId}` } }),
          ...(item.caption ? { caption: item.caption } : {}),
          ...replyEcho(chatId, other),
        }),
      );
      calls.push({ method: "sendMediaGroup", chatId, media, other, messages });
      return messages;
    },
    // biome-ignore lint/suspicious/noExplicitAny: same as above
    async sendDocument(chatId: number, _doc: unknown, other?: any) {
      const message = mkMsg(chatId, {
        document: { file_id: `d${nextId}`, file_unique_id: `ud${nextId}` },
        ...replyEcho(chatId, other),
      });
      calls.push({ method: "sendDocument", chatId, other, message });
      return message;
    },
    // biome-ignore lint/suspicious/noExplicitAny: same as above
    async editMessageText(chatId: number, messageId: number, text: string, other?: any) {
      calls.push({ method: "editMessageText", chatId, messageId, text, other });
      // the real Bot API returns the edited Message for non-inline messages
      const message = { ...mkMsg(chatId), message_id: messageId, text };
      return message;
    },
    async deleteMessage(chatId: number, messageId: number) {
      calls.push({ method: "deleteMessage", chatId, messageId });
      return true;
    },
    async setMessageReaction(chatId: number, messageId: number, reaction: unknown) {
      calls.push({ method: "setMessageReaction", chatId, messageId, reaction });
      return true;
    },
    // biome-ignore lint/suspicious/noExplicitAny: same as above
    async answerCallbackQuery(id: string, other?: any) {
      calls.push({ method: "answerCallbackQuery", id, other });
      return true;
    },
  };

  return {
    port: raw as unknown as TelegramPort,
    calls,
    callsOf: (method) => calls.filter((c) => c.method === method),
    lastMessageId: () => nextId - 1,
  };
}

export interface FakeGemini {
  port: GeminiPort;
  requests: GenerateContentParameters[];
}

/** Gemini fake yielding scripted responses/errors in order; the last entry repeats. */
export function createFakeGemini(
  ...script: (GenerateContentResponse | Error | (() => Promise<GenerateContentResponse>))[]
): FakeGemini {
  const requests: GenerateContentParameters[] = [];
  let index = 0;
  return {
    requests,
    port: {
      async generateContent(params) {
        requests.push(params);
        const entry = script[Math.min(index, script.length - 1)];
        index += 1;
        if (entry instanceof Error) throw entry;
        if (typeof entry === "function") return entry();
        if (!entry) throw new Error("fake gemini: no scripted response");
        return entry;
      },
    },
  };
}

export function textResponse(text: string, parts?: Part[]): GenerateContentResponse {
  return {
    candidates: [{ content: { role: "model", parts: parts ?? [{ text }] } }],
  } as unknown as GenerateContentResponse;
}

/** SDK-shaped API failure: `status` plus the stringified error body. */
export function apiError(status: number, message?: string): Error {
  return Object.assign(new Error(message ?? `{"error":{"code":${status}}}`), { status });
}

/** Prompt-level refusal: promptFeedback only, no candidates. */
export function blockedResponse(blockReason: string): GenerateContentResponse {
  return { promptFeedback: { blockReason } } as unknown as GenerateContentResponse;
}

export function imageResponse(caption: string | undefined): GenerateContentResponse {
  const parts: Part[] = [
    ...(caption ? [{ text: caption }] : []),
    { inlineData: { mimeType: "image/png", data: Buffer.from("png-bytes").toString("base64") } },
  ];
  return textResponse("", parts);
}

export interface TestBot {
  handlers: Handlers;
  repo: Repo;
  telegram: FakeTelegram;
  gemini: FakeGemini;
  deps: Deps;
  shutdown: AbortController;
}

export function createTestBot(geminiFake?: FakeGemini): TestBot {
  const repo = new Repo(openDb(":memory:"));
  const telegram = createFakeTelegram();
  const gemini = geminiFake ?? createFakeGemini(textResponse("기본 응답"));
  const shutdown = new AbortController();

  const cfg: Config = {
    telegramToken: "token",
    googleApiKey: "key",
    models: { pro: "pro-model", image: "image-model" },
    allowedChannelIds: new Set([CHAT]),
    trustedUserIds: new Set(),
  };

  const deps: Deps = {
    cfg,
    repo,
    gemini: new GeminiClient(gemini.port, shutdown.signal),
    sender: new Sender(telegram.port, repo),
    files: new FileCache(async (fileId) => Buffer.from(`content-of-${fileId}`)),
    botId: BOT_ID,
    botUsername: "TestBot",
    shutdownSignal: shutdown.signal,
  };

  return { handlers: createHandlers(deps), repo, telegram, gemini, deps, shutdown };
}

let userMessageId = 1;

export function userMsg(overrides: Partial<Message> = {}): Message {
  return {
    message_id: userMessageId++,
    date: 1700000000,
    chat: { id: CHAT, type: "private", first_name: "chat" },
    from: { id: USER, is_bot: false, first_name: "user" },
    ...overrides,
  } as Message;
}

export function callback(data: string, message: Message, id = "cbq-1"): CallbackQuery {
  return {
    id,
    from: { id: USER, is_bot: false, first_name: "user" },
    chat_instance: "ci",
    data,
    message,
  } as CallbackQuery;
}
