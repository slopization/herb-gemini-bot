// Telegram silently truncates rich HTML input past ~35000 UTF-8 bytes and rejects more
// than 32768 characters of text; a byte budget at the documented figure satisfies both.
export const MAX_BYTES = 32768;
// Telegram rejects more than 500 blocks; every block tag is counted, nested ones included.
export const MAX_BLOCKS = 500;

interface OpenTag {
  name: string;
  open: string;
}

const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s[^>]*?)?)(\/?)>/g;
const VOID_TAGS = new Set(["br", "hr", "input", "img"]);
const BLOCK_TAGS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "pre",
  "blockquote",
  "details",
  "ul",
  "ol",
  "li",
  "table",
  "tr",
  "hr",
  "footer",
  "tg-math-block",
]);
// A details block is invalid without its summary, so reopening one has to repeat it.
const SUMMARY_RE = /^<summary>.*?<\/summary>/;
const DETAILS_RE = /\n?<details><summary>.*?<\/summary>([\s\S]*?)<\/details>/g;

/**
 * Split finished rich HTML into sendable chunks: line-based accumulation, closing open
 * tags at each boundary and reopening them in the next chunk. Overlong single lines are
 * cut outside tags, entities and surrogate pairs.
 */
export function splitRichHtml(html: string): string[] {
  if (html.trim() === "") return [];

  const chunks: string[] = [];
  let stack: OpenTag[] = [];
  let current = "";
  let currentBytes = 0;
  let currentBlocks = 0;

  const finalize = (): void => {
    emit(chunks, current.replace(/(?:<br\/>)?\n*$/, "") + closersOf(stack));
    current = "";
    currentBytes = 0;
    currentBlocks = 0;
  };

  for (const rawLine of html.split("\n")) {
    const stackAfter = [...stack];
    scanTags(rawLine, stackAfter);
    const joinedBytes = currentBytes + (current === "" ? 0 : 1) + byteLength(rawLine);
    const joinedBlocks = currentBlocks + blocksIn(rawLine);

    if (joinedBytes + closersBytesOf(stackAfter) <= MAX_BYTES && joinedBlocks <= MAX_BLOCKS) {
      current = current === "" ? rawLine : `${current}\n${rawLine}`;
      currentBytes = joinedBytes;
      currentBlocks = joinedBlocks;
      stack = stackAfter;
      continue;
    }

    let line = rawLine;
    if (current !== "") {
      // finalize before this line and reopen the still-open tags in the next chunk
      const reopen = openersOf(stack);
      finalize();
      stack = [];
      line = reopen + line;
    }

    const rest = cutLine(line, chunks);
    current = rest.text;
    currentBytes = byteLength(current);
    currentBlocks = blocksIn(current);
    stack = rest.stack;
  }

  if (current !== "") finalize();
  return chunks;
}

/**
 * Emit an over-long line as chunks, then return the trailing piece that fits.
 * Each pass rescans only the segment it emits, so the whole line is walked a
 * bounded number of times regardless of its length.
 */
function cutLine(line: string, out: string[]): { text: string; stack: OpenTag[] } {
  const prefix = prefixBytes(line);
  let segStart = 0;
  let openers = "";
  let stack: OpenTag[] = [];

  for (;;) {
    const at = findCut(line, prefix, segStart, stack, byteLength(openers));
    if (at === undefined) break;

    const segment = line.slice(segStart, at);
    const stackAtCut = [...stack];
    scanTags(segment, stackAtCut);
    emit(out, openers + segment + closersOf(stackAtCut));

    openers = openersOf(stackAtCut);
    stack = stackAtCut;
    // openers with no room left for content would repeat on every pass, one character
    // at a time — drop the formatting instead and emit the remainder plain
    if (byteLength(openers) + closersBytesOf(stack) >= MAX_BYTES) {
      openers = "";
      stack = [];
    }
    segStart = at;
  }

  const tail = line.slice(segStart);
  const tailStack = [...stack];
  scanTags(tail, tailStack);
  return { text: openers + tail, stack: tailStack };
}

/**
 * Index at which the piece starting at `from` must be cut, or undefined when the
 * rest of the line fits. A cut never lands inside a tag and always carries at
 * least one character of content, so the caller always makes progress. A tag too
 * long to fit on its own is emitted whole, overflowing the limit rather than
 * being broken.
 */
function findCut(
  line: string,
  prefix: readonly number[],
  from: number,
  baseStack: readonly OpenTag[],
  openersBytes: number,
): number | undefined {
  const stack = [...baseStack];
  let closers = closersBytesOf(stack);
  let best = from;
  let inTag = false;
  let tagStart = 0;
  let sawContent = false;
  const bytesBetween = (start: number, end: number): number =>
    (prefix[end] ?? 0) - (prefix[start] ?? 0);

  for (let i = from; i < line.length; i++) {
    const ch = line[i];
    if (!inTag && ch === "<") {
      inTag = true;
      tagStart = i;
    } else if (inTag && ch === ">") {
      inTag = false;
      scanTags(line.slice(tagStart, i + 1), stack);
      closers = closersBytesOf(stack);
    } else if (!inTag) {
      sawContent = true;
    }
    if (inTag || !sawContent) continue;

    const at = safeBoundary(line, i + 1);
    if (at <= best) continue;
    if (openersBytes + bytesBetween(from, at) + closers <= MAX_BYTES) best = at;
    else if (best > from) return best;
    else return at;
  }

  if (openersBytes + bytesBetween(from, line.length) + closers <= MAX_BYTES) return undefined;
  return best > from ? best : undefined;
}

/**
 * Telegram rejects a message with no visible characters, so tag-only chunks are dropped.
 * A cut next to a toggle's edge can leave it empty; its summary alone is not content.
 */
function emit(out: string[], chunk: string): void {
  const kept = chunk.replace(DETAILS_RE, (block, body: string) => (hasText(body) ? block : ""));
  if (hasText(kept)) out.push(kept.trim());
}

function hasText(html: string): boolean {
  return html.replace(TAG_RE, "").trim() !== "";
}

function scanTags(fragment: string, stack: OpenTag[]): void {
  TAG_RE.lastIndex = 0;
  let match = TAG_RE.exec(fragment);
  while (match !== null) {
    const closing = match[1] === "/";
    const name = (match[2] ?? "").toLowerCase();
    const selfClosing = match[4] === "/" || VOID_TAGS.has(name);
    if (closing) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i]?.name === name) {
          stack.splice(i, 1);
          break;
        }
      }
    } else if (!selfClosing) {
      const rest = name === "details" ? fragment.slice(TAG_RE.lastIndex) : "";
      const summary = SUMMARY_RE.exec(rest)?.[0] ?? "";
      stack.push({ name, open: match[0] + summary });
      TAG_RE.lastIndex += summary.length;
    }
    match = TAG_RE.exec(fragment);
  }
}

function blocksIn(fragment: string): number {
  let count = 0;
  TAG_RE.lastIndex = 0;
  let match = TAG_RE.exec(fragment);
  while (match !== null) {
    if (match[1] !== "/" && BLOCK_TAGS.has((match[2] ?? "").toLowerCase())) count += 1;
    match = TAG_RE.exec(fragment);
  }
  return count;
}

function closersOf(stack: readonly OpenTag[]): string {
  return [...stack]
    .reverse()
    .map((t) => `</${t.name}>`)
    .join("");
}

function closersBytesOf(stack: readonly OpenTag[]): number {
  let total = 0;
  for (const tag of stack) total += tag.name.length + 3;
  return total;
}

function openersOf(stack: readonly OpenTag[]): string {
  return stack.map((t) => t.open).join("");
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** prefix[i] = UTF-8 bytes of text.slice(0, i); a surrogate half counts 2 so pairs sum to 4. */
function prefixBytes(text: string): number[] {
  const prefix = [0];
  let total = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    total += code < 0x80 ? 1 : code < 0x800 ? 2 : code >= 0xd800 && code <= 0xdfff ? 2 : 3;
    prefix.push(total);
  }
  return prefix;
}

/** Pull a cut point out of an `&...;` entity (8-char lookback) or a surrogate pair. */
function safeBoundary(line: string, at: number): number {
  let cutAt = at;
  const prev = line.charCodeAt(cutAt - 1);
  if (prev >= 0xd800 && prev <= 0xdbff) cutAt -= 1;
  for (let back = 1; back <= 8 && cutAt - back >= 0; back++) {
    const ch = line[cutAt - back];
    if (ch === ";") return cutAt;
    if (ch === "&") return cutAt - back;
  }
  return cutAt;
}
