import { format } from "node:util";
import { pino } from "pino";

// Gemini SDK error strings can embed URLs carrying `?key=<api key>` — strip it from every logged error.
const KEY_PATTERN = /([?&]key=)[^&\s"']+/gi;

export function redactText(text: string): string {
  return text.replace(KEY_PATTERN, "$1[REDACTED]");
}

export function redactError(err: unknown): { name: string; message: string; stack?: string } {
  if (err instanceof Error) {
    const out: { name: string; message: string; stack?: string } = {
      name: err.name,
      message: redactText(err.message),
    };
    if (err.stack) out.stack = redactText(err.stack);
    return out;
  }
  return { name: "UnknownError", message: redactText(String(err)) };
}

export const log = pino({
  level: "info",
  serializers: { err: redactError },
  ...(process.stdout.isTTY
    ? { transport: { target: "pino-pretty", options: { singleLine: true } } }
    : {}),
});

export type Log = typeof log;

const CONSOLE_ROUTES = [
  ["log", "debug"],
  ["info", "debug"],
  ["debug", "debug"],
  ["warn", "warn"],
  ["error", "error"],
] as const;

/** @google/genai reports response-shape and deprecation notices through console.* — those lines
 *  reach stdout with no level, time or context unless they are routed into pino. */
export function captureConsole(): void {
  for (const [method, level] of CONSOLE_ROUTES) {
    console[method] = (...args: unknown[]): void => {
      log[level]({ source: "console" }, redactText(format(...args)));
    };
  }
}
