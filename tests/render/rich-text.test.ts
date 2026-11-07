import type { RichMessage } from "grammy/types";
import { expect, it } from "vitest";
import { richMessageText } from "../../src/render/rich-text.ts";

it("flattens a received rich message into its display text", () => {
  // shapes as returned by sendRichMessage for rendered HTML
  const message = {
    blocks: [
      { type: "heading", text: "제목", size: 2 },
      {
        type: "paragraph",
        text: ["넓이 ", { type: "mathematical_expression", expression: "\\pi r^2" }, " 입니다"],
      },
      {
        type: "list",
        items: [
          { label: "•", blocks: [{ type: "paragraph", text: { type: "bold", text: "굵게" } }] },
          { label: "2.", blocks: [{ type: "paragraph", text: "둘" }] },
        ],
      },
      {
        type: "table",
        cells: [
          [
            { text: "a", is_header: true },
            { text: "b", is_header: true },
          ],
          [{ text: "1" }, {}],
        ],
      },
      { type: "blockquote", blocks: [{ type: "paragraph", text: "인용" }] },
      { type: "details", summary: "모두 보기", blocks: [{ type: "paragraph", text: "접힌 본문" }] },
      { type: "pre", text: "x = 1\ny = 2", language: "python" },
      { type: "mathematical_expression", expression: "E=mc^2" },
      { type: "divider" },
      { type: "footer", text: ["출처: ", { type: "url", text: "링크", url: "https://t.me/" }] },
    ],
  } as unknown as RichMessage;

  expect(richMessageText(message)).toBe(
    [
      "제목",
      "넓이 \\pi r^2 입니다",
      "• 굵게",
      "2. 둘",
      "a | b",
      "1 | ",
      "인용",
      "모두 보기",
      "접힌 본문",
      "x = 1\ny = 2",
      "E=mc^2",
      "출처: 링크",
    ].join("\n"),
  );
});
