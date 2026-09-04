import { describe, expect, it } from "vite-plus/test";

import { findComposerCodeBlocks, serializeComposerCodeBlock } from "~/composerCodeBlocks";

/** Asserts the offsets actually carve the block back out of the prompt. */
function sliceBlocks(prompt: string): Array<{ source: string; info: string; content: string }> {
  return findComposerCodeBlocks(prompt).map((block) => ({
    source: prompt.slice(block.start, block.end),
    info: block.info,
    content: block.content,
  }));
}

describe("findComposerCodeBlocks", () => {
  it("finds nothing in plain prose", () => {
    expect(findComposerCodeBlocks("no fences here")).toEqual([]);
  });

  it("finds a closed block and its language", () => {
    expect(sliceBlocks("```ts\nconst a = 1\n```")).toEqual([
      { source: "```ts\nconst a = 1\n```", info: "ts", content: "const a = 1" },
    ]);
  });

  it("keeps multi-line content intact", () => {
    expect(sliceBlocks("```\na\nb\nc\n```")[0]?.content).toBe("a\nb\nc");
  });

  it("collapses a block holding only a blank line to an empty block", () => {
    const block = findComposerCodeBlocks("```\n\n```")[0];
    expect(block?.content).toBe("");
    expect(serializeComposerCodeBlock("", block?.content ?? "")).toBe("```\n```");
  });

  it("handles an empty block", () => {
    expect(sliceBlocks("```\n```")).toEqual([{ source: "```\n```", info: "", content: "" }]);
  });

  it("ignores an unclosed fence so half-typed input stays plain text", () => {
    expect(findComposerCodeBlocks("```ts\nstill typing")).toEqual([]);
  });

  it("requires the closing fence to match the opening marker and width", () => {
    expect(findComposerCodeBlocks("```\nbody\n~~~")).toEqual([]);
    expect(findComposerCodeBlocks("````\nbody\n```")).toEqual([]);
    expect(sliceBlocks("```\nbody\n````")[0]?.content).toBe("body");
  });

  it("finds several blocks and reports offsets that round-trip", () => {
    const prompt = "before\n```js\na\n```\nmiddle\n```\nb\n```\nafter";
    const blocks = findComposerCodeBlocks(prompt);
    expect(blocks).toHaveLength(2);
    for (const block of blocks) {
      const source = prompt.slice(block.start, block.end);
      expect(source.startsWith("```")).toBe(true);
      expect(source.endsWith("```")).toBe(true);
      // The prefix must land exactly on the content.
      expect(
        prompt.slice(
          block.start + block.prefixLength,
          block.start + block.prefixLength + block.content.length,
        ),
      ).toBe(block.content);
    }
    expect(blocks.map((block) => block.content)).toEqual(["a", "b"]);
  });

  it("treats a fence inside an open block as content, not a new block", () => {
    const blocks = findComposerCodeBlocks("```\na\n```\n```\nb\n```");
    expect(blocks.map((block) => block.content)).toEqual(["a", "b"]);
  });

  it("round-trips through the serializer", () => {
    const prompt = serializeComposerCodeBlock("ts", "const a = 1");
    const block = findComposerCodeBlocks(prompt)[0];
    expect(block?.info).toBe("ts");
    expect(block?.content).toBe("const a = 1");
    expect(prompt.slice(block?.start ?? 0, block?.end ?? 0)).toBe(prompt);
  });
});
