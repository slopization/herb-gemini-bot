import type { GenerateContentResponseUsageMetadata, GroundingMetadata, Part } from "@google/genai";
import { strings } from "../strings.ts";
import { escapeAttribute, escapeHtml, markdownToTelegramHtml, safeHref } from "./markdown.ts";

export interface RenderInput {
  parts: Part[];
  /** Fallback when parts carry no renderable text. */
  text?: string;
  groundingMetadata?: GroundingMetadata;
  usageMetadata?: GenerateContentResponseUsageMetadata;
}

/** Gemini response parts + grounding metadata → one sendable Telegram HTML document. */
export function renderResponseHtml(input: RenderInput): string {
  const segments: string[] = [];
  let mdBuffer = "";
  const flush = (): void => {
    if (mdBuffer.trim() !== "") segments.push(markdownToTelegramHtml(mdBuffer));
    mdBuffer = "";
  };

  for (const part of input.parts) {
    if (part.text) {
      mdBuffer += part.text;
    } else if (part.executableCode) {
      flush();
      segments.push(
        `${strings.render.codeExecutionLabel}\n<pre><code class="language-python">${escapeHtml(part.executableCode.code ?? "")}</code></pre>`,
      );
    } else if (part.codeExecutionResult) {
      flush();
      const ok = part.codeExecutionResult.outcome === "OUTCOME_OK";
      segments.push(
        `${strings.render.executionResultLabel(ok)}\n<pre><code>${escapeHtml(part.codeExecutionResult.output ?? "")}</code></pre>`,
      );
    }
  }
  flush();
  if (segments.length === 0 && input.text) segments.push(markdownToTelegramHtml(input.text));

  const footer =
    renderGroundingFooter(input.groundingMetadata) + renderTokenUsage(input.usageMetadata);
  // the divider belongs to the footer as a whole, not to any single line of it
  const divided = footer === "" ? "" : `\n${strings.render.groundingDivider}${footer}`;
  return (segments.join("\n\n") + divided).trim();
}

function renderTokenUsage(usage: GenerateContentResponseUsageMetadata | undefined): string {
  if (usage?.totalTokenCount === undefined) return "";
  const count = (n: number | undefined): string => (n ?? 0).toLocaleString("en-US");
  return strings.render.tokenUsage(
    count(usage.promptTokenCount),
    count(usage.candidatesTokenCount),
    count(usage.thoughtsTokenCount),
    count(usage.totalTokenCount),
  );
}

function renderGroundingFooter(grounding: GroundingMetadata | undefined): string {
  if (!grounding) return "";

  let footer = "";
  const queries = grounding.webSearchQueries ?? [];
  if (queries.length > 0) {
    const joined = queries.map((q) => `'${escapeHtml(q)}'`).join(", ");
    footer += strings.render.searchQueries(joined);
  }

  const sources = new Map<string, string>();
  for (const chunk of grounding.groundingChunks ?? []) {
    if (chunk.web?.uri && chunk.web.title) sources.set(chunk.web.uri, chunk.web.title);
  }
  if (sources.size > 0) {
    footer += strings.render.sourcesHeader;
    for (const [uri, title] of sources) {
      const href = safeHref(uri);
      footer += strings.render.sourceLine(
        href ? `<a href="${escapeAttribute(href)}">${escapeHtml(title)}</a>` : escapeHtml(title),
      );
    }
  }

  return footer;
}
