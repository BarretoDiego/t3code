import { Node } from "@tiptap/core";
import { TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";

export const ComposerCodeBlockExtension = Node.create({
  name: "codeBlock",
  group: "block",
  content: "text*",
  marks: "",
  code: true,
  defining: true,
  addAttributes() {
    return {
      info: { default: "", rendered: false },
      openingFence: { default: "```\n", rendered: false },
      closingFence: { default: "```", rendered: false },
      closingNewline: { default: false, rendered: false },
    };
  },
  parseHTML() {
    return [{ tag: "pre", preserveWhitespace: "full" }];
  },
  renderHTML() {
    return ["pre", ["code", 0]];
  },
});

export function exitComposerCodeBlock(
  state: EditorState,
  dispatch: (transaction: Transaction) => void,
  position = state.selection.$from.before(),
  removeTrailingText = 0,
): boolean {
  const block = state.doc.nodeAt(position);
  if (block?.type.name !== "codeBlock") return false;
  const transaction = state.tr;
  if (removeTrailingText > 0) {
    const end = position + 1 + block.content.size;
    transaction.delete(end - removeTrailingText, end);
  }
  const updated = transaction.doc.nodeAt(position)!;
  if (updated.attrs.closingFence === null) {
    const marker = /^[ \t]*(`{3,}|~{3,})/.exec(updated.attrs.openingFence)?.[1] ?? "```";
    transaction.setNodeMarkup(position, undefined, {
      ...updated.attrs,
      openingFence: updated.attrs.openingFence.endsWith("\n")
        ? updated.attrs.openingFence
        : `${updated.attrs.openingFence}\n`,
      closingFence: marker,
    });
  }
  const after = position + updated.nodeSize;
  if (transaction.doc.nodeAt(after)?.type.name !== "paragraph") {
    transaction.insert(after, state.schema.nodes.paragraph!.create());
  }
  transaction.setSelection(TextSelection.create(transaction.doc, after + 1));
  dispatch(transaction.scrollIntoView());
  return true;
}

export function handleComposerCodeBlockKey(
  state: EditorState,
  event: Pick<KeyboardEvent, "key" | "shiftKey" | "metaKey" | "ctrlKey" | "altKey" | "isComposing">,
  dispatch: (transaction: Transaction) => void,
  atBottom = true,
): boolean {
  if (event.isComposing || event.altKey) return false;
  const { $from, empty } = state.selection;
  if ($from.parent.type.name === "codeBlock") {
    const text = $from.parent.textContent;
    if (event.key === "Backspace" && empty && $from.parentOffset === 0) {
      dispatch(
        state.tr.setBlockType($from.pos, $from.pos, state.schema.nodes.paragraph!).scrollIntoView(),
      );
      return true;
    }
    if (
      empty &&
      event.key === "ArrowDown" &&
      !event.shiftKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      atBottom &&
      !text.slice($from.parentOffset).includes("\n")
    ) {
      return exitComposerCodeBlock(state, dispatch);
    }
    if (event.key !== "Enter") return false;
    if (event.metaKey || event.ctrlKey) return exitComposerCodeBlock(state, dispatch);
    if (empty && !event.shiftKey && $from.parentOffset === text.length) {
      const lineStart = text.lastIndexOf("\n") + 1;
      const line = text.slice(lineStart);
      const closing = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)?.[1];
      const opening = /^[ \t]*(`{3,}|~{3,})/.exec($from.parent.attrs.openingFence)?.[1];
      if (closing && opening && closing[0] === opening[0] && closing.length >= opening.length) {
        return exitComposerCodeBlock(
          state,
          dispatch,
          $from.before(),
          line.length + (lineStart > 0 ? 1 : 0),
        );
      }
      if (text.endsWith("\n\n")) {
        return exitComposerCodeBlock(state, dispatch, $from.before(), 2);
      }
    }
    dispatch(state.tr.insertText("\n").scrollIntoView());
    return true;
  }
  if (
    event.key !== "Enter" ||
    event.metaKey ||
    event.ctrlKey ||
    !empty ||
    $from.parent.type.name !== "paragraph" ||
    $from.parentOffset !== $from.parent.content.size
  )
    return false;
  const opening = /^[ \t]{0,3}(`{3,}|~{3,})([^`\n]*)$/.exec($from.parent.textContent);
  if (!opening) return false;
  const position = $from.before();
  const transaction = state.tr.replaceWith(
    position,
    position + $from.parent.nodeSize,
    state.schema.nodes.codeBlock!.create({
      info: opening[2]!.trim(),
      openingFence: `${$from.parent.textContent}\n`,
      closingFence: opening[1],
    }),
  );
  dispatch(
    transaction.setSelection(TextSelection.create(transaction.doc, position + 1)).scrollIntoView(),
  );
  return true;
}
