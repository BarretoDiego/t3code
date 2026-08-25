/**
 * Finds fenced code blocks in a composer prompt.
 *
 * The composer renders a closed fence as a container the user types inside,
 * with the fence characters themselves hidden. That makes the fences part of
 * the prompt string but absent from the visible text, so every offset the
 * composer tracks exists in two spaces: "expanded" (the prompt as submitted)
 * and "collapsed" (what the caret can actually reach). This module is the one
 * place that decides where a block starts and ends, so the structural node, the
 * segmentation, and the syntax scanner cannot drift apart.
 *
 * Only *closed* fences qualify. A half-typed fence stays plain text and is left
 * to the inline highlighter, because promoting it would move the caret out from
 * under the user mid-keystroke.
 */

export interface ComposerCodeBlockMatch {
  /** Offset of the opening fence within the prompt. */
  readonly start: number;
  /** Offset just past the closing fence. */
  readonly end: number;
  /** Language hint from the opening fence, e.g. `ts`. Empty when absent. */
  readonly info: string;
  /** The editable text between the fences, without the surrounding newlines. */
  readonly content: string;
  /** Length of the opening fence line plus its newline. */
  readonly prefixLength: number;
}

const FENCE_OPEN = /^[ \t]{0,3}(`{3,}|~{3,})([^`\n]*)$/;
const FENCE_CLOSE = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/;

interface OpenFence {
  readonly marker: string;
  readonly width: number;
  readonly start: number;
  readonly lineEnd: number;
  readonly info: string;
}

export function findComposerCodeBlocks(prompt: string): ComposerCodeBlockMatch[] {
  if (!prompt.includes("```") && !prompt.includes("~~~")) {
    return [];
  }

  const blocks: ComposerCodeBlockMatch[] = [];
  let open: OpenFence | null = null;
  let lineStart = 0;

  while (lineStart <= prompt.length) {
    const newline = prompt.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? prompt.length : newline;
    const line = prompt.slice(lineStart, lineEnd);

    if (open) {
      const close = FENCE_CLOSE.exec(line);
      const marker = close?.[1] ?? "";
      if (close && marker[0] === open.marker && marker.length >= open.width) {
        const contentStart = open.lineEnd + 1;
        const contentEnd = Math.max(contentStart, lineStart - 1);
        blocks.push({
          start: open.start,
          end: lineEnd,
          info: open.info,
          content: prompt.slice(contentStart, contentEnd),
          prefixLength: contentStart - open.start,
        });
        open = null;
      }
    } else {
      const match = FENCE_OPEN.exec(line);
      if (match) {
        const marker = match[1] ?? "";
        open = {
          marker: marker[0] ?? "`",
          width: marker.length,
          start: lineStart,
          lineEnd,
          info: (match[2] ?? "").trim(),
        };
      }
    }

    if (newline === -1) break;
    lineStart = newline + 1;
  }

  return blocks;
}

/**
 * Rebuilds the prompt text for a block, fences included.
 *
 * An empty block is written without a content line, so ```` ```\n``` ```` round
 * trips. That normalizes the one degenerate input where a block holding a
 * single blank line is indistinguishable from an empty one; it collapses to
 * empty rather than growing a line on every edit.
 */
export function serializeComposerCodeBlock(info: string, content: string): string {
  if (content.length === 0) {
    return `\`\`\`${info}\n\`\`\``;
  }
  return `\`\`\`${info}\n${content}\n\`\`\``;
}
