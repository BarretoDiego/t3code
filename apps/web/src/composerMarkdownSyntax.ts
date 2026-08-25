/**
 * Markdown syntax scanner for the prompt composer.
 *
 * The composer keeps the exact markdown the user typed. This scanner only
 * reports which character ranges deserve paint, so the prompt string, cursor
 * math, drafts, and submission all stay byte-identical to what was typed.
 *
 * It is a highlighter, not a CommonMark parser: staying cheap and stable while
 * a construct is still half-typed matters more here than matching every
 * reference-implementation edge case.
 */

export type ComposerMarkdownMark =
  | "code"
  | "bold"
  | "italic"
  | "strikethrough"
  | "heading"
  | "link-text"
  | "link-url"
  | "punctuation";

export interface ComposerMarkdownSpan {
  readonly start: number;
  readonly end: number;
  readonly marks: readonly ComposerMarkdownMark[];
}

/**
 * Past this size the scan costs more than the affordance is worth, and pasted
 * payloads that large are never being read as prose anyway.
 */
export const COMPOSER_MARKDOWN_MAX_LENGTH = 20_000;

const CODE = 1 << 0;
const BOLD = 1 << 1;
const ITALIC = 1 << 2;
const STRIKETHROUGH = 1 << 3;
const HEADING = 1 << 4;
const LINK_TEXT = 1 << 5;
const LINK_URL = 1 << 6;
const PUNCTUATION = 1 << 7;

const MARK_BITS: ReadonlyArray<readonly [ComposerMarkdownMark, number]> = [
  ["code", CODE],
  ["bold", BOLD],
  ["italic", ITALIC],
  ["strikethrough", STRIKETHROUGH],
  ["heading", HEADING],
  ["link-text", LINK_TEXT],
  ["link-url", LINK_URL],
  ["punctuation", PUNCTUATION],
];

/** Emphasis may nest, but a prompt that nests this deep is pathological. */
const MAX_INLINE_DEPTH = 4;

const FENCE_OPEN = /^[ \t]{0,3}(`{3,}|~{3,})([^`\n]*)$/;
const THEMATIC_BREAK = /^[ \t]{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const HEADING_MARKER = /^([ \t]{0,3})(#{1,6})(?:[ \t]+|$)/;
const BLOCK_QUOTE_MARKER = /^[ \t]{0,3}>+[ \t]?/;
const LIST_MARKER = /^[ \t]*(?:[-+*]|\d{1,9}[.)])(?:[ \t]+|$)/;
const LINK = /^(!?)\[([^\]\n]*)\]\(([^()\s]*)((?:[ \t]+"[^"\n]*")?)\)/;

/**
 * Scans `text` and returns the styled ranges, ordered and non-overlapping.
 * Unstyled stretches are simply absent from the result.
 */
export function scanComposerMarkdown(text: string): ComposerMarkdownSpan[] {
  if (text.length === 0 || text.length > COMPOSER_MARKDOWN_MAX_LENGTH) {
    return [];
  }
  const bits = new Uint8Array(text.length);
  paintBlocks(text, bits);
  return coalesce(bits);
}

function paintBlocks(text: string, bits: Uint8Array): void {
  let lineStart = 0;
  let openFence: { marker: string; length: number } | null = null;

  while (lineStart <= text.length) {
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    const line = text.slice(lineStart, lineEnd);

    if (openFence) {
      const closing = closingFenceLength(line, openFence);
      if (closing === null) {
        paint(bits, lineStart, 0, line.length, CODE);
      } else {
        paint(bits, lineStart, 0, line.length, CODE | PUNCTUATION);
        openFence = null;
      }
    } else {
      const fence = FENCE_OPEN.exec(line);
      if (fence) {
        const marker = fence[1] ?? "";
        const markerStart = line.indexOf(marker);
        paint(bits, lineStart, markerStart, markerStart + marker.length, CODE | PUNCTUATION);
        paint(bits, lineStart, markerStart + marker.length, line.length, CODE);
        openFence = { marker: marker[0] ?? "`", length: marker.length };
      } else {
        paintLine(line, lineStart, bits);
      }
    }

    if (newline === -1) break;
    lineStart = newline + 1;
  }
}

function closingFenceLength(
  line: string,
  openFence: { marker: string; length: number },
): number | null {
  const match = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  if (!match) return null;
  const marker = match[1] ?? "";
  if (marker[0] !== openFence.marker) return null;
  if (marker.length < openFence.length) return null;
  return marker.length;
}

function paintLine(line: string, base: number, bits: Uint8Array): void {
  if (line.length === 0) return;

  if (THEMATIC_BREAK.test(line)) {
    paint(bits, base, 0, line.length, PUNCTUATION);
    return;
  }

  const heading = HEADING_MARKER.exec(line);
  if (heading) {
    const indent = (heading[1] ?? "").length;
    const hashes = (heading[2] ?? "").length;
    paint(bits, base, indent, indent + hashes, HEADING | PUNCTUATION);
    paint(bits, base, heading[0].length, line.length, HEADING);
    paintInline(line, base, bits, heading[0].length, line.length, HEADING, 0);
    return;
  }

  let contentStart = 0;
  const quote = BLOCK_QUOTE_MARKER.exec(line);
  if (quote) {
    paint(bits, base, 0, quote[0].length, PUNCTUATION);
    contentStart = quote[0].length;
  } else {
    const list = LIST_MARKER.exec(line);
    if (list) {
      paint(bits, base, 0, list[0].length, PUNCTUATION);
      contentStart = list[0].length;
    }
  }

  paintInline(line, base, bits, contentStart, line.length, 0, 0);
}

function paintInline(
  line: string,
  base: number,
  bits: Uint8Array,
  from: number,
  to: number,
  inherited: number,
  depth: number,
): void {
  paintInlineCode(line, base, bits, from, to, inherited);
  if (depth > MAX_INLINE_DEPTH) return;
  paintInlineSpans(line, base, bits, from, to, inherited, depth);
}

/**
 * Inline code wins over every other inline construct, so it is painted first
 * and later passes treat anything already carrying `CODE` as untouchable.
 */
function paintInlineCode(
  line: string,
  base: number,
  bits: Uint8Array,
  from: number,
  to: number,
  inherited: number,
): void {
  let index = from;
  while (index < to) {
    if (line[index] !== "`") {
      index += 1;
      continue;
    }
    const openEnd = runEnd(line, index, "`", to);
    const width = openEnd - index;
    const closeStart = findRun(line, openEnd, to, "`", width);
    if (closeStart === -1) {
      index = openEnd;
      continue;
    }
    paint(bits, base, index, openEnd, inherited | CODE | PUNCTUATION);
    paint(bits, base, openEnd, closeStart, inherited | CODE);
    paint(bits, base, closeStart, closeStart + width, inherited | CODE | PUNCTUATION);
    index = closeStart + width;
  }
}

function paintInlineSpans(
  line: string,
  base: number,
  bits: Uint8Array,
  from: number,
  to: number,
  inherited: number,
  depth: number,
): void {
  let index = from;
  while (index < to) {
    if (isCode(bits, base, index)) {
      index += 1;
      continue;
    }
    const char = line[index];

    if (char === "[" || (char === "!" && line[index + 1] === "[")) {
      const consumed = paintLink(line, base, bits, index, to, inherited, depth);
      if (consumed > 0) {
        index += consumed;
        continue;
      }
    }

    if (char === "~" || char === "*" || char === "_") {
      const consumed = paintDelimited(line, base, bits, index, to, inherited, depth, char);
      if (consumed > 0) {
        index += consumed;
        continue;
      }
    }

    index += 1;
  }
}

function paintLink(
  line: string,
  base: number,
  bits: Uint8Array,
  index: number,
  to: number,
  inherited: number,
  depth: number,
): number {
  const match = LINK.exec(line.slice(index, to));
  if (!match) return 0;

  const bang = (match[1] ?? "").length;
  const label = match[2] ?? "";
  const url = match[3] ?? "";
  const title = (match[4] ?? "").length;

  const labelStart = index + bang + 1;
  const labelEnd = labelStart + label.length;
  const urlStart = labelEnd + 2;
  const urlEnd = urlStart + url.length + title;

  paint(bits, base, index, labelStart, inherited | PUNCTUATION);
  paint(bits, base, labelStart, labelEnd, inherited | LINK_TEXT);
  paint(bits, base, labelEnd, urlStart, inherited | PUNCTUATION);
  paint(bits, base, urlStart, urlEnd, inherited | LINK_URL);
  paint(bits, base, urlEnd, index + match[0].length, inherited | PUNCTUATION);

  paintInline(line, base, bits, labelStart, labelEnd, inherited | LINK_TEXT, depth + 1);
  return match[0].length;
}

/** Handles `**bold**`, `_italic_`, and `~~strikethrough~~` with one scan. */
function paintDelimited(
  line: string,
  base: number,
  bits: Uint8Array,
  index: number,
  to: number,
  inherited: number,
  depth: number,
  marker: string,
): number {
  const openEnd = runEnd(line, index, marker, to);
  const run = openEnd - index;
  const width = marker === "~" ? 2 : Math.min(run, 2);
  if (run < width) return 0;

  const openerStart = openEnd - width;
  if (!canOpen(line, openerStart, openEnd, to, marker)) return 0;

  const closeStart = findClosing(line, bits, base, openEnd, to, marker, width);
  if (closeStart === -1) return 0;

  const applied = marker === "~" ? STRIKETHROUGH : width === 2 ? BOLD : ITALIC;
  paint(bits, base, openerStart, openEnd, inherited | applied | PUNCTUATION);
  paint(bits, base, openEnd, closeStart, inherited | applied);
  paint(bits, base, closeStart, closeStart + width, inherited | applied | PUNCTUATION);

  paintInline(line, base, bits, openEnd, closeStart, inherited | applied, depth + 1);
  return closeStart + width - index;
}

function canOpen(line: string, start: number, end: number, to: number, marker: string): boolean {
  const next = end < to ? line[end] : undefined;
  if (next === undefined || isSpace(next) || next === marker) return false;
  if (marker !== "_") return true;
  const previous = start > 0 ? line[start - 1] : undefined;
  return previous === undefined || !isWordCharacter(previous);
}

function findClosing(
  line: string,
  bits: Uint8Array,
  base: number,
  from: number,
  to: number,
  marker: string,
  width: number,
): number {
  for (let index = from; index < to; index += 1) {
    if (line[index] !== marker || isCode(bits, base, index)) continue;

    const end = runEnd(line, index, marker, to);
    if (end - index < width) {
      index = end - 1;
      continue;
    }
    const previous = line[index - 1];
    if (previous === undefined || isSpace(previous)) {
      index = end - 1;
      continue;
    }
    const closeStart = end - width;
    if (closeStart < from) {
      index = end - 1;
      continue;
    }
    if (marker === "_") {
      const next = end < to ? line[end] : undefined;
      if (next !== undefined && isWordCharacter(next)) {
        index = end - 1;
        continue;
      }
    }
    return closeStart;
  }
  return -1;
}

function runEnd(line: string, start: number, marker: string, to: number): number {
  let index = start;
  while (index < to && line[index] === marker) index += 1;
  return index;
}

function findRun(line: string, from: number, to: number, marker: string, width: number): number {
  let index = from;
  while (index < to) {
    if (line[index] !== marker) {
      index += 1;
      continue;
    }
    const end = runEnd(line, index, marker, to);
    if (end - index === width) return index;
    index = end;
  }
  return -1;
}

function isCode(bits: Uint8Array, base: number, offset: number): boolean {
  return ((bits[base + offset] ?? 0) & CODE) !== 0;
}

function isSpace(char: string): boolean {
  return char === " " || char === "\t";
}

function isWordCharacter(char: string): boolean {
  return /[\p{L}\p{N}_]/u.test(char);
}

function paint(bits: Uint8Array, base: number, from: number, to: number, value: number): void {
  for (let index = base + from; index < base + to; index += 1) {
    const current = bits[index];
    if (current === undefined) break;
    bits[index] = current | value;
  }
}

const marksCache = new Map<number, readonly ComposerMarkdownMark[]>();

function marksFor(value: number): readonly ComposerMarkdownMark[] {
  const cached = marksCache.get(value);
  if (cached) return cached;
  const marks = MARK_BITS.filter(([, bit]) => (value & bit) !== 0).map(([mark]) => mark);
  marksCache.set(value, marks);
  return marks;
}

function coalesce(bits: Uint8Array): ComposerMarkdownSpan[] {
  const spans: ComposerMarkdownSpan[] = [];
  let index = 0;
  while (index < bits.length) {
    const value = bits[index] ?? 0;
    if (value === 0) {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < bits.length && bits[end] === value) end += 1;
    spans.push({ start: index, end, marks: marksFor(value) });
    index = end;
  }
  return spans;
}
