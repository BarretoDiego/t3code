import {
  $createParagraphNode,
  $createTextNode,
  $getSelection,
  $isLineBreakNode,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_CRITICAL,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_BACKSPACE_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_TAB_COMMAND,
  type LexicalEditor,
  type LexicalNode,
} from "lexical";

import {
  $createComposerCodeBlockNode,
  $isComposerCodeBlockNode,
  type ComposerCodeBlockNode,
} from "./ComposerCodeBlockNode";

function countFenceLines(text: string): number {
  return text.split("\n").filter((line) => /^[ \t]{0,3}(?:`{3,}|~{3,})/.test(line)).length;
}

/** Two spaces, because a prompt is read as plain text wherever it lands. */
export const COMPOSER_CODE_BLOCK_INDENT = "  ";

/**
 * Keyboard behaviour for the fenced code container.
 *
 * Inside a block the composer stops being a chat input and starts being a code
 * field: Enter breaks the line instead of sending, and Tab indents instead of
 * accepting an autocomplete. Every one of those has a way back out, so the
 * block can never trap the caret.
 */
export function registerComposerCodeBlockKeys(editor: LexicalEditor): () => void {
  const unregisters = [
    editor.registerCommand(KEY_ENTER_COMMAND, $handleEnter, COMMAND_PRIORITY_CRITICAL),
    editor.registerCommand(KEY_TAB_COMMAND, $handleTab, COMMAND_PRIORITY_CRITICAL),
    editor.registerCommand(KEY_BACKSPACE_COMMAND, $handleBackspace, COMMAND_PRIORITY_CRITICAL),
    editor.registerCommand(KEY_ARROW_DOWN_COMMAND, $handleArrowDown, COMMAND_PRIORITY_CRITICAL),
    editor.registerCommand(KEY_ARROW_UP_COMMAND, $handleArrowUp, COMMAND_PRIORITY_CRITICAL),
  ];
  return () => {
    for (const unregister of unregisters) unregister();
  };
}

function $currentCodeBlock(): ComposerCodeBlockNode | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return null;
  return $enclosingCodeBlock(selection.anchor.getNode());
}

function $enclosingCodeBlock(node: LexicalNode | null): ComposerCodeBlockNode | null {
  let current: LexicalNode | null = node;
  while (current) {
    if ($isComposerCodeBlockNode(current)) return current;
    current = current.getParent();
  }
  return null;
}

function $handleEnter(event: KeyboardEvent | null): boolean {
  const block = $currentCodeBlock();
  if (!block) return false;
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return false;

  // A trailing blank line is the way out: the second Enter leaves the block.
  if (selection.isCollapsed() && $isAtEndOfBlock(block, selection.anchor.getNode())) {
    const last = block.getLastChild();
    if ($isLineBreakNode(last)) {
      last.remove();
      $moveCaretAfter(block);
      event?.preventDefault();
      return true;
    }
  }

  selection.insertLineBreak();
  event?.preventDefault();
  return true;
}

function $handleTab(event: KeyboardEvent | null): boolean {
  const block = $currentCodeBlock();
  if (!block) return false;
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return false;

  if (event?.shiftKey) {
    $outdentSelection(block);
  } else if (selection.isCollapsed()) {
    selection.insertText(COMPOSER_CODE_BLOCK_INDENT);
  } else {
    $indentSelection(block);
  }
  event?.preventDefault();
  return true;
}

/** Backspace in an empty block removes the container instead of stranding it. */
function $handleBackspace(event: KeyboardEvent | null): boolean {
  const block = $currentCodeBlock();
  if (!block) return false;
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;
  if (block.getTextContentSize() > 0) return false;

  const paragraph = $createParagraphNode();
  block.replace(paragraph);
  paragraph.select();
  event?.preventDefault();
  return true;
}

/** A block with nothing after it would otherwise trap the caret at the end. */
function $handleArrowDown(event: KeyboardEvent | null): boolean {
  const block = $currentCodeBlock();
  if (!block || block.getNextSibling()) return false;
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;
  if (!$isAtEndOfBlock(block, selection.anchor.getNode())) return false;

  $moveCaretAfter(block);
  event?.preventDefault();
  return true;
}

/** Mirror of the above for a block that opens the prompt. */
function $handleArrowUp(event: KeyboardEvent | null): boolean {
  const block = $currentCodeBlock();
  if (!block || block.getPreviousSibling()) return false;
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;
  if (selection.anchor.offset !== 0) return false;
  const first = block.getFirstChild();
  if (first && selection.anchor.getNode().getKey() !== first.getKey()) return false;

  const paragraph = $createParagraphNode();
  block.insertBefore(paragraph);
  paragraph.select();
  event?.preventDefault();
  return true;
}

function $isAtEndOfBlock(block: ComposerCodeBlockNode, node: LexicalNode): boolean {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return false;
  const last = block.getLastDescendant() ?? block;
  if (node.getKey() !== last.getKey()) return false;
  if ($isTextNode(node)) return selection.anchor.offset === node.getTextContentSize();
  return true;
}

function $moveCaretAfter(block: ComposerCodeBlockNode): void {
  const next = block.getNextSibling();
  if (next && !$isComposerCodeBlockNode(next)) {
    next.selectStart();
    return;
  }
  const paragraph = $createParagraphNode();
  block.insertAfter(paragraph);
  paragraph.select();
}

function $indentSelection(block: ComposerCodeBlockNode): void {
  for (const line of $selectedLineStarts(block)) {
    line.setTextContent(`${COMPOSER_CODE_BLOCK_INDENT}${line.getTextContent()}`);
  }
}

function $outdentSelection(block: ComposerCodeBlockNode): void {
  for (const line of $selectedLineStarts(block)) {
    const text = line.getTextContent();
    if (text.startsWith(COMPOSER_CODE_BLOCK_INDENT)) {
      line.setTextContent(text.slice(COMPOSER_CODE_BLOCK_INDENT.length));
      continue;
    }
    if (text.startsWith(" ") || text.startsWith("\t")) {
      line.setTextContent(text.slice(1));
    }
  }
}

/**
 * The first text node of every line the selection touches. Lines are separated
 * by line breaks inside the block, so a line start is any text node that opens
 * the block or directly follows a break.
 */
function $selectedLineStarts(block: ComposerCodeBlockNode): ReturnType<typeof collectLineStarts> {
  const selection = $getSelection();
  const selected = $isRangeSelection(selection) ? new Set(selection.getNodes().map(keyOf)) : null;
  return collectLineStarts(block).filter((line) => !selected || selected.has(line.getKey()));
}

function keyOf(node: LexicalNode): string {
  return node.getKey();
}

function collectLineStarts(block: ComposerCodeBlockNode) {
  const starts = [];
  let atLineStart = true;
  for (const child of block.getChildren()) {
    if ($isLineBreakNode(child)) {
      atLineStart = true;
      continue;
    }
    if (atLineStart && $isTextNode(child)) {
      starts.push(child);
    }
    atLineStart = false;
  }
  return starts;
}

/**
 * Turns a just-typed fence into an empty container with the caret inside.
 *
 * Only handles typing. A pasted fence already reaches the composer as prompt
 * text, and the controlled update rebuilds it into a block from there.
 */
export function $openCodeBlockFromTypedFence(): boolean {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;
  if ($currentCodeBlock()) return false;

  const node = selection.anchor.getNode();
  if (!$isTextNode(node)) return false;
  const offset = selection.anchor.offset;
  const before = node.getTextContent().slice(0, offset);
  if (!before.endsWith("```")) return false;
  // The fence has to open its own line, otherwise it is inline code.
  if (!/(^|\n)```$/.test(before)) return false;
  // An even count means this one closes an earlier fence, which is what a
  // pasted block looks like. Those are rebuilt from the prompt instead.
  if (countFenceLines(before) % 2 === 0) return false;

  const parent = node.getParent();
  if (!parent || $isComposerCodeBlockNode(parent)) return false;

  const block = $createComposerCodeBlockNode();
  const trailing = node.getTextContent().slice(offset);
  node.setTextContent(before.slice(0, -3));

  // Whatever followed the caret becomes the block's first line.
  const moved: LexicalNode[] = [];
  if (trailing.length > 0) moved.push($createTextNode(trailing));
  for (const sibling of node.getNextSiblings()) {
    sibling.remove();
    moved.push(sibling);
  }
  for (const child of moved) block.append(child);

  parent.insertAfter(block);
  if (parent.getTextContentSize() === 0 && parent.getPreviousSibling()) {
    parent.remove();
  }
  block.selectStart();
  return true;
}
