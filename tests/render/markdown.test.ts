import { expect, it } from "vitest";
import { escapeHtml, markdownToRichHtml } from "../../src/render/markdown.ts";

it("headings keep their level", () => {
  expect(markdownToRichHtml("### 제목 *강조*")).toBe("<h3>제목 <i>강조</i></h3>");
});

it("paragraph soft breaks become line-break tags, since bare newlines collapse", () => {
  expect(markdownToRichHtml("줄1\n줄2\n\n다음 문단")).toBe(
    "<p>줄1<br/>\n줄2</p>\n<p>다음 문단</p>",
  );
});

it("raw HTML in prose is escaped as text", () => {
  expect(markdownToRichHtml("type is <div> & <span>")).toBe(
    "<p>type is &lt;div&gt; &amp; &lt;span&gt;</p>",
  );
  expect(markdownToRichHtml("<div>block</div>")).toBe("<p>&lt;div&gt;block&lt;/div&gt;</p>");
});

it("entities Telegram resolves are kept, a bare ampersand is escaped", () => {
  expect(markdownToRichHtml("a &amp; b &nbsp; c & d")).toBe("<p>a &amp; b &nbsp; c &amp; d</p>");
});

it("fenced code blocks get a language class and escaped content", () => {
  const out = markdownToRichHtml('```html\n<div class="x">&nbsp;</div>\n```');
  expect(out).toBe(
    '<pre><code class="language-html">&lt;div class="x"&gt;&amp;nbsp;&lt;/div&gt;</code></pre>',
  );
});

it("inline formatting maps to Telegram tags", () => {
  expect(markdownToRichHtml("**b** *i* ~~s~~ `c <x>` [링크](https://a.b)")).toBe(
    '<p><b>b</b> <i>i</i> <s>s</s> <code>c &lt;x&gt;</code> <a href="https://a.b">링크</a></p>',
  );
});

it("links with a scheme Telegram does not link render as their label", () => {
  expect(markdownToRichHtml("[x](javascript:alert(1)) [y](/relative)")).toBe("<p>x y</p>");
});

it("lists become real lists, one item per line, nested inside their parent item", () => {
  const out = markdownToRichHtml("- one **b**\n  - nested\n- two\n\n3. third\n4. fourth");
  expect(out).toBe(
    [
      "<ul>",
      "<li>one <b>b</b>",
      "<ul>",
      "<li>nested</li>",
      "</ul></li>",
      "<li>two</li>",
      "</ul>",
      '<ol start="3">',
      "<li>third</li>",
      "<li>fourth</li>",
      "</ol>",
    ].join("\n"),
  );
});

it("task list items carry checkboxes", () => {
  expect(markdownToRichHtml("- [x] done\n- [ ] todo")).toBe(
    [
      "<ul>",
      '<li><input type="checkbox" checked/>done</li>',
      '<li><input type="checkbox"/>todo</li>',
      "</ul>",
    ].join("\n"),
  );
});

it("lists nested past the depth cap continue as bullet lines", () => {
  const md = Array.from({ length: 8 }, (_, i) => `${"  ".repeat(i)}- d${i + 1}`).join("\n");
  const out = markdownToRichHtml(md);
  expect(out.match(/<ul>/g)).toHaveLength(6);
  expect(out).toContain("<li>d6\n<p>• d7<br/>\n• d8</p></li>");
});

it("tables become bordered tables with alignment and inline formatting", () => {
  const out = markdownToRichHtml("| a | b |\n|:--|--:|\n| **1** | `2` |");
  expect(out).toBe(
    [
      "<table bordered>",
      '<tr><th align="left">a</th><th align="right">b</th></tr>',
      '<tr><td align="left"><b>1</b></td><td align="right"><code>2</code></td></tr>',
      "</table>",
    ].join("\n"),
  );
});

it("a table wider than Telegram allows stays raw in a monospace block", () => {
  const row = (cell: string): string => `|${` ${cell} |`.repeat(21)}`;
  const md = [row("h"), `|${"---|".repeat(21)}`, row("v")].join("\n");
  expect(markdownToRichHtml(md)).toBe(`<pre><code>${md}</code></pre>`);
});

it("dollar, \\( \\), \\[ \\], and fenced math render as formulas with escaped source", () => {
  expect(markdownToRichHtml("넓이 $\\pi r^2$, 조건 \\(a<b\\)")).toBe(
    "<p>넓이 <tg-math>\\pi r^2</tg-math>, 조건 <tg-math>a&lt;b</tg-math></p>",
  );
  expect(markdownToRichHtml("$$\n\\int_0^1 x\\,dx\n$$")).toBe(
    "<tg-math-block>\\int_0^1 x\\,dx</tg-math-block>",
  );
  expect(markdownToRichHtml("\\[ E = mc^2 \\]")).toBe("<tg-math-block>E = mc^2</tg-math-block>");
  expect(markdownToRichHtml("```math\na^2+b^2\n```")).toBe(
    "<tg-math-block>a^2+b^2</tg-math-block>",
  );
});

it("currency amounts are not mistaken for formulas", () => {
  expect(markdownToRichHtml("가격은 $5 and $10, 범위 $5-$10")).toBe(
    "<p>가격은 $5 and $10, 범위 $5-$10</p>",
  );
});

it("math inside code stays code", () => {
  expect(markdownToRichHtml("`$x$`")).toBe("<p><code>$x$</code></p>");
});

it("horizontal rules and escaped characters", () => {
  expect(markdownToRichHtml("위\n\n---\n\n아래 \\* 별")).toBe("<p>위</p>\n<hr/>\n<p>아래 * 별</p>");
});

it("blockquotes nest up to the cap, deeper ones merge into the innermost", () => {
  expect(markdownToRichHtml("> 인용 <태그>")).toBe(
    "<blockquote>\n<p>인용 &lt;태그&gt;</p>\n</blockquote>",
  );
  const deep = markdownToRichHtml("> > > > 깊은 인용");
  expect(deep.match(/<blockquote>/g)).toHaveLength(3);
  expect(deep).toContain("<p>깊은 인용</p>");
});

it("inline formatting past the depth cap keeps its text without the tags", () => {
  const out = markdownToRichHtml("***~~[`x`](https://a.b)~~*** **a *b ~~c **d *e ~~f~~***~~***");
  expect(out).not.toMatch(/(<[bis]>){6}/);
  expect(out.replace(/<[^>]+>/g, "")).toBe("x a b c d e f");
});

it("escapeHtml replaces only &, <, and >", () => {
  expect(escapeHtml('<a href="x">&</a>')).toBe('&lt;a href="x"&gt;&amp;&lt;/a&gt;');
});
