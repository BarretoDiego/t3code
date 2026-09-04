import { $getRoot, createEditor } from "lexical";
import { describe, expect, it } from "vite-plus/test";

import { ComposerCodeBlockNode } from "./ComposerCodeBlockNode";
import { $readComposerPrompt, $setComposerEditorPrompt } from "./ComposerPromptEditor";

/** Builds the editor tree for `prompt`, then serializes it back out. */
function roundTrip(prompt: string): { prompt: string; shape: string[] } {
  const editor = createEditor({
    namespace: "composer-code-block-document-test",
    nodes: [ComposerCodeBlockNode],
    onError: (error) => {
      throw error;
    },
  });

  editor.update(
    () => {
      $setComposerEditorPrompt(prompt, [], new Map());
    },
    { discrete: true },
  );

  let result = { prompt: "", shape: [] as string[] };
  editor.getEditorState().read(() => {
    result = {
      prompt: $readComposerPrompt(),
      shape: $getRoot()
        .getChildren()
        .map((child) => child.getType()),
    };
  });
  return result;
}

describe("code block document round-trip", () => {
  const cases: Array<[string, string]> = [
    ["plain prose", "just a prompt"],
    ["block only", "```\nx\n```"],
    ["block with language", "```ts\nconst a = 1\n```"],
    ["text before", "before\n```\nx\n```"],
    ["text after", "```\nx\n```\nafter"],
    ["text on both sides", "before\n```ts\nconst a = 1\n```\nafter"],
    ["multi-line content", "```\na\nb\nc\n```"],
    ["empty block", "```\n```"],
    ["two adjacent blocks", "```\na\n```\n```\nb\n```"],
    ["blank line before a block", "text\n\n```\nx\n```"],
    ["blank line after a block", "```\nx\n```\n\ntext"],
    ["unclosed fence stays text", "```ts\nstill typing"],
  ];

  for (const [name, prompt] of cases) {
    it(`preserves the prompt exactly: ${name}`, () => {
      expect(roundTrip(prompt).prompt).toBe(prompt);
    });
  }

  it("puts the block at the root, not inside a paragraph", () => {
    expect(roundTrip("before\n```\nx\n```\nafter").shape).toEqual([
      "paragraph",
      "composer-code-block",
      "paragraph",
    ]);
  });

  it("does not emit empty paragraphs around a leading or trailing block", () => {
    expect(roundTrip("```\nx\n```").shape).toEqual(["composer-code-block"]);
  });

  it("keeps an unclosed fence inside a paragraph", () => {
    expect(roundTrip("```ts\nstill typing").shape).toEqual(["paragraph"]);
  });
});
