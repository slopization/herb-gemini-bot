import type { RichMessage } from "grammy/types";

/** Plain text of a received rich message — its display text for history fallback. */
export function richMessageText(message: RichMessage): string {
  return blocksText(message.blocks).trim();
}

function blocksText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .map(blockText)
    .filter((text) => text !== "")
    .join("\n");
}

function blockText(block: unknown): string {
  if (typeof block !== "object" || block === null) return "";
  if ("items" in block && Array.isArray(block.items)) {
    return block.items
      .map((item: unknown) => {
        if (typeof item !== "object" || item === null) return "";
        const label = "label" in item && typeof item.label === "string" ? `${item.label} ` : "";
        return label + ("blocks" in item ? blocksText(item.blocks) : "");
      })
      .join("\n");
  }
  if ("cells" in block && Array.isArray(block.cells)) {
    return block.cells
      .map((row: unknown) => (Array.isArray(row) ? row.map(inlineText).join(" | ") : ""))
      .join("\n");
  }
  const own = [
    "summary" in block ? inlineText(block.summary) : "",
    "text" in block || "expression" in block ? inlineText(block) : "",
    "blocks" in block ? blocksText(block.blocks) : "",
  ];
  return own.filter((text) => text !== "").join("\n");
}

function inlineText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(inlineText).join("");
  if (typeof value !== "object" || value === null) return "";
  if ("expression" in value && typeof value.expression === "string") return value.expression;
  if ("text" in value) return inlineText(value.text);
  return "";
}
