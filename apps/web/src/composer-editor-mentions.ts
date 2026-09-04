import type { AssistantCitation } from "@t3tools/contracts";
import { collectAssistantCitations } from "@t3tools/shared/assistantCitations";
import {
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
  type TerminalContextDraft,
} from "./lib/terminalContext";
import {
  collectComposerInlineTokens,
  type ComposerInlineToken,
} from "@t3tools/shared/composerInlineTokens";
import { findComposerCodeBlocks } from "./composerCodeBlocks";

export type ComposerPromptSegment =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "mention";
      path: string;
      source: string;
    }
  | {
      type: "skill";
      name: string;
    }
  | {
      type: "citation";
      citation: AssistantCitation;
      source: string;
    }
  | {
      type: "terminal-context";
      context: TerminalContextDraft | null;
    }
  | {
      /**
       * A closed fenced block. The composer renders it as a container and hides
       * the fences, so `content` is what the caret can reach while `source` is
       * what the prompt actually carries.
       */
      type: "code-block";
      info: string;
      content: string;
      source: string;
      /** Characters of `source` that precede `content` (the fence line plus its newline). */
      prefixLength: number;
    };

function rangeIncludesIndex(start: number, end: number, index: number): boolean {
  return start <= index && index < end;
}

function pushTextSegment(segments: ComposerPromptSegment[], text: string): void {
  if (!text) return;
  const last = segments[segments.length - 1];
  if (last && last.type === "text") {
    last.text += text;
    return;
  }
  segments.push({ type: "text", text });
}

function forEachPromptSegmentSlice(
  prompt: string,
  visitor: (
    slice:
      | {
          type: "text";
          text: string;
          promptOffset: number;
        }
      | {
          type: "terminal-context";
          promptOffset: number;
        },
  ) => boolean | void,
): boolean {
  let textCursor = 0;

  for (let index = 0; index < prompt.length; index += 1) {
    if (prompt[index] !== INLINE_TERMINAL_CONTEXT_PLACEHOLDER) {
      continue;
    }

    if (
      index > textCursor &&
      visitor({
        type: "text",
        text: prompt.slice(textCursor, index),
        promptOffset: textCursor,
      }) === true
    ) {
      return true;
    }
    if (visitor({ type: "terminal-context", promptOffset: index }) === true) {
      return true;
    }
    textCursor = index + 1;
  }

  if (
    textCursor < prompt.length &&
    visitor({
      type: "text",
      text: prompt.slice(textCursor),
      promptOffset: textCursor,
    }) === true
  ) {
    return true;
  }

  return false;
}

function forEachPromptTextSlice(
  prompt: string,
  visitor: (text: string, promptOffset: number) => boolean | void,
): boolean {
  return forEachPromptSegmentSlice(prompt, (slice) => {
    if (slice.type !== "text") {
      return false;
    }
    return visitor(slice.text, slice.promptOffset);
  });
}

function forEachMentionMatch(
  prompt: string,
  visitor: (
    match: Extract<ComposerInlineToken, { type: "mention" }>,
    promptOffset: number,
  ) => boolean | void,
): boolean {
  return forEachPromptTextSlice(prompt, (text, promptOffset) => {
    for (const match of collectComposerPromptInlineTokens(text)) {
      if (match.type !== "mention") {
        continue;
      }
      if (visitor(match, promptOffset) === true) {
        return true;
      }
    }
    return false;
  });
}

export function collectComposerPromptInlineTokens(text: string) {
  const tokens = collectComposerInlineTokens(text);
  const citations = collectAssistantCitations(text);
  if (citations.length === 0) return tokens;

  // An unfinished @ mention can otherwise consume the start of a citation's label.
  return [
    ...tokens.filter(
      (token) =>
        !citations.some((citation) => token.start < citation.end && token.end > citation.start),
    ),
    ...citations.map((match) => ({ ...match, type: "citation" as const })),
  ].sort((left, right) => left.start - right.start);
}

function splitPromptTextIntoComposerSegments(text: string): ComposerPromptSegment[] {
  const segments: ComposerPromptSegment[] = [];
  if (!text) {
    return segments;
  }

  const tokenMatches = collectComposerPromptInlineTokens(text);
  let cursor = 0;
  for (const match of tokenMatches) {
    if (match.start < cursor) {
      continue;
    }

    if (match.start > cursor) {
      pushTextSegment(segments, text.slice(cursor, match.start));
    }

    if (match.type === "citation") {
      segments.push({ type: "citation", citation: match.citation, source: match.source });
    } else if (match.type === "mention") {
      segments.push({
        type: "mention",
        path: match.value,
        source: match.source,
      });
    } else {
      segments.push({ type: "skill", name: match.value });
    }

    cursor = match.end;
  }

  if (cursor < text.length) {
    pushTextSegment(segments, text.slice(cursor));
  }

  return segments;
}

export function selectionTouchesMentionBoundary(
  prompt: string,
  start: number,
  end: number,
): boolean {
  if (!prompt || start >= end) {
    return false;
  }

  return forEachMentionMatch(prompt, (match, promptOffset) => {
    const mentionStart = promptOffset + match.start;
    const mentionEnd = promptOffset + match.end;
    const beforeMentionIndex = mentionStart - 1;
    const afterMentionIndex = mentionEnd;

    if (
      beforeMentionIndex >= 0 &&
      /\s/.test(prompt[beforeMentionIndex] ?? "") &&
      rangeIncludesIndex(start, end, beforeMentionIndex)
    ) {
      return true;
    }

    if (
      afterMentionIndex < prompt.length &&
      /\s/.test(prompt[afterMentionIndex] ?? "") &&
      rangeIncludesIndex(start, end, afterMentionIndex)
    ) {
      return true;
    }
    return false;
  });
}

/**
 * Segments a stretch of prompt that is known to sit outside any code block.
 * The terminal-context cursor is shared across calls so chips keep matching
 * their drafts when blocks split the prompt into several stretches.
 */
function splitPlainPromptIntoComposerSegments(
  prompt: string,
  terminalContexts: ReadonlyArray<TerminalContextDraft>,
  terminalContextCursor: { index: number },
): ComposerPromptSegment[] {
  const segments: ComposerPromptSegment[] = [];
  forEachPromptSegmentSlice(prompt, (slice) => {
    if (slice.type === "text") {
      segments.push(...splitPromptTextIntoComposerSegments(slice.text));
      return false;
    }

    segments.push({
      type: "terminal-context",
      context: terminalContexts[terminalContextCursor.index] ?? null,
    });
    terminalContextCursor.index += 1;
    return false;
  });

  return segments;
}

export function splitPromptIntoComposerSegments(
  prompt: string,
  terminalContexts: ReadonlyArray<TerminalContextDraft> = [],
): ComposerPromptSegment[] {
  if (!prompt) {
    return [];
  }

  const terminalContextCursor = { index: 0 };
  const blocks = findComposerCodeBlocks(prompt);
  if (blocks.length === 0) {
    return splitPlainPromptIntoComposerSegments(prompt, terminalContexts, terminalContextCursor);
  }

  // Code blocks are carved out first: their content is literal, so a `@path` or
  // `$skill` inside one must stay text rather than becoming a chip.
  const segments: ComposerPromptSegment[] = [];
  let cursor = 0;
  for (const block of blocks) {
    if (block.start > cursor) {
      segments.push(
        ...splitPlainPromptIntoComposerSegments(
          prompt.slice(cursor, block.start),
          terminalContexts,
          terminalContextCursor,
        ),
      );
    }
    segments.push({
      type: "code-block",
      info: block.info,
      content: block.content,
      source: prompt.slice(block.start, block.end),
      prefixLength: block.prefixLength,
    });
    cursor = block.end;
  }
  if (cursor < prompt.length) {
    segments.push(
      ...splitPlainPromptIntoComposerSegments(
        prompt.slice(cursor),
        terminalContexts,
        terminalContextCursor,
      ),
    );
  }

  return segments;
}
