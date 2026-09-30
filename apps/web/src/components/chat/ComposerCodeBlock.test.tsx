// @vitest-environment jsdom

import { Editor } from "@tiptap/core";
import { EditorContent, ReactNodeViewRenderer } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { buildDocJson, serializeEditorDoc } from "~/composer-rich-text-doc";
import { ComposerCodeBlockExtension } from "~/composerCodeBlockExtension";
import { ComposerCodeBlockHighlight } from "~/composerCodeBlockHighlight";
import { getSyntaxHighlighterPromise } from "~/lib/syntaxHighlighting";
import { TooltipProvider } from "../ui/tooltip";
import { ComposerCodeBlock } from "./ComposerCodeBlock";

let root: Root;
let container: HTMLDivElement;
let editor: Editor;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  editor = new Editor({
    extensions: [
      StarterKit.configure({ codeBlock: false, trailingNode: false }),
      ComposerCodeBlockExtension.extend({
        addNodeView: () => ReactNodeViewRenderer(ComposerCodeBlock),
      }),
      ComposerCodeBlockHighlight,
    ],
    content: buildDocJson("```ts\nconst x = 1;\n```", (name) => ({
      label: name,
      description: null,
    })),
  });
  await act(async () => {
    root.render(
      <TooltipProvider>
        <EditorContent editor={editor} />
      </TooltipProvider>,
    );
  });
});

afterEach(async () => {
  await act(async () => {
    editor.destroy();
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

it("edits code without visible fences and continues below the final container", async () => {
  await act(async () => {
    await getSyntaxHighlighterPromise("ts");
  });
  expect(container.querySelectorAll("pre code .composer-code-token").length).toBeGreaterThan(0);
  expect(container.textContent).not.toContain("```");
  expect(container.querySelector("pre code")?.textContent).toBe("const x = 1;");
  await act(async () => {
    editor.commands.setTextSelection(13);
    editor.commands.insertContent({ type: "text", text: "\nconst y = 2;" });
  });
  expect(container.querySelector("pre code")?.textContent).toBe("const x = 1;\nconst y = 2;");
  const exit = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Continue below code block"]',
  )!;
  await act(async () => exit.click());
  expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
  await act(async () => editor.commands.insertContent("after"));
  expect(serializeEditorDoc(editor.state.doc).value).toBe(
    "```ts\nconst x = 1;\nconst y = 2;\n```\nafter",
  );
  expect(container.textContent).not.toContain("```");
  expect(container.querySelector("p")?.textContent).toBe("after");
});
