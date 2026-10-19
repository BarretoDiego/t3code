import { threadPullRequestSearchTerms } from "@t3tools/shared/threadPullRequests";
import {
  canSnooze,
  effectiveSnoozed,
  hasQueuedTurnStart,
  QUEUED_TURN_START_GRACE_MS,
  resolveSnoozePresets,
  snoozeWakeLabel,
} from "@t3tools/client-runtime/state/thread-settled";
import type { SnoozePreset } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { resolveThreadProviderStack } from "@t3tools/client-runtime/state/models";
import { threadSearchMatchKey } from "@t3tools/client-runtime/state/thread-search";
import {
  buildThreadNesting,
  flattenThreadNesting,
  resolveThreadNestingSignal,
  THREAD_NESTING_CHILD_LIMIT,
  threadNestingAncestorKeys,
  type ThreadNestingDisplay,
  type ThreadNestingSignal,
  type ThreadNestingSummary,
} from "@t3tools/client-runtime/state/thread-relationships";
import {
  createInboxReturnTracker,
  isThreadWorking,
  sortInboxThreadsByReturn,
  sortWorkingThreadsBySend,
} from "@t3tools/client-runtime/state/thread-inbox";
import {
  sortActiveThreadsByOrderKey,
  resolveSettledThreadTimestamp,
  sortPinnedThreadsByOrderKey,
  sortSettledThreads,
} from "@t3tools/client-runtime/state/thread-sort";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

import type { ThreadListProvider } from "../../state/thread-list-environments";
import type { ThreadMoveAvailability } from "./threadOrder";

import { relativeTime } from "../../lib/time";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";

import {
  applyPendingThreadOrder,
  reconcilePendingThreadOrder,
  type PendingThreadOrder,
} from "./threadOrder";

export { snoozeWakeLabel };

export const threadListInboxReturns = createInboxReturnTracker();

export function resolveThreadListV2ProviderDrivers(
  thread: Pick<EnvironmentThreadShell, "providerInstanceHistory" | "modelSelection" | "runtime">,
  providers: ReadonlyArray<ThreadListProvider> | undefined,
): ReadonlyArray<string> {
  if (providers === undefined) return [];
  const stack = resolveThreadProviderStack(thread);
  const drivers = stack.flatMap((instanceId) => {
    const driver = providers.find((provider) => provider.instanceId === instanceId)?.driver;
    return driver === undefined ? [] : [driver];
  });
  const currentDriver = providers.find(
    (provider) => provider.instanceId === stack[stack.length - 1],
  )?.driver;
  return currentDriver === undefined ? [] : drivers;
}

export type ThreadListV2Status =
  | "approval"
  | "input"
  | "working"
  | "waiting"
  | "failed"
  | "limited"
  | "ready";
export type ThreadListV2SwipeAction = "archive" | "settle" | "unsettle" | "snooze" | "unsnooze";

export function resolveThreadListV2SnoozeMenuSelection(input: {
  readonly event: string;
  readonly displayedPresets: ReadonlyArray<SnoozePreset>;
  readonly now: Date;
}):
  | { readonly _tag: "selected"; readonly preset: SnoozePreset }
  | { readonly _tag: "expired" }
  | { readonly _tag: "not-snooze" } {
  if (!input.event.startsWith("snooze:")) return { _tag: "not-snooze" };

  const currentPreset = resolveSnoozePresets(input.now).find(
    (candidate) => input.event === `snooze:${candidate.id}`,
  );
  if (currentPreset) return { _tag: "selected", preset: currentPreset };

  const displayedPreset = input.displayedPresets.find(
    (candidate) => input.event === `snooze:${candidate.id}`,
  );
  if (displayedPreset && Date.parse(displayedPreset.snoozedUntil) > input.now.getTime()) {
    return { _tag: "selected", preset: displayedPreset };
  }
  return { _tag: "expired" };
}

export function resolveThreadListV2SwipeActions(input: {
  readonly variant: "card" | "slim";
  readonly settlementSupported: boolean;
  readonly snoozeSupported: boolean;
  readonly snoozable: boolean;
  readonly snoozed?: boolean;
}): {
  readonly primary: Exclude<ThreadListV2SwipeAction, "snooze">;
  readonly secondary: "snooze" | null;
} {
  if (input.snoozed === true) {
    return { primary: "unsnooze", secondary: null };
  }
  const primary = input.settlementSupported
    ? input.variant === "slim"
      ? "unsettle"
      : "settle"
    : "archive";
  return {
    primary,
    secondary: input.snoozeSupported && input.snoozable ? "snooze" : null,
  };
}

export function resolveThreadListV2SnoozeGateExpiryMs(
  thread: Pick<
    EnvironmentThreadShell,
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "pendingSubagentRequest"
    | "latestRun"
    | "latestUserMessageAt"
    | "runtime"
  >,
  options: { readonly now: string },
): number | null {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return null;
  if (thread.pendingSubagentRequest != null) return null;
  if (!hasQueuedTurnStart(thread, options)) return null;
  const messageAtMs = Date.parse(thread.latestUserMessageAt ?? "");
  if (Number.isNaN(messageAtMs)) return null;
  return messageAtMs + QUEUED_TURN_START_GRACE_MS;
}

export const THREAD_LIST_V2_SETTLED_INITIAL_COUNT = 10;
export const THREAD_LIST_V2_SETTLED_PAGE_COUNT = 25;

export function threadHasUnseenCompletion(
  thread: Pick<EnvironmentThreadShell, "latestRun" | "lastVisitedAt">,
): boolean {
  const completedAt = thread.latestRun?.completedAt;
  if (!completedAt) return false;
  const completedAtMs = Date.parse(completedAt);
  if (Number.isNaN(completedAtMs)) return false;
  if (!thread.lastVisitedAt) return false;
  const lastVisitedAtMs = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(lastVisitedAtMs)) return true;
  return completedAtMs > lastVisitedAtMs;
}

export function resolveThreadListV2Status(
  thread: Pick<
    EnvironmentThreadShell,
    "hasPendingApprovals" | "hasPendingUserInput" | "pendingSubagentRequest" | "runtime"
  >,
): ThreadListV2Status {
  if (thread.hasPendingApprovals || thread.pendingSubagentRequest === "approval") {
    return "approval";
  }
  if (thread.hasPendingUserInput || thread.pendingSubagentRequest === "user_input") {
    return "input";
  }
  if (
    thread.runtime !== null &&
    ["preparing", "queued", "starting", "running", "waiting"].includes(thread.runtime.status)
  ) {
    return "working";
  }
  if (thread.runtime?.status === "idle") {
    return "waiting";
  }
  if (thread.runtime?.status === "failed") {
    return thread.runtime.lastErrorClass === "usage_limit" ? "limited" : "failed";
  }
  return "ready";
}

/** NaN-safe Date.parse for sort comparators: a malformed timestamp must not
    poison the whole ordering, so it sinks to the epoch instead. */
const NO_KEYS: ReadonlySet<string> = new Set<string>();

function parseTimestampMs(isoDate: string): number {
  const parsed = Date.parse(isoDate);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function sortThreadsForListV2<
  T extends {
    readonly id: string;
    readonly createdAt: string;
    readonly unsettledAt?: string | null | undefined;
    readonly activeOrderKey?: string | null | undefined;
    readonly environmentId?: string | undefined;
  },
>(threads: readonly T[]): T[] {
  return sortActiveThreadsByOrderKey(threads);
}

export function getThreadListV2OrderedSection(input: {
  readonly threads: readonly EnvironmentThreadShell[];
  readonly section: "pinned" | "active";
  readonly pendingOrder?: PendingThreadOrder | null;
  readonly now: string;
  readonly settlementEnvironmentIds?: ReadonlySet<EnvironmentId>;
  readonly snoozeEnvironmentIds?: ReadonlySet<EnvironmentId>;
  readonly queuedThreadKeys?: ReadonlySet<string>;
}): EnvironmentThreadShell[] {
  const isParked = (thread: EnvironmentThreadShell) =>
    ((input.settlementEnvironmentIds?.has(thread.environmentId) ?? true) &&
      thread.settledOverride === "settled" &&
      input.queuedThreadKeys?.has(`${thread.environmentId}:${thread.id}`) !== true) ||
    ((input.snoozeEnvironmentIds?.has(thread.environmentId) ?? true) &&
      effectiveSnoozed(thread, { now: input.now }));
  // Nested subagents are placed by their parent, so only top-level rows have
  // a slot to move.
  const threads = buildThreadNesting({
    threads: input.threads,
    isListed: (thread) => thread.archivedAt === null,
  })
    .roots.filter(
      ({ thread, summary }) =>
        (summary?.live === true || !isParked(thread)) &&
        (thread.pinnedAt != null) === (input.section === "pinned"),
    )
    .map((root) => root.thread);
  const ordered =
    input.section === "pinned"
      ? sortPinnedThreadsByOrderKey(threads)
      : sortActiveThreadsByOrderKey(threads);
  const pending =
    input.pendingOrder?.section === input.section
      ? reconcilePendingThreadOrder(input.pendingOrder, ordered)
      : null;
  return applyPendingThreadOrder(ordered, input.section, pending);
}

export interface ThreadListV2Item {
  readonly thread: EnvironmentThreadShell;
  readonly variant: "card" | "slim";
  readonly snoozed: boolean;
  readonly pinned: boolean;
  readonly isLast: boolean;
}

/** What a row says about the subagent threads nested under it. */
export interface ThreadListV2NestedSummary {
  readonly total: number;
  readonly signal: ThreadNestingSignal | null;
  readonly expanded: boolean;
  /** Spoken summary, e.g. "3 subagents, 1 awaiting approval". */
  readonly label: string;
}

const NESTED_SIGNAL_PHRASE: Record<ThreadNestingSignal, string> = {
  approval: "awaiting approval",
  input: "awaiting input",
  failed: "failed",
  working: "working",
};

function summarizeNestedThreads(
  summary: ThreadNestingSummary,
  expanded: boolean,
): ThreadListV2NestedSummary {
  const reported = (["approval", "input", "failed", "working"] as const)
    .filter((signal) => summary.counts[signal] > 0)
    .map((signal) => `${summary.counts[signal]} ${NESTED_SIGNAL_PHRASE[signal]}`);
  return {
    total: summary.total,
    signal: summary.signal,
    expanded,
    label: [`${summary.total} ${summary.total === 1 ? "subagent" : "subagents"}`, ...reported].join(
      ", ",
    ),
  };
}

function nestedSummariesAreEqual(
  previous: ThreadListV2NestedSummary | null,
  next: ThreadListV2NestedSummary | null,
): boolean {
  if (previous === null || next === null) return previous === next;
  return previous.expanded === next.expanded && previous.label === next.label;
}

export interface ThreadListV2Layout {
  readonly items: ThreadListV2Item[];
  /** Subagent rows to draw under each top-level item, keyed by
      `environmentId:threadId`. `items` itself stays top-level, so section
      indexes, reordering, and arranging never see a nested row. */
  readonly nestedByKey: ReadonlyMap<string, ThreadNestingDisplay<EnvironmentThreadShell>>;
  /** Settled threads beyond the render limit (behind "Show more"). */
  readonly hiddenSettledCount: number;
  readonly workingCount: number;
  readonly workingShelfHeaderIndex: number | null;
  readonly snoozedCount: number;
  readonly snoozedShelfHeaderIndex: number | null;
  readonly settledCount: number;
  readonly settledShelfHeaderIndex: number | null;
  /**
   * Callers arm a timeout at this boundary so the list re-partitions the moment
   * a snooze expires instead of on the next minute tick.
   */
  readonly nextSnoozeWakeAt: string | null;
}

export interface ThreadListV2ThreadListItem {
  readonly type: "v2-thread";
  readonly key: string;
  readonly item: ThreadListV2Item;
  readonly snoozeWakeLabelText: string | undefined;
  readonly timeLabel: string;
  readonly snoozePresetMinute: string | undefined;
  readonly showTrailingDivider: boolean;
  /**
   * Carried on the item so an outbox write (which never touches the thread
   * shell) reaches the row through recycled-list equality instead of leaving a
   * stale icon.
   */
  readonly hasQueuedMessages: boolean;
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
  /** Null when the thread has no nested subagents. */
  readonly nested: ThreadListV2NestedSummary | null;
}

/** A subagent thread drawn indented under its parent. */
export interface ThreadListV2NestedThreadListItem {
  readonly type: "v2-nested-thread";
  readonly key: string;
  readonly thread: EnvironmentThreadShell;
  /** `environmentId:threadId`, the key its own expansion is stored under. */
  readonly threadKey: string;
  /** 1 for a direct child of the top-level row. */
  readonly depth: number;
  readonly signal: ThreadNestingSignal | null;
  /** Blank while the row shows a status instead of a time. */
  readonly timeLabel: string;
  readonly nested: ThreadListV2NestedSummary | null;
  readonly showTrailingDivider: boolean;
}

/** Stands in for the quiet subagents a long list leaves out. */
export interface ThreadListV2NestedSettledListItem {
  readonly type: "v2-nested-settled";
  readonly key: string;
  readonly groupKey: string;
  readonly depth: number;
  readonly count: number;
  readonly expanded: boolean;
  readonly showTrailingDivider: boolean;
}

export interface ThreadListV2NestedMoreListItem {
  readonly type: "v2-nested-more";
  readonly key: string;
  readonly parentKey: string;
  readonly depth: number;
  readonly hiddenCount: number;
  readonly showTrailingDivider: boolean;
}

export interface ThreadListV2PendingListItem {
  readonly type: "v2-pending";
  readonly key: string;
  readonly pendingTask: PendingNewTask;
  readonly showPendingDivider: boolean;
  readonly showTrailingDivider: boolean;
}

export interface ThreadListV2WorkingShelfListItem {
  readonly type: "v2-working-shelf";
  readonly key: "v2-working-shelf";
  readonly count: number;
  readonly expanded: boolean;
  readonly disabled: boolean;
}

export interface ThreadListV2SnoozedShelfListItem {
  readonly type: "v2-snoozed-shelf";
  readonly key: "v2-snoozed-shelf";
  readonly count: number;
  readonly expanded: boolean;
  /**
   * Carried on the item because a recycled cell ignores the render closure —
   * without it the header would stay visibly disabled (or enabled too early)
   * after the preference load lands.
   */
  readonly disabled: boolean;
}

export interface ThreadListV2SettledShelfListItem {
  readonly type: "v2-settled-shelf";
  readonly key: "v2-settled-shelf";
  readonly count: number;
  readonly expanded: boolean;
  readonly disabled: boolean;
}

export type ThreadListV2ListItem =
  | ThreadListV2ThreadListItem
  | ThreadListV2NestedThreadListItem
  | ThreadListV2NestedMoreListItem
  | ThreadListV2NestedSettledListItem
  | ThreadListV2PendingListItem
  | ThreadListV2WorkingShelfListItem
  | ThreadListV2SnoozedShelfListItem
  | ThreadListV2SettledShelfListItem;

export function isThreadListV2ListItem(value: {
  readonly type: string;
}): value is ThreadListV2ListItem {
  return (
    value.type === "v2-thread" ||
    value.type === "v2-nested-thread" ||
    value.type === "v2-nested-more" ||
    value.type === "v2-nested-settled" ||
    value.type === "v2-pending" ||
    value.type === "v2-working-shelf" ||
    value.type === "v2-snoozed-shelf" ||
    value.type === "v2-settled-shelf"
  );
}

/**
 * Item objects are rebuilt on every minute tick and every partition run;
 * without this the lists would consider every mounted row changed and re-render
 * all of them (each carrying a swipeable + a PR subscription).
 */
export function threadListV2ListItemsAreEqual(
  previous: ThreadListV2ListItem,
  item: ThreadListV2ListItem,
): boolean {
  switch (item.type) {
    case "v2-thread":
      return (
        previous.type === "v2-thread" &&
        previous.key === item.key &&
        previous.item.thread === item.item.thread &&
        previous.item.variant === item.item.variant &&
        previous.item.snoozed === item.item.snoozed &&
        previous.item.pinned === item.item.pinned &&
        previous.snoozeWakeLabelText === item.snoozeWakeLabelText &&
        previous.timeLabel === item.timeLabel &&
        previous.snoozePresetMinute === item.snoozePresetMinute &&
        previous.showTrailingDivider === item.showTrailingDivider &&
        previous.hasQueuedMessages === item.hasQueuedMessages &&
        previous.canMoveUp === item.canMoveUp &&
        previous.canMoveDown === item.canMoveDown &&
        nestedSummariesAreEqual(previous.nested, item.nested)
      );
    case "v2-nested-thread":
      return (
        previous.type === "v2-nested-thread" &&
        previous.key === item.key &&
        previous.thread === item.thread &&
        previous.depth === item.depth &&
        previous.timeLabel === item.timeLabel &&
        previous.showTrailingDivider === item.showTrailingDivider &&
        nestedSummariesAreEqual(previous.nested, item.nested)
      );
    case "v2-nested-settled":
      return (
        previous.type === "v2-nested-settled" &&
        previous.key === item.key &&
        previous.depth === item.depth &&
        previous.count === item.count &&
        previous.expanded === item.expanded &&
        previous.showTrailingDivider === item.showTrailingDivider
      );
    case "v2-nested-more":
      return (
        previous.type === "v2-nested-more" &&
        previous.key === item.key &&
        previous.depth === item.depth &&
        previous.hiddenCount === item.hiddenCount &&
        previous.showTrailingDivider === item.showTrailingDivider
      );
    case "v2-pending":
      return (
        previous.type === "v2-pending" &&
        previous.key === item.key &&
        previous.pendingTask === item.pendingTask &&
        previous.showPendingDivider === item.showPendingDivider &&
        previous.showTrailingDivider === item.showTrailingDivider
      );
    case "v2-working-shelf":
      return (
        previous.type === "v2-working-shelf" &&
        previous.count === item.count &&
        previous.expanded === item.expanded &&
        previous.disabled === item.disabled
      );
    case "v2-snoozed-shelf":
      return (
        previous.type === "v2-snoozed-shelf" &&
        previous.count === item.count &&
        previous.expanded === item.expanded &&
        previous.disabled === item.disabled
      );
    case "v2-settled-shelf":
      return (
        previous.type === "v2-settled-shelf" &&
        previous.count === item.count &&
        previous.expanded === item.expanded &&
        previous.disabled === item.disabled
      );
  }
}

function resolveThreadListV2ItemTimeLabel(
  item: ThreadListV2Item,
  showSnoozeWakeLabel: boolean,
): string {
  const { thread, variant, snoozed } = item;
  if (showSnoozeWakeLabel) return "";
  if (
    variant === "card" &&
    (resolveThreadListV2Status(thread) !== "ready" || threadHasUnseenCompletion(thread))
  )
    return "";
  const settledTimestamp =
    variant === "slim" && !snoozed ? resolveSettledThreadTimestamp(thread) : null;
  return relativeTime(
    settledTimestamp ?? thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt,
  );
}

function nestedSummaryFor(
  display: ThreadNestingDisplay<EnvironmentThreadShell> | undefined,
): ThreadListV2NestedSummary | null {
  return display === undefined ? null : summarizeNestedThreads(display.summary, display.expanded);
}

/**
 * Builds the shared mobile order: active → pending → working shelf (beta) →
 * snoozed shelf → settled. Pending tasks are waiting rather than asking, and
 * busy or parked work remains reachable without competing with either the
 * inbox or settled history.
 */
export function buildThreadListV2ListItems(input: {
  readonly items: ReadonlyArray<ThreadListV2Item>;
  readonly pendingTasks: ReadonlyArray<PendingNewTask>;
  readonly workingCount?: number;
  readonly workingShelfExpanded?: boolean;
  readonly workingShelfHeaderIndex?: number | null;
  readonly snoozedCount?: number;
  readonly snoozedShelfExpanded?: boolean;
  readonly snoozedShelfHeaderIndex?: number | null;
  readonly settledCount?: number;
  readonly settledShelfExpanded?: boolean;
  readonly settledShelfHeaderIndex?: number | null;
  readonly snoozeLabelNow?: string;
  readonly snoozeEnvironmentIds?: ReadonlySet<EnvironmentId>;
  readonly queuedThreadKeys?: ReadonlySet<string>;
  readonly moveAvailability?: ReadonlyMap<string, ThreadMoveAvailability>;
  readonly shelfPreferencesLoading?: boolean;
  /** The layout's `nestedByKey`. Absent = no nested rows (tests). */
  readonly nestedByKey?: ReadonlyMap<string, ThreadNestingDisplay<EnvironmentThreadShell>>;
}): ThreadListV2ListItem[] {
  const queuedThreadKeys = input.queuedThreadKeys?.size ? input.queuedThreadKeys : undefined;
  const threadItems = input.items.map((item): ThreadListV2ListItem => {
    const snoozeWakeLabelText =
      item.snoozed && item.thread.snoozedUntil != null && input.snoozeLabelNow !== undefined
        ? snoozeWakeLabel(item.thread.snoozedUntil, { now: input.snoozeLabelNow })
        : undefined;
    // The minute clock belongs on the item, not the list's extraData, so the
    // recycler's equality can confine the per-minute re-render to rows whose
    // snooze menu actually shows preset times.
    const snoozePresetMinute =
      !item.snoozed &&
      input.snoozeLabelNow !== undefined &&
      (input.snoozeEnvironmentIds?.has(item.thread.environmentId) ?? true) &&
      canSnooze(item.thread, { now: input.snoozeLabelNow })
        ? input.snoozeLabelNow
        : undefined;
    const move =
      item.variant === "card"
        ? input.moveAvailability?.get(`${item.thread.environmentId}:${item.thread.id}`)
        : undefined;
    return {
      type: "v2-thread",
      key: `v2-thread:${item.thread.environmentId}:${item.thread.id}`,
      item,
      snoozeWakeLabelText,
      timeLabel: resolveThreadListV2ItemTimeLabel(item, snoozeWakeLabelText !== undefined),
      snoozePresetMinute,
      showTrailingDivider: false,
      hasQueuedMessages:
        queuedThreadKeys?.has(`${item.thread.environmentId}:${item.thread.id}`) === true,
      canMoveUp: move?.canMoveUp === true,
      canMoveDown: move?.canMoveDown === true,
      nested: nestedSummaryFor(
        input.nestedByKey?.get(`${item.thread.environmentId}:${item.thread.id}`),
      ),
    };
  });
  const pendingItems = input.pendingTasks.map((pendingTask, index): ThreadListV2ListItem => ({
    type: "v2-pending",
    key: `v2-${pendingTask.key}`,
    pendingTask,
    showPendingDivider: index === 0,
    showTrailingDivider: false,
  }));
  const workingCount = input.workingCount ?? 0;
  const workingShelfHeaderIndex = input.workingShelfHeaderIndex ?? null;
  const snoozedCount = input.snoozedCount ?? 0;
  const snoozedShelfHeaderIndex = input.snoozedShelfHeaderIndex ?? null;
  const settledCount = input.settledCount ?? 0;
  const settledShelfHeaderIndex = input.settledShelfHeaderIndex ?? null;
  const snoozedEnd = settledShelfHeaderIndex ?? threadItems.length;
  const workingEnd = snoozedShelfHeaderIndex ?? snoozedEnd;
  const activeEnd = workingShelfHeaderIndex ?? workingEnd;
  const result: ThreadListV2ListItem[] = [...threadItems.slice(0, activeEnd), ...pendingItems];
  const shelfDisabled = input.shelfPreferencesLoading === true;
  if (workingShelfHeaderIndex !== null && workingCount > 0) {
    result.push({
      type: "v2-working-shelf",
      key: "v2-working-shelf",
      count: workingCount,
      expanded: input.workingShelfExpanded === true,
      disabled: shelfDisabled,
    });
    result.push(...threadItems.slice(workingShelfHeaderIndex, workingEnd));
  }
  if (snoozedShelfHeaderIndex !== null && snoozedCount > 0) {
    result.push({
      type: "v2-snoozed-shelf",
      key: "v2-snoozed-shelf",
      count: snoozedCount,
      expanded: input.snoozedShelfExpanded === true,
      disabled: shelfDisabled,
    });
    result.push(...threadItems.slice(snoozedShelfHeaderIndex, snoozedEnd));
  }
  if (settledShelfHeaderIndex !== null && settledCount > 0) {
    result.push({
      type: "v2-settled-shelf",
      key: "v2-settled-shelf",
      count: settledCount,
      expanded: input.settledShelfExpanded !== false,
      disabled: shelfDisabled,
    });
    result.push(...threadItems.slice(settledShelfHeaderIndex));
  }
  // Nested rows follow their parent wherever the splice above put it.
  const nestedByKey = input.nestedByKey;
  const withNested =
    nestedByKey === undefined || nestedByKey.size === 0
      ? result
      : result.flatMap((entry): ThreadListV2ListItem[] => {
          if (entry.type !== "v2-thread") return [entry];
          const display = nestedByKey.get(
            `${entry.item.thread.environmentId}:${entry.item.thread.id}`,
          );
          if (display === undefined) return [entry];
          return [
            entry,
            ...display.rows.map((row): ThreadListV2ListItem =>
              row.kind === "settled"
                ? {
                    type: "v2-nested-settled",
                    key: `v2-nested-settled:${row.key}`,
                    groupKey: row.key,
                    depth: row.depth,
                    count: row.count,
                    expanded: row.expanded,
                    showTrailingDivider: false,
                  }
                : row.kind === "more"
                  ? {
                      type: "v2-nested-more",
                      key: `v2-nested-more:${row.key}`,
                      parentKey: row.parentKey,
                      depth: row.depth,
                      hiddenCount: row.hiddenCount,
                      showTrailingDivider: false,
                    }
                  : {
                      type: "v2-nested-thread",
                      key: `v2-nested-thread:${row.key}`,
                      thread: row.thread,
                      threadKey: row.key,
                      depth: row.depth,
                      signal: resolveThreadNestingSignal(row.thread),
                      // A row showing a status draws no time, so its minute
                      // tick must not invalidate the cell.
                      timeLabel:
                        resolveThreadNestingSignal(row.thread) !== null ||
                        threadHasUnseenCompletion(row.thread)
                          ? ""
                          : relativeTime(
                              row.thread.latestUserMessageAt ??
                                row.thread.updatedAt ??
                                row.thread.createdAt,
                            ),
                      nested:
                        row.summary === null
                          ? null
                          : summarizeNestedThreads(row.summary, row.expanded),
                      showTrailingDivider: false,
                    },
            ),
          ];
        });
  // Hairlines depend on the final neighbour, so they are stamped after the
  // splice: a recycled cell only re-renders when its divider actually flips.
  // A parent draws none above its own nested rows; the last nested row draws
  // the one that closes the family.
  return withNested.map((entry, index) => {
    if (
      entry.type !== "v2-thread" &&
      entry.type !== "v2-pending" &&
      entry.type !== "v2-nested-thread" &&
      entry.type !== "v2-nested-more" &&
      entry.type !== "v2-nested-settled"
    ) {
      return entry;
    }
    const next = withNested[index + 1];
    const showTrailingDivider =
      next?.type === "v2-thread" || (next?.type === "v2-pending" && !next.showPendingDivider);
    return showTrailingDivider === entry.showTrailingDivider
      ? entry
      : { ...entry, showTrailingDivider };
  });
}

// Shells are immutable and the settled sort reads only their own fields, so an
// element-identical input has an identical output.
let lastSettledInput: ReadonlyArray<EnvironmentThreadShell> = [];
let lastSettledOutput: ReadonlyArray<EnvironmentThreadShell> = [];

function sortSettledThreadsReusingLast(
  settled: ReadonlyArray<EnvironmentThreadShell>,
): ReadonlyArray<EnvironmentThreadShell> {
  if (settled.length === lastSettledInput.length) {
    let same = true;
    for (let index = 0; index < settled.length; index += 1) {
      if (settled[index] !== lastSettledInput[index]) {
        same = false;
        break;
      }
    }
    if (same) return lastSettledOutput;
  }
  lastSettledInput = settled;
  lastSettledOutput = sortSettledThreads(settled);
  return lastSettledOutput;
}

export function buildThreadListV2Items(input: {
  readonly pendingOrder?: PendingThreadOrder | null;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly environmentId: EnvironmentId | null;
  readonly projectRefs?: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
  }> | null;
  readonly searchQuery: string;
  readonly matchedThreadKeys?: ReadonlySet<string>;
  readonly settlementEnvironmentIds?: ReadonlySet<EnvironmentId>;
  readonly snoozeEnvironmentIds?: ReadonlySet<EnvironmentId>;
  readonly settledLimit?: number;
  readonly now: string;
  readonly workingShelfEnabled?: boolean;
  readonly workingShelfExpanded?: boolean;
  readonly inboxReturnAt?: (thread: EnvironmentThreadShell) => number | undefined;
  readonly snoozedShelfExpanded?: boolean;
  readonly settledShelfExpanded?: boolean;
  readonly selectedThreadKey?: string | null;
  readonly queuedThreadKeys?: ReadonlySet<string>;
  /** The user's show/hide choice per parent, keyed by `environmentId:threadId`.
      Without one, subagents show while any of them is live. */
  readonly nestedExpandedByKey?: Readonly<Record<string, boolean>>;
  /** Parents whose long subagent list the user opened in full. */
  readonly nestedShowAllKeys?: ReadonlySet<string>;
}): ThreadListV2Layout {
  const now = input.now;
  const pending =
    input.pendingOrder == null
      ? null
      : reconcilePendingThreadOrder(
          input.pendingOrder,
          getThreadListV2OrderedSection({
            ...input,
            section: input.pendingOrder.section,
            pendingOrder: null,
          }),
        );
  const query = input.searchQuery.trim().toLocaleLowerCase();
  const projectKeys = input.projectRefs
    ? new Set(input.projectRefs.map((ref) => `${ref.environmentId}:${ref.projectId}`))
    : null;

  const workingShelfEnabled = input.workingShelfEnabled === true;
  const pinned: EnvironmentThreadShell[] = [];
  const active: EnvironmentThreadShell[] = [];
  const working: EnvironmentThreadShell[] = [];
  const settled: EnvironmentThreadShell[] = [];
  const snoozed: EnvironmentThreadShell[] = [];
  let nextSnoozeWakeAt: string | null = null;
  const isListed = (thread: EnvironmentThreadShell) => {
    if (thread.archivedAt !== null) return false;
    // The server stamps settledOverride for the tail.
    if (input.environmentId !== null && thread.environmentId !== input.environmentId) return false;
    if (projectKeys !== null && !projectKeys.has(`${thread.environmentId}:${thread.projectId}`)) {
      return false;
    }
    return !(
      query.length > 0 &&
      !thread.title.toLocaleLowerCase().includes(query) &&
      !threadPullRequestSearchTerms(thread).some((term) =>
        term.toLocaleLowerCase().includes(query),
      ) &&
      input.matchedThreadKeys?.has(
        threadSearchMatchKey({
          environmentId: thread.environmentId,
          threadId: thread.id,
        }),
      ) !== true
    );
  };
  const isSnoozed = (thread: EnvironmentThreadShell) =>
    (input.snoozeEnvironmentIds?.has(thread.environmentId) ?? true) &&
    effectiveSnoozed(thread, { now });
  const isSettled = (thread: EnvironmentThreadShell) =>
    (input.settlementEnvironmentIds?.has(thread.environmentId) ?? true) &&
    thread.settledOverride === "settled" &&
    input.queuedThreadKeys?.has(`${thread.environmentId}:${thread.id}`) !== true;
  // Subagent threads ride under the thread that spawned them (the same forest
  // the web sidebar builds), so only its top-level rows are sectioned.
  const nesting = buildThreadNesting({
    threads: input.threads,
    isListed,
  });
  for (const { thread, summary } of nesting.roots) {
    // Keep a live family visible together without changing its saved shelf.
    const carriesLiveWork = summary?.live === true;
    if (!carriesLiveWork && isSnoozed(thread)) {
      snoozed.push(thread);
      if (
        thread.snoozedUntil != null &&
        (nextSnoozeWakeAt === null ||
          parseTimestampMs(thread.snoozedUntil) < parseTimestampMs(nextSnoozeWakeAt))
      ) {
        nextSnoozeWakeAt = thread.snoozedUntil;
      }
      continue;
    }
    if (!carriesLiveWork && isSettled(thread)) {
      settled.push(thread);
    } else if (thread.pinnedAt != null) {
      pinned.push(thread);
    } else if (workingShelfEnabled && (isThreadWorking(thread) || carriesLiveWork)) {
      working.push(thread);
    } else {
      active.push(thread);
    }
  }

  const orderedActive = workingShelfEnabled
    ? sortInboxThreadsByReturn(active, input.inboxReturnAt)
    : applyPendingThreadOrder(sortThreadsForListV2(active), "active", pending);
  const orderedWorking = sortWorkingThreadsBySend(working);
  const orderedSnoozed = [...snoozed].sort(
    (left, right) =>
      parseTimestampMs(left.snoozedUntil ?? "") - parseTimestampMs(right.snoozedUntil ?? ""),
  );
  // A closed shelf keeps the row that carries the selected thread: the
  // thread itself, or the parent it is nested under.
  const selectedPathKeys =
    input.selectedThreadKey == null
      ? []
      : [input.selectedThreadKey, ...threadNestingAncestorKeys(nesting, input.selectedThreadKey)];
  const selectedThreadKey = selectedPathKeys.at(-1) ?? null;
  const activePathKeys = new Set(selectedPathKeys.length > 1 ? selectedPathKeys : []);
  const nestedByKey = new Map<string, ThreadNestingDisplay<EnvironmentThreadShell>>();
  for (const root of nesting.roots) {
    const display = flattenThreadNesting({
      node: root,
      expandedOverrides: input.nestedExpandedByKey ?? {},
      activePathKeys,
      childLimit: THREAD_NESTING_CHILD_LIMIT,
      showAllKeys: input.nestedShowAllKeys ?? NO_KEYS,
    });
    if (display !== null) nestedByKey.set(root.key, display);
  }
  const visibleWorking =
    input.workingShelfExpanded === true
      ? orderedWorking
      : orderedWorking.filter(
          (thread) => `${thread.environmentId}:${thread.id}` === selectedThreadKey,
        );
  const visibleSnoozed =
    input.snoozedShelfExpanded === true
      ? orderedSnoozed
      : orderedSnoozed.filter(
          (thread) => `${thread.environmentId}:${thread.id}` === selectedThreadKey,
        );
  const orderedSettled = sortSettledThreadsReusingLast(settled);
  const settledLimit = input.settledLimit ?? Number.POSITIVE_INFINITY;
  const limitedSettled =
    orderedSettled.length > settledLimit ? orderedSettled.slice(0, settledLimit) : orderedSettled;
  const selectedSettled =
    selectedThreadKey === null
      ? undefined
      : orderedSettled
          .slice(limitedSettled.length)
          .find((thread) => `${thread.environmentId}:${thread.id}` === selectedThreadKey);
  const pagedSettled =
    selectedSettled === undefined ? limitedSettled : [...limitedSettled, selectedSettled];
  const visibleSettled =
    input.settledShelfExpanded !== false
      ? pagedSettled
      : pagedSettled.filter(
          (thread) => `${thread.environmentId}:${thread.id}` === selectedThreadKey,
        );

  const items: ThreadListV2Item[] = [];
  for (const thread of applyPendingThreadOrder(
    sortPinnedThreadsByOrderKey(pinned),
    "pinned",
    pending,
  )) {
    items.push({
      thread,
      variant: "card",
      snoozed: false,
      pinned: true,
      isLast: false,
    });
  }
  for (const thread of orderedActive) {
    items.push({
      thread,
      variant: "card",
      snoozed: false,
      pinned: false,
      isLast: false,
    });
  }
  const workingShelfHeaderIndex = orderedWorking.length > 0 ? items.length : null;
  for (const thread of visibleWorking) {
    items.push({
      thread,
      variant: "card",
      snoozed: false,
      pinned: false,
      isLast: false,
    });
  }
  const snoozedShelfHeaderIndex = orderedSnoozed.length > 0 ? items.length : null;
  for (const thread of visibleSnoozed) {
    items.push({
      thread,
      variant: "slim",
      snoozed: true,
      pinned: false,
      isLast: false,
    });
  }
  const settledShelfHeaderIndex = orderedSettled.length > 0 ? items.length : null;
  for (const thread of visibleSettled) {
    items.push({
      thread,
      variant: "slim",
      snoozed: false,
      pinned: false,
      isLast: false,
    });
  }
  const last = items.at(-1);
  if (last) {
    items[items.length - 1] = { ...last, isLast: true };
  }
  return {
    items,
    nestedByKey,
    hiddenSettledCount: orderedSettled.length - pagedSettled.length,
    workingCount: orderedWorking.length,
    workingShelfHeaderIndex,
    snoozedCount: orderedSnoozed.length,
    snoozedShelfHeaderIndex,
    settledCount: orderedSettled.length,
    settledShelfHeaderIndex,
    nextSnoozeWakeAt,
  };
}
