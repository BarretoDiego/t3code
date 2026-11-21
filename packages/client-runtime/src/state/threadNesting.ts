import type { OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import type { EnvironmentThreadShell, ThreadRuntimeSummary } from "./models.ts";
import { effectiveSnoozed } from "./threadSettled.ts";

const ACTIVE_RUN_STATUSES: ReadonlySet<ThreadRuntimeSummary["status"]> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

function runtimeIsActive(runtime: Pick<ThreadRuntimeSummary, "status"> | null): boolean {
  return runtime !== null && ACTIVE_RUN_STATUSES.has(runtime.status);
}

/** The thread a shell hangs from: the run it was forked from when recorded, else its lineage parent. */
function resolveThreadParentThreadId(
  thread: Pick<OrchestrationV2ThreadShell, "forkedFrom" | "lineage">,
): ThreadId | null {
  return thread.forkedFrom?.type === "run"
    ? thread.forkedFrom.threadId
    : thread.lineage.parentThreadId;
}

/**
 * Thread list nesting: subagent threads shown under their spawning thread, built
 * from one forest so web and mobile agree. Only `subagent` lineage nests; a fork is
 * driven on its own (pin, order, settlement), so it keeps a top-level row and its
 * lineage stays in the details panel.
 */
export type ThreadNestingSignal = "approval" | "input" | "failed" | "working";

/** How many children an expanded parent draws before the quiet rest waits behind "Show more". */
export const THREAD_NESTING_CHILD_LIMIT = 8;

/** Strongest first: what a collapsed parent has to say about its children. */
const THREAD_NESTING_SIGNALS: ReadonlyArray<ThreadNestingSignal> = [
  "approval",
  "input",
  "failed",
  "working",
];

export interface ThreadNestingThread {
  readonly environmentId: string;
  readonly id: string;
  readonly createdAt: string;
  readonly archivedAt: string | null;
  readonly settledOverride?: "settled" | "active" | null;
  readonly lineage: OrchestrationV2ThreadShell["lineage"];
  readonly forkedFrom: OrchestrationV2ThreadShell["forkedFrom"];
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly runtime: Pick<ThreadRuntimeSummary, "status"> | null;
  readonly pendingBackgroundTasks?:
    | ReadonlyArray<{ readonly kind: string; readonly childThreadId?: string | undefined }>
    | undefined;
  /** Set by `markRunningSubagents`: the parent still lists this subagent as running. */
  readonly subagentRunning?: boolean | undefined;
}

const runningSubagentCopies = new WeakMap<object, object>();

/**
 * A native subagent (Claude's Task tool, for one) runs inside its parent's
 * provider session, so its own thread has no active run; the parent's pending
 * background work is what says it is still going. Copies are cached per shell so
 * a row keeps its identity while the subagent runs.
 */
export function markRunningSubagents<T extends ThreadNestingThread>(
  threads: ReadonlyArray<T>,
): ReadonlyArray<T> {
  const running = new Set<string>();
  for (const thread of threads) {
    for (const task of thread.pendingBackgroundTasks ?? []) {
      if (task.kind === "subagent" && task.childThreadId !== undefined) {
        running.add(`${thread.environmentId}:${task.childThreadId}`);
      }
    }
  }
  if (running.size === 0) return threads;
  return threads.map((thread) => {
    if (!running.has(threadNestingKey(thread)) || runtimeIsActive(thread.runtime)) return thread;
    const cached = runningSubagentCopies.get(thread) as T | undefined;
    if (cached !== undefined) return cached;
    const copy = { ...thread, subagentRunning: true };
    runningSubagentCopies.set(thread, copy);
    return copy;
  });
}

/** Counts every nested descendant of a row, however deep and whether or not it is on screen. */
export interface ThreadNestingSummary {
  readonly total: number;
  readonly counts: Readonly<Record<ThreadNestingSignal, number>>;
  /** Strongest signal among the descendants, or null when all of them are quiet. */
  readonly signal: ThreadNestingSignal | null;
  /** A descendant is working or waiting on the user. */
  readonly live: boolean;
}

export type ThreadNestingDetachReason = "archived" | "unlisted" | "missing" | "cycle";

export interface ThreadNestingNode<T> {
  /** `environmentId:threadId`, the scoped thread key both clients already use. */
  readonly key: string;
  readonly thread: T;
  /** Null on a top-level row. */
  readonly parentKey: string | null;
  /** 0 on a top-level row. */
  readonly depth: number;
  /** Spawn order, which never changes, so rows hold still as statuses move. */
  readonly children: ReadonlyArray<ThreadNestingNode<T>>;
  readonly summary: ThreadNestingSummary | null;
  /**
   * Set on a subagent that takes a top-level row because its parent cannot
   * show it. `parent` is null when no shell for the parent is loaded.
   */
  readonly detachedFrom: {
    readonly parentKey: string;
    readonly parent: T | null;
    readonly reason: ThreadNestingDetachReason;
  } | null;
}

export interface ThreadNesting<T> {
  /** Top-level rows in input order. Callers still sort and section them. */
  readonly roots: ReadonlyArray<ThreadNestingNode<T>>;
  /** Every thread the list shows, nested or not. */
  readonly nodeByKey: ReadonlyMap<string, ThreadNestingNode<T>>;
}

function threadNestingKey(thread: Pick<ThreadNestingThread, "environmentId" | "id">) {
  return `${thread.environmentId}:${thread.id}`;
}

export function resolveThreadNestingSignal(
  thread: Pick<
    ThreadNestingThread,
    "hasPendingApprovals" | "hasPendingUserInput" | "runtime" | "subagentRunning"
  >,
): ThreadNestingSignal | null {
  if (thread.hasPendingApprovals) return "approval";
  if (thread.hasPendingUserInput) return "input";
  if (runtimeIsActive(thread.runtime) || thread.subagentRunning === true) return "working";
  return thread.runtime?.status === "failed" ? "failed" : null;
}

function isLiveThreadNestingSignal(signal: ThreadNestingSignal | null): boolean {
  return signal === "approval" || signal === "input" || signal === "working";
}

function nestingParentKey(thread: ThreadNestingThread): string | null {
  if (thread.lineage.relationshipToParent !== "subagent") return null;
  const parentThreadId = resolveThreadParentThreadId(thread);
  if (parentThreadId === null || parentThreadId === thread.id) return null;
  return `${thread.environmentId}:${parentThreadId}`;
}

function createdAtMillis(thread: ThreadNestingThread): number {
  const millis = Date.parse(thread.createdAt);
  return Number.isFinite(millis) ? millis : Number.MAX_SAFE_INTEGER;
}

interface ThreadNestingDraft<T> {
  readonly key: string;
  readonly thread: T;
  readonly order: number;
  readonly signal: ThreadNestingSignal | null;
  readonly wantedParentKey: string | null;
  detachReason: ThreadNestingDetachReason | null;
  children: Array<ThreadNestingDraft<T>>;
  liveBearing: boolean;
}

function compareDraftsBySpawn<T extends ThreadNestingThread>(
  left: ThreadNestingDraft<T>,
  right: ThreadNestingDraft<T>,
): number {
  const delta = createdAtMillis(left.thread) - createdAtMillis(right.thread);
  if (delta !== 0) return delta;
  return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
}

type ThreadNestingCounts = { total: number } & Record<ThreadNestingSignal, number>;

function summarizeThreadNestingCounts(counted: ThreadNestingCounts): ThreadNestingSummary {
  const { total, ...counts } = counted;
  return {
    total,
    counts,
    signal: THREAD_NESTING_SIGNALS.find((signal) => counts[signal] > 0) ?? null,
    live: counts.approval + counts.input + counts.working > 0,
  };
}

/**
 * Places every listed thread at the top level or under its parent. `threads` is
 * every loaded shell, archived included, so a child can tell an archived parent from
 * an unloaded one; `isListed` is the list's own filter. A child follows its parent's
 * row, or takes its own top-level row when the parent is missing or filtered out; quiet children leave with an unlisted archived parent.
 */
export function buildThreadNesting<T extends ThreadNestingThread>(input: {
  readonly threads: ReadonlyArray<T>;
  readonly isListed: (thread: T) => boolean;
}): ThreadNesting<T> {
  const shellByKey = new Map<string, T>();
  for (const thread of input.threads) {
    const key = threadNestingKey(thread);
    // Same rule as the relationship graph: the first shell is authoritative.
    if (!shellByKey.has(key)) shellByKey.set(key, thread);
  }

  const drafts = new Map<string, ThreadNestingDraft<T>>();
  for (const [key, thread] of shellByKey) {
    if (!input.isListed(thread)) continue;
    drafts.set(key, {
      key,
      thread,
      order: drafts.size,
      signal: resolveThreadNestingSignal(thread),
      wantedParentKey: nestingParentKey(thread),
      detachReason: null,
      children: [],
      liveBearing: false,
    });
  }

  const starts: Array<ThreadNestingDraft<T>> = [];
  const wantedChildren = new Map<string, Array<ThreadNestingDraft<T>>>();
  for (const draft of drafts.values()) {
    if (draft.wantedParentKey === null) {
      starts.push(draft);
      continue;
    }
    const parent = shellByKey.get(draft.wantedParentKey);
    const reason: ThreadNestingDetachReason | null =
      parent === undefined
        ? "missing"
        : drafts.has(draft.wantedParentKey)
          ? null
          : parent.archivedAt !== null
            ? "archived"
            : "unlisted";
    if (reason !== null) {
      draft.detachReason = reason;
      starts.push(draft);
      continue;
    }
    const siblings = wantedChildren.get(draft.wantedParentKey);
    if (siblings === undefined) wantedChildren.set(draft.wantedParentKey, [draft]);
    else siblings.push(draft);
  }
  for (const siblings of wantedChildren.values()) siblings.sort(compareDraftsBySpawn);

  // Each thread is attached exactly once, so a parent loop cannot recurse.
  const attached = new Set<string>();
  const attach = (draft: ThreadNestingDraft<T>) => {
    attached.add(draft.key);
    let liveBearing = isLiveThreadNestingSignal(draft.signal);
    for (const child of wantedChildren.get(draft.key) ?? []) {
      if (attached.has(child.key)) continue;
      attach(child);
      draft.children.push(child);
      liveBearing ||= child.liveBearing;
    }
    draft.liveBearing = liveBearing;
  };
  for (const start of starts) attach(start);
  // What is left only has parents inside a loop. The oldest member of each
  // loop becomes its top-level row so none of them is dropped.
  for (const draft of drafts.values()) {
    if (attached.has(draft.key)) continue;
    const path: Array<ThreadNestingDraft<T>> = [];
    let cursor = draft;
    while (!path.includes(cursor)) {
      path.push(cursor);
      cursor = drafts.get(cursor.wantedParentKey!)!;
    }
    const lead = path.slice(path.indexOf(cursor)).sort(compareDraftsBySpawn)[0]!;
    lead.detachReason = "cycle";
    starts.push(lead);
    attach(lead);
  }

  const roots = starts.filter((draft) => draft.detachReason !== "archived" || draft.liveBearing);
  roots.sort((left, right) => left.order - right.order);

  const nodeByKey = new Map<string, ThreadNestingNode<T>>();
  const finish = (
    draft: ThreadNestingDraft<T>,
    parentKey: string | null,
    depth: number,
  ): { readonly node: ThreadNestingNode<T>; readonly counted: ThreadNestingCounts } => {
    const counted: ThreadNestingCounts = { total: 0, approval: 0, input: 0, failed: 0, working: 0 };
    const children: Array<ThreadNestingNode<T>> = [];
    for (const child of draft.children) {
      const finished = finish(child, draft.key, depth + 1);
      children.push(finished.node);
      counted.total += 1 + finished.counted.total;
      if (child.signal !== null) counted[child.signal] += 1;
      for (const signal of THREAD_NESTING_SIGNALS) counted[signal] += finished.counted[signal];
    }
    const node: ThreadNestingNode<T> = {
      key: draft.key,
      thread: draft.thread,
      parentKey,
      depth,
      children,
      summary: counted.total === 0 ? null : summarizeThreadNestingCounts(counted),
      detachedFrom:
        parentKey !== null || draft.wantedParentKey === null || draft.detachReason === null
          ? null
          : {
              parentKey: draft.wantedParentKey,
              parent: shellByKey.get(draft.wantedParentKey) ?? null,
              reason: draft.detachReason,
            },
    };
    nodeByKey.set(node.key, node);
    return { node, counted };
  };

  return { roots: roots.map((root) => finish(root, null, 0).node), nodeByKey };
}

/**
 * Whether a parent shows its children. The user's own choice wins; without
 * one, children show while any of them is working or waiting on the user and
 * fold away once they have all finished.
 */
export function resolveThreadNestingExpanded(
  summary: ThreadNestingSummary | null,
  override: boolean | undefined,
): boolean {
  if (summary === null) return false;
  return override ?? summary.live;
}

/** The keys from a thread's parent up to its top-level row, nearest first. */
export function threadNestingAncestorKeys<T>(
  nesting: ThreadNesting<T>,
  key: string | null,
): ReadonlyArray<string> {
  const ancestors: string[] = [];
  let parentKey = key === null ? null : (nesting.nodeByKey.get(key)?.parentKey ?? null);
  while (parentKey !== null) {
    ancestors.push(parentKey);
    parentKey = nesting.nodeByKey.get(parentKey)?.parentKey ?? null;
  }
  return ancestors;
}

export type ThreadNestingRow<T> =
  | {
      readonly kind: "settled";
      readonly key: string;
      readonly parentKey: string;
      readonly depth: number;
      readonly count: number;
      readonly expanded: boolean;
    }
  | {
      readonly kind: "thread";
      readonly key: string;
      readonly thread: T;
      readonly parentKey: string;
      /** 1 for a direct child of the top-level row. */
      readonly depth: number;
      readonly summary: ThreadNestingSummary | null;
      readonly expanded: boolean;
    }
  | {
      /** Stands in for the quiet children a long list leaves out. */
      readonly kind: "more";
      readonly key: string;
      readonly parentKey: string;
      readonly depth: number;
      readonly hiddenCount: number;
    };

export interface ThreadNestingDisplay<T> {
  readonly summary: ThreadNestingSummary;
  readonly expanded: boolean;
  readonly rows: ReadonlyArray<ThreadNestingRow<T>>;
}

/**
 * The rows to draw under one top-level thread, or null with no children. A collapsed
 * parent still shows the path to the open thread. An expanded parent over
 * `childLimit` keeps children with something to report plus the newest quiet ones,
 * the rest behind a `more` row; settled children sit in a collapsible group.
 */
export function flattenThreadNesting<T extends ThreadNestingThread>(input: {
  readonly node: ThreadNestingNode<T>;
  readonly expandedOverrides: Readonly<Record<string, boolean>>;
  /** The open thread and its ancestors; see `threadNestingAncestorKeys`. */
  readonly activePathKeys: ReadonlySet<string>;
  readonly childLimit: number;
  readonly showAllKeys: ReadonlySet<string>;
}): ThreadNestingDisplay<T> | null {
  if (input.node.summary === null) return null;
  const rows: Array<ThreadNestingRow<T>> = [];
  const isExpanded = (node: ThreadNestingNode<T>) =>
    resolveThreadNestingExpanded(node.summary, input.expandedOverrides[node.key]);
  const reportsSomething = (node: ThreadNestingNode<T>) =>
    input.activePathKeys.has(node.key) ||
    resolveThreadNestingSignal(node.thread) !== null ||
    (node.summary?.signal ?? null) !== null;

  const visit = (parent: ThreadNestingNode<T>, expanded: boolean) => {
    const settled = parent.children.filter(
      (child) =>
        child.thread.settledOverride === "settled" &&
        resolveThreadNestingSignal(child.thread) === null &&
        child.summary?.signal == null,
    );
    const settledKeys = new Set(settled.map((child) => child.key));
    const unsettled = parent.children.filter((child) => !settledKeys.has(child.key));
    const draw = (
      children: ReadonlyArray<ThreadNestingNode<T>>,
      expanded: boolean,
      groupKey: string,
    ) => {
      let shown = children;
      if (!expanded) {
        shown = shown.filter((child) => input.activePathKeys.has(child.key));
      } else if (shown.length > input.childLimit && !input.showAllKeys.has(groupKey)) {
        const kept = new Set(shown.filter(reportsSomething));
        for (let index = shown.length - 1; index >= 0 && kept.size < input.childLimit; index -= 1) {
          kept.add(shown[index]!);
        }
        shown = shown.filter((child) => kept.has(child));
      }
      for (const child of shown) {
        const childExpanded = isExpanded(child);
        rows.push({
          kind: "thread",
          key: child.key,
          thread: child.thread,
          parentKey: parent.key,
          depth: child.depth - input.node.depth,
          summary: child.summary,
          expanded: childExpanded,
        });
        visit(child, childExpanded);
      }
      if (expanded && shown.length < children.length) {
        rows.push({
          kind: "more",
          key: `${groupKey}:more`,
          parentKey: groupKey,
          depth: parent.depth - input.node.depth + 1,
          hiddenCount: children.length - shown.length,
        });
      }
    };
    draw(unsettled, expanded, parent.key);
    if (
      settled.length > 0 &&
      (expanded || settled.some((child) => input.activePathKeys.has(child.key)))
    ) {
      const key = `${parent.key}:settled`;
      const settledExpanded = input.expandedOverrides[key] ?? false;
      rows.push({
        kind: "settled",
        key,
        parentKey: parent.key,
        depth: parent.depth - input.node.depth + 1,
        count: settled.length,
        expanded: settledExpanded,
      });
      draw(settled, settledExpanded, key);
    }
  };
  const expanded = isExpanded(input.node);
  visit(input.node, expanded);
  return { summary: input.node.summary, expanded, rows };
}

function threadNestingSummariesEqual(
  left: ThreadNestingSummary | null,
  right: ThreadNestingSummary | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.total === right.total &&
    THREAD_NESTING_SIGNALS.every((signal) => left.counts[signal] === right.counts[signal])
  );
}

/**
 * Returns `previous` when `next` draws the same rows, so a shell update that
 * leaves a parent's children untouched does not re-render that parent.
 */
export function reuseEqualThreadNestingDisplay<T>(
  previous: ThreadNestingDisplay<T> | null | undefined,
  next: ThreadNestingDisplay<T> | null,
): ThreadNestingDisplay<T> | null {
  if (previous == null || next === null) return next;
  if (
    previous.expanded !== next.expanded ||
    previous.rows.length !== next.rows.length ||
    !threadNestingSummariesEqual(previous.summary, next.summary)
  ) {
    return next;
  }
  for (const [index, row] of next.rows.entries()) {
    const before = previous.rows[index]!;
    if (before.key !== row.key || before.depth !== row.depth) return next;
    if (before.kind === "settled" || row.kind === "settled") {
      if (before.kind !== "settled" || row.kind !== "settled") return next;
      if (before.count !== row.count || before.expanded !== row.expanded) return next;
      continue;
    }
    if (before.kind === "more" || row.kind === "more") {
      if (before.kind !== "more" || row.kind !== "more") return next;
      if (before.hiddenCount !== row.hiddenCount) return next;
      continue;
    }
    if (
      before.thread !== row.thread ||
      before.expanded !== row.expanded ||
      !threadNestingSummariesEqual(before.summary, row.summary)
    ) {
      return next;
    }
  }
  return previous;
}

const SUBTHREAD_RUN_LABEL: Record<ThreadRuntimeSummary["status"], string> = {
  idle: msg("Idle", { $context: "subagent run status" }),
  preparing: msg("Preparing", { $context: "subagent run status" }),
  queued: msg("Queued", { $context: "subagent run status" }),
  starting: msg("Starting", { $context: "subagent run status" }),
  running: msg("Working", { $context: "subagent run status" }),
  waiting: msg("Waiting", { $context: "subagent run status" }),
  completed: msg("Completed", { $context: "subagent run status" }),
  interrupted: msg("Interrupted", { $context: "subagent run status" }),
  failed: msg("Failed", { $context: "subagent run status" }),
  cancelled: msg("Cancelled", { $context: "subagent run status" }),
  rolled_back: msg("Rolled back", { $context: "subagent run status" }),
};

/** A nested subagent keeps its run's result visible after the user reads, settles or parks it. */
export function resolveSubthreadStatusLabel(
  thread: Pick<
    EnvironmentThreadShell,
    | "runtime"
    | "latestRun"
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "pendingBackgroundTasks"
    | "archivedAt"
    | "settledOverride"
    | "snoozedAt"
    | "snoozedUntil"
  > &
    Pick<ThreadNestingThread, "subagentRunning">,
  now: string,
  resolve: MFunctionType = mFallback,
): string {
  const runtimeStatus = thread.runtime?.status;
  const runStatus =
    thread.subagentRunning === true && !runtimeIsActive(thread.runtime)
      ? "running"
      : runtimeStatus === "idle"
        ? thread.latestRun !== null && !ACTIVE_RUN_STATUSES.has(thread.latestRun.status)
          ? thread.latestRun.status
          : "idle"
        : (runtimeStatus ?? thread.latestRun?.status ?? "idle");
  const execution = thread.hasPendingApprovals
    ? resolve(msg("Pending approval"))
    : thread.hasPendingUserInput
      ? resolve(msg("Awaiting input"))
      : (runStatus === "idle" || runStatus === "completed") &&
          backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks)
        ? resolve(SUBTHREAD_RUN_LABEL.waiting)
        : resolve(SUBTHREAD_RUN_LABEL[runStatus]);
  const lifecycle =
    thread.archivedAt !== null
      ? resolve(msg("Archived", { $context: "thread lifecycle state" }))
      : effectiveSnoozed(thread, { now })
        ? resolve(msg("Snoozed", { $context: "thread lifecycle state" }))
        : thread.settledOverride === "settled"
          ? resolve(msg("Settled", { $context: "thread lifecycle state" }))
          : null;
  return lifecycle === null
    ? execution
    : resolve(msg("{status} · {lifecycle}", { status: execution, lifecycle }));
}
