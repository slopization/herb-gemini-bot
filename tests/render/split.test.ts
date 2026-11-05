import { expect, it } from "vitest";
import { MAX_BLOCKS, MAX_BYTES, splitRichHtml } from "../../src/render/split.ts";

const bytes = (text: string): number => Buffer.byteLength(text, "utf8");

it("a document within the limits stays one chunk", () => {
  expect(splitRichHtml("<p>hello</p>\n<p>world</p>")).toEqual(["<p>hello</p>\n<p>world</p>"]);
});

it("an empty or tag-only document yields no chunks", () => {
  expect(splitRichHtml("  \n ")).toEqual([]);
  expect(splitRichHtml("<hr/>")).toEqual([]);
});

it("chunks are budgeted in UTF-8 bytes, so Korean splits sooner than ASCII", () => {
  const ascii = Array.from({ length: 10 }, () => `<p>${"x".repeat(3000)}</p>`).join("\n");
  const korean = Array.from({ length: 10 }, () => `<p>${"가".repeat(3000)}</p>`).join("\n");

  expect(splitRichHtml(ascii)).toHaveLength(1);
  const chunks = splitRichHtml(korean);
  expect(chunks.length).toBeGreaterThan(1);
  for (const chunk of chunks) expect(bytes(chunk)).toBeLessThanOrEqual(MAX_BYTES);
  expect(chunks.join("\n")).toBe(korean);
});

it("chunks never exceed the block budget", () => {
  const html = Array.from({ length: MAX_BLOCKS + 10 }, (_, i) => `<p>${i}</p>`).join("\n");
  const chunks = splitRichHtml(html);
  expect(chunks).toHaveLength(2);
  expect(chunks[0]?.match(/<p>/g)).toHaveLength(MAX_BLOCKS);
});

it("a list cut between items is closed and reopened, nested items counted as blocks", () => {
  const items = Array.from({ length: 600 }, (_, i) => `<li>${i}</li>`).join("\n");
  const chunks = splitRichHtml(`<ul>\n${items}\n</ul>`);

  expect(chunks).toHaveLength(2);
  expect(chunks[0]).toMatch(/^<ul>\n<li>0<\/li>/);
  expect(chunks[0]).toMatch(/<li>498<\/li><\/ul>$/);
  expect(chunks[1]).toMatch(/^<ul><li>499<\/li>/);
  expect(chunks[1]).toMatch(/<li>599<\/li>\n<\/ul>$/);
});

it("a <pre><code> spanning chunks is closed and reopened", () => {
  const codeLines = Array.from({ length: 3000 }, (_, i) => `line ${i} of code`).join("\n");
  const chunks = splitRichHtml(`<pre><code class="language-python">${codeLines}</code></pre>`);

  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks[0]).toMatch(/<\/code><\/pre>$/);
  expect(chunks[1]).toMatch(/^<pre><code class="language-python">/);
});

it("a chunk cut after a line break does not end on a dangling break", () => {
  const lines = Array.from({ length: 30 }, () => "가".repeat(1000)).join("<br/>\n");
  const chunks = splitRichHtml(`<p>${lines}</p>`);

  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks[0]).toMatch(/가<\/p>$/);
  expect(chunks[1]).toMatch(/^<p>가/);
});

it("self-closing tags are not treated as open tags", () => {
  const html = `<p>a<br/>\nb</p>\n<hr/>\n<ul>\n<li><input type="checkbox" checked/>x</li>\n</ul>`;
  expect(splitRichHtml(html)).toEqual([html]);
});

it("an overlong single line is force-cut outside tags", () => {
  const html = `<p><b>${"가".repeat(30000)}</b></p>`;
  const chunks = splitRichHtml(html);

  expect(chunks.length).toBeGreaterThan(1);
  for (const chunk of chunks) {
    expect(bytes(chunk)).toBeLessThanOrEqual(MAX_BYTES);
    expect(chunk).toMatch(/^<p><b>가/);
    expect(chunk).toMatch(/가<\/b><\/p>$/);
  }
});

it("force-cutting never splits an HTML entity or a surrogate pair", () => {
  const unit = "aa&amp;😀";
  const html = unit.repeat(5000);
  const chunks = splitRichHtml(html);

  expect(chunks.length).toBeGreaterThan(1);
  for (const chunk of chunks) {
    expect(chunk).not.toMatch(/&a?m?p?$/);
    expect(chunk).not.toMatch(/[\uD800-\uDBFF]$/);
    expect(bytes(chunk)).toBeLessThanOrEqual(MAX_BYTES);
  }
  expect(chunks.join("")).toBe(html);
});
