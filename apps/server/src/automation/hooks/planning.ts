import {
  AUTOMATION_EVENT_MAX_HOPS,
  type AutomationJournalEntry,
  type Hook,
  type HookDelivery,
  type HookRetryPolicy,
} from "@t3tools/contracts";

/** A batch hook without a window groups events that arrive within this long. */
const DEFAULT_HOOK_BATCH_WINDOW_MS = 5_000;
/** Events one batch delivery carries at most; the rest go in the next one. */
export const HOOK_MAX_BATCH_ENTRIES = 100;

/**
 * Outcomes something is waiting on. The per-chain cooldown and the per-task
 * limit throttle chatter, so they never hold these back; the hop limit and the
 * self-turn rule still apply to them.
 */
const RESULT_EVENT_TYPES = new Set<string>([
  "turn.completed",
  "turn.failed",
  "turn.interrupted",
  "request.opened",
  "request.resolved",
  "task.blocked",
  "task.reported",
  "task.validated",
  "task.failed",
  "task.cancelled",
  "task.unknown",
  "job.finished",
  "job.cancelled",
  "job.unknown",
]);

export type HookConfig = Pick<
  Hook,
  | "name"
  | "filter"
  | "target"
  | "deliveryMode"
  | "batchWindowMs"
  | "retry"
  | "timeoutMs"
  | "cooldownMs"
  | "maxDeliveriesPerTask"
>;

type SuppressedReason = NonNullable<HookDelivery["suppressedReason"]>;

export interface PlannedDelivery {
  readonly entries: ReadonlyArray<AutomationJournalEntry>;
  readonly suppressedReason: SuppressedReason | null;
}

/** What the hook already delivered, for the limits that look back. */
interface DeliveryHistory {
  /** Deliveries made so far per task. */
  readonly taskDeliveries: ReadonlyMap<string, number>;
  /** When the hook last delivered for a correlation chain, in epoch milliseconds. */
  readonly lastDeliveryAt: ReadonlyMap<string, number>;
}

const recordedAtMs = (entry: AutomationJournalEntry) => Date.parse(entry.event.recordedAt);

/**
 * Decides what a hook delivers for the entries it matched, and how far its
 * cursor may move. Every matched entry ends up in exactly one delivery,
 * suppressed or not; a batch whose window is still open is left for later by
 * stopping the cursor in front of it.
 */
export const planDeliveries = (input: {
  readonly config: HookConfig;
  readonly entries: ReadonlyArray<AutomationJournalEntry>;
  /** How far the journal was examined to find `entries`. */
  readonly scannedThrough: number;
  readonly nowMs: number;
  readonly history: DeliveryHistory;
}): { readonly deliveries: ReadonlyArray<PlannedDelivery>; readonly cursor: number } => {
  const { config, nowMs } = input;
  const taskDeliveries = new Map(input.history.taskDeliveries);
  const lastDeliveryAt = new Map(input.history.lastDeliveryAt);
  const deliveries: Array<PlannedDelivery> = [];

  const suppression = (entry: AutomationJournalEntry): SuppressedReason | null => {
    const { event } = entry;
    if (event.hops >= AUTOMATION_EVENT_MAX_HOPS) return "hop_limit";
    if (
      event.type === "orchestrator.turn.finished" &&
      config.target.type === "orchestrator_inbox" &&
      event.scope.orchestratorId === config.target.orchestratorId
    ) {
      return "self_turn";
    }
    if (RESULT_EVENT_TYPES.has(event.type)) return null;
    const taskId = event.scope.taskId;
    if (
      config.maxDeliveriesPerTask !== undefined &&
      taskId !== undefined &&
      (taskDeliveries.get(taskId) ?? 0) >= config.maxDeliveriesPerTask
    ) {
      return "task_limit";
    }
    const last = lastDeliveryAt.get(event.correlationId);
    if (
      config.cooldownMs !== undefined &&
      config.cooldownMs > 0 &&
      last !== undefined &&
      nowMs - last < config.cooldownMs
    ) {
      return "cooldown";
    }
    return null;
  };

  const account = (entry: AutomationJournalEntry) => {
    const taskId = entry.event.scope.taskId;
    if (taskId !== undefined) taskDeliveries.set(taskId, (taskDeliveries.get(taskId) ?? 0) + 1);
    lastDeliveryAt.set(entry.event.correlationId, nowMs);
  };

  /** Files one entry: on its own when suppressed, otherwise into `group`. */
  const place = (entry: AutomationJournalEntry, group: Array<AutomationJournalEntry>) => {
    const suppressedReason = suppression(entry);
    if (suppressedReason === null) {
      account(entry);
      group.push(entry);
    } else {
      deliveries.push({ entries: [entry], suppressedReason });
    }
  };

  if (config.deliveryMode === "each") {
    for (const entry of input.entries) {
      const group: Array<AutomationJournalEntry> = [];
      place(entry, group);
      if (group.length > 0) deliveries.push({ entries: group, suppressedReason: null });
    }
    return { deliveries, cursor: input.scannedThrough };
  }

  const windowMs = config.batchWindowMs ?? DEFAULT_HOOK_BATCH_WINDOW_MS;
  let index = 0;
  while (index < input.entries.length) {
    const first = input.entries[index]!;
    const windowEnd = recordedAtMs(first) + windowMs;
    // The window is still open: stop in front of it and look again later.
    if (nowMs < windowEnd) return { deliveries, cursor: first.cursor - 1 };
    const group: Array<AutomationJournalEntry> = [];
    while (index < input.entries.length && group.length < HOOK_MAX_BATCH_ENTRIES) {
      const entry = input.entries[index]!;
      if (recordedAtMs(entry) > windowEnd) break;
      place(entry, group);
      index++;
    }
    if (group.length > 0) deliveries.push({ entries: group, suppressedReason: null });
  }
  return { deliveries, cursor: input.scannedThrough };
};

/** Stable for a hook and the events it carries, whatever the attempt or restart. */
export const deliveryDedupKey = (
  hookId: string,
  entries: ReadonlyArray<AutomationJournalEntry>,
) => {
  const first = entries[0]?.event.eventId ?? "none";
  const last = entries.at(-1)?.event.eventId ?? first;
  return entries.length <= 1
    ? `${hookId}:${first}`
    : `${hookId}:${first}..${last}#${entries.length}`;
};

/**
 * Delay before the next attempt: exponential from the policy's initial delay,
 * capped at its maximum, with the upper half randomized so hooks that failed
 * together do not retry together. `jitter` is a number in [0, 1).
 */
export const retryDelayMs = (retry: HookRetryPolicy, attempt: number, jitter: number) => {
  const ceiling = Math.min(retry.maxDelayMs, retry.initialDelayMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(ceiling / 2 + (ceiling / 2) * jitter);
};
