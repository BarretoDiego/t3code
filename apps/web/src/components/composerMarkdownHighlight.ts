import {
  $getRoot,
  $isElementNode,
  $isLineBreakNode,
  $isTextNode,
  ParagraphNode,
  TextNode,
  type ElementNode,
  type LexicalEditor,
  type TextFormatType,
} from "lexical";

import { $isComposerCodeBlockNode } from "./ComposerCodeBlockNode";
import {
  scanComposerMarkdown,
  type ComposerMarkdownMark,
  type ComposerMarkdownSpan,
} from "~/composerMarkdownSyntax";

/**
 * Paints markdown syntax inside the prompt composer while the user types.
 *
 * The paint rides on Lexical text formats rather than an overlay, so it lives
 * in the same layout pass as the mention/skill chips instead of fighting them
 * for position. Node text is never rewritten: the prompt the user sees is the
 * prompt that gets submitted.
 */

/** Chips collapse to opaque filler so a path like `a_b_c` cannot read as emphasis. */
const INLINE_TOKEN_PLACEHOLDER = "￼";

const MUTED_STYLE = "color:var(--color-muted-foreground)";

/**
 * The composer runs on PlainTextPlugin and exposes no formatting commands, so
 * these five formats belong entirely to the highlighter.
 */
const MANAGED_FORMATS = [
  "bold",
  "italic",
  "strikethrough",
  "underline",
  "code",
] as const satisfies readonly TextFormatType[];

const FORMAT_BITS: Readonly<Record<(typeof MANAGED_FORMATS)[number], number>> = {
  bold: 1 << 0,
  italic: 1 << 1,
  strikethrough: 1 << 2,
  underline: 1 << 3,
  code: 1 << 4,
};

interface HighlightStyle {
  readonly formats: number;
  readonly style: string;
}

/**
 * Styles are interned so equality is a reference check. That matters: distinct
 * marks can land on the same paint (a link url and a delimiter are both just
 * muted), and splitting there would fight Lexical's own merging of adjacent
 * identical text nodes forever.
 */
const styleCache = new Map<string, HighlightStyle>();

function canonicalStyle(formats: number, style: string): HighlightStyle {
  const key = `${formats}|${style}`;
  const cached = styleCache.get(key);
  if (cached) return cached;
  const value: HighlightStyle = { formats, style };
  styleCache.set(key, value);
  return value;
}

const PLAIN = canonicalStyle(0, "");

interface TextEntry {
  readonly node: TextNode;
  readonly start: number;
}

/**
 * Registers the highlighter. The text transform covers typing; the paragraph
 * transform covers structural rewrites (controlled updates, chip insertion)
 * where the text can be unchanged while every node is brand new.
 */
export function registerComposerMarkdownHighlight(editor: LexicalEditor): () => void {
  const unregisterText = editor.registerNodeTransform(TextNode, () => {
    $highlight(editor, false);
  });
  const unregisterParagraph = editor.registerNodeTransform(ParagraphNode, () => {
    $highlight(editor, true);
  });
  return () => {
    unregisterText();
    unregisterParagraph();
  };
}

/**
 * Paints the current document immediately. Needed on mount, because the
 * initial editor state is built before any transform is registered.
 */
export function $highlightComposerMarkdown(editor: LexicalEditor): void {
  $highlight(editor, true);
}

/**
 * Each pass repaints the whole document, so re-entrant transform rounds can be
 * skipped whenever the text is untouched. Keyed per editor because the
 * appearance settings preview mounts a second composer.
 */
const appliedText = new WeakMap<LexicalEditor, string>();

function $highlight(editor: LexicalEditor, force: boolean): void {
  const { text, entries } = collectComposerText($getRoot());
  if (!force && appliedText.get(editor) === text) return;
  appliedText.set(editor, text);
  if (entries.length === 0) return;

  const spans = spansFor(text);
  let spanIndex = 0;
  for (const entry of entries) {
    const end = entry.start + entry.node.getTextContentSize();
    if (end === entry.start) continue;
    while (spanIndex < spans.length && (spans[spanIndex]?.end ?? 0) <= entry.start) {
      spanIndex += 1;
    }
    $applyToNode(entry.node, entry.start, end, spans, spanIndex);
  }
}

/**
 * Walks the editor in document order, building the string the scanner sees
 * alongside the text nodes that string maps onto. Offsets stay consistent
 * because both come from the same walk.
 */
function collectComposerText(root: ElementNode): { text: string; entries: TextEntry[] } {
  const entries: TextEntry[] = [];
  let text = "";

  const visit = (element: ElementNode): void => {
    for (const child of element.getChildren()) {
      if ($isTextNode(child)) {
        entries.push({ node: child, start: text.length });
        text += child.getTextContent();
        continue;
      }
      if ($isLineBreakNode(child)) {
        text += "\n";
        continue;
      }
      if ($isComposerCodeBlockNode(child)) {
        // Everything inside a block is code; markdown there is literal.
        if (text.length > 0) text += "\n";
        text += INLINE_TOKEN_PLACEHOLDER.repeat(child.getChildren().length > 0 ? 1 : 0);
        continue;
      }
      if ($isElementNode(child)) {
        if (text.length > 0) text += "\n";
        visit(child);
        continue;
      }
      text += INLINE_TOKEN_PLACEHOLDER.repeat(child.getTextContentSize());
    }
  };

  visit(root);
  return { text, entries };
}

function $applyToNode(
  node: TextNode,
  start: number,
  end: number,
  spans: readonly ComposerMarkdownSpan[],
  fromIndex: number,
): void {
  const segments = segmentsForRange(start, end, spans, fromIndex);

  if (segments.length <= 1) {
    applyStyle(node, segments[0]?.style ?? PLAIN);
    return;
  }

  const cuts = segments
    .slice(1)
    .map((segment) => segment.offset)
    .filter((offset) => offset > 0 && offset < end - start);
  if (cuts.length === 0) {
    applyStyle(node, segments[0]?.style ?? PLAIN);
    return;
  }

  const parts = node.splitText(...cuts);
  for (const [index, segment] of segments.entries()) {
    const part = parts[index];
    if (part) applyStyle(part, segment.style);
  }
}

interface HighlightSegment {
  /** Offset relative to the node's own text. */
  readonly offset: number;
  readonly style: HighlightStyle;
}

function segmentsForRange(
  start: number,
  end: number,
  spans: readonly ComposerMarkdownSpan[],
  fromIndex: number,
): HighlightSegment[] {
  const segments: HighlightSegment[] = [];
  let cursor = start;
  let index = fromIndex;

  const push = (offset: number, style: HighlightStyle): void => {
    if (segments.at(-1)?.style === style) return;
    segments.push({ offset: offset - start, style });
  };

  while (cursor < end) {
    const span = spans[index];
    if (!span || span.start >= end) {
      push(cursor, PLAIN);
      break;
    }
    if (span.start > cursor) {
      push(cursor, PLAIN);
      cursor = span.start;
    }
    push(cursor, styleForMarks(span.marks));
    cursor = Math.min(span.end, end);
    index += 1;
  }

  return segments;
}

/**
 * Only writes when the value actually differs. Transforms re-run for as long as
 * they keep marking nodes dirty, so an unconditional write would never settle.
 */
function applyStyle(node: TextNode, style: HighlightStyle): void {
  if (!node.isAttached()) return;
  for (const format of MANAGED_FORMATS) {
    const wanted = (style.formats & FORMAT_BITS[format]) !== 0;
    if (node.hasFormat(format) !== wanted) node.toggleFormat(format);
  }
  if (node.getStyle() !== style.style) node.setStyle(style.style);
}

const markStyleCache = new Map<string, HighlightStyle>();

function styleForMarks(marks: readonly ComposerMarkdownMark[]): HighlightStyle {
  const key = marks.join("+");
  const cached = markStyleCache.get(key);
  if (cached) return cached;

  let formats = 0;
  let muted = false;
  for (const mark of marks) {
    switch (mark) {
      case "code":
        formats |= FORMAT_BITS.code;
        break;
      case "bold":
      case "heading":
        formats |= FORMAT_BITS.bold;
        break;
      case "italic":
        formats |= FORMAT_BITS.italic;
        break;
      case "strikethrough":
        formats |= FORMAT_BITS.strikethrough;
        break;
      case "link-text":
        formats |= FORMAT_BITS.underline;
        break;
      case "link-url":
      case "punctuation":
        muted = true;
        break;
    }
  }

  const style = canonicalStyle(formats, muted ? MUTED_STYLE : "");
  markStyleCache.set(key, style);
  return style;
}

let cachedText: string | null = null;
let cachedSpans: readonly ComposerMarkdownSpan[] = [];

function spansFor(text: string): readonly ComposerMarkdownSpan[] {
  if (cachedText !== text) {
    cachedText = text;
    cachedSpans = scanComposerMarkdown(text);
  }
  return cachedSpans;
}
