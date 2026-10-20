import { Language, Outcome } from "@google/genai";
import type { Message } from "grammy/types";
import { afterEach, expect, it, vi } from "vitest";
import {
  apiError,
  blockedResponse,
  CHAT,
  callback,
  createFakeGemini,
  createTestBot,
  imageResponse,
  textResponse,
  userMsg,
} from "./helpers.ts";

const OVERLOADED_COPY =
  "현재 AI 모델의 접속량이 많아 처리가 지연되고 있습니다. 잠시 후 다시 시도해주세요. (503)";

afterEach(() => {
  vi.useRealTimers();
});

it("scenario 1: /gemini question sends a spec-shaped request, HTML reply, reactions, and meta", async () => {
  const bot = createTestBot(createFakeGemini(textResponse("**답**입니다")));
  const msg = userMsg({ text: "/gemini 오늘 날씨 알려줘" });

  await bot.handlers.onMessage(msg);

  expect(bot.gemini.requests).toHaveLength(1);
  const request = bot.gemini.requests[0];
  expect(request?.model).toBe("pro-model");
  expect(request?.contents).toEqual([{ role: "user", parts: [{ text: "오늘 날씨 알려줘" }] }]);
  const config = request?.config as Record<string, unknown>;
  expect(config.tools).toEqual([{ googleSearch: {} }, { codeExecution: {} }, { urlContext: {} }]);
  expect(config.thinkingConfig).toEqual({ thinkingBudget: 32768 });

  const sends = bot.telegram.callsOf("sendMessage");
  expect(sends).toHaveLength(1);
  expect(sends[0]?.text).toBe("<b>답</b>입니다");
  expect(sends[0]?.other).toMatchObject({
    parse_mode: "HTML",
    reply_parameters: { message_id: msg.message_id },
  });

  const reactions = bot.telegram.callsOf("setMessageReaction");
  expect(reactions[0]?.reaction).toEqual([{ type: "emoji", emoji: "👍" }]);
  expect(reactions.at(-1)?.reaction).toEqual([]);

  expect(bot.repo.getCommandType(CHAT, msg.message_id)).toBe("gemini");
  const botMsgId = sends[0]?.message.message_id as number;
  expect(bot.repo.getCommandType(CHAT, botMsgId)).toBe("gemini");
  expect(bot.repo.getModelParts(CHAT, botMsgId)?.parts).toEqual([{ text: "**답**입니다" }]);
});

it("scenario 2: a command-less reply continues as [user, model(stored parts), user]", async () => {
  const bot = createTestBot(createFakeGemini(textResponse("첫 답변"), textResponse("이어진 답변")));
  const first = userMsg({ text: "/gemini 첫 질문" });
  await bot.handlers.onMessage(first);

  const botMessage = bot.telegram.callsOf("sendMessage")[0]?.message as Message;
  const followUp = userMsg({ text: "더 자세히", reply_to_message: botMessage as never });
  await bot.handlers.onMessage(followUp);

  expect(bot.gemini.requests).toHaveLength(2);
  expect(bot.gemini.requests[1]?.contents).toEqual([
    { role: "user", parts: [{ text: "첫 질문" }] },
    { role: "model", parts: [{ text: "첫 답변" }] }, // stored parts, verbatim
    { role: "user", parts: [{ text: "더 자세히" }] },
  ]);
});

it("scenario 3: an album of 3 with a caption yields one request with 3 inlineData parts", async () => {
  vi.useFakeTimers();
  const bot = createTestBot(createFakeGemini(textResponse("사진 설명")));

  const album = (n: number, caption?: string): Message =>
    userMsg({
      media_group_id: "album-1",
      photo: [{ file_id: `f${n}`, file_unique_id: `u${n}`, width: 10, height: 10 }],
      ...(caption ? { caption } : {}),
    } as Partial<Message>);

  await bot.handlers.onMessage(album(1, "/gemini 이 사진들 설명해줘"));
  await bot.handlers.onMessage(album(2));
  await bot.handlers.onMessage(album(3));
  await vi.advanceTimersByTimeAsync(600); // fire the 500ms debounce

  expect(bot.gemini.requests).toHaveLength(1);
  const contents = bot.gemini.requests[0]?.contents as {
    parts: { inlineData?: unknown; text?: string }[];
  }[];
  const parts = contents[0]?.parts ?? [];
  expect(parts.filter((p) => p.inlineData)).toHaveLength(3);
  expect(parts.at(-1)?.text).toBe("이 사진들 설명해줘");
});

it("scenario 4: a long reply chains chunks — first replies to the user, pre tags balanced", async () => {
  const longCode = Array.from({ length: 400 }, (_, i) => `print("line ${i}")`).join("\n");
  const bot = createTestBot(
    createFakeGemini(textResponse(`설명입니다\n\n\`\`\`python\n${longCode}\n\`\`\``)),
  );
  const msg = userMsg({ text: "/gemini 코드 보여줘" });

  await bot.handlers.onMessage(msg);

  const sends = bot.telegram.callsOf("sendMessage");
  expect(sends.length).toBeGreaterThan(1);
  expect(sends[0]?.other?.reply_parameters?.message_id).toBe(msg.message_id);
  for (let i = 1; i < sends.length; i++) {
    expect(sends[i]?.other?.reply_parameters?.message_id).toBe(sends[i - 1]?.message.message_id);
  }
  // the cut chunk closes its tags and the next one reopens them
  expect(sends[0]?.text).toMatch(/<\/code><\/pre>$/);
  expect(sends[1]?.text).toMatch(/^<pre><code class="language-python">/);
  const firstId = sends[0]?.message.message_id as number;
  const secondId = sends[1]?.message.message_id as number;
  expect(bot.repo.getModelParts(CHAT, secondId)).toEqual(bot.repo.getModelParts(CHAT, firstId));
});

it("scenario 5: error → 🔄 button → successful retry deletes the placeholder", async () => {
  const bot = createTestBot(
    createFakeGemini(
      Object.assign(new Error("boom"), { status: 400 }),
      textResponse("재시도 성공"),
    ),
  );
  const msg = userMsg({ text: "/gemini 실패할 질문" });
  await bot.handlers.onMessage(msg);

  const errorSend = bot.telegram.callsOf("sendMessage")[0];
  expect(errorSend?.text).toBe("API 오류가 발생했습니다.");
  expect(errorSend?.text).not.toContain("boom");
  expect(errorSend?.other?.reply_markup?.inline_keyboard?.[0]?.[0]).toEqual({
    text: "🔄 재시도",
    callback_data: `retry_${msg.message_id}`,
  });
  const errorMsgId = errorSend?.message.message_id as number;
  expect(bot.repo.getCommandType(CHAT, errorMsgId)).toBe("error");

  await bot.handlers.onCallback(callback(`retry_${msg.message_id}`, errorSend?.message));

  const edits = bot.telegram.callsOf("editMessageText");
  expect(edits[0]).toMatchObject({ messageId: errorMsgId, text: "⏳ 재시도 중입니다..." });
  expect(bot.telegram.callsOf("deleteMessage")[0]?.messageId).toBe(errorMsgId);
  const retrySend = bot.telegram.callsOf("sendMessage").at(-1);
  expect(retrySend?.text).toBe("재시도 성공");
  expect(retrySend?.other?.reply_parameters?.message_id).toBe(msg.message_id);
});

it("scenario 5b: a duplicate press during a retry gets the in-progress toast", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const bot = createTestBot(
    createFakeGemini(async () => {
      await gate;
      return textResponse("done");
    }),
  );
  const msg = userMsg({ text: "/gemini 느린 질문" });
  bot.repo.logMessage(msg);
  const errorMessage = userMsg({ text: "오류였던 메시지" });

  const first = bot.handlers.onCallback(callback(`retry_${msg.message_id}`, errorMessage, "cb1"));
  await Promise.resolve(); // let the first press take the lock
  const second = bot.handlers.onCallback(callback(`retry_${msg.message_id}`, errorMessage, "cb2"));
  await second;
  release?.();
  await first;

  const answers = bot.telegram.callsOf("answerCallbackQuery");
  const toast = answers.find((a) => a.other?.text === "이미 재처리가 진행 중입니다.");
  expect(toast?.id).toBe("cb2");
});

it("scenario 6: replying to a summary continues as plain gemini", async () => {
  const bot = createTestBot(createFakeGemini(textResponse("요약본"), textResponse("후속 답")));
  await bot.handlers.onMessage(userMsg({ text: "/summarize https://example.com" }));

  const summaryRequest = bot.gemini.requests[0]?.config as Record<string, unknown>;
  expect(summaryRequest.systemInstruction).toContain("고밀도 정보 분석가");
  expect(summaryRequest.temperature).toBe(0);

  const summaryMsg = bot.telegram.callsOf("sendMessage")[0]?.message as Message;
  await bot.handlers.onMessage(
    userMsg({ text: "더 요약해줘", reply_to_message: summaryMsg as never }),
  );

  const followConfig = bot.gemini.requests[1]?.config as Record<string, unknown>;
  expect(followConfig.systemInstruction).toBeUndefined(); // summarize remapped to gemini
  expect(followConfig.temperature).toBeUndefined();
  expect(followConfig.tools).toEqual([
    { googleSearch: {} },
    { codeExecution: {} },
    { urlContext: {} },
  ]);
});

it("scenario 7: unauthorized chats get no response and no DB rows", async () => {
  const bot = createTestBot();
  const strangerMsg = userMsg({
    chat: { id: 55, type: "private", first_name: "stranger" },
    text: "/gemini 안녕",
  } as Partial<Message>);

  await bot.handlers.onMessage(strangerMsg);
  await bot.handlers.onCallback(callback("retry_1", strangerMsg));

  expect(bot.telegram.calls).toHaveLength(0);
  expect(bot.gemini.requests).toHaveLength(0);
  expect(bot.repo.getMessage(55, strangerMsg.message_id)).toBeUndefined();
});

it("scenario 8: a mid-text 4k token sets imageSize 4K, strips the token, sends photo+document", async () => {
  const bot = createTestBot(createFakeGemini(imageResponse("그렸어요")));
  const msg = userMsg({ text: "/image 고양이를 4k 로 그려줘" });

  await bot.handlers.onMessage(msg);

  const config = bot.gemini.requests[0]?.config as Record<string, unknown>;
  expect(config.imageConfig).toEqual({ imageSize: "4K" });
  expect(config.thinkingConfig).toBeUndefined();
  const imageContents = bot.gemini.requests[0]?.contents as { parts: { text?: string }[] }[];
  const parts = imageContents[0]?.parts ?? [];
  expect(parts.at(-1)?.text).toBe("고양이를 로 그려줘");

  const photo = bot.telegram.callsOf("sendPhoto")[0];
  expect(photo?.other?.caption).toBe("그렸어요");
  expect(photo?.other?.reply_parameters?.message_id).toBe(msg.message_id);
  const document = bot.telegram.callsOf("sendDocument")[0];
  expect(document?.other?.reply_parameters?.message_id).toBe(photo?.message.message_id);
});

it("a bare /gemini is refused with the guidance line (plain, no button)", async () => {
  const bot = createTestBot();
  await bot.handlers.onMessage(userMsg({ text: "/gemini" }));

  expect(bot.gemini.requests).toHaveLength(0);
  const send = bot.telegram.callsOf("sendMessage")[0];
  expect(send?.text).toBe(
    "명령어와 함께 프롬프트를 입력하거나, 내용이 있는 메시지에 답장하며 사용해주세요.",
  );
  expect(send?.other?.parse_mode).toBeUndefined();
  expect(send?.other?.reply_markup).toBeUndefined();
});

it("replying to an error message does nothing", async () => {
  const bot = createTestBot(createFakeGemini(Object.assign(new Error("x"), { status: 400 })));
  const msg = userMsg({ text: "/gemini 실패" });
  await bot.handlers.onMessage(msg);
  const errorMessage = bot.telegram.callsOf("sendMessage")[0]?.message as Message;

  const before = bot.telegram.calls.length;
  await bot.handlers.onMessage(
    userMsg({ text: "다시 해줘", reply_to_message: errorMessage as never }),
  );

  expect(bot.gemini.requests).toHaveLength(1);
  expect(bot.telegram.calls.length).toBe(before);
});

it("non-retry callbacks are still answered to stop the spinner", async () => {
  const bot = createTestBot();
  await bot.handlers.onCallback(callback("unknown_action", userMsg({ text: "x" })));

  expect(bot.telegram.callsOf("answerCallbackQuery")).toHaveLength(1);
});

it("/start and /help answer without calling the AI", async () => {
  const bot = createTestBot();
  await bot.handlers.onMessage(userMsg({ text: "/start" }));
  await bot.handlers.onMessage(userMsg({ text: "/help gemini" }));

  expect(bot.gemini.requests).toHaveLength(0);
  const sends = bot.telegram.callsOf("sendMessage");
  expect(sends[0]?.text).toContain("반갑습니다! Gemini AI 봇입니다. 🤖");
  expect(sends[1]?.text).toContain("<b>/gemini</b>");
  expect(sends[1]?.text).toContain("별칭: g");
});

it("replying to the re-sent document continues the image conversation", async () => {
  const bot = createTestBot(
    createFakeGemini(imageResponse("그렸어요"), imageResponse("더 크게 그렸어요")),
  );
  const msg = userMsg({ text: "/image 고양이" });
  await bot.handlers.onMessage(msg);

  const docMessage = bot.telegram.callsOf("sendDocument")[0]?.message as Message;
  await bot.handlers.onMessage(userMsg({ text: "더 크게", reply_to_message: docMessage as never }));

  expect(bot.gemini.requests).toHaveLength(2);
  const config = bot.gemini.requests[1]?.config as Record<string, unknown>;
  expect(config.imageConfig).toEqual({ imageSize: "1K" });
  const contents = bot.gemini.requests[1]?.contents as { role: string }[];
  expect(contents.filter((c) => c.role === "model")).toHaveLength(1);
  expect(contents.at(-1)).toEqual({ role: "user", parts: [{ text: "더 크게" }] });
});

it("replying to a later chunk emits the response parts only once", async () => {
  const longCode = Array.from({ length: 400 }, (_, i) => `print(${i})`).join("\n");
  const bot = createTestBot(
    createFakeGemini(textResponse(`\`\`\`python\n${longCode}\n\`\`\``), textResponse("후속")),
  );
  await bot.handlers.onMessage(userMsg({ text: "/gemini 코드" }));

  const secondChunk = bot.telegram.callsOf("sendMessage")[1]?.message as Message;
  await bot.handlers.onMessage(
    userMsg({ text: "설명해줘", reply_to_message: secondChunk as never }),
  );

  const contents = bot.gemini.requests[1]?.contents as { role: string }[];
  expect(contents.filter((c) => c.role === "model")).toHaveLength(1);
});

it("a 503 burst is retried until it succeeds, with no error message", async () => {
  vi.useFakeTimers();
  const bot = createTestBot(
    createFakeGemini(apiError(503), apiError(503), apiError(503), textResponse("복구됨")),
  );
  const msg = userMsg({ text: "/gemini 과부하일 때" });

  const done = bot.handlers.onMessage(msg);
  await vi.runAllTimersAsync();
  await done;

  expect(bot.gemini.requests).toHaveLength(4);
  const sends = bot.telegram.callsOf("sendMessage");
  expect(sends).toHaveLength(1);
  expect(sends[0]?.text).toBe("복구됨");
});

it("503s that never clear stop at the attempt cap and answer with the overload copy", async () => {
  vi.useFakeTimers();
  const starts: number[] = [];
  const bot = createTestBot(
    createFakeGemini(async () => {
      starts.push(Date.now());
      throw apiError(503);
    }),
  );
  const msg = userMsg({ text: "/gemini 계속 과부하" });

  const done = bot.handlers.onMessage(msg);
  await vi.runAllTimersAsync();
  await done;

  expect(starts).toHaveLength(12);
  expect(Math.max(...starts) - Math.min(...starts)).toBe(85_000); // 1+2+4+8+10×7
  const send = bot.telegram.callsOf("sendMessage")[0];
  expect(send?.text).toBe(OVERLOADED_COPY);
  expect(send?.other?.reply_markup?.inline_keyboard?.[0]?.[0]).toEqual({
    text: "🔄 재시도",
    callback_data: `retry_${msg.message_id}`,
  });
});

it("a 429 whose retry hint outlasts the window is not retried", async () => {
  vi.useFakeTimers();
  const bot = createTestBot(
    createFakeGemini(
      apiError(
        429,
        '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"3600s"}]}}',
      ),
    ),
  );

  const done = bot.handlers.onMessage(userMsg({ text: "/gemini 한도 초과" }));
  await vi.runAllTimersAsync();
  await done;

  expect(bot.gemini.requests).toHaveLength(1);
  expect(bot.telegram.callsOf("sendMessage")[0]?.text).toBe(
    "요청 한도를 초과했습니다. 잠시 후 다시 시도해주세요. (429)",
  );
});

it("a persistent 500 gives up inside the 15-second window", async () => {
  vi.useFakeTimers();
  const starts: number[] = [];
  const bot = createTestBot(
    createFakeGemini(async () => {
      starts.push(Date.now());
      throw apiError(500);
    }),
  );

  const done = bot.handlers.onMessage(userMsg({ text: "/gemini 서버 오류" }));
  await vi.runAllTimersAsync();
  await done;

  expect(starts).toHaveLength(5); // 0, 1, 3, 7, 15s
  expect(Math.max(...starts) - Math.min(...starts)).toBe(15_000);
  expect(bot.telegram.callsOf("sendMessage")[0]?.text).toBe("API 오류가 발생했습니다.");
});

it("a shutdown during a retry wait stops retrying and answers nothing", async () => {
  vi.useFakeTimers();
  const bot = createTestBot(createFakeGemini(apiError(503)));

  const done = bot.handlers.onMessage(userMsg({ text: "/gemini 종료 직전" }));
  await vi.advanceTimersByTimeAsync(0);
  expect(bot.gemini.requests).toHaveLength(1);

  bot.shutdown.abort();
  await done;

  expect(bot.gemini.requests).toHaveLength(1);
  expect(bot.telegram.callsOf("sendMessage")).toHaveLength(0);
});

it("a code-execution answer sends its code, its output, and its text in one message", async () => {
  const bot = createTestBot(
    createFakeGemini(
      textResponse("", [
        {
          executableCode: { code: "print(2**10)", language: Language.PYTHON },
          thoughtSignature: "sig",
        },
        { codeExecutionResult: { outcome: Outcome.OUTCOME_OK, output: "1024" } },
        { text: "답은 **1024**입니다" },
      ]),
    ),
  );
  const msg = userMsg({ text: "/gemini 2의 10제곱 계산해줘" });

  await bot.handlers.onMessage(msg);

  const sends = bot.telegram.callsOf("sendMessage");
  expect(sends).toHaveLength(1);
  expect(sends[0]?.text).toBe(
    [
      '<b>[코드 실행]</b>\n<pre><code class="language-python">print(2**10)</code></pre>',
      "",
      "<b>[실행 결과 ✅]</b>\n<pre><code>1024</code></pre>",
      "",
      "답은 <b>1024</b>입니다",
    ].join("\n"),
  );
  expect(sends[0]?.other?.reply_markup).toBeUndefined();
});

it("a prompt blocked by the API answers with the block copy and a retry button", async () => {
  const bot = createTestBot(createFakeGemini(blockedResponse("OTHER")));
  const msg = userMsg({ text: "/gemini 차단되는 프롬프트" });

  await bot.handlers.onMessage(msg);

  const send = bot.telegram.callsOf("sendMessage")[0];
  expect(send?.text).toBe("프롬프트 차단됨: OTHER");
  expect(send?.other?.reply_markup?.inline_keyboard?.[0]?.[0]).toEqual({
    text: "🔄 재시도",
    callback_data: `retry_${msg.message_id}`,
  });
  expect(bot.repo.getCommandType(CHAT, send?.message.message_id as number)).toBe("error");
});

it("a response whose parts render nothing answers with the empty-response copy, not a bare footer", async () => {
  const response = textResponse("", [{ text: "", thoughtSignature: "sig" }]);
  response.usageMetadata = { promptTokenCount: 10, candidatesTokenCount: 0, totalTokenCount: 10 };
  const bot = createTestBot(createFakeGemini(response));
  const msg = userMsg({ text: "/gemini 아무 질문" });

  await bot.handlers.onMessage(msg);

  const sends = bot.telegram.callsOf("sendMessage");
  expect(sends).toHaveLength(1);
  expect(sends[0]?.text).toBe("응답에 데이터가 없습니다.");
  expect(sends[0]?.other?.reply_markup?.inline_keyboard?.[0]?.[0]).toEqual({
    text: "🔄 재시도",
    callback_data: `retry_${msg.message_id}`,
  });
});
