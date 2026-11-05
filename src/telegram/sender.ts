import type { Api } from "grammy";
import { InputFile } from "grammy";
import type { InlineKeyboardMarkup, Message } from "grammy/types";
import type { Repo } from "../db/repo.ts";
import type { GenImage } from "../gemini/client.ts";
import { log } from "../log.ts";
import { strings } from "../strings.ts";

/** Telegram port — the grammY Api subset we use; the boundary faked in tests. */
export type TelegramPort = Pick<
  Api,
  | "sendMessage"
  | "sendRichMessage"
  | "sendPhoto"
  | "sendMediaGroup"
  | "sendDocument"
  | "editMessageText"
  | "deleteMessage"
  | "setMessageReaction"
  | "answerCallbackQuery"
>;

export interface ReplyChunkedOptions {
  chatId: number;
  replyTo: number;
  chunks: string[];
  images: GenImage[];
  /** Called as each message lands, so a partial send still leaves continuable state. */
  onSent?: (message: Message) => void;
  /** Retry-flow placeholder message; deleted before a successful reply. */
  placeholderId?: number;
}

export interface SendErrorOptions {
  chatId: number;
  replyTo: number;
  text: string;
  /** Original user message id carried in the 🔄 button callback_data. */
  retryTargetId: number;
  placeholderId?: number;
}

export class Sender {
  private readonly port: TelegramPort;
  private readonly repo: Repo;

  constructor(port: TelegramPort, repo: Repo) {
    this.port = port;
    this.repo = repo;
  }

  /** Progress reaction (👍 set / null clear); failures log-and-continue. */
  async react(chatId: number, messageId: number, emoji: "👍" | null): Promise<void> {
    try {
      await this.port.setMessageReaction(
        chatId,
        messageId,
        emoji ? [{ type: "emoji", emoji }] : [],
      );
    } catch (error) {
      log.warn({ err: error, chatId, messageId }, "리액션 설정 실패");
    }
  }

  /** Record a delivered message; a failed DB write must never fail the send itself. */
  private record(message: Message, onSent?: (message: Message) => void): void {
    try {
      this.repo.logMessage(message);
      onSent?.(message);
    } catch (error) {
      log.warn({ err: error, messageId: message.message_id }, "발신 메시지 기록 실패");
    }
  }

  /** Plain reply without parse_mode. */
  async sendPlain(chatId: number, text: string, replyTo: number): Promise<Message> {
    const sent = await this.port.sendMessage(chatId, text, {
      reply_parameters: { message_id: replyTo },
    });
    this.record(sent);
    return sent;
  }

  /** Single HTML reply. */
  async sendHtml(chatId: number, html: string, replyTo: number): Promise<Message> {
    const sent = await this.port.sendMessage(chatId, html, {
      parse_mode: "HTML",
      reply_parameters: { message_id: replyTo },
    });
    this.record(sent);
    return sent;
  }

  /**
   * Send an AI reply: delete placeholder → images (photo/mediaGroup) → rich text chunks
   * chained → original-quality documents replying to the first message. Returns the
   * whole response set (documents included) so the pipeline can meta-link every member
   * to the first message.
   */
  async replyChunked(options: ReplyChunkedOptions): Promise<Message[]> {
    if (options.placeholderId !== undefined) {
      try {
        await this.port.deleteMessage(options.chatId, options.placeholderId);
      } catch (error) {
        log.warn({ err: error }, "재시도 placeholder 삭제 실패");
      }
    }

    const sent: Message[] = [];
    let replyTarget = options.replyTo;

    if (options.images.length > 0) {
      // a rejected photo must not discard the text; the document re-send below still runs
      try {
        const posted = await this.sendImages(options, replyTarget);
        for (const message of posted) {
          sent.push(message);
          this.record(message, options.onSent);
        }
        replyTarget = posted[0]?.message_id ?? replyTarget;
      } catch (error) {
        log.warn({ err: error, chatId: options.chatId }, "이미지 전송 실패");
      }
    }

    for (const chunk of options.chunks) {
      const sentText = await this.port.sendRichMessage(
        options.chatId,
        { html: chunk },
        { reply_parameters: { message_id: replyTarget } },
      );
      sent.push(sentText);
      this.record(sentText, options.onSent);
      replyTarget = sentText.message_id;
    }

    if (options.images.length > 0) {
      const anchor = sent[0]?.message_id ?? options.replyTo;
      sent.push(
        ...(await this.resendOriginals(options.chatId, anchor, options.images, options.onSent)),
      );
    }

    return sent;
  }

  private async sendImages(options: ReplyChunkedOptions, replyTo: number): Promise<Message[]> {
    const [only] = options.images;
    if (options.images.length === 1 && only) {
      const sentPhoto = await this.port.sendPhoto(options.chatId, new InputFile(only.buffer), {
        reply_parameters: { message_id: replyTo },
      });
      return [sentPhoto];
    }
    const media = options.images.map((image) => ({
      type: "photo" as const,
      media: new InputFile(image.buffer),
    }));
    return this.port.sendMediaGroup(options.chatId, media, {
      reply_parameters: { message_id: replyTo },
    });
  }

  /** Re-send generated images as documents; the main reply is already delivered, so failures log-and-continue. */
  private async resendOriginals(
    chatId: number,
    replyTo: number,
    images: GenImage[],
    onSent?: (message: Message) => void,
  ): Promise<Message[]> {
    try {
      if (images.length === 1 && images[0]) {
        const sent = await this.port.sendDocument(
          chatId,
          new InputFile(images[0].buffer, "image.png"),
          { reply_parameters: { message_id: replyTo } },
        );
        this.record(sent, onSent);
        return [sent];
      }
      const media = images.map((image, index) => ({
        type: "document" as const,
        media: new InputFile(image.buffer, `image_${index + 1}.png`),
      }));
      const sentDocs = await this.port.sendMediaGroup(chatId, media, {
        reply_parameters: { message_id: replyTo },
      });
      for (const message of sentDocs) this.record(message, onSent);
      return sentDocs;
    } catch (error) {
      log.warn({ err: error, chatId }, "원본 document 재전송 실패");
      return [];
    }
  }

  /**
   * Error reply: edit the retry placeholder (with the 🔄 button) or send a new message.
   * Returns the id of the message carrying the error; undefined if even that failed.
   */
  async sendError(options: SendErrorOptions): Promise<number | undefined> {
    const replyMarkup = retryMarkup(options.retryTargetId);

    if (options.placeholderId !== undefined) {
      try {
        const edited = await this.port.editMessageText(
          options.chatId,
          options.placeholderId,
          options.text,
          { reply_markup: replyMarkup },
        );
        if (typeof edited !== "boolean") this.record(edited);
        return options.placeholderId;
      } catch (error) {
        log.warn({ err: error }, "재시도 오류 편집 실패 — 새 메시지로 대체");
      }
    }

    try {
      const sent = await this.port.sendMessage(options.chatId, options.text, {
        reply_parameters: { message_id: options.replyTo },
        reply_markup: replyMarkup,
      });
      this.record(sent);
      return sent.message_id;
    } catch (error) {
      log.error({ err: error, chatId: options.chatId }, "오류 메시지 전송 실패");
      return undefined;
    }
  }

  /** Always answer callback queries — an unanswered one leaves the client spinner hanging. */
  async answerCallback(
    callbackQueryId: string,
    options?: { text: string; showAlert?: boolean },
  ): Promise<void> {
    try {
      await this.port.answerCallbackQuery(
        callbackQueryId,
        options ? { text: options.text, show_alert: options.showAlert ?? false } : undefined,
      );
    } catch (error) {
      log.warn({ err: error }, "callback 응답 실패");
    }
  }

  /** Best-effort delete. */
  async delete(chatId: number, messageId: number): Promise<void> {
    try {
      await this.port.deleteMessage(chatId, messageId);
    } catch (error) {
      log.warn({ err: error, chatId, messageId }, "메시지 삭제 실패");
    }
  }

  /**
   * Best-effort edit. `retryTargetId` re-attaches the 🔄 button, without which a
   * shutdown mid-retry would strand the placeholder with no way back.
   */
  async editText(
    chatId: number,
    messageId: number,
    text: string,
    retryTargetId?: number,
  ): Promise<void> {
    try {
      const edited = await this.port.editMessageText(chatId, messageId, text, {
        ...(retryTargetId !== undefined ? { reply_markup: retryMarkup(retryTargetId) } : {}),
      });
      if (typeof edited !== "boolean") this.record(edited);
    } catch (error) {
      log.warn({ err: error, chatId, messageId }, "메시지 편집 실패");
    }
  }
}

function retryMarkup(retryTargetId: number): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[{ text: strings.retry.button, callback_data: `retry_${retryTargetId}` }]],
  };
}
