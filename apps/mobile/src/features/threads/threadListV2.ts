import {
  canSnooze,
  effectiveSnoozed,
  hasQueuedTurnStart,
  pickSnoozePreset,
  QUEUED_TURN_START_GRACE_MS,
  resolveSnoozePresets,
  snoozeWakeLabel,
  threadWokeAt,
} from "@t3tools/client-runtime/state/thread-settled";
import type { SnoozePreset } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { resolveThreadProviderStack } from "@t3tools/client-runtime/state/models";
import {
  threadSearchMatchKey,
  threadSearchSubject,
} from "@t3tools/client-runtime/state/thread-search";
import { foldSearchQuery, rankSearchItems, scoreThreadSearch } from "@t3tools/shared/paletteSearch";
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
import type { SnoozePresetSetting } from "@t3tools/contracts/settings";

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
  | "request"
  | "working"
  | "waiting"
  | "failed"
  | "limited"
  | "ready";
export type ThreadListV2SwipeAction = "archive" | "settle" | "unsettle" | "snooze" | "unsnooze";

/**
 * Presets for a row's snooze menu, read at the list's minute instead of the
 * clock: the compiler keys a row's memo on its inputs, so a clock read inside
 * it would keep the times from the row's first render.
 */
export function resolveThreadListV2SnoozePresets(input: {
  readonly secondary: "snooze" | null;
  readonly now: string;
  readonly presets: ReadonlyArray<SnoozePresetSetting> | undefined;
}): ReadonlyArray<SnoozePreset> {
  return input.secondary === "snooze"
    ? resolveSnoozePresets(new Date(input.now), presetOptions(input.presets))
    : [];
}

function presetOptions(presets: ReadonlyArray<SnoozePresetSetting> | undefined) {
  return presets ? { presets } : {};
}

export function resolveThreadListV2SnoozeMenuSelection(input: {
  readonly event: string;
  readonly displayedPresets: ReadonlyArray<SnoozePreset>;
  readonly now: Date;
  readonly presets: ReadonlyArray<SnoozePresetSetting> | undefined;
}):
  | { readonly _tag: "selected"; readonly preset: SnoozePreset }
  | { readonly _tag: "expired" }
  | { readonly _tag: "not-snooze" } {
  if (!input.event.startsWith("snooze:")) return { _tag: "not-snooze" };
  const preset = pickSnoozePreset({
    shown: input.displayedPresets,
    id: input.event.slice("snooze:".length),
    now: input.now,
    ...presetOptions(input.presets),
  });
  return preset ? { _tag: "selected", preset } : { _tag: "expired" };
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

/** The earliest `snoozedUntil` strictly after `nowMs`, in epoch ms. */
export function nextSnoozeWakeAfter(
  threads: ReadonlyArray<{ readonly snoozedUntil?: string | null }>,
  nowMs: number,
): number | null {
  let next: number | null = null;
  for (const thread of threads) {
    if (thread.snoozedUntil == null) continue;
    const wakeAtMs = Date.parse(thread.snoozedUntil);
    if (wakeAtMs > nowMs && (next === null || wakeAtMs < next)) next = wakeAtMs;
  }
  return next;
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

export function resolveThreadListV2WokeAt(
  thread: EnvironmentThreadShell,
  options: { readonly now: string },
): string | null {
  // Older servers cannot persist an acknowledgement.
  if (thread.lastVisitedAt === undefined || thread.settledOverride === "settled") return null;
  const wokeAt = threadWokeAt(thread, options);
  const wokeAtMs = Date.parse(wokeAt ?? "");
  const lastVisitedAtMs = Date.parse(thread.lastVisitedAt ?? "");
  return !Number.isNaN(wokeAtMs) && (Number.isNaN(lastVisitedAtMs) || lastVisitedAtMs < wokeAtMs)
    ? wokeAt
    : null;
}

export function resolveThreadListV2Status(
  thread: Pick<
    EnvironmentThreadShell,
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "pendingSubagentRequest"
    | "pendingGuestMessageCount"
    | "runtime"
    | "blockedOnThreadWait"
  >,
): ThreadListV2Status {
  if (thread.hasPendingApprovals || thread.pendingSubagentRequest === "approval") {
    return "approval";
  }
  if (thread.hasPendingUserInput || thread.pendingSubagentRequest === "user_input") {
    return "input";
  }
  // A guest is waiting on the owner; the agent's own requests come first.
  if ((thread.pendingGuestMessageCount ?? 0) > 0) {
    return "request";
  }
  if (thread.runtime?.status === "running" && thread.blockedOnThreadWait === true) {
    return "waiting";
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
  readonly wokeAt: string | null;
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
  /** The settled rows the shelf may list, before its visible limit. */
  readonly listedSettledThreads: ReadonlyArray<EnvironmentThreadShell>;
  readonly workingCount: number;
  readonly workingShelfHeaderIndex: number | null;
  readonly snoozedCount: number;
  readonly snoozedShelfHeaderIndex: number | null;
  readonly settledCount: number;
  readonly settledShelfHeaderIndex: number | null;
  /** Arm a timeout here to repartition at snooze expiry rather than the next minute tick. */
  readonly nextSnoozeWakeAt: string | null;
  /** Threads listed only because their messages match the search. */
  readonly contentOnlyThreadKeys: ReadonlySet<string>;
}

export interface ThreadListV2ThreadListItem {
  readonly type: "v2-thread";
  readonly key: string;
  readonly item: ThreadListV2Item;
  readonly snoozeWakeLabelText: string | undefined;
  readonly timeLabel: string;
  readonly snoozePresetMinute: string | undefined;
  readonly showTrailingDivider: boolean;
  /** Include queued state in item equality; outbox writes do not update thread shells. */
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
  /** Include disabled state in item equality; recycled cells ignore render-closure updates. */
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

/** Compare rebuilt items by content so minute ticks and partition runs do not re-render every mounted row. */
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
        previous.item.wokeAt === item.item.wokeAt &&
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
    (resolveThreadListV2Status(thread) !== "ready" ||
      item.wokeAt !== null ||
      threadHasUnseenCompletion(thread))
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
    // Put the clock on items so recycler equality limits ticks to rows displaying snooze preset times.
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
  const result: ThreadListV2ListItem[] = [...pendingItems, ...threadItems.slice(0, activeEnd)];
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

// Immutable shells and field-only sorting make element-identical inputs produce identical output.
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
  readonly isWorking?: (thread: EnvironmentThreadShell) => boolean;
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
  /** Whether the shelf may list a settled row yet; older settled rows load in pages. */
  readonly isListedSettled?: (thread: EnvironmentThreadShell) => boolean;
  /** Settled threads in scope that are not local (older settled threads not loaded). */
  readonly unloadedSettledCount?: number;
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
  const query = foldSearchQuery(input.searchQuery);
  const nowMs = Date.parse(now);
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
  const isListed = (thread: EnvironmentThreadShell) =>
    thread.archivedAt === null &&
    (input.environmentId === null || thread.environmentId === input.environmentId) &&
    (projectKeys === null || projectKeys.has(`${thread.environmentId}:${thread.projectId}`));
  const listedThreads = input.threads.filter(isListed);
  // The same matches as the command palette, typo fallback included. Only
  // listed threads are ranked: a hidden exact match must not turn typos off.
  const rankedMatches =
    query.length > 0
      ? rankSearchItems(listedThreads, (thread, options) =>
          scoreThreadSearch(query, threadSearchSubject(thread, null), nowMs, {
            ...options,
            picks: false,
          }),
        ).map(({ item }) => item)
      : null;
  const matchingThreads = rankedMatches === null ? null : new Set(rankedMatches);
  // Threads listed only because their messages match; only their rows show
  // the message and open at it.
  const contentOnlyThreadKeys = new Set<string>();
  const isSnoozed = (thread: EnvironmentThreadShell) =>
    (input.snoozeEnvironmentIds?.has(thread.environmentId) ?? true) &&
    effectiveSnoozed(thread, { now });
  const isSettled = (thread: EnvironmentThreadShell) =>
    (input.settlementEnvironmentIds?.has(thread.environmentId) ?? true) &&
    thread.settledOverride === "settled" &&
    input.queuedThreadKeys?.has(`${thread.environmentId}:${thread.id}`) !== true;
  // Subagent threads ride under the thread that spawned them (the same forest
  // the web sidebar builds), so only its top-level rows are sectioned. Search
  // results stay flat, subagents included, in rank order.
  const nesting = buildThreadNesting({ threads: input.threads, isListed });
  const candidates =
    rankedMatches === null
      ? nesting.roots
      : listedThreads.map((thread) => ({ thread, summary: null }));
  for (const { thread, summary } of candidates) {
    if (matchingThreads !== null && !matchingThreads.has(thread)) {
      const key = threadSearchMatchKey({
        environmentId: thread.environmentId,
        threadId: thread.id,
      });
      if (input.matchedThreadKeys?.has(key) !== true) continue;
      contentOnlyThreadKeys.add(key);
    }
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
    } else if (
      workingShelfEnabled &&
      ((input.isWorking ?? isThreadWorking)(thread) || carriesLiveWork)
    ) {
      working.push(thread);
    } else {
      active.push(thread);
    }
  }

  if (rankedMatches !== null) {
    // Searching lists every match by rank across shelves, as the palette and
    // the web sidebar do, then threads listed for their messages in the
    // server's order. Each row keeps its shelf's look.
    const slim = new Set([...snoozed, ...settled]);
    const snoozedThreads = new Set(snoozed);
    const pinnedThreads = new Set(pinned);
    const threadByKey = new Map(
      listedThreads.map((thread) => [
        threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id }),
        thread,
      ]),
    );
    const contentOnly = [...(input.matchedThreadKeys ?? [])].flatMap((key) => {
      const thread = contentOnlyThreadKeys.has(key) ? threadByKey.get(key) : undefined;
      return thread ? [thread] : [];
    });
    const results = [...rankedMatches, ...contentOnly];
    return {
      items: results.map((thread, index) => ({
        thread,
        variant: slim.has(thread) ? "slim" : "card",
        snoozed: snoozedThreads.has(thread),
        pinned: pinnedThreads.has(thread),
        wokeAt: slim.has(thread) ? null : resolveThreadListV2WokeAt(thread, { now }),
        isLast: index === results.length - 1,
      })),
      nestedByKey: new Map(),
      hiddenSettledCount: 0,
      listedSettledThreads: [],
      workingCount: 0,
      workingShelfHeaderIndex: null,
      snoozedCount: 0,
      snoozedShelfHeaderIndex: null,
      settledCount: 0,
      settledShelfHeaderIndex: null,
      nextSnoozeWakeAt,
      contentOnlyThreadKeys,
    };
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
  const listedSettled =
    input.isListedSettled === undefined
      ? orderedSettled
      : orderedSettled.filter(input.isListedSettled);
  const settledTotal = orderedSettled.length + (input.unloadedSettledCount ?? 0);
  const settledLimit = input.settledLimit ?? Number.POSITIVE_INFINITY;
  const limitedSettled =
    listedSettled.length > settledLimit ? listedSettled.slice(0, settledLimit) : listedSettled;
  const selectedSettled =
    selectedThreadKey === null ||
    limitedSettled.some((thread) => `${thread.environmentId}:${thread.id}` === selectedThreadKey)
      ? undefined
      : orderedSettled.find(
          (thread) => `${thread.environmentId}:${thread.id}` === selectedThreadKey,
        );
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
      wokeAt: resolveThreadListV2WokeAt(thread, { now }),
      isLast: false,
    });
  }
  for (const thread of orderedActive) {
    items.push({
      thread,
      variant: "card",
      snoozed: false,
      pinned: false,
      wokeAt: resolveThreadListV2WokeAt(thread, { now }),
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
      wokeAt: resolveThreadListV2WokeAt(thread, { now }),
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
      wokeAt: null,
      isLast: false,
    });
  }
  const settledShelfHeaderIndex = settledTotal > 0 ? items.length : null;
  for (const thread of visibleSettled) {
    items.push({
      thread,
      variant: "slim",
      snoozed: false,
      pinned: false,
      wokeAt: null,
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
    hiddenSettledCount: Math.max(0, settledTotal - pagedSettled.length),
    listedSettledThreads: listedSettled,
    workingCount: orderedWorking.length,
    workingShelfHeaderIndex,
    snoozedCount: orderedSnoozed.length,
    snoozedShelfHeaderIndex,
    settledCount: settledTotal,
    settledShelfHeaderIndex,
    nextSnoozeWakeAt,
    contentOnlyThreadKeys,
  };
}
