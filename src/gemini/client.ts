import type {
  Content,
  GenerateContentConfig,
  GenerateContentParameters,
  GenerateContentResponse,
  GenerateContentResponseUsageMetadata,
  GroundingMetadata,
  Part,
} from "@google/genai";
import { FinishReason } from "@google/genai";
import { type Log, log } from "../log.ts";
import { strings } from "../strings.ts";

/** Gemini port — the boundary faked in tests. Real implementation: `new GoogleGenAI(...).models`. */
export interface GeminiPort {
  generateContent(params: GenerateContentParameters): Promise<GenerateContentResponse>;
}

export interface GenRequest {
  model: string;
  contents: Content[];
  config: GenerateContentConfig;
}

export interface GenImage {
  buffer: Buffer;
  mimeType: string;
}

export type GenResult =
  | {
      ok: true;
      parts: Part[];
      images: GenImage[];
      finishReason?: string;
      groundingMetadata?: GroundingMetadata;
      usageMetadata?: GenerateContentResponseUsageMetadata;
    }
  | { ok: false; userMessage: string };

const MAX_ATTEMPTS = 12;
const TIMEOUT_MS = 30 * 60 * 1000;
// 429/503 are per-request capacity shedding; other 5xx usually come from the request itself
const OVERLOAD_RETRY_WINDOW_MS = 2 * 60 * 1000;
const TRANSIENT_RETRY_WINDOW_MS = 15 * 1000;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 10 * 1000;

export class GeminiClient {
  private readonly port: GeminiPort;
  private readonly shutdownSignal: AbortSignal;

  constructor(port: GeminiPort, shutdownSignal: AbortSignal) {
    this.port = port;
    this.shutdownSignal = shutdownSignal;
  }

  async generate(request: GenRequest, jobLog: Log = log): Promise<GenResult> {
    const callLog = jobLog.child({ model: request.model });
    // the window opens at the first failure — generation itself can run for minutes
    let failedAt: number | undefined;
    for (let attempt = 1; ; attempt++) {
      // fresh signal per attempt — a spent signal would fail every retry instantly
      const signal = AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), this.shutdownSignal]);
      try {
        const response = await this.port.generateContent({
          model: request.model,
          contents: request.contents,
          config: { ...request.config, abortSignal: signal, httpOptions: { timeout: TIMEOUT_MS } },
        });
        return classifyResponse(response, callLog);
      } catch (error) {
        const cls = classifyError(error);
        failedAt ??= Date.now();
        const elapsedMs = Date.now() - failedAt;
        const waitMs = Math.max(cls.retryAfterMs ?? 0, backoffMs(attempt));
        if (attempt < MAX_ATTEMPTS && elapsedMs + waitMs <= cls.retryWindowMs) {
          callLog.warn({ err: error, attempt, elapsedMs, waitMs }, "gemini 호출 실패, 재시도");
          await delay(waitMs, this.shutdownSignal);
          if (!this.shutdownSignal.aborted) continue;
        }
        callLog.error({ err: error, attempt, elapsedMs }, "gemini 호출 실패");
        return { ok: false, userMessage: cls.userMessage };
      }
    }
  }
}

function classifyResponse(response: GenerateContentResponse, callLog: Log): GenResult {
  const candidate = response.candidates?.[0];
  const finishReason = candidate?.finishReason;
  const parts = candidate?.content?.parts ?? [];
  const shape = {
    finishReason,
    candidates: response.candidates?.length ?? 0,
    partKinds: partKinds(parts),
  };

  const feedbackReason = response.promptFeedback?.blockReason;
  if (feedbackReason) {
    callLog.warn({ ...shape, blockReason: feedbackReason }, "gemini 프롬프트 차단");
    return { ok: false, userMessage: strings.errors.promptBlocked(String(feedbackReason)) };
  }

  if (finishReason === FinishReason.SAFETY || finishReason === FinishReason.PROHIBITED_CONTENT) {
    callLog.warn(shape, "gemini 응답 차단");
    return { ok: false, userMessage: strings.errors.safetyBlocked };
  }
  if (finishReason === FinishReason.MALFORMED_FUNCTION_CALL) {
    callLog.warn(shape, "gemini 함수 호출 오류");
    return { ok: false, userMessage: strings.errors.malformedFunctionCall };
  }

  const images: GenImage[] = [];
  for (const cand of response.candidates ?? []) {
    for (const part of cand.content?.parts ?? []) {
      if (part.inlineData?.mimeType?.startsWith("image/") && part.inlineData.data) {
        images.push({
          buffer: Buffer.from(part.inlineData.data, "base64"),
          mimeType: part.inlineData.mimeType,
        });
      }
    }
  }

  const grounding = candidate?.groundingMetadata;
  const usage = response.usageMetadata;
  if (parts.length === 0 && images.length === 0) {
    callLog.warn(shape, "gemini 빈 응답");
    return { ok: false, userMessage: strings.errors.emptyResponse };
  }
  if (finishReason !== undefined && finishReason !== FinishReason.STOP) {
    callLog.warn(shape, "gemini 응답이 끝까지 생성되지 않음");
  }
  return {
    ok: true,
    parts,
    images,
    ...(finishReason ? { finishReason: String(finishReason) } : {}),
    ...(grounding ? { groundingMetadata: grounding } : {}),
    ...(usage ? { usageMetadata: usage } : {}),
  };
}

/** Part field names with counts (`{ text: 2, executableCode: 1 }`) — a response's shape in one log field. */
export function partKinds(parts: readonly Part[]): Record<string, number> {
  const kinds: Record<string, number> = {};
  for (const part of parts) {
    for (const [name, value] of Object.entries(part)) {
      if (value === undefined || value === null) continue;
      kinds[name] = (kinds[name] ?? 0) + 1;
    }
  }
  return kinds;
}

interface ErrorClass {
  /** How long retries may keep starting, measured from the first failure; 0 never retries. */
  retryWindowMs: number;
  userMessage: string;
  retryAfterMs?: number;
}

// Gemini error bodies arrive stringified in `message`; these are their canonical status names.
const STATUS_NAMES: Readonly<Record<string, number>> = {
  RESOURCE_EXHAUSTED: 429,
  UNAVAILABLE: 503,
  INTERNAL: 500,
  DEADLINE_EXCEEDED: 504,
};

function classifyError(error: unknown): ErrorClass {
  const err = error as { message?: unknown; status?: unknown; name?: unknown } | null;
  const message = typeof err?.message === "string" ? err.message : String(error);
  const name = typeof err?.name === "string" ? err.name : "";

  // timeouts/aborts are not auto-retried — manual 🔄 only
  if (name === "AbortError" || name === "TimeoutError") {
    return { retryWindowMs: 0, userMessage: strings.errors.timeout };
  }

  const status = typeof err?.status === "number" ? err.status : statusOf(message);
  if (status === 429) {
    const hint = parseRetryDelayMs(message);
    return {
      retryWindowMs: OVERLOAD_RETRY_WINDOW_MS,
      userMessage: strings.errors.rateLimited,
      ...(hint !== undefined ? { retryAfterMs: hint } : {}),
    };
  }
  if (status === 503) {
    return { retryWindowMs: OVERLOAD_RETRY_WINDOW_MS, userMessage: strings.errors.overloaded };
  }
  if (status === 500 || status === 502 || status === 504) {
    return { retryWindowMs: TRANSIENT_RETRY_WINDOW_MS, userMessage: strings.errors.apiError };
  }
  if (status === undefined) {
    if (message.includes("aborted")) {
      return { retryWindowMs: 0, userMessage: strings.errors.timeout };
    }
    if (message.includes("fetch failed")) {
      return { retryWindowMs: TRANSIENT_RETRY_WINDOW_MS, userMessage: strings.errors.apiError };
    }
  }
  return { retryWindowMs: 0, userMessage: strings.errors.apiError };
}

/** Read the status out of the error body's own fields — never from loose digits in prose. */
function statusOf(message: string): number | undefined {
  const code = /"code"\s*:\s*(\d{3})\b/.exec(message);
  if (code?.[1] !== undefined) return Number(code[1]);
  const name = /"status"\s*:\s*"([A-Z_]+)"/.exec(message);
  return name?.[1] !== undefined ? STATUS_NAMES[name[1]] : undefined;
}

/** Best-effort parse of RetryInfo (`"retryDelay":"7s"`) from a 429 body. */
function parseRetryDelayMs(message: string): number | undefined {
  const match = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(message);
  if (!match?.[1]) return undefined;
  return Math.round(Number(match[1]) * 1000);
}

function backoffMs(attempt: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_CAP_MS);
}

// global setTimeout, not node:timers/promises — fake timers cannot drive the latter
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
