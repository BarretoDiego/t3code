import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  buildThreadNesting,
  flattenThreadNesting,
  markRunningSubagents,
  THREAD_NESTING_CHILD_LIMIT,
  threadNestingAncestorKeys,
  type ThreadNestingSummary,
} from "@t3tools/client-runtime/state/thread-nesting";

import type { ThreadListNestedSummary } from "./threadListNestingTypes";
import type { ThreadListV2ListItem } from "./threadListV2";

export {
  isThreadListNestedListItem,
  threadListNestedListItemsAreEqual,
  threadListNestedSummariesAreEqual,
  type ThreadListNestedListItem,
  type ThreadListNestedMoreItem,
  type ThreadListNestedSettledItem,
  type ThreadListNestedSummary,
  type ThreadListNestedThreadItem,
} from "./threadListNestingTypes";

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
    threads: markRunningSubagents(input.threads),
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
