import type { Token, TokenizerExtension, Tokens } from "marked";
import { Marked } from "marked";

// Untrusted text (model output, user echoes) passes through this escape exactly once.
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Entities Telegram resolves back to their character. Anything outside this set keeps the
// literal-ampersand treatment, so an entity Telegram might not resolve is never emitted raw.
const RESOLVED_ENTITY =
  /&(?!(?:amp|lt|gt|quot|apos|nbsp|hellip|mdash|ndash|lsquo|rsquo|ldquo|rdquo|#\d{1,7}|#[xX][0-9a-fA-F]{1,6});)/g;

/**
 * Escape prose. Markdown resolves entity references in text (but not in code), so an
 * `&amp;` the model wrote is already the character `&` and must not be escaped twice.
 */
function escapeProse(text: string): string {
  return text.replace(RESOLVED_ENTITY, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeAttribute(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;");
}

// Telegram silently unlinks an anchor with any other scheme.
const SUPPORTED_SCHEME = /^(?:https?|tg):\/\//i;

/** An href Telegram links, or undefined when the label must render as plain text. */
export function safeHref(href: string): string | undefined {
  const trimmed = href.trim();
  return SUPPORTED_SCHEME.test(trimmed) ? trimmed : undefined;
}

/** Line break inside a text block; bare newlines collapse to spaces in rich HTML. */
export const BR = "<br/>\n";

// Telegram rejects a message nested deeper than 16 levels (blocks and inline formatting
// together); these caps keep the worst case at quote 3 + list 6 + paragraph 1 + inline 5.
const MAX_QUOTE_DEPTH = 3;
const MAX_LIST_DEPTH = 6;
const MAX_INLINE_DEPTH = 5;
// Telegram rejects a table with more columns than this.
const MAX_TABLE_COLUMNS = 20;

interface MathToken {
  type: "mathBlock" | "mathInline";
  raw: string;
  text: string;
}

const BLOCK_MATH = [
  /^ {0,3}\$\$([\s\S]+?)\$\$[ \t]*(?:\n+|$)/,
  /^ {0,3}\\\[([\s\S]+?)\\\][ \t]*(?:\n+|$)/,
];
const INLINE_MATH = [
  /^\$\$([\s\S]+?)\$\$/,
  /^\\\[([\s\S]+?)\\\]/,
  /^\\\(([\s\S]+?)\\\)/,
  // a currency amount is not math: no space inside the delimiters, no digit after the close
  /^\$(?!\s)((?:\\.|[^\\$\n])+?)(?<!\s)\$(?!\d)/,
];

function mathExtension(level: "block" | "inline", rules: RegExp[]): TokenizerExtension {
  const name = level === "block" ? "mathBlock" : "mathInline";
  return {
    name,
    level,
    start: (src) => {
      const at = src.search(level === "block" ? /^ {0,3}(?:\$\$|\\\[)/m : /\$|\\[([]/);
      return at === -1 ? undefined : at;
    },
    tokenizer: (src): MathToken | undefined => {
      for (const rule of rules) {
        const match = rule.exec(src);
        const body = match?.[1]?.trim();
        if (match && body) return { type: name, raw: match[0], text: body };
      }
      return undefined;
    },
  };
}

const markdown = new Marked({
  extensions: [mathExtension("block", BLOCK_MATH), mathExtension("inline", INLINE_MATH)],
});

interface Depth {
  quote: number;
  list: number;
}

/**
 * Markdown → Telegram rich HTML. marked is a tokenizer only; all emission happens here.
 * Every block, list item, and table row starts its own line so the splitter can cut
 * between them.
 */
export function markdownToRichHtml(source: string): string {
  return renderBlocks(markdown.lexer(source), { quote: 0, list: 0 }).join("\n");
}

function renderBlocks(tokens: Token[], depth: Depth): string[] {
  const out: string[] = [];
  for (const token of tokens) {
    const block = renderBlock(token, depth);
    if (block !== "") out.push(block);
  }
  return out;
}

function renderBlock(token: Token, depth: Depth): string {
  switch (token.type) {
    case "heading": {
      const heading = token as Tokens.Heading;
      return `<h${heading.depth}>${renderInline(heading.tokens, 0)}</h${heading.depth}>`;
    }
    case "paragraph":
      return `<p>${renderInline((token as Tokens.Paragraph).tokens, 0)}</p>`;
    case "text": {
      const text = token as Tokens.Text;
      return `<p>${text.tokens ? renderInline(text.tokens, 0) : proseLines(text.text)}</p>`;
    }
    case "code": {
      const code = token as Tokens.Code;
      if (code.lang?.trim().toLowerCase() === "math") return mathBlock(code.text);
      return codeBlock(code.text, code.lang);
    }
    case "mathBlock":
      return mathBlock((token as Tokens.Generic).text);
    case "blockquote": {
      const inner = renderBlocks((token as Tokens.Blockquote).tokens, {
        ...depth,
        quote: depth.quote + 1,
      });
      if (inner.length === 0) return "";
      if (depth.quote >= MAX_QUOTE_DEPTH) return inner.join("\n");
      return `<blockquote>\n${inner.join("\n")}\n</blockquote>`;
    }
    case "list":
      return renderList(token as Tokens.List, depth);
    case "table":
      return renderTable(token as Tokens.Table);
    case "hr":
      return "<hr/>";
    case "space":
    case "def":
      return "";
    case "html":
      return `<p>${breakLines(escapeHtml((token as Tokens.HTML).text.trim()))}</p>`;
    default:
      return rawOf(token).trim() === ""
        ? ""
        : `<p>${breakLines(escapeHtml(rawOf(token).trim()))}</p>`;
  }
}

export function codeBlock(text: string, lang?: string): string {
  const cls = lang ? ` class="language-${escapeAttribute(lang)}"` : "";
  return `<pre><code${cls}>${escapeHtml(text)}</code></pre>`;
}

function mathBlock(latex: string): string {
  return `<tg-math-block>${escapeHtml(latex.trim())}</tg-math-block>`;
}

function renderList(list: Tokens.List, depth: Depth): string {
  if (depth.list >= MAX_LIST_DEPTH) return flattenList(list);
  const inner: Depth = { ...depth, list: depth.list + 1 };
  const start = typeof list.start === "number" ? list.start : 1;
  const open = list.ordered ? (start === 1 ? "<ol>" : `<ol start="${start}">`) : "<ul>";
  const lines = [open];
  for (const item of list.items) {
    const checkbox = item.task ? `<input type="checkbox"${item.checked ? " checked" : ""}/>` : "";
    const body = renderItemBody(item.tokens, inner);
    lines.push(`<li>${checkbox}${body}</li>`);
  }
  lines.push(list.ordered ? "</ol>" : "</ul>");
  return lines.join("\n");
}

/** Tight items carry bare inline text; loose items and nested blocks carry their own tags. */
function renderItemBody(tokens: Token[], depth: Depth): string {
  const parts: string[] = [];
  for (const child of tokens) {
    if (child.type === "checkbox") continue; // carried by the <input> marker
    if (child.type === "text") {
      const text = child as Tokens.Text;
      parts.push(text.tokens ? renderInline(text.tokens, 0) : proseLines(text.text));
      continue;
    }
    const block = renderBlock(child, depth);
    if (block !== "") parts.push(block);
  }
  return parts.join("\n");
}

/** Lists past the depth cap continue as bullet lines inside the enclosing item. */
function flattenList(list: Tokens.List): string {
  const lines: string[] = [];
  const walk = (current: Tokens.List): void => {
    for (const item of current.items) {
      const text: string[] = [];
      for (const child of item.tokens) {
        if (child.type === "list") continue;
        if ("tokens" in child && Array.isArray(child.tokens)) {
          text.push(renderInline(child.tokens, 0));
        } else if (child.type !== "checkbox" && child.type !== "space") {
          text.push(breakLines(escapeHtml(rawOf(child).trim())));
        }
      }
      lines.push(`• ${text.join(" ")}`);
      for (const child of item.tokens) if (child.type === "list") walk(child as Tokens.List);
    }
  };
  walk(list);
  return `<p>${lines.join(BR)}</p>`;
}

function renderTable(table: Tokens.Table): string {
  if (table.header.length > MAX_TABLE_COLUMNS) return codeBlock(table.raw.trim());
  const cell = (tag: "th" | "td", c: Tokens.TableCell): string => {
    const align = c.align ? ` align="${c.align}"` : "";
    return `<${tag}${align}>${renderInline(c.tokens, 0)}</${tag}>`;
  };
  const lines = ["<table bordered>"];
  lines.push(`<tr>${table.header.map((c) => cell("th", c)).join("")}</tr>`);
  for (const row of table.rows) lines.push(`<tr>${row.map((c) => cell("td", c)).join("")}</tr>`);
  lines.push("</table>");
  return lines.join("\n");
}

/** Inline formatting past the depth cap keeps its text but drops its tags. */
function renderInline(tokens: Token[], depth: number): string {
  const wrap = (tag: string, inner: Token[]): string => {
    const content = renderInline(inner, depth + 1);
    return depth >= MAX_INLINE_DEPTH ? content : `<${tag}>${content}</${tag}>`;
  };
  let out = "";
  for (const token of tokens) {
    switch (token.type) {
      case "text": {
        const text = token as Tokens.Text;
        out += text.tokens ? renderInline(text.tokens, depth) : proseLines(text.text);
        break;
      }
      case "escape":
        out += escapeHtml((token as Tokens.Escape).text);
        break;
      case "strong":
        out += wrap("b", (token as Tokens.Strong).tokens);
        break;
      case "em":
        out += wrap("i", (token as Tokens.Em).tokens);
        break;
      case "del":
        out += wrap("s", (token as Tokens.Del).tokens);
        break;
      case "codespan":
        out += `<code>${escapeHtml((token as Tokens.Codespan).text)}</code>`;
        break;
      case "mathInline":
        out += `<tg-math>${escapeHtml((token as Tokens.Generic).text.replace(/\s*\n\s*/g, " "))}</tg-math>`;
        break;
      case "link": {
        const link = token as Tokens.Link;
        const href = safeHref(link.href);
        const label = renderInline(link.tokens, depth + 1);
        out +=
          href && depth < MAX_INLINE_DEPTH
            ? `<a href="${escapeAttribute(href)}">${label}</a>`
            : label;
        break;
      }
      case "image": {
        const image = token as Tokens.Image;
        const href = safeHref(image.href);
        const label = escapeHtml(image.text || image.href);
        out += href ? `<a href="${escapeAttribute(href)}">${label}</a>` : label;
        break;
      }
      case "br":
        out += BR;
        break;
      case "html":
        out += escapeHtml((token as Tokens.HTML).text);
        break;
      default:
        out += escapeHtml(rawOf(token));
    }
  }
  return out;
}

function proseLines(text: string): string {
  return breakLines(escapeProse(text));
}

function breakLines(escaped: string): string {
  return escaped.replace(/\n/g, BR);
}

function rawOf(token: Token): string {
  return "raw" in token && typeof token.raw === "string" ? token.raw : "";
}
