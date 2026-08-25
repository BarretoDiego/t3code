import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isTextNode,
  createEditor,
  DecoratorNode,
  type TextFormatType,
} from "lexical";
import { describe, expect, it } from "vite-plus/test";

import { registerComposerMarkdownHighlight } from "./composerMarkdownHighlight";

/** Stands in for the mention/skill/terminal chips: opaque, but carries text. */
class TestChipNode extends DecoratorNode<null> {
  __text: string;

  static override getType(): string {
    return "test-chip";
  }

  static override clone(node: TestChipNode): TestChipNode {
    return new TestChipNode(node.__text, node.__key);
  }

  constructor(text = "", key?: string) {
    super(key);
    this.__text = text;
  }

  override createDOM(): HTMLElement {
    return document.createElement("span");
  }

  override updateDOM(): false {
    return false;
  }

  override getTextContent(): string {
    return this.__text;
  }

  override isInline(): true {
    return true;
  }

  override decorate(): null {
    return null;
  }
}

const FORMATS = ["bold", "italic", "strikethrough", "underline", "code"] as const;

interface PaintedNode {
  readonly text: string;
  readonly formats: string;
  readonly muted: boolean;
}

/**
 * Runs the real transform against a headless editor seeded with `text`, then
 * reports the painted text nodes in document order.
 */
function paint(text: string): { text: string; nodes: PaintedNode[] } {
  const editor = createEditor({
    namespace: "composer-markdown-highlight-test",
    onError: (error) => {
      throw error;
    },
  });
  const unregister = registerComposerMarkdownHighlight(editor);

  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      const paragraph = $createParagraphNode();
      root.append(paragraph);
      for (const [index, line] of text.split("\n").entries()) {
        if (index > 0) paragraph.append($createLineBreakNode());
        if (line.length > 0) paragraph.append($createTextNode(line));
      }
    },
    { discrete: true },
  );

  let result: { text: string; nodes: PaintedNode[] } = { text: "", nodes: [] };
  editor.getEditorState().read(() => {
    const root = $getRoot();
    const nodes: PaintedNode[] = [];
    for (const node of root.getAllTextNodes()) {
      if (!$isTextNode(node)) continue;
      nodes.push({
        text: node.getTextContent(),
        formats: FORMATS.filter((format) => node.hasFormat(format as TextFormatType)).join("+"),
        muted: node.getStyle().includes("muted-foreground"),
      });
    }
    result = { text: root.getTextContent(), nodes };
  });

  unregister();
  return result;
}

describe("registerComposerMarkdownHighlight", () => {
  it("never rewrites the prompt text", () => {
    const prompt = "fix `foo()` in **bar**\n```ts\nconst a = 1\n```\n- [x](y)";
    expect(paint(prompt).text).toBe(prompt);
  });

  it("paints inline code and dims its backticks", () => {
    expect(paint("run `npm test` now").nodes).toEqual([
      { text: "run ", formats: "", muted: false },
      { text: "`", formats: "code", muted: true },
      { text: "npm test", formats: "code", muted: false },
      { text: "`", formats: "code", muted: true },
      { text: " now", formats: "", muted: false },
    ]);
  });

  it("paints a fenced block across line breaks", () => {
    expect(paint("```ts\nconst a = 1\n```").nodes).toEqual([
      { text: "```", formats: "code", muted: true },
      { text: "ts", formats: "code", muted: false },
      { text: "const a = 1", formats: "code", muted: false },
      { text: "```", formats: "code", muted: true },
    ]);
  });

  it("paints emphasis and combines nested formats", () => {
    expect(paint("**bold _and_ more**").nodes).toEqual([
      { text: "**", formats: "bold", muted: true },
      { text: "bold ", formats: "bold", muted: false },
      { text: "_", formats: "bold+italic", muted: true },
      { text: "and", formats: "bold+italic", muted: false },
      { text: "_", formats: "bold+italic", muted: true },
      { text: " more", formats: "bold", muted: false },
      { text: "**", formats: "bold", muted: true },
    ]);
  });

  it("leaves plain prose as a single unstyled node", () => {
    expect(paint("just a normal prompt").nodes).toEqual([
      { text: "just a normal prompt", formats: "", muted: false },
    ]);
  });

  it("treats chips as opaque so their paths cannot read as markdown", () => {
    const editor = createEditor({
      namespace: "composer-markdown-highlight-chip-test",
      nodes: [TestChipNode],
      onError: (error) => {
        throw error;
      },
    });
    const unregister = registerComposerMarkdownHighlight(editor);

    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        paragraph.append($createTextNode("see "));
        paragraph.append(new TestChipNode("@src/_a_/b_c.ts"));
        paragraph.append($createTextNode(" and `run` it"));
        $getRoot().clear().append(paragraph);
      },
      { discrete: true },
    );

    const nodes: PaintedNode[] = [];
    editor.getEditorState().read(() => {
      for (const node of $getRoot().getAllTextNodes()) {
        nodes.push({
          text: node.getTextContent(),
          formats: FORMATS.filter((format) => node.hasFormat(format as TextFormatType)).join("+"),
          muted: node.getStyle().includes("muted-foreground"),
        });
      }
    });

    // The chip's underscores stay inert, and offsets past it stay aligned so
    // the inline code after it still lands on the right characters.
    expect(nodes).toEqual([
      { text: "see ", formats: "", muted: false },
      { text: " and ", formats: "", muted: false },
      { text: "`", formats: "code", muted: true },
      { text: "run", formats: "code", muted: false },
      { text: "`", formats: "code", muted: true },
      { text: " it", formats: "", muted: false },
    ]);

    unregister();
  });

  it("repaints when a construct is completed and again when it is undone", () => {
    const editor = createEditor({
      namespace: "composer-markdown-highlight-edit-test",
      onError: (error) => {
        throw error;
      },
    });
    const unregister = registerComposerMarkdownHighlight(editor);

    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        paragraph.append($createTextNode("a `b"));
        $getRoot().clear().append(paragraph);
      },
      { discrete: true },
    );

    const readCodeNodeCount = (): number => {
      let count = 0;
      editor.getEditorState().read(() => {
        count = $getRoot()
          .getAllTextNodes()
          .filter((node) => node.hasFormat("code")).length;
      });
      return count;
    };

    expect(readCodeNodeCount()).toBe(0);

    // Close the span: the whole run should light up.
    editor.update(
      () => {
        const last = $getRoot().getAllTextNodes().at(-1);
        last?.setTextContent("a `b`");
      },
      { discrete: true },
    );
    expect(readCodeNodeCount()).toBeGreaterThan(0);

    // Remove the closing backtick again: the paint has to come back off.
    editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        const paragraph = $createParagraphNode();
        paragraph.append($createTextNode("a `b"));
        root.append(paragraph);
      },
      { discrete: true },
    );
    expect(readCodeNodeCount()).toBe(0);

    unregister();
  });
});
