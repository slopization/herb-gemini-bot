import type { Part } from "@google/genai";
import type { Message } from "grammy/types";
import type { Repo } from "../db/repo.ts";
import { extractAttachments } from "../db/repo.ts";
import { richMessageText } from "../render/rich-text.ts";

export interface TurnFile {
  fileId: string;
  fileUniqueId: string;
  kind: "photo" | "document";
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
}

export interface Turn {
  role: "user" | "model";
  text: string;
  files: TurnFile[];
  /** Stored Gemini parts of a model turn, replayed verbatim to keep thoughtSignature. */
  parts?: Part[];
  /** Id of the chunk holding the parts — shared by every message of one response set. */
  partsRootId?: number;
}

// includes the current message
const HISTORY_DEPTH_LIMIT = 15;

/**
 * Walk the reply chain upward into chronological turns; the current message is the
 * last turn. Live reply_to_message objects (Telegram inlines one hop) are upgraded
 * to their fuller DB copies, which carry the next hop's reply pointer.
 */
export function buildHistory(repo: Repo, current: Message, botId: number): Turn[] {
  const turns: Turn[] = [];
  const seen = new Set<number>();
  const keptByRoot = new Map<number, Turn>();
  let cursor: Message | undefined = current;

  while (cursor && turns.length < HISTORY_DEPTH_LIMIT) {
    if (seen.has(cursor.message_id)) break; // cycle guard
    seen.add(cursor.message_id);

    const turn = toTurn(repo, cursor, botId);
    // every message of one response set resolves to the same root: its parts are emitted
    // once, but each member's own media still belongs to that turn
    const kept = turn.partsRootId !== undefined ? keptByRoot.get(turn.partsRootId) : undefined;
    if (kept) {
      mergeFiles(kept, turn.files);
    } else {
      turns.unshift(turn);
      if (turn.partsRootId !== undefined) keptByRoot.set(turn.partsRootId, turn);
    }

    const replyRef: Message | undefined = cursor.reply_to_message as Message | undefined;
    cursor = replyRef
      ? (repo.getMessage(cursor.chat.id, replyRef.message_id) ?? replyRef)
      : undefined;
  }
  return turns;
}

function mergeFiles(target: Turn, extra: readonly TurnFile[]): void {
  const known = new Set(target.files.map((file) => file.fileUniqueId));
  for (const file of extra) {
    if (known.has(file.fileUniqueId)) continue;
    known.add(file.fileUniqueId);
    target.files.push(file);
  }
}

function toTurn(repo: Repo, msg: Message, botId: number): Turn {
  // identity, not is_bot: anonymous admins and other bots are still user turns
  const role = msg.from?.id === botId ? "model" : "user";
  const text =
    msg.text ?? msg.caption ?? (msg.rich_message ? richMessageText(msg.rich_message) : "");
  const files = collectFiles(repo, msg);

  if (role === "model") {
    const resolved = repo.getModelParts(msg.chat.id, msg.message_id);
    // model turns without stored parts fall back to their display text
    if (resolved) {
      return { role, text, files, parts: resolved.parts, partsRootId: resolved.rootId };
    }
  }
  return { role, text, files };
}

function collectFiles(repo: Repo, msg: Message): TurnFile[] {
  const files = new Map<string, TurnFile>(); // deduped by file_unique_id

  const members = msg.media_group_id
    ? withFallback(repo.getAlbumMessages(msg.chat.id, msg.media_group_id), msg)
    : [msg];
  for (const member of members) addFrom(files, member);

  return [...files.values()];
}

function withFallback(members: Message[], msg: Message): Message[] {
  return members.length > 0 ? members : [msg];
}

function addFrom(files: Map<string, TurnFile>, msg: Message): void {
  for (const row of extractAttachments(msg)) {
    files.set(row.file_unique_id, {
      fileId: row.file_id,
      fileUniqueId: row.file_unique_id,
      kind: row.kind,
      ...(row.file_name !== null ? { fileName: row.file_name } : {}),
      ...(row.mime_type !== null ? { mimeType: row.mime_type } : {}),
      ...(row.file_size !== null ? { fileSize: row.file_size } : {}),
    });
  }
}
