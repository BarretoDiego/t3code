import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  buildThreadNesting,
  flattenThreadNesting,
  THREAD_NESTING_CHILD_LIMIT,
  threadNestingAncestorKeys,
  type ThreadNestingSignal,
  type ThreadNestingSummary,
} from "@t3tools/client-runtime/state/thread-nesting";

import type { ThreadListV2ListItem } from "./threadListV2";

/** What a row says about the subagent threads nested under it. */
export interface ThreadListNestedSummary {
  readonly total: number;
  readonly counts: Readonly<Record<ThreadNestingSignal, number>>;
  readonly signal: ThreadNestingSignal | null;
  readonly expanded: boolean;
}

/** A subagent thread drawn indented under its parent. */
export interface ThreadListNestedThreadItem {
  readonly type: "v2-nested-thread";
  readonly key: string;
  readonly thread: EnvironmentThreadShell;
  /** `environmentId:threadId`, the key its own expansion is stored under. */
  readonly threadKey: string;
  /** The top-level row the family hangs from, where the subagent opens beside. */
  readonly rootThread: EnvironmentThreadShell;
  /** 1 for a direct child of the top-level row. */
  readonly depth: number;
  readonly nested: ThreadListNestedSummary | null;
  readonly showTrailingDivider: boolean;
}

/** Stands in for the quiet subagents a long list leaves out. */
export interface ThreadListNestedMoreItem {
  readonly type: "v2-nested-more";
  readonly key: string;
  readonly groupKey: string;
  readonly depth: number;
  readonly hiddenCount: number;
  readonly showTrailingDivider: boolean;
}

/** The collapsible group of a parent's settled subagents. */
export interface ThreadListNestedSettledItem {
  readonly type: "v2-nested-settled";
  readonly key: string;
  readonly groupKey: string;
  readonly depth: number;
  readonly count: number;
  readonly expanded: boolean;
  readonly showTrailingDivider: boolean;
}

export type ThreadListNestedListItem =
  | ThreadListNestedThreadItem
  | ThreadListNestedMoreItem
  | ThreadListNestedSettledItem;

export function isThreadListNestedListItem(value: {
  readonly type: string;
}): value is ThreadListNestedListItem {
  return (
    value.type === "v2-nested-thread" ||
    value.type === "v2-nested-more" ||
    value.type === "v2-nested-settled"
  );
}

export function threadListNestedSummariesAreEqual(
  previous: ThreadListNestedSummary | null | undefined,
  next: ThreadListNestedSummary | null | undefined,
): boolean {
  if (previous == null || next == null) return (previous ?? null) === (next ?? null);
  return (
    previous.total === next.total &&
    previous.expanded === next.expanded &&
    previous.counts.approval === next.counts.approval &&
    previous.counts.input === next.counts.input &&
    previous.counts.failed === next.counts.failed &&
    previous.counts.working === next.counts.working
  );
}

export function threadListNestedListItemsAreEqual(
  previous: ThreadListNestedListItem | ThreadListV2ListItem,
  item: ThreadListNestedListItem,
): boolean {
  switch (item.type) {
    case "v2-nested-thread":
      return (
        previous.type === "v2-nested-thread" &&
        previous.key === item.key &&
        previous.thread === item.thread &&
        previous.rootThread === item.rootThread &&
        previous.depth === item.depth &&
        previous.showTrailingDivider === item.showTrailingDivider &&
        threadListNestedSummariesAreEqual(previous.nested, item.nested)
      );
    case "v2-nested-more":
      return (
        previous.type === "v2-nested-more" &&
        previous.key === item.key &&
        previous.depth === item.depth &&
        previous.hiddenCount === item.hiddenCount &&
        previous.showTrailingDivider === item.showTrailingDivider
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
  }
}

function summarize(summary: ThreadNestingSummary, expanded: boolean): ThreadListNestedSummary {
  return { total: summary.total, counts: summary.counts, signal: summary.signal, expanded };
}

const NO_KEYS: ReadonlySet<string> = new Set<string>();

/**
 * Places subagent rows under the top-level thread rows they belong to. Top-level
 * items keep their order, so sections, shelves and reordering never see a nested
 * row. `threads` is every loaded shell, subagents included; side chats never nest.
 */
export function withThreadListNesting(input: {
  readonly items: ReadonlyArray<ThreadListV2ListItem>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly expandedOverrides: Readonly<Record<string, boolean>>;
  readonly showAllKeys: ReadonlySet<string>;
  readonly selectedThreadKey: string | null;
}): ReadonlyArray<ThreadListV2ListItem> {
  const nesting = buildThreadNesting({
    threads: input.threads,
    isListed: (thread) => thread.archivedAt === null && thread.lineage.sideChat !== true,
  });
  if (nesting.roots.every((root) => root.summary === null)) return input.items;
  const activePathKeys =
    input.selectedThreadKey === null
      ? NO_KEYS
      : new Set([
          input.selectedThreadKey,
          ...threadNestingAncestorKeys(nesting, input.selectedThreadKey),
        ]);
  const result: ThreadListV2ListItem[] = [];
  for (const item of input.items) {
    if (item.type !== "v2-thread") {
      result.push(item);
      continue;
    }
    const key = `${item.item.thread.environmentId}:${item.item.thread.id}`;
    const node = nesting.nodeByKey.get(key);
    const display =
      node === undefined || node.parentKey !== null
        ? null
        : flattenThreadNesting({
            node,
            expandedOverrides: input.expandedOverrides,
            activePathKeys,
            childLimit: THREAD_NESTING_CHILD_LIMIT,
            showAllKeys: input.showAllKeys,
          });
    if (display === null) {
      result.push(item);
      continue;
    }
    // The family's last row draws the divider the parent would have drawn.
    result.push({
      ...item,
      nested: summarize(display.summary, display.expanded),
      showTrailingDivider: display.rows.length === 0 && item.showTrailingDivider,
    });
    display.rows.forEach((row, index) => {
      const showTrailingDivider =
        index === display.rows.length - 1 ? item.showTrailingDivider : false;
      switch (row.kind) {
        case "thread":
          result.push({
            type: "v2-nested-thread",
            key: `v2-nested-thread:${row.key}`,
            thread: row.thread,
            threadKey: row.key,
            rootThread: item.item.thread,
            depth: row.depth,
            nested: row.summary === null ? null : summarize(row.summary, row.expanded),
            showTrailingDivider,
          });
          break;
        case "more":
          result.push({
            type: "v2-nested-more",
            key: `v2-nested-more:${row.key}`,
            groupKey: row.parentKey,
            depth: row.depth,
            hiddenCount: row.hiddenCount,
            showTrailingDivider,
          });
          break;
        case "settled":
          result.push({
            type: "v2-nested-settled",
            key: `v2-nested-settled:${row.key}`,
            groupKey: row.key,
            depth: row.depth,
            count: row.count,
            expanded: row.expanded,
            showTrailingDivider,
          });
          break;
      }
    });
  }
  return result;
}
