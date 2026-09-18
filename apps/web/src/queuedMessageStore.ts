import type { PreviewAnnotationPayload } from "@t3tools/contracts";
import { create } from "zustand";

import type { ComposerSubmissionIntent } from "./composer-logic";
import type { ComposerFileAttachment, ComposerImageAttachment } from "./composerDraftStore";
import type { TerminalContextDraft } from "./lib/terminalContext";
import { randomUUID } from "./lib/utils";
import type { ReviewCommentContext } from "./reviewCommentContext";

/**
 * A composer submission held back while the thread's turn is running. It
 * carries the full draft snapshot so the send path can dispatch it later with
 * the same text, attachments, and contexts the user pressed Enter on.
 */
export interface QueuedComposerMessage {
  id: string;
  prompt: string;
  images: ComposerImageAttachment[];
  files: ComposerFileAttachment[];
  terminalContexts: TerminalContextDraft[];
  previewAnnotations: PreviewAnnotationPayload[];
  reviewComments: ReviewCommentContext[];
  submissionIntent: ComposerSubmissionIntent;
  /**
   * The newest completed tool activity at queue time. A different id later
   * means a tool call finished after the user queued, which is the boundary
   * the message goes out on.
   */
  queuedAfterToolActivityId: string | null;
  /**
   * Set when the message was created by Stop or a failed restore, not by the
   * user pressing send. It waits for Send now instead of leaving on its own.
   */
  holdUntilUserAction?: boolean;
  /**
   * Set when the send failed on (or the queue is waiting for) an exhausted
   * plan window. The message auto-sends after this instant; Send now still
   * forces it and Cancel still drops it.
   */
  rateLimitedUntil?: string | null;
  /**
   * Set when the user scheduled the send for later, from the composer or the
   * queued row. Like a rate-limit wait it auto-sends after this instant;
   * clearing it returns the message to the normal queue boundaries.
   */
  sendAt?: string | null;
  createdAt: string;
}

interface QueuedMessageStoreState {
  queuesByThreadKey: Record<string, QueuedComposerMessage[]>;
  /**
   * Bumped by `drain`. A send that took a message before a drain and finishes
   * its upload after it compares this to the value it captured and gives up,
   * so Stop cannot be followed by a queued message starting a new turn.
   */
  drainGeneration: number;
  enqueue: (threadKey: string, message: Omit<QueuedComposerMessage, "id">) => QueuedComposerMessage;
  /**
   * Removes one message and returns it, or null when another caller already
   * took it. The remaining messages are re-anchored to `toolActivityId` so
   * only one queued message leaves per tool boundary.
   */
  take: (
    threadKey: string,
    id: string,
    toolActivityId: string | null,
  ) => QueuedComposerMessage | null;
  /** Removes one message without touching the others' anchors. Null when already gone. */
  remove: (threadKey: string, id: string) => QueuedComposerMessage | null;
  /**
   * Puts a message back at the head, held for user action. Used when its
   * send failed: the queue keeps its order and nothing behind it overtakes.
   */
  holdAtFront: (threadKey: string, message: QueuedComposerMessage) => void;
  /**
   * Parks a message at the head until an exhausted plan window resets. Unlike
   * holdAtFront it stays eligible for auto-send: the drain effect fires it
   * once `resetsAt` passes. Send now forces it, Cancel drops it.
   */
  holdForRateLimit: (threadKey: string, message: QueuedComposerMessage, resetsAt: string) => void;
  /**
   * Schedules a queued message for later without moving it. A null `sendAt`
   * clears the schedule and returns the message to the normal boundaries.
   */
  scheduleSend: (threadKey: string, id: string, sendAt: string | null) => void;
  /** Removes and returns every queued message for the thread, oldest first. */
  drain: (threadKey: string) => QueuedComposerMessage[];
}

const EMPTY_QUEUE: QueuedComposerMessage[] = [];

/** In-memory only: a queued message is a live intent, not a draft worth persisting. */
export const useQueuedMessageStore = create<QueuedMessageStoreState>()((set, get) => ({
  queuesByThreadKey: {},
  drainGeneration: 0,
  enqueue: (threadKey, message) => {
    const entry: QueuedComposerMessage = { ...message, id: randomUUID() };
    set((state) => ({
      queuesByThreadKey: {
        ...state.queuesByThreadKey,
        [threadKey]: [...(state.queuesByThreadKey[threadKey] ?? EMPTY_QUEUE), entry],
      },
    }));
    return entry;
  },
  take: (threadKey, id, toolActivityId) => {
    const queue = get().queuesByThreadKey[threadKey];
    const entry = queue?.find((message) => message.id === id);
    if (!queue || !entry) {
      return null;
    }
    set((state) => {
      const remaining = (state.queuesByThreadKey[threadKey] ?? EMPTY_QUEUE)
        .filter((message) => message.id !== id)
        .map((message) =>
          message.queuedAfterToolActivityId === toolActivityId
            ? message
            : { ...message, queuedAfterToolActivityId: toolActivityId },
        );
      const queuesByThreadKey = { ...state.queuesByThreadKey };
      if (remaining.length === 0) {
        delete queuesByThreadKey[threadKey];
      } else {
        queuesByThreadKey[threadKey] = remaining;
      }
      return { queuesByThreadKey };
    });
    return entry;
  },
  remove: (threadKey, id) => {
    const queue = get().queuesByThreadKey[threadKey];
    const entry = queue?.find((message) => message.id === id);
    if (!queue || !entry) {
      return null;
    }
    set((state) => {
      const remaining = (state.queuesByThreadKey[threadKey] ?? EMPTY_QUEUE).filter(
        (message) => message.id !== id,
      );
      const queuesByThreadKey = { ...state.queuesByThreadKey };
      if (remaining.length === 0) {
        delete queuesByThreadKey[threadKey];
      } else {
        queuesByThreadKey[threadKey] = remaining;
      }
      return { queuesByThreadKey };
    });
    return entry;
  },
  holdAtFront: (threadKey, message) => {
    set((state) => {
      const rest = (state.queuesByThreadKey[threadKey] ?? EMPTY_QUEUE).filter(
        (entry) => entry.id !== message.id,
      );
      return {
        queuesByThreadKey: {
          ...state.queuesByThreadKey,
          [threadKey]: [
            { ...message, holdUntilUserAction: true, rateLimitedUntil: null, sendAt: null },
            ...rest,
          ],
        },
      };
    });
  },
  scheduleSend: (threadKey, id, sendAt) => {
    set((state) => {
      const queue = state.queuesByThreadKey[threadKey] ?? EMPTY_QUEUE;
      if (!queue.some((entry) => entry.id === id)) return state;
      return {
        queuesByThreadKey: {
          ...state.queuesByThreadKey,
          [threadKey]: queue.map((entry) =>
            entry.id === id
              ? { ...entry, sendAt, holdUntilUserAction: sendAt ? false : entry.holdUntilUserAction }
              : entry,
          ),
        },
      };
    });
  },
  holdForRateLimit: (threadKey, message, resetsAt) => {
    set((state) => {
      const rest = (state.queuesByThreadKey[threadKey] ?? EMPTY_QUEUE).filter(
        (entry) => entry.id !== message.id,
      );
      return {
        queuesByThreadKey: {
          ...state.queuesByThreadKey,
          [threadKey]: [
            {
              ...message,
              holdUntilUserAction: false,
              rateLimitedUntil: resetsAt,
            },
            ...rest,
          ],
        },
      };
    });
  },
  drain: (threadKey) => {
    const queue = get().queuesByThreadKey[threadKey];
    if (!queue || queue.length === 0) {
      return EMPTY_QUEUE;
    }
    set((state) => {
      const queuesByThreadKey = { ...state.queuesByThreadKey };
      delete queuesByThreadKey[threadKey];
      return { queuesByThreadKey, drainGeneration: state.drainGeneration + 1 };
    });
    return queue;
  },
}));

/**
 * The newest finished tool call. Its id changing is the boundary a queued
 * message goes out on. Live arrays are sorted, but a snapshot loaded from the
 * database is not, so pick by sequence rather than position.
 */
export function latestCompletedToolActivityId(
  activities: ReadonlyArray<{
    readonly id: string;
    readonly kind: string;
    readonly sequence?: number | undefined;
    readonly createdAt: string;
  }>,
): string | null {
  let latest: (typeof activities)[number] | null = null;
  for (const activity of activities) {
    if (activity.kind !== "tool.completed") continue;
    if (
      latest === null ||
      (activity.sequence ?? -1) > (latest.sequence ?? -1) ||
      ((activity.sequence ?? -1) === (latest.sequence ?? -1) &&
        activity.createdAt > latest.createdAt)
    ) {
      latest = activity;
    }
  }
  return latest?.id ?? null;
}

/**
 * A queued message is due mid-turn once a tool call finished after it was
 * queued, and as soon as the turn is over otherwise. "connecting" is the gap
 * between a send and the provider picking it up, so nothing is due there.
 */
export function isQueuedMessageDue(input: {
  message: Pick<
    QueuedComposerMessage,
    "queuedAfterToolActivityId" | "holdUntilUserAction" | "rateLimitedUntil" | "sendAt"
  >;
  phase: "connecting" | "running" | "ready" | "disconnected";
  latestToolActivityId: string | null;
  nowMs?: number;
}): boolean {
  if (input.message.holdUntilUserAction) return false;
  if (input.phase === "connecting") return false;
  // A scheduled or rate-limited wait parks the message until its instant; the
  // drain effect arms a timer for exactly then instead of sending early.
  if (getQueuedMessageWaitUntil(input.message, input.nowMs ?? Date.now()) !== null) return false;
  if (input.phase !== "running") return true;
  return input.latestToolActivityId !== input.message.queuedAfterToolActivityId;
}

const futureInstantMs = (iso: string | null | undefined, nowMs: number): number | null => {
  if (!iso) return null;
  const timestampMs = Date.parse(iso);
  return Number.isFinite(timestampMs) && timestampMs > nowMs ? timestampMs : null;
};

/**
 * Latest instant a queued message must wait for: a manual schedule, an
 * exhausted plan window, or null when nothing holds it back. The drain
 * effect arms one timer for this instant and re-evaluates then.
 */
export function getQueuedMessageWaitUntil(
  message: Pick<QueuedComposerMessage, "rateLimitedUntil" | "sendAt">,
  nowMs: number = Date.now(),
): string | null {
  const candidates = [
    futureInstantMs(message.sendAt, nowMs),
    futureInstantMs(message.rateLimitedUntil, nowMs),
  ].filter((candidate): candidate is number => candidate !== null);
  if (candidates.length === 0) return null;
  const latestMs = Math.max(...candidates);
  return (
    [message.sendAt, message.rateLimitedUntil].find(
      (iso) => iso && Date.parse(iso) === latestMs,
    ) ?? null
  );
}

/** True while a manual schedule holds the message back. */
export function isQueuedMessageScheduled(
  message: Pick<QueuedComposerMessage, "sendAt">,
  nowMs: number = Date.now(),
): boolean {
  return futureInstantMs(message.sendAt, nowMs) !== null;
}

/** True while the message is parked waiting for an exhausted window to reset. */
export function isQueuedMessageRateLimited(
  message: Pick<QueuedComposerMessage, "rateLimitedUntil">,
  nowMs: number = Date.now(),
): boolean {
  return futureInstantMs(message.rateLimitedUntil, nowMs) !== null;
}

export function useQueuedMessages(threadKey: string): QueuedComposerMessage[] {
  return useQueuedMessageStore((state) => state.queuesByThreadKey[threadKey] ?? EMPTY_QUEUE);
}
