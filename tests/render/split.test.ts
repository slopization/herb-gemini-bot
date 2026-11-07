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

const TOGGLE = "<details><summary>모두 보기</summary>";

it("a toggle cut across chunks reopens with its summary in every chunk", () => {
  const lines = Array.from({ length: 20 }, () => `<p>${"가".repeat(2000)}</p>`).join("\n");
  const chunks = splitRichHtml(
    `<p>요약</p>\n${TOGGLE}\n${lines}\n</details>\n<hr/>\n<footer>끝</footer>`,
  );

  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks[0]).toMatch(/^<p>요약<\/p>\n<details><summary>모두 보기<\/summary>\n<p>가/);
  for (const chunk of chunks) {
    expect(bytes(chunk)).toBeLessThanOrEqual(MAX_BYTES);
    expect(chunk.match(/<details><summary>모두 보기<\/summary>/g)).toHaveLength(1);
    expect(chunk.match(/<\/details>/g)).toHaveLength(1);
  }
  expect(chunks.at(-1)).toMatch(/<\/details>\n<hr\/>\n<footer>끝<\/footer>$/);
});

it("a toggle counts against the block budget, as does its reopening", () => {
  const items = Array.from({ length: 1200 }, (_, i) => `<p>${i}</p>`).join("\n");
  const chunks = splitRichHtml(`${TOGGLE}\n${items}\n</details>`);

  expect(chunks).toHaveLength(3);
  for (const chunk of chunks) {
    const blocks = chunk.match(/<(?:p|details)>/g) ?? [];
    expect(blocks.length).toBeLessThanOrEqual(MAX_BLOCKS);
  }
});

it("a body too long to share a chunk with the lead never leaves an empty toggle behind", () => {
  const body = `<p>${"가".repeat(30000)}</p>`;
  const chunks = splitRichHtml(`<p>요약</p>\n${TOGGLE}\n${body}\n</details>`);

  expect(chunks[0]).toBe("<p>요약</p>");
  for (const chunk of chunks.slice(1))
    expect(chunk).toMatch(/^<details><summary>모두 보기<\/summary><p>가/);
});

it("closing tags spilling over the budget never open a toggle with nothing inside", () => {
  for (let pad = 0; pad < 80; pad++) {
    const item = "x".repeat(MAX_BYTES - 120 + pad);
    const html = `${TOGGLE}\n<ul>\n<li>${item}</li>\n</ul>\n</details>\n<hr/>\n<footer>끝</footer>`;

    for (const chunk of splitRichHtml(html)) {
      expect(chunk).not.toMatch(/<\/summary>(?:<[^>]*>|\s)*<\/details>/);
    }
  }
});

it("a toggle whose only text is its summary is dropped", () => {
  expect(splitRichHtml(`${TOGGLE}\n</details>`)).toEqual([]);
  expect(splitRichHtml(`${TOGGLE}\n<hr/>\n</details>\n<p>끝</p>`)).toEqual(["<p>끝</p>"]);
});

const SOURCES = "<details><summary>출처 보기</summary>";

it("each toggle reopens with its own summary, and an emptied one goes without its neighbour", () => {
  const body = Array.from({ length: 20 }, () => `<p>${"가".repeat(2000)}</p>`).join("\n");
  const links = Array.from({ length: 2000 }, (_, i) => `- 링크 ${i}<br/>`).join("\n");
  const html = `${TOGGLE}\n${body}\n</details>\n<hr/>\n${SOURCES}\n<p>${links}</p>\n</details>\n<footer>토큰</footer>`;

  const chunks = splitRichHtml(html);

  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks[0]).toMatch(/^<details><summary>모두 보기<\/summary>\n<p>가/);
  expect(chunks.at(-1)).toMatch(/^<details><summary>출처 보기<\/summary><p>/);
  expect(chunks.at(-1)).toMatch(/<\/details>\n<footer>토큰<\/footer>$/);
  for (const chunk of chunks) {
    expect(bytes(chunk)).toBeLessThanOrEqual(MAX_BYTES);
    expect(chunk).not.toMatch(/<\/summary>(?:<[^>]*>|\s)*<\/details>/);
  }

  const kept = `${TOGGLE}\n<p>본문</p>\n</details>`;
  expect(splitRichHtml(`${kept}\n${SOURCES}\n</details>`)).toEqual([kept]);
});

it("a host line of numbered links cuts outside its anchors' tags", () => {
  const href = `https://r.example/${"x".repeat(200)}`;
  const anchors = Array.from({ length: 400 }, () => `<a href="${href}">1</a>`).join(" ");
  const html = `${SOURCES}\n<p>📚 <b>출처</b>:<br/>\n- github.com ${anchors}</p>\n</details>`;

  const chunks = splitRichHtml(html);

  expect(chunks.length).toBeGreaterThan(1);
  for (const chunk of chunks) {
    expect(bytes(chunk)).toBeLessThanOrEqual(MAX_BYTES);
    expect(chunk).toMatch(/^<details><summary>출처 보기<\/summary>/);
    expect(chunk).toMatch(/<\/details>$/);
  }
  const whole = chunks.flatMap((chunk) => chunk.match(/<a href="[^"]+">1<\/a>/g) ?? []);
  expect(whole).toHaveLength(400);
});
