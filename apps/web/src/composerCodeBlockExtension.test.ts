import { getSchema, type JSONContent } from "@tiptap/core";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vite-plus/test";

import {
  ComposerCodeBlockExtension,
  exitComposerCodeBlock,
  handleComposerCodeBlockKey,
} from "./composerCodeBlockExtension";
import {
  buildDocJson,
  flatToCollapsed,
  flatToMarkdown,
  flatToPm,
  pmToFlat,
  serializeEditorDoc,
} from "./composer-rich-text-doc";

const schema = getSchema([
  StarterKit.configure({ codeBlock: false, trailingNode: false }),
  ComposerCodeBlockExtension,
]);

function harness(prompt: string, cursor = 1) {
  const doc = schema.nodeFromJSON(
    buildDocJson(prompt, (name) => ({ label: name, description: null })),
  );
  let state = EditorState.create({ doc, selection: TextSelection.create(doc, cursor) });
  const dispatch = (transaction: Parameters<typeof state.apply>[0]) => {
    state = state.apply(transaction);
  };
  return {
    get state() {
      return state;
    },
    dispatch,
    key(key: string, options: Partial<KeyboardEvent> = {}, atBottom = true) {
      return handleComposerCodeBlockKey(
        state,
        {
          key,
          shiftKey: false,
          metaKey: false,
          ctrlKey: false,
          altKey: false,
          isComposing: false,
          ...options,
        },
        dispatch,
        atBottom,
      );
    },
    get prompt() {
      return serializeEditorDoc(state.doc).value;
    },
  };
}

describe("editable composer code blocks", () => {
  it("turns a typed opening fence into an empty editable block on Enter", () => {
    const editor = harness("");
    editor.dispatch(editor.state.tr.insertText("```ts"));
    expect(editor.key("Enter")).toBe(true);
    expect(editor.state.selection.$from.parent.type.name).toBe("codeBlock");
    expect(editor.state.doc.textContent).toBe("");
    expect(editor.prompt).toBe("```ts\n```");
  });

  it("also converts an opening fence on Shift+Enter", () => {
    const editor = harness("");
    editor.dispatch(editor.state.tr.insertText("```json"));
    expect(editor.key("Enter", { shiftKey: true })).toBe(true);
    expect(editor.state.selection.$from.parent.type.name).toBe("codeBlock");
  });

  it("creates a paragraph below the last block when ArrowDown exits", () => {
    const editor = harness("```ts\nconst x = 1;\n```", 13);
    expect(editor.key("ArrowDown")).toBe(true);
    expect(editor.state.doc.childCount).toBe(2);
    expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
    editor.dispatch(editor.state.tr.insertText("after"));
    expect(editor.prompt).toBe("```ts\nconst x = 1;\n```\nafter");
  });

  it("moves into the existing paragraph without creating extra blank lines", () => {
    const editor = harness("```\nx\n```\nafter", 2);
    expect(editor.key("ArrowDown")).toBe(true);
    expect(editor.state.doc.childCount).toBe(2);
    expect(editor.state.selection.$from.parent.textContent).toBe("after");
    expect(editor.state.selection.$from.parentOffset).toBe(0);
  });

  it("keeps arrows inside earlier lines and soft-wrapped lines", () => {
    const editor = harness("```\none\ntwo\n```", 2);
    expect(editor.key("ArrowDown")).toBe(false);
    editor.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 6)));
    expect(editor.key("ArrowDown", {}, false)).toBe(false);
  });

  it("inserts a code newline on Enter and exits on Control+Enter", () => {
    const editor = harness("```\nx\n```", 2);
    expect(editor.key("Enter")).toBe(true);
    expect(editor.state.selection.$from.parent.type.name).toBe("codeBlock");
    expect(editor.state.doc.firstChild?.textContent).toBe("x\n");
    expect(editor.key("Enter", { ctrlKey: true })).toBe(true);
    expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
  });

  it("consumes a typed closing fence instead of leaving visible backticks", () => {
    const editor = harness("```ts\nx", 2);
    editor.dispatch(editor.state.tr.insertText("\n```"));
    expect(editor.key("Enter")).toBe(true);
    expect(editor.state.doc.firstChild?.textContent).toBe("x");
    expect(editor.prompt).toBe("```ts\nx\n```\n");
    expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
  });

  it("closes an unfinished block when creating the following paragraph", () => {
    const editor = harness("~~~sh\necho ok", 8);
    expect(editor.key("ArrowDown")).toBe(true);
    expect(editor.prompt).toBe("~~~sh\necho ok\n~~~\n");
  });

  it("lets an empty block exit and lets three Enter presses exit", () => {
    const editor = harness("```\n```");
    editor.key("Enter");
    editor.key("Enter");
    expect(editor.key("Enter")).toBe(true);
    expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
    expect(editor.prompt).toBe("```\n```\n");
  });

  it("removes delimiters when a code block becomes ordinary text", () => {
    const editor = harness("```ts\nx\n```");
    expect(editor.key("Backspace")).toBe(true);
    expect(editor.prompt).toBe("x");
  });

  it.each(["```ts\nx\n```", "```ts\nx\n```\nafter", "```ts\n```"])(
    "maps the caret before the hidden closing fence in %s",
    (prompt) => {
      const editor = harness(prompt);
      const map = serializeEditorDoc(editor.state.doc);
      const end = editor.state.doc.firstChild!.content.size;
      expect(flatToMarkdown(map, end)).toBe("```ts\n".length + end);
    },
  );

  it("keeps pasted literal closing markers inside the editable block", () => {
    const editor = harness("```md\nx\n```", 2);
    editor.dispatch(editor.state.tr.insertText("\n```\ny"));
    expect(editor.prompt).toBe("````md\nx\n```\ny\n````");
    const restored = schema.nodeFromJSON(
      buildDocJson(editor.prompt, (name) => ({ label: name, description: null })),
    );
    expect(restored.childCount).toBe(1);
    expect(restored.firstChild?.textContent).toBe("x\n```\ny");
  });

  it("allows the exit control to target a block without moving the selection first", () => {
    const editor = harness("before\n```\nx\n```", 1);
    const position = editor.state.doc.firstChild!.nodeSize;
    expect(exitComposerCodeBlock(editor.state, editor.dispatch, position)).toBe(true);
    expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
    expect(editor.prompt).toBe("before\n```\nx\n```\n");
  });

  it.each([
    "```ts\nconst x = **literal**;\n```",
    "before\n~~~sh\necho @./file $skill\n~~~\nafter",
    "````md\n```ts\nx\n```\n````",
    "```\n```",
    "```\n\n```",
    "```ts\nx\n",
    "```",
  ])("preserves Markdown and editable cursor positions for %s", (prompt) => {
    const editor = harness(prompt);
    const map = serializeEditorDoc(editor.state.doc);
    expect(map.value).toBe(prompt);
    for (let offset = 0; offset <= map.docLength; offset += 1) {
      const position = flatToPm(map, offset);
      expect(editor.state.doc.resolve(position).parent.isTextblock).toBe(true);
      expect(pmToFlat(map, position)).toBe(offset);
      expect(flatToCollapsed(map, offset)).toBe(offset);
    }
    const restored = schema.nodeFromJSON(
      buildDocJson(map.value, (name) => ({ label: name, description: null })) as JSONContent,
    );
    expect(serializeEditorDoc(restored).value).toBe(prompt);
  });
});
