# Coding Rules (CODING)

Rules that machines already enforce (Biome, tsc) are not repeated here. This document
holds only what tools cannot catch.

## Architecture style — Functional Core / Imperative Shell + 3 ports + Composition Root

**A pure functional core makes every decision, a thin imperative shell performs those
decisions as I/O, and interfaces exist only at process boundaries.**

- **Pure core**: `render/*`, `commands/*` (specs, parse, help) — input → output only.
  No I/O, clocks, or randomness.
- **Shell**: `pipeline/*`, `telegram/handlers.ts`, `main.ts` — performs I/O in order
  and delegates decisions to the core. Keep it short and boring.
- **Ports (the only interfaces; faked only in tests)**:
  - `TelegramPort` (`telegram/sender.ts`) — the grammY Api subset we use
  - `GeminiPort` (`gemini/client.ts`) — generateContent
  - `Repo` (`db/repo.ts`) has no interface — tests use the real class on `:memory:`
  - **No other interfaces.** Abstraction stops where a second implementation (= a
    test fake) actually exists.
- **Composition Root**: objects are created and wired in `main.ts` only. No DI
  container or service locator; plain `Deps` argument passing. No mutable
  module-scope state.
- External SDK **runtime** stays inside adapters. Wire-format **types** (grammy/types
  `Message`, @google/genai `Part`, …) may be used anywhere.

### Layers (imports point from higher numbers to lower only; Biome fails on cycles)

```
L0  config.ts / strings.ts / log.ts
L1  db/* · render/* · commands/*
L2  gemini/client.ts · telegram/files.ts
L3  telegram/sender.ts
L4  pipeline/*
L5  telegram/handlers.ts
L6  main.ts
```

### Patterns in use (introducing anything outside this list requires a recorded decision)

Strategy-as-data (commands/specs — a new AI command is one spec entry) ·
Repository (db/repo) · Adapter (sender, client, files) · Result types (discriminated
unions — expected failures are values) · Composition Root with argument injection.

### OOP policy

Classes only where state and the behavior over it cohere (GeminiClient, FileCache,
Repo, Sender). Everything else is a plain function. **No inheritance — composition
only.** No getters/setters, empty wrappers, or single-use interfaces.

## Comments

- **English only.** Korean belongs to user-facing copy (`strings.ts` values), log
  message values, and test fixture data.
- **Minimal**: only constraints the code cannot express (invariants, ordering
  requirements, external-system traps).
- Forbidden: comments restating the code, change rationale/provenance/decision
  numbers, next-line narration.

## Errors and promises

- Users see only classified copy from `strings.ts`. Raw SDK/Error text and stacks go
  to logs only (no `API 오류: ${err.message}`-style leaks).
- Best-effort Telegram calls (reactions, deletes, edits, answerCallbackQuery, document
  re-send) log-and-continue on failure — that is the sanctioned "explicit handling".
  Everything else must not swallow errors.

## Strings

Every user-facing Korean string lives in `src/strings.ts`; never inline them in
handlers or services. docs/SPEC.md copy is canonical — do not reword. Untrusted text
(model output, user echoes) is escaped exactly once at render time.

## Logging

- pino only (`src/log.ts`); console.* is banned (Biome-enforced, log.ts excepted).
- Log errors under the `err` key — the serializer redacts `key=` query params. Never
  stringify or print error objects yourself (API-key leak path).
- Child loggers carry `{ chatId, messageId, command }`; Gemini calls add `{ model }`.
- Steady state emits one info line per handled request; flow tracing is debug.
- Dependencies report through `console.*`; `captureConsole()` in main routes those lines
  into pino as `{ source: "console" }` — they get a level and a time, but no request context.
- A rejected or truncated Gemini response is a warn line carrying `partKinds` — the
  response's part field names, which is what `response.text` would have warned about.

## No gates

No feature flags, no tuning env vars, no "might need it later" abstractions.
Constants (timeouts, retries, history depth, debounce, cache cap) are code constants.
If it is not in docs/SPEC.md, it does not get an option.

## Tests (T1–T6)

- **T1** Test behavior, not implementation: assert only on public-API inputs and
  observable outputs (return values, requests that left through ports, DB state). No
  mock-verify of internal calls/order/counts. The bar: a test that survives
  refactoring.
- **T2** Semantic in/out: calls leaving through a port are system output and fair to
  assert on. Where output itself is the contract (renderer), golden comparison is fine.
- **T3** Integration-first (Testing Trophy): the main layer assembles real modules
  (real `:memory:` DB, real renderer/pipeline) and fakes only the two ports. The pure
  core gets zero-mock unit tests.
- **T4** Sociable by default: never mock internal collaborators; fakes exist only at
  the ports.
- **T5** Test names are behavior sentences.
- **T6** Never test private functions; the urge to means the logic wants to be a pure
  function.
- Tests never touch the network. Boundary casts in test fakes are the one sanctioned
  `as` exception.

## TypeScript

- Relative imports end in `.ts`; use `import type` (verbatimModuleSyntax).
- No enum/namespace/constructor parameter properties (erasableSyntaxOnly) — use
  `as const` objects and unions.
- Do not defeat the compiler: no `any`, no evasive `as` casts (test-fake boundary
  casts excepted).
