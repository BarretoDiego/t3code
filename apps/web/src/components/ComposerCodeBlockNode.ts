import {
  $applyNodeReplacement,
  ElementNode,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
  type SerializedElementNode,
  type Spread,
} from "lexical";

import { serializeComposerCodeBlock } from "~/composerCodeBlocks";

export type SerializedComposerCodeBlockNode = Spread<
  {
    info: string;
    type: "composer-code-block";
    version: 1;
  },
  SerializedElementNode
>;

export const COMPOSER_CODE_BLOCK_CLASS_NAME = "composer-code-block";

/**
 * A fenced code block rendered as one container the caret types inside.
 *
 * The fences are never rendered, but they are still part of the prompt, so
 * `getTextContent()` synthesizes them. That is what lets the block hold only
 * the code the user sees while the submitted prompt stays valid markdown — the
 * same "collapsed versus expanded" split the composer already uses for chips.
 */
export class ComposerCodeBlockNode extends ElementNode {
  __info: string;

  static override getType(): string {
    return "composer-code-block";
  }

  static override clone(node: ComposerCodeBlockNode): ComposerCodeBlockNode {
    return new ComposerCodeBlockNode(node.__info, node.__key);
  }

  static override importJSON(
    serializedNode: SerializedComposerCodeBlockNode,
  ): ComposerCodeBlockNode {
    return $createComposerCodeBlockNode(serializedNode.info).updateFromJSON(serializedNode);
  }

  constructor(info = "", key?: NodeKey) {
    super(key);
    this.__info = info;
  }

  override exportJSON(): SerializedComposerCodeBlockNode {
    return {
      ...super.exportJSON(),
      info: this.getInfo(),
      type: "composer-code-block",
      version: 1,
    };
  }

  getInfo(): string {
    return this.getLatest().__info;
  }

  setInfo(info: string): this {
    const self = this.getWritable();
    self.__info = info;
    return self;
  }

  override createDOM(_config: EditorConfig): HTMLElement {
    const dom = document.createElement("div");
    dom.className = COMPOSER_CODE_BLOCK_CLASS_NAME;
    applyLanguage(dom, this.__info);
    return dom;
  }

  override updateDOM(prevNode: ComposerCodeBlockNode, dom: HTMLElement): boolean {
    if (prevNode.__info !== this.__info) {
      applyLanguage(dom, this.__info);
    }
    return false;
  }

  override isInline(): false {
    return false;
  }

  override canBeEmpty(): true {
    return true;
  }

  /** Characters of the prompt that precede the content: the fence line plus its newline. */
  getPrefixLength(): number {
    return "```".length + this.getInfo().length + 1;
  }

  /** Characters of the prompt that follow the content: the newline plus the closing fence. */
  getSuffixLength(): number {
    return 1 + "```".length;
  }

  override getTextContent(): string {
    return serializeComposerCodeBlock(this.getInfo(), super.getTextContent());
  }
}

/** The language hint is drawn by CSS from this attribute, keeping it out of the caret's way. */
function applyLanguage(dom: HTMLElement, info: string): void {
  if (info) {
    dom.dataset.language = info;
  } else {
    delete dom.dataset.language;
  }
}

export function $createComposerCodeBlockNode(info = ""): ComposerCodeBlockNode {
  return $applyNodeReplacement(new ComposerCodeBlockNode(info));
}

export function $isComposerCodeBlockNode(
  node: LexicalNode | null | undefined,
): node is ComposerCodeBlockNode {
  return node instanceof ComposerCodeBlockNode;
}
