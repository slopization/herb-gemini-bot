import { GoogleGenAI } from "@google/genai";
import { autoRetry } from "@grammyjs/auto-retry";
import { run } from "@grammyjs/runner";
import { Bot } from "grammy";
import { Agent, setGlobalDispatcher } from "undici";
import { buildMenuCommands } from "./commands/help.ts";
import { loadConfig } from "./config.ts";
import { openDb } from "./db/database.ts";
import { Repo } from "./db/repo.ts";
import { GeminiClient } from "./gemini/client.ts";
import { captureConsole, log } from "./log.ts";
import type { Deps } from "./pipeline/run.ts";
import { createTelegramFileFetcher, FileCache } from "./telegram/files.ts";
import { createHandlers } from "./telegram/handlers.ts";
import { Sender } from "./telegram/sender.ts";

const SHUTDOWN_DRAIN_MS = 8000;

async function main(): Promise<void> {
  captureConsole();
  const cfg = loadConfig();

  // Some networks cannot route the AAAA records Telegram and Gemini resolve to.
  setGlobalDispatcher(new Agent({ connect: { family: 4 } }));

  const db = openDb();
  const repo = new Repo(db);

  const shutdownController = new AbortController();
  const gemini = new GeminiClient(
    new GoogleGenAI({ apiKey: cfg.googleApiKey }).models,
    shutdownController.signal,
  );

  const bot = new Bot(cfg.telegramToken);
  bot.api.config.use(autoRetry());
  await bot.init();
  log.info({ username: bot.botInfo.username }, "봇 초기화 완료");

  const sender = new Sender(bot.api, repo);
  const files = new FileCache(
    createTelegramFileFetcher((fileId) => bot.api.getFile(fileId), cfg.telegramToken),
  );

  const deps: Deps = {
    cfg,
    repo,
    gemini,
    sender,
    files,
    botId: bot.botInfo.id,
    botUsername: bot.botInfo.username,
    shutdownSignal: shutdownController.signal,
  };
  const handlers = createHandlers(deps);

  const menu = buildMenuCommands();
  const scopes = ["all_private_chats", "all_chat_administrators", "all_group_chats"] as const;
  await Promise.all(scopes.map((type) => bot.api.setMyCommands(menu, { scope: { type } })));

  bot.on("message", (ctx) => handlers.onMessage(ctx.message));
  bot.on("callback_query", (ctx) => handlers.onCallback(ctx.callbackQuery));
  bot.catch((err) => {
    log.error({ err: err.error }, "처리되지 않은 업데이트 오류");
  });

  const runner = run(bot, {
    runner: { fetch: { allowed_updates: ["message", "callback_query"] } },
  });
  log.info("폴링 시작");

  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, "종료 절차 시작");
    handlers.cancelAlbumTimers();
    shutdownController.abort(); // in-flight Gemini calls abort without sending error replies
    await Promise.race([runner.stop(), delay(SHUTDOWN_DRAIN_MS)]);
    db.close();
    log.info("종료 완료");
    process.exit(0);
  };
  process.once("SIGINT", () => {
    shutdown("SIGINT").catch((error) => {
      log.error({ err: error }, "종료 중 오류");
      process.exit(1);
    });
  });
  process.once("SIGTERM", () => {
    shutdown("SIGTERM").catch((error) => {
      log.error({ err: error }, "종료 중 오류");
      process.exit(1);
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  log.fatal({ err: error }, "부팅 실패");
  process.exit(1);
});
