import type { GenerateContentResponseUsageMetadata, GroundingMetadata, Part } from "@google/genai";
import { strings } from "../strings.ts";
import {
  BR,
  codeBlock,
  escapeAttribute,
  escapeHtml,
  markdownToRichHtml,
  safeHref,
} from "./markdown.ts";

export interface RenderInput {
  parts: Part[];
  groundingMetadata?: GroundingMetadata;
  usageMetadata?: GenerateContentResponseUsageMetadata;
}

/** Gemini response parts + grounding metadata → one Telegram rich HTML document. */
export function renderResponseHtml(input: RenderInput): string {
  const segments: string[] = [];
  let mdBuffer = "";
  const flush = (): void => {
    if (mdBuffer.trim() !== "") segments.push(markdownToRichHtml(mdBuffer));
    mdBuffer = "";
  };

  for (const part of input.parts) {
    if (part.text) {
      mdBuffer += part.text;
    } else if (part.executableCode) {
      flush();
      segments.push(
        `<p>${strings.render.codeExecutionLabel}</p>\n${codeBlock(part.executableCode.code ?? "", "python")}`,
      );
    } else if (part.codeExecutionResult) {
      flush();
      const ok = part.codeExecutionResult.outcome === "OUTCOME_OK";
      segments.push(
        `<p>${strings.render.executionResultLabel(ok)}</p>\n${codeBlock(part.codeExecutionResult.output ?? "")}`,
      );
    }
  }
  flush();
  // "" is what the pipeline reads as an empty response, so a footer never stands in for content
  const hasImage = input.parts.some((part) => part.inlineData?.mimeType?.startsWith("image/"));
  if (segments.length === 0 && !hasImage) return "";

  const footer = [
    ...renderGroundingFooter(input.groundingMetadata),
    ...renderTokenUsage(input.usageMetadata),
  ];
  // the divider belongs to the footer as a whole, not to any single section of it
  if (footer.length > 0) segments.push(`<hr/>\n<footer>${footer.join(BR + BR)}</footer>`);
  return segments.join("\n");
}

function renderTokenUsage(usage: GenerateContentResponseUsageMetadata | undefined): string[] {
  if (usage?.totalTokenCount === undefined) return [];
  const count = (n: number | undefined): string => (n ?? 0).toLocaleString("en-US");
  return [
    strings.render.tokenUsage(
      count(usage.promptTokenCount),
      count(usage.candidatesTokenCount),
      count(usage.thoughtsTokenCount),
      count(usage.totalTokenCount),
    ),
  ];
}

/** Footer sections, each one or more lines already joined by line breaks. */
function renderGroundingFooter(grounding: GroundingMetadata | undefined): string[] {
  if (!grounding) return [];

  const sections: string[] = [];
  const queries = grounding.webSearchQueries ?? [];
  if (queries.length > 0) {
    const joined = queries.map((q) => `'${escapeHtml(q)}'`).join(", ");
    sections.push(strings.render.searchQueries(joined));
  }

  const sources = new Map<string, string>();
  for (const chunk of grounding.groundingChunks ?? []) {
    if (chunk.web?.uri && chunk.web.title) sources.set(chunk.web.uri, chunk.web.title);
  }
  if (sources.size > 0) {
    const lines: string[] = [strings.render.sourcesHeader];
    for (const [uri, title] of sources) {
      const href = safeHref(uri);
      lines.push(
        strings.render.sourceLine(
          href ? `<a href="${escapeAttribute(href)}">${escapeHtml(title)}</a>` : escapeHtml(title),
        ),
      );
    }
    sections.push(lines.join(BR));
  }

  return sections;
}
