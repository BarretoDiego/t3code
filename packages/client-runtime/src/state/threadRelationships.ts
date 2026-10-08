import type {
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { threadRuntimeIsActive, type ThreadRuntimeSummary } from "./models.ts";

export type ThreadRelationshipKind = "parent" | "fork" | "subagent" | "transfer";

export interface ThreadRelationshipNode {
  readonly threadId: ThreadId;
  readonly thread: OrchestrationV2ThreadShell | null;
  readonly missing: boolean;
}

export interface ThreadRelationshipEdge {
  readonly sourceThreadId: ThreadId;
  readonly targetThreadId: ThreadId;
  readonly kind: ThreadRelationshipKind;
  readonly status: string | null;
}

export interface ThreadRelationshipGraph {
  readonly nodes: ReadonlyMap<ThreadId, ThreadRelationshipNode>;
  readonly edges: ReadonlyArray<ThreadRelationshipEdge>;
}

export interface ThreadRelationshipWalkRow {
  readonly threadId: ThreadId;
  readonly fromThreadId: ThreadId;
  readonly depth: number;
  readonly edge: ThreadRelationshipEdge;
}

export function resolveMergeBackTargetThreadId(
  projection: Pick<OrchestrationV2ThreadProjection, "thread"> | null,
): ThreadId | null {
  if (projection?.thread.lineage.relationshipToParent !== "fork") return null;
  return projection.thread.forkedFrom?.type === "run"
    ? projection.thread.forkedFrom.threadId
    : projection.thread.lineage.parentThreadId;
}

/** The thread a shell hangs from: the run it was forked from when recorded, else its lineage parent. */
export function resolveThreadParentThreadId(
  thread: Pick<OrchestrationV2ThreadShell, "forkedFrom" | "lineage">,
): ThreadId | null {
  return thread.forkedFrom?.type === "run"
    ? thread.forkedFrom.threadId
    : thread.lineage.parentThreadId;
}

function edgeKey(edge: ThreadRelationshipEdge): string {
  return `${edge.sourceThreadId}\u001f${edge.targetThreadId}\u001f${edge.kind}`;
}

export function deriveThreadRelationshipGraph(input: {
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly projection: OrchestrationV2ThreadProjection | null;
}): ThreadRelationshipGraph {
  const threadsById = new Map<ThreadId, OrchestrationV2ThreadShell>();
  for (const thread of input.threads) {
    // Callers order shells from most to least authoritative. In particular,
    // live shells precede archived snapshots, which may still contain a stale
    // copy during archive refresh.
    if (!threadsById.has(thread.id)) {
      threadsById.set(thread.id, thread);
    }
  }
  const threads = [...threadsById.values()];
  const nodes = new Map<ThreadId, ThreadRelationshipNode>(
    threads.map((thread) => [thread.id, { threadId: thread.id, thread, missing: false }]),
  );
  const edgesByKey = new Map<string, ThreadRelationshipEdge>();
  const ensureNode = (threadId: ThreadId) => {
    if (!nodes.has(threadId)) {
      nodes.set(threadId, { threadId, thread: null, missing: true });
    }
  };
  const addEdge = (edge: ThreadRelationshipEdge) => {
    ensureNode(edge.sourceThreadId);
    ensureNode(edge.targetThreadId);
    edgesByKey.set(edgeKey(edge), edge);
  };

  for (const thread of threads) {
    const parentThreadId = resolveThreadParentThreadId(thread);
    if (parentThreadId === null) continue;
    addEdge({
      sourceThreadId: parentThreadId,
      targetThreadId: thread.id,
      kind: thread.lineage.relationshipToParent === "subagent" ? "subagent" : "fork",
      status: thread.activityRunStatus ?? thread.status,
    });
  }

  if (input.projection !== null) {
    const ownerThreadId = input.projection.thread.id;
    for (const subagent of input.projection.subagents) {
      if (subagent.childThreadId === null) continue;
      // The subagent record settles with the delegated task's first run, but the
      // parent can keep sending the child follow-ups. A live run on the child
      // thread outranks that settled status.
      addEdge({
        sourceThreadId: ownerThreadId,
        targetThreadId: subagent.childThreadId,
        kind: "subagent",
        status: threadsById.get(subagent.childThreadId)?.activityRunStatus ?? subagent.status,
      });
    }
    for (const transfer of input.projection.contextTransfers) {
      if (transfer.sourceThreadId === transfer.targetThreadId) continue;
      addEdge({
        sourceThreadId: transfer.sourceThreadId,
        targetThreadId: transfer.targetThreadId,
        kind: "transfer",
        status: transfer.status,
      });
    }
  }

  return { nodes, edges: [...edgesByKey.values()] };
}

export function relatedThreadIds(
  graph: ThreadRelationshipGraph,
  threadId: ThreadId,
): ReadonlyArray<ThreadId> {
  const ids = new Set<ThreadId>();
  for (const edge of graph.edges) {
    if (edge.sourceThreadId === threadId) ids.add(edge.targetThreadId);
    if (edge.targetThreadId === threadId) ids.add(edge.sourceThreadId);
  }
  return [...ids];
}

export function walkThreadRelationships(
  graph: ThreadRelationshipGraph,
  threadId: ThreadId,
): ReadonlyArray<ThreadRelationshipWalkRow> {
  const visited = new Set<ThreadId>([threadId]);
  const pending: Array<{ readonly threadId: ThreadId; readonly depth: number }> = [
    { threadId, depth: 0 },
  ];
  const rows: ThreadRelationshipWalkRow[] = [];

  for (let index = 0; index < pending.length; index += 1) {
    const current = pending[index];
    if (current === undefined) continue;
    for (const edge of graph.edges) {
      const relatedId =
        edge.sourceThreadId === current.threadId
          ? edge.targetThreadId
          : edge.targetThreadId === current.threadId
            ? edge.sourceThreadId
            : null;
      if (relatedId === null || visited.has(relatedId)) continue;
      visited.add(relatedId);
      const depth = current.depth + 1;
      rows.push({ threadId: relatedId, fromThreadId: current.threadId, depth, edge });
      pending.push({ threadId: relatedId, depth });
    }
  }

  return rows;
}

export function immediateThreadRelationships(
  graph: ThreadRelationshipGraph,
  threadId: ThreadId,
): ReadonlyArray<ThreadRelationshipWalkRow> {
  const visited = new Set<ThreadId>();
  const rows: ThreadRelationshipWalkRow[] = [];

  for (const edge of graph.edges) {
    const relatedId =
      edge.sourceThreadId === threadId
        ? edge.targetThreadId
        : edge.targetThreadId === threadId
          ? edge.sourceThreadId
          : null;
    if (relatedId === null || visited.has(relatedId)) continue;
    visited.add(relatedId);
    rows.push({ threadId: relatedId, fromThreadId: threadId, depth: 1, edge });
  }

  return rows;
}

/** True when `edge` reaches `currentThreadId` from its parent or owning agent. */
export function isParentThreadRelationship(
  edge: ThreadRelationshipEdge,
  currentThreadId: ThreadId,
): boolean {
  return edge.kind !== "transfer" && edge.targetThreadId === currentThreadId;
}

/** An incoming parent row shows its own activity, not the child's edge status. */
export function threadRelationshipRowStatus(
  graph: ThreadRelationshipGraph,
  row: Pick<ThreadRelationshipWalkRow, "threadId" | "edge">,
): string | null {
  if (row.edge.kind === "transfer" || row.threadId === row.edge.targetThreadId) {
    return row.edge.status;
  }
  const thread = graph.nodes.get(row.threadId)?.thread;
  return thread?.activityRunStatus ?? thread?.status ?? null;
}

function threadCreatedAtMillis(node: ThreadRelationshipNode | undefined): number | null {
  // `createdAt` is typed as a DateTime, but the value reaches here from a
  // decoded shell that may be missing (a related thread we have no shell for).
  const createdAt: unknown = node?.thread?.createdAt;
  if (!DateTime.isDateTime(createdAt)) return null;
  const millis = DateTime.toEpochMillis(createdAt);
  return Number.isFinite(millis) ? millis : null;
}

/**
 * Orders the web thread-details Lineage rows for display.
 *
 * Web-specific by design: the panel pins the parent row first and a distinct
 * merge-back target second so their actions stay where the user expects, and
 * only then falls back to newest-created-first. Mobile does not share that
 * exception, so this is not the canonical relationship order and should not be
 * reused as one.
 *
 * Ordering below the pins is `createdAt` descending, which is immutable, so
 * rows never move when messages or status changes arrive on a related thread.
 * Threads whose shell is missing (or whose `createdAt` did not decode) sink to
 * the bottom. Ties break by thread id ascending so the order is total.
 */
export function orderWebThreadLineageRows(input: {
  readonly graph: ThreadRelationshipGraph;
  readonly rows: ReadonlyArray<ThreadRelationshipWalkRow>;
  readonly currentThreadId: ThreadId;
  readonly mergeTargetThreadId: ThreadId | null;
}): ReadonlyArray<ThreadRelationshipWalkRow> {
  const pinRank = (row: ThreadRelationshipWalkRow): number => {
    if (isParentThreadRelationship(row.edge, input.currentThreadId)) return 0;
    if (row.threadId === input.mergeTargetThreadId) return 1;
    return 2;
  };

  return [...input.rows].sort((left, right) => {
    const rankDelta = pinRank(left) - pinRank(right);
    if (rankDelta !== 0) return rankDelta;
    const leftCreatedAt = threadCreatedAtMillis(input.graph.nodes.get(left.threadId));
    const rightCreatedAt = threadCreatedAtMillis(input.graph.nodes.get(right.threadId));
    if (leftCreatedAt !== rightCreatedAt) {
      if (leftCreatedAt === null) return 1;
      if (rightCreatedAt === null) return -1;
      return rightCreatedAt - leftCreatedAt;
    }
    return left.threadId < right.threadId ? -1 : left.threadId > right.threadId ? 1 : 0;
  });
}

/**
 * Thread list nesting: subagent threads shown under the thread that spawned
 * them. Web and mobile build their lists from this one forest so a parent and
 * its children land in the same place on every client.
 *
 * Only `subagent` lineage nests. A fork is a conversation the user drives on
 * its own, with its own pin, order, and settlement, so it keeps a top-level
 * row and its lineage stays in the thread details panel.
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
  readonly lineage: OrchestrationV2ThreadShell["lineage"];
  readonly forkedFrom: OrchestrationV2ThreadShell["forkedFrom"];
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly runtime: Pick<ThreadRuntimeSummary, "status"> | null;
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

export function threadNestingKey(thread: Pick<ThreadNestingThread, "environmentId" | "id">) {
  return `${thread.environmentId}:${thread.id}`;
}

export function resolveThreadNestingSignal(
  thread: Pick<ThreadNestingThread, "hasPendingApprovals" | "hasPendingUserInput" | "runtime">,
): ThreadNestingSignal | null {
  if (thread.hasPendingApprovals) return "approval";
  if (thread.hasPendingUserInput) return "input";
  if (threadRuntimeIsActive(thread.runtime)) return "working";
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
 * Places every listed thread either at the top level or under its parent.
 *
 * - `threads` is every loaded shell, archived ones included, so a child can
 *   tell an archived parent from one that is not loaded.
 * - `isListed` is the list's own filter (archive, project scope, provider,
 *   search). An unlisted thread gets no row.
 *
 * A child follows its parent's row wherever that row is. Lists keep the
 * whole family visible while its summary has live work, even when the
 * parent is settled or snoozed. A child takes its own top-level row when
 * the parent is missing, filtered out, or archived. Quiet children of an
 * archived parent leave with it.
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
        : parent.archivedAt !== null
          ? "archived"
          : drafts.has(draft.wantedParentKey)
            ? null
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
 * The rows to draw under one top-level thread, in order, or null when it has
 * no children.
 *
 * A collapsed parent still shows the path to the open thread, so the row for
 * what the user is looking at never disappears. An expanded parent with more
 * than `childLimit` children keeps every child that has something to report
 * and fills the rest with the newest quiet ones; the remainder waits behind a
 * `more` row until its parent is in `showAllKeys`.
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
    let shown = parent.children;
    if (!expanded) {
      shown = shown.filter((child) => input.activePathKeys.has(child.key));
    } else if (shown.length > input.childLimit && !input.showAllKeys.has(parent.key)) {
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
    if (expanded && shown.length < parent.children.length) {
      rows.push({
        kind: "more",
        key: `${parent.key}:more`,
        parentKey: parent.key,
        depth: parent.depth - input.node.depth + 1,
        hiddenCount: parent.children.length - shown.length,
      });
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
