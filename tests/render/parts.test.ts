import { Language, Outcome } from "@google/genai";
import { expect, it } from "vitest";
import { DETAILS_MARKER, renderResponseHtml } from "../../src/render/parts.ts";

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
      "<p>계산해볼게요.</p>",
      "<p><b>[코드 실행]</b></p>",
      '<pre><code class="language-python">print(1 &lt; 2)</code></pre>',
      "<p><b>[실행 결과 ✅]</b></p>",
      "<pre><code>True</code></pre>",
      "<p>결과는 <b>참</b>입니다.</p>",
    ].join("\n"),
  );
});

it("failed execution gets the ❌ label", () => {
  const html = renderResponseHtml({
    parts: [{ codeExecutionResult: { outcome: Outcome.OUTCOME_FAILED, output: "boom" } }],
  });
  expect(html).toContain("<b>[실행 결과 ❌]</b>");
});

it("queries and URI-deduped sources sit behind their own toggle", () => {
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
      "<p>본문</p>",
      "<hr/>",
      "<details><summary>출처 보기</summary>",
      "<p>🔍 <b>검색어</b>: '금리 인상', '한국은행'</p>",
      "<p>📚 <b>출처</b>:<br/>",
      '- <a href="https://a.example">기사 A</a><br/>',
      '- <a href="https://b.example">B &amp; C</a></p>',
      "</details>",
    ].join("\n"),
  );
});

it("consecutive text parts are joined into one markdown render", () => {
  const html = renderResponseHtml({ parts: [{ text: "이어지는 **문" }, { text: "장**입니다" }] });
  expect(html).toBe("<p>이어지는 <b>문장</b>입니다</p>");
});

it("token usage stays visible after the sources toggle", () => {
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
      "<p>본문</p>",
      "<hr/>",
      "<details><summary>출처 보기</summary>",
      "<p>🔍 <b>검색어</b>: 'q'</p>",
      "</details>",
      "<footer><b>토큰</b>: 입력 1,234 / 출력 56 / 생각 789 / 합계 2,079</footer>",
    ].join("\n"),
  );
});

it("token usage alone still gets the divider", () => {
  const html = renderResponseHtml({
    parts: [{ text: "본문" }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
  });
  expect(html).toBe(
    "<p>본문</p>\n<hr/>\n<footer><b>토큰</b>: 입력 10 / 출력 5 / 생각 0 / 합계 15</footer>",
  );
});

it("a footer with nothing to annotate renders as empty", () => {
  const html = renderResponseHtml({
    parts: [{ text: "", thoughtSignature: "sig" }],
    groundingMetadata: { webSearchQueries: ["q"] },
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 0, totalTokenCount: 10 },
  });
  expect(html).toBe("");
});

it("an image-only response still renders its footer", () => {
  const html = renderResponseHtml({
    parts: [{ inlineData: { mimeType: "image/png", data: "cG5n" } }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
  });
  expect(html).toBe("<hr/>\n<footer><b>토큰</b>: 입력 10 / 출력 5 / 생각 0 / 합계 15</footer>");
});

it("text before the marker stays visible and the rest folds behind a toggle", () => {
  const html = renderResponseHtml({
    parts: [{ text: `짧은 **답**입니다.\n\n${DETAILS_MARKER}\n\n## 근거\n\n- 하나\n- 둘` }],
  });

  expect(html).toBe(
    [
      "<p>짧은 <b>답</b>입니다.</p>",
      "<details><summary>모두 보기</summary>",
      "<h2>근거</h2>",
      "<ul>",
      "<li>하나</li>",
      "<li>둘</li>",
      "</ul>",
      "</details>",
    ].join("\n"),
  );
});

it("the footer stays outside the toggle", () => {
  const html = renderResponseHtml({
    parts: [{ text: `요약\n${DETAILS_MARKER}\n전문` }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
  });

  expect(html).toBe(
    [
      "<p>요약</p>",
      "<details><summary>모두 보기</summary>",
      "<p>전문</p>",
      "</details>",
      "<hr/>",
      "<footer><b>토큰</b>: 입력 10 / 출력 5 / 생각 0 / 합계 15</footer>",
    ].join("\n"),
  );
});

it("a folded reply keeps its sources in a separate toggle and its tokens visible", () => {
  const html = renderResponseHtml({
    parts: [{ text: `요약\n${DETAILS_MARKER}\n전문` }],
    groundingMetadata: {
      groundingChunks: [{ web: { uri: "https://a.example", title: "기사 A" } }],
    },
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
  });

  expect(html).toBe(
    [
      "<p>요약</p>",
      "<details><summary>모두 보기</summary>",
      "<p>전문</p>",
      "</details>",
      "<hr/>",
      "<details><summary>출처 보기</summary>",
      "<p>📚 <b>출처</b>:<br/>",
      '- <a href="https://a.example">기사 A</a></p>',
      "</details>",
      "<footer><b>토큰</b>: 입력 10 / 출력 5 / 생각 0 / 합계 15</footer>",
    ].join("\n"),
  );
});

it("grounding without any queries or sources adds no toggle", () => {
  const html = renderResponseHtml({
    parts: [{ text: "본문" }],
    groundingMetadata: { webSearchQueries: [], groundingChunks: [] },
  });
  expect(html).toBe("<p>본문</p>");
});

it("code the model ran before writing its lead folds, so the lead still comes first", () => {
  const html = renderResponseHtml({
    parts: [
      { text: "계산해볼게요." },
      { executableCode: { code: "print(6 * 7)", language: Language.PYTHON } },
      { codeExecutionResult: { outcome: Outcome.OUTCOME_OK, output: "42" } },
      { text: `답은 42입니다.\n${DETAILS_MARKER}\n곱셈 결과입니다.` },
    ],
  });

  expect(html).toBe(
    [
      "<p>답은 42입니다.</p>",
      "<details><summary>모두 보기</summary>",
      "<p>계산해볼게요.</p>",
      "<p><b>[코드 실행]</b></p>",
      '<pre><code class="language-python">print(6 * 7)</code></pre>',
      "<p><b>[실행 결과 ✅]</b></p>",
      "<pre><code>42</code></pre>",
      "<p>곱셈 결과입니다.</p>",
      "</details>",
    ].join("\n"),
  );
});

it("a marker split across text parts still folds", () => {
  const html = renderResponseHtml({
    parts: [{ text: "요약\n[[DET" }, { text: "AILS]]\n전문" }],
  });
  expect(html).toContain("<details>");
  expect(html).not.toContain("DET");
});

it("a marker with nothing after it leaves the lead without a toggle", () => {
  const html = renderResponseHtml({ parts: [{ text: `짧은 답\n${DETAILS_MARKER}\n` }] });
  expect(html).toBe("<p>짧은 답</p>");
});

it("a marker with nothing before it renders flat instead of hiding the whole reply", () => {
  const html = renderResponseHtml({ parts: [{ text: `${DETAILS_MARKER}\n전문` }] });
  expect(html).toBe("<p>전문</p>");
});

it("a repeated marker folds at the first one and never reaches the reader", () => {
  const html = renderResponseHtml({
    parts: [{ text: `요약\n${DETAILS_MARKER}\n앞\n\n${DETAILS_MARKER}\n\n뒤` }],
  });
  expect(html).toBe(
    [
      "<p>요약</p>",
      "<details><summary>모두 보기</summary>",
      "<p>앞</p>",
      "<p>뒤</p>",
      "</details>",
    ].join("\n"),
  );
});

it("a marker-only reply renders as empty", () => {
  const html = renderResponseHtml({
    parts: [{ text: DETAILS_MARKER }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
  });
  expect(html).toBe("");
});
