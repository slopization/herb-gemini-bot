import { Language, Outcome } from "@google/genai";
import { expect, it } from "vitest";
import { renderResponseHtml } from "../../src/render/parts.ts";

it("renders text, executable code, and results in order with labels", () => {
  const html = renderResponseHtml({
    parts: [
      { text: "계산해볼게요." },
      { executableCode: { code: "print(1 < 2)", language: Language.PYTHON } },
      { codeExecutionResult: { outcome: Outcome.OUTCOME_OK, output: "True" } },
      { text: "결과는 **참**입니다." },
    ],
  });

  expect(html).toBe(
    [
      "계산해볼게요.",
      "",
      '<b>[코드 실행]</b>\n<pre><code class="language-python">print(1 &lt; 2)</code></pre>',
      "",
      "<b>[실행 결과 ✅]</b>\n<pre><code>True</code></pre>",
      "",
      "결과는 <b>참</b>입니다.",
    ].join("\n"),
  );
});

it("failed execution gets the ❌ label", () => {
  const html = renderResponseHtml({
    parts: [{ codeExecutionResult: { outcome: Outcome.OUTCOME_FAILED, output: "boom" } }],
  });
  expect(html).toContain("<b>[실행 결과 ❌]</b>");
});

it("the grounding footer lists queries and URI-deduped sources", () => {
  const html = renderResponseHtml({
    parts: [{ text: "본문" }],
    groundingMetadata: {
      webSearchQueries: ["금리 인상", "한국은행"],
      groundingChunks: [
        { web: { uri: "https://a.example", title: "기사 A" } },
        { web: { uri: "https://a.example", title: "기사 A" } },
        { web: { uri: "https://b.example", title: "B & C" } },
      ],
    },
  });

  expect(html).toBe(
    [
      "본문",
      "",
      "---",
      "🔍 <b>검색어</b>: '금리 인상', '한국은행'",
      "",
      "📚 <b>출처</b>:",
      ' - <a href="https://a.example">기사 A</a>',
      ' - <a href="https://b.example">B &amp; C</a>',
    ].join("\n"),
  );
});

it("consecutive text parts are joined into one markdown render", () => {
  const html = renderResponseHtml({ parts: [{ text: "이어지는 **문" }, { text: "장**입니다" }] });
  expect(html).toBe("이어지는 <b>문장</b>입니다");
});

it("token usage closes the footer after grounding", () => {
  const html = renderResponseHtml({
    parts: [{ text: "본문" }],
    groundingMetadata: { webSearchQueries: ["q"] },
    usageMetadata: {
      promptTokenCount: 1234,
      candidatesTokenCount: 56,
      thoughtsTokenCount: 789,
      totalTokenCount: 2079,
    },
  });

  expect(html).toBe(
    [
      "본문",
      "",
      "---",
      "🔍 <b>검색어</b>: 'q'",
      "",
      "<b>토큰</b>: 입력 1,234 / 출력 56 / 생각 789 / 합계 2,079",
    ].join("\n"),
  );
});

it("token usage alone still gets the divider", () => {
  const html = renderResponseHtml({
    parts: [{ text: "본문" }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
  });
  expect(html).toBe("본문\n\n---\n\n<b>토큰</b>: 입력 10 / 출력 5 / 생각 0 / 합계 15");
});
