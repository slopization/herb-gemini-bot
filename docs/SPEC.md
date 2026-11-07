# Feature Specification (SPEC)

This document is the canonical source of behavior and user-facing copy. Anything not
specified here does not get built (no gates). Every user-facing Korean string is
implemented in `src/strings.ts` and nowhere else.

## Commands

| Command | Aliases | Menu | Behavior |
|---|---|---|---|
| /start | - | ✕ | Greeting + list of menu commands (no AI call) |
| /help [cmd] | - | ○ | Listing / detail (description, aliases, params) / unknown-command notice |
| /gemini | g | ○ | pro model. Chat system prompt (`CHAT_PROMPT` in `src/commands/specs.ts`: a 1–3 sentence opening, then the full text after `[[DETAILS]]` — see Folding under Output). Tools: googleSearch + codeExecution + urlContext, thinkingBudget 32768 |
| /image [1k\|2k\|4k] | img | ○ | image model. Tools: googleSearch. imageSize sent uppercase (1K/2K/4K), default 1k. functionCall/Response parts are dropped from replayed history |
| /map | - | ○ | pro model. Chat system prompt (same as /gemini). Tools: googleSearch + googleMaps + urlContext, thinkingBudget 32768 |
| /summarize | - | ○ | pro model. GeekNews system prompt (`src/commands/summarize-prompt.ts`, verbatim) plus a rule placing `[[DETAILS]]` after the introduction, temperature 0, tools: googleSearch + urlContext + codeExecution, thinkingBudget 32768 |

- `/cmd@BotUsername` works, commands work in captions, matching is case-insensitive
  and longest-first. Commands addressed to other bots are ignored.
- Menu (setMyCommands): canonical names as primary entries, aliases registered too with
  the description `/{name}의 별칭. {description}`. Three scopes: all_private_chats,
  all_chat_administrators, all_group_chats.
- Param tokens (/image resolution): the first case-insensitive match **anywhere** in the
  text is consumed and removed from the prompt (plus one adjacent space — newlines are
  preserved). The same rule applies to explicit, implicit, and history parsing.
- The 30-minute timeout and the auto-retry limits (12 attempts, per-class windows,
  backoff) are code constants, not env.

## Conversation mechanics

- **Context = the Telegram reply chain.** No sessions, no reset. Up to 15 turns
  (including the current message); live reply_to_message objects are preferred, then DB
  copies. Turn role: `from.id === bot id → model`, otherwise user — anonymous group
  admins and other bots are `is_bot` senders but their messages are user turns.
- Model turns replay their stored Gemini parts verbatim (preserving thoughtSignature).
  Chunks of a split response resolve to the first chunk via linked_message_id
  (hops ≤ 3, cycle-safe), and a response's parts are emitted **once** per history even
  when several of its messages appear in the chain — the dedup covers parts only, so
  every member's own media is merged into the surviving turn. Model turns without stored
  parts fall back to their display text.
- **Response set**: one AI reply may span several messages — photo(s), text chunks, and
  original-quality documents. Every member carries the response's command_type, so
  **replying to any of them continues that conversation identically**.
- **Implicit continuation**: a command-less reply to a bot response re-runs that
  response's command_type. `summarize → gemini` remap (the summary prompt and
  temperature 0 do not apply to follow-ups; the chat system prompt does). Replies to
  `error` messages and to meta-less bot messages (/start and /help output) do nothing.
  Any other command-less text gets no response, DMs included.
- **validate** (explicit commands only; implicit always passes): when there is neither
  media nor text —
  replying to a bot response: "봇의 응답이나 다른 명령어에는 내용을 입력하여 답장해야 합니다." /
  replying to a human message: passes (that message becomes the prompt) /
  standalone: "명령어와 함께 프롬프트를 입력하거나, 내용이 있는 메시지에 답장하며 사용해주세요."
  Both are plain replies with no retry button.

## Input

- Text/captions, photos (largest variant), documents. Voice, audio, video etc. are
  unsupported.
- **Albums**: collected with a 500ms debounce, sorted by message_id, the first
  captioned message is the driver, and **all member photos go into one request**.
  Members are logged individually on arrival, so history and retries expand the album
  from the DB.
- Files are sent as inline base64. MIME: Telegram-provided mime_type → photo default
  (image/jpeg) → extension map → application/octet-stream. A file (file_unique_id) is
  attached once across the whole history. Over 100MiB total:
  "총 파일 용량이 100MB를 초과할 수 없습니다. (NMB)". The download cache is a 64MiB
  byte-capped LRU.

## Retry (🔄) and progress

- AI error messages carry a `🔄 재시도` button (`retry_{original user message id}`).
- Flow: duplicate press → toast "이미 재처리가 진행 중입니다." → load the original from
  the DB (missing → alert "원본 메시지를 찾을 수 없습니다.") → edit to
  "⏳ 재시도 중입니다..." → re-run → on success delete the placeholder / on failure
  re-edit it to the error with the button.
- Non-retry callbacks are still answered (spinner prevention). Unauthorized callbacks
  get complete silence.
- Progress: a 👍 reaction on the user's message while working, cleared in finally.

## Output

- AI replies are **rich messages** (`sendRichMessage`, rich HTML); system replies (/start,
  /help, validation copy, error classes) stay plain or HTML parse_mode messages. Markdown
  converts including block elements: headings → `<h1>`–`<h6>`, lists → `<ul>`/`<ol>`
  (nested, `start` kept, task items get checkboxes; nesting past 6 levels continues as
  `• ` lines), fenced code → `<pre><code class="language-…">`, blockquote (nesting past 3
  levels merges), tables → bordered `<table>` with column alignment (wider than 20
  columns → raw `<pre>`), hr → `<hr/>`. Math: `$…$`, `\(…\)` → `<tg-math>`; `$$…$$`,
  `\[…\]`, ```` ```math ```` → `<tg-math-block>`; a `$` followed by a space, or closed by
  a `$` that is preceded by a space or followed by a digit, is a currency amount, not math.
  Soft line breaks become `<br/>` (bare newlines collapse in rich HTML). Inline
  formatting past 5 levels keeps its text without the tags. Raw HTML from the model is
  shown as text. All untrusted text (model output, user echoes) is HTML-escaped exactly
  once.
- Folding: the system prompt (/gemini, /map, /summarize) has the model open with a 1–3
  sentence answer and write `[[DETAILS]]` on its own line before the full text — one
  request, no second model call. The text before the first marker stays visible; every
  other part, code execution included, goes into `<details><summary>모두 보기</summary>`.
  The closing blocks stay outside this toggle. No marker, nothing before it, or nothing
  after it → no toggle. Stored model parts keep the marker, so history shows the model its own
  format.
- Parts assembly: text + `[코드 실행]`/`[실행 결과 ✅|❌]`-labeled pre blocks + closing
  blocks: an `<hr/>` divider, then `<details><summary>출처 보기</summary>` holding one
  paragraph each for `🔍 검색어: 'q1', 'q2'` and `📚 출처:` with one `- ` line per host
  (the chunk title, in first-seen order; URIs deduped) — a host with one URI links its name
  (`- example.org`), a host with several keeps its name plain and links numbers after it
  (`- github.com 1 2 3`) — omitted when the response carries neither, then one always-visible
  `<footer>` block with `토큰: 입력 N / 출력 N / 생각 N / 합계 N` (from usageMetadata; omitted
  when the response carries none). This applies with or without the `모두 보기` toggle.
- Splitting: at most 32768 UTF-8 bytes of HTML and 500 block tags (nested ones counted)
  per message, line-based (each block, list item, and table row is its own line), open
  tags closed at boundaries and reopened in the next chunk; overlong single lines are
  force-cut outside tags, entities, and surrogate pairs. Telegram silently truncates rich
  HTML past ~35000 bytes, which is why the budget is in bytes. A toggle cut across chunks
  reopens with its summary, and one left empty by a cut is dropped. The first chunk
  replies to the user message (or to the first image); later chunks chain to the
  previous one.
- History: a bot message without stored parts falls back to the plain text of its rich
  message.
- Generated images: photo (one) / mediaGroup (several), without a caption — the text
  follows as rich messages replying to the first image — plus an
  **original-quality document re-send** (replying to the first response message;
  multiple images become one document mediaGroup named image.png / image_N.png). A
  failed document re-send does not affect the main reply.
- Best-effort calls (reactions, placeholder delete, edits, answerCallbackQuery,
  document re-send) log-and-continue on failure — they must never surface as
  "오류가 발생했습니다.".

## Authorization and logging

- Whitelist: TRUSTED_USER_IDS (users) OR ALLOWED_CHANNEL_IDS (chats). Unauthorized
  messages and callbacks get **complete silence and are not stored**. Exception: an
  unauthorized original that an authorized user replies to is backfilled (one hop).
- Authorized inbound messages and all outbound messages are stored as full JSON — the
  source for history reconstruction.

## Error classes (canonical copy)

| Case | Copy | Button | Auto-retry |
|---|---|---|---|
| promptFeedback.blockReason | `프롬프트 차단됨: {reason}` | ○ | ✕ |
| SAFETY / PROHIBITED_CONTENT | `생성된 내용이 안전 정책에 의해 차단되었습니다.` | ○ | ✕ |
| MALFORMED_FUNCTION_CALL | `함수 호출 오류입니다.` | ○ | ✕ |
| Empty response | `응답에 데이터가 없습니다.` | ○ | ✕ |
| 503 / overloaded | `현재 AI 모델의 접속량이 많아 처리가 지연되고 있습니다. 잠시 후 다시 시도해주세요. (503)` | ○ | ○ 2-min window |
| 429 | `요청 한도를 초과했습니다. 잠시 후 다시 시도해주세요. (429)` | ○ | ○ 2-min window; the retryDelay hint is the minimum wait |
| 500/502/504/fetch failed | (when exhausted) `API 오류가 발생했습니다.` | ○ | ○ 15 s window |
| Timeout (fresh signal per attempt) | `AI 응답 대기 시간이 초과되었습니다. (Timeout)` | ○ | ✕ |
| Other API error | `API 오류가 발생했습니다.` (raw SDK text goes to logs only) | ○ | ✕ |
| Pipeline exception | `오류가 발생했습니다.` | ○ | ✕ |
| Over 100MiB / no valid prompt | copy above / `프롬프트로 삼을 유효한 메시지가 없습니다.` | ✕ | ✕ |

At most 12 attempts; the wait is 1, 2, 4, 8, 10, 10, … s (1s·2ⁿ⁻¹ capped at 10s). A
window opens at the first failure; no new attempt starts once the attempt cap is
reached or elapsed + next wait exceeds the latest error's window. Retrying stops on
shutdown.

Exhausted retries keep their class copy. Requests aborted by shutdown (SIGTERM) get no
error reply.

## Database

- Fixed path `./telegram_log.db` (not env), WAL. Four tables: messages (full JSON,
  media_group_id as a real column + partial index), attachments (file_unique_id dedup),
  message_attachments, message_meta (command_type, model_parts, linked_message_id).
- Schema changes go only through the user_version array in `src/db/database.ts`.
- Legacy (old-schema) conversion is a **manual one-off**: stop the old bot →
  `sqlite3 telegram_log.db < scripts/migrate-legacy.sql` → start the new bot. Single
  transaction: a failure leaves the original untouched. The script can be deleted
  after the production cutover.
