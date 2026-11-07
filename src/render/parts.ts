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

/** The model's fold point: its text before this stays visible, the rest goes behind a toggle. */
export const DETAILS_MARKER = "[[DETAILS]]";

export interface RenderInput {
  parts: Part[];
  groundingMetadata?: GroundingMetadata;
  usageMetadata?: GenerateContentResponseUsageMetadata;
}

/** Gemini response parts + grounding metadata → one Telegram rich HTML document. */
export function renderResponseHtml(input: RenderInput): string {
  const segments: string[] = [];
  let lead = "";
  let mdBuffer = "";
  const flush = (): void => {
    const pieces = mdBuffer.split(DETAILS_MARKER);
    if (pieces.length > 1 && lead === "") lead = pieces.shift() ?? "";
    const markdown = pieces.join("");
    if (markdown.trim() !== "") segments.push(markdownToRichHtml(markdown));
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
  const content = foldBehindLead(lead, segments);
  // "" is what the pipeline reads as an empty response, so a footer never stands in for content
  const hasImage = input.parts.some((part) => part.inlineData?.mimeType?.startsWith("image/"));
  if (content.length === 0 && !hasImage) return "";

  const closing = [
    ...renderGrounding(input.groundingMetadata),
    ...renderTokenUsage(input.usageMetadata),
  ];
  // the divider belongs to the closing blocks as a whole, not to any single one of them
  if (closing.length > 0) content.push("<hr/>", ...closing);
  return content.join("\n");
}

/** Body parts the model ran before writing its lead fold too, so the lead always comes first. */
function foldBehindLead(lead: string, body: string[]): string[] {
  if (lead.trim() === "") return body;
  const visible = markdownToRichHtml(lead);
  if (body.length === 0) return [visible];
  return [visible, ...toggle(strings.render.detailsSummary, body)];
}

function toggle(summary: string, body: string[]): string[] {
  return [`<details><summary>${summary}</summary>`, ...body, "</details>"];
}

function renderTokenUsage(usage: GenerateContentResponseUsageMetadata | undefined): string[] {
  if (usage?.totalTokenCount === undefined) return [];
  const count = (n: number | undefined): string => (n ?? 0).toLocaleString("en-US");
  const line = strings.render.tokenUsage(
    count(usage.promptTokenCount),
    count(usage.candidatesTokenCount),
    count(usage.thoughtsTokenCount),
    count(usage.totalTokenCount),
  );
  return [`<footer>${line}</footer>`];
}

function renderGrounding(grounding: GroundingMetadata | undefined): string[] {
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

  if (sections.length === 0) return [];
  return toggle(
    strings.render.sourcesSummary,
    sections.map((section) => `<p>${section}</p>`),
  );
}
