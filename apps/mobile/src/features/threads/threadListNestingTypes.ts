import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ThreadNestingSignal } from "@t3tools/client-runtime/state/thread-nesting";

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
  previous: { readonly type: string },
  item: ThreadListNestedListItem,
): boolean {
  if (!isThreadListNestedListItem(previous)) return false;
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
