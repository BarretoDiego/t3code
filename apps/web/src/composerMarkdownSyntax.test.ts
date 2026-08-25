import { describe, expect, it } from "vite-plus/test";

import {
  COMPOSER_MARKDOWN_MAX_LENGTH,
  scanComposerMarkdown,
  type ComposerMarkdownMark,
} from "~/composerMarkdownSyntax";

/** Renders the scan as `text -> marks` rows so expectations read like the input. */
function describeScan(text: string): Array<[string, string]> {
  return scanComposerMarkdown(text).map((span) => [
    text.slice(span.start, span.end),
    span.marks.join("+"),
  ]);
}

function marksAt(text: string, offset: number): readonly ComposerMarkdownMark[] {
  const span = scanComposerMarkdown(text).find(
    (candidate) => candidate.start <= offset && offset < candidate.end,
  );
  return span?.marks ?? [];
}

describe("scanComposerMarkdown", () => {
  it("leaves plain prose untouched", () => {
    expect(scanComposerMarkdown("just a normal prompt")).toEqual([]);
  });

  it("marks inline code and dims its backticks", () => {
    expect(describeScan("run `npm test` now")).toEqual([
      ["`", "code+punctuation"],
      ["npm test", "code"],
      ["`", "code+punctuation"],
    ]);
  });

  it("supports multi-backtick inline code containing a backtick", () => {
    expect(describeScan("``a ` b``")).toEqual([
      ["``", "code+punctuation"],
      ["a ` b", "code"],
      ["``", "code+punctuation"],
    ]);
  });

  it("ignores an unclosed inline backtick", () => {
    expect(scanComposerMarkdown("what does ` do")).toEqual([]);
  });

  it("marks a fenced code block including its fences", () => {
    expect(describeScan("```ts\nconst a = 1\n```")).toEqual([
      ["```", "code+punctuation"],
      ["ts", "code"],
      ["const a = 1", "code"],
      ["```", "code+punctuation"],
    ]);
  });

  it("keeps highlighting a fence that is still being typed", () => {
    expect(describeScan("```\nhalf written")).toEqual([
      ["```", "code+punctuation"],
      ["half written", "code"],
    ]);
  });

  it("does not close a fence with a shorter marker or a different character", () => {
    expect(describeScan("````\nbody\n```\nstill code")).toEqual([
      ["````", "code+punctuation"],
      ["body", "code"],
      ["```", "code"],
      ["still code", "code"],
    ]);
    expect(describeScan("```\nbody\n~~~")).toEqual([
      ["```", "code+punctuation"],
      ["body", "code"],
      ["~~~", "code"],
    ]);
  });

  it("keeps markdown inside a fence inert", () => {
    expect(marksAt("```\n**not bold**\n```", 6)).toEqual(["code"]);
  });

  it("marks bold, italic, and strikethrough", () => {
    expect(describeScan("**b** _i_ ~~s~~")).toEqual([
      ["**", "bold+punctuation"],
      ["b", "bold"],
      ["**", "bold+punctuation"],
      ["_", "italic+punctuation"],
      ["i", "italic"],
      ["_", "italic+punctuation"],
      ["~~", "strikethrough+punctuation"],
      ["s", "strikethrough"],
      ["~~", "strikethrough+punctuation"],
    ]);
  });

  it("nests italic inside bold", () => {
    expect(marksAt("**bold _and_ more**", 8)).toEqual(["bold", "italic"]);
  });

  it("does not italicise snake_case identifiers", () => {
    expect(scanComposerMarkdown("call some_long_name here")).toEqual([]);
  });

  it("does not emphasise across a space-adjacent delimiter", () => {
    expect(scanComposerMarkdown("2 * 3 * 4")).toEqual([]);
  });

  it("leaves emphasis unmarked until it is closed", () => {
    expect(scanComposerMarkdown("**half typed")).toEqual([]);
  });

  it("marks headings and dims the hashes", () => {
    expect(describeScan("## Title")).toEqual([
      ["##", "heading+punctuation"],
      ["Title", "heading"],
    ]);
  });

  it("marks list and quote markers without touching their content", () => {
    expect(describeScan("- item")).toEqual([["- ", "punctuation"]]);
    expect(describeScan("1. item")).toEqual([["1. ", "punctuation"]]);
    expect(describeScan("> quoted")).toEqual([["> ", "punctuation"]]);
  });

  it("treats a leading asterisk as a list marker, not emphasis", () => {
    expect(describeScan("* one *two* three")).toEqual([
      ["* ", "punctuation"],
      ["*", "italic+punctuation"],
      ["two", "italic"],
      ["*", "italic+punctuation"],
    ]);
  });

  it("marks a thematic break", () => {
    expect(describeScan("---")).toEqual([["---", "punctuation"]]);
  });

  it("marks link text and url separately", () => {
    expect(describeScan("see [docs](https://t3.gg)")).toEqual([
      ["[", "punctuation"],
      ["docs", "link-text"],
      ["](", "punctuation"],
      ["https://t3.gg", "link-url"],
      [")", "punctuation"],
    ]);
  });

  it("marks an image link including its bang", () => {
    expect(describeScan("![alt](img.png)")).toEqual([
      ["![", "punctuation"],
      ["alt", "link-text"],
      ["](", "punctuation"],
      ["img.png", "link-url"],
      [")", "punctuation"],
    ]);
  });

  it("does not let emphasis pair with a delimiter inside inline code", () => {
    expect(describeScan("`*` a * b")).toEqual([
      ["`", "code+punctuation"],
      ["*", "code"],
      ["`", "code+punctuation"],
    ]);
  });

  it("scopes inline constructs to a single line", () => {
    expect(scanComposerMarkdown("**start\nend**")).toEqual([]);
  });

  it("returns nothing beyond the size guard", () => {
    const oversized = `\`${"a".repeat(COMPOSER_MARKDOWN_MAX_LENGTH)}\``;
    expect(scanComposerMarkdown(oversized)).toEqual([]);
  });

  it("produces ordered, non-overlapping spans", () => {
    const text = "# T\n`c` **b** [l](u)\n```\nx\n```";
    const spans = scanComposerMarkdown(text);
    for (const [index, span] of spans.entries()) {
      expect(span.start).toBeLessThan(span.end);
      const previous = spans[index - 1];
      if (previous) expect(previous.end).toBeLessThanOrEqual(span.start);
    }
  });
});
