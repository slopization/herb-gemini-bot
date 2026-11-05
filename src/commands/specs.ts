import type { GenerateContentConfig, Part, Tool } from "@google/genai";
import type { Config } from "../config.ts";
import { SUMMARIZE_PROMPT } from "./summarize-prompt.ts";

export interface ParamSpec {
  readonly name: string;
  readonly type: "string";
  readonly allowedValues: readonly string[];
  readonly defaultValue: string;
  readonly description: string;
}

export interface CommandMeta {
  readonly name: string;
  /** Extra names besides `name`; also registered in the menu as alias entries. */
  readonly aliases: readonly string[];
  readonly description: string;
  readonly showInMenu: boolean;
  readonly params?: readonly ParamSpec[];
}

export interface AiCommandSpec extends CommandMeta {
  readonly kind: "ai";
  readonly modelKey: keyof Config["models"];
  readonly tools: Tool[];
  readonly thinkingBudget?: number;
  readonly systemInstruction?: string;
  readonly temperature?: number;
  /** Filter applied to replayed model parts (image drops functionCall/Response). */
  readonly historyPartFilter?: (part: Part) => boolean;
  /** Extra request config derived from parsed params (image: imageSize). */
  readonly requestOverrides?: (args: Readonly<Record<string, string>>) => GenerateContentConfig;
}

const THINKING_BUDGET = 32768;

export const CHAT_PROMPT =
  "You are replying in a Telegram chat. Keep answers concise and to the point: match the length to the question, skip preambles, recaps and filler, and go long only when the user asks for depth.";

const start: CommandMeta = {
  name: "start",
  aliases: [],
  description: "봇을 시작하고 간단한 도움말을 표시합니다.",
  showInMenu: false,
};

const help: CommandMeta = {
  name: "help",
  aliases: [],
  description: "도움말을 표시합니다.",
  showInMenu: true,
};

const gemini: AiCommandSpec = {
  kind: "ai",
  name: "gemini",
  aliases: ["g"],
  description: "Gemini 3.0 Pro 모델과 대화합니다.",
  showInMenu: true,
  modelKey: "pro",
  tools: [{ googleSearch: {} }, { codeExecution: {} }, { urlContext: {} }],
  thinkingBudget: THINKING_BUDGET,
  systemInstruction: CHAT_PROMPT,
};

const image: AiCommandSpec = {
  kind: "ai",
  name: "image",
  aliases: ["img"],
  description: "Gemini 3.0 Pro Image 모델로 이미지를 생성합니다.",
  showInMenu: true,
  modelKey: "image",
  tools: [{ googleSearch: {} }],
  params: [
    {
      name: "resolution",
      type: "string",
      allowedValues: ["1k", "2k", "4k"],
      defaultValue: "1k",
      description: "이미지 해상도",
    },
  ],
  historyPartFilter: (part) => !("functionCall" in part) && !("functionResponse" in part),
  requestOverrides: (args) => ({
    imageConfig: { imageSize: (args.resolution ?? "1k").toUpperCase() },
  }),
};

const map: AiCommandSpec = {
  kind: "ai",
  name: "map",
  aliases: [],
  description: "Google 지도 기능이 활성화된 상태로 Gemini 3.0 Pro 모델과 대화합니다.",
  showInMenu: true,
  modelKey: "pro",
  tools: [{ googleSearch: {} }, { googleMaps: {} }, { urlContext: {} }],
  thinkingBudget: THINKING_BUDGET,
  systemInstruction: CHAT_PROMPT,
};

const summarize: AiCommandSpec = {
  kind: "ai",
  name: "summarize",
  aliases: [],
  description: "링크나 긴 텍스트(파일)를 요약합니다.",
  showInMenu: true,
  modelKey: "pro",
  tools: [{ googleSearch: {} }, { urlContext: {} }, { codeExecution: {} }],
  thinkingBudget: THINKING_BUDGET,
  systemInstruction: SUMMARIZE_PROMPT,
  temperature: 0,
};

/** Declaration order is the menu and /help listing order. */
export const allSpecs: readonly (CommandMeta | AiCommandSpec)[] = [
  start,
  help,
  gemini,
  image,
  map,
  summarize,
];

/** Implicit-continuation remap: follow-ups to a summary continue as plain chat. */
export const IMPLICIT_REMAP: Readonly<Record<string, string>> = { summarize: "gemini" };

export function isAiSpec(spec: CommandMeta | AiCommandSpec): spec is AiCommandSpec {
  return "kind" in spec && spec.kind === "ai";
}

export function findCommand(nameOrAlias: string): CommandMeta | AiCommandSpec | undefined {
  const needle = nameOrAlias.toLowerCase();
  return allSpecs.find(
    (spec) => spec.name === needle || spec.aliases.some((alias) => alias === needle),
  );
}
