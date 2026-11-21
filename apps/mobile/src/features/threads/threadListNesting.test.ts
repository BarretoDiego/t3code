import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadShellFixture } from "../../test-fixtures";
import { threadJumpTarget } from "../keyboard/threadKeyboardShortcuts";
import {
  buildThreadListV2Items,
  buildThreadListV2ListItems,
  isThreadListV2ListItem,
  threadListV2ListItemsAreEqual,
  type ThreadListV2ListItem,
} from "./threadListV2";
import { withThreadListNesting } from "./threadListNesting";

const environmentId = EnvironmentId.make("environment-1");
const NOW = "2026-06-02T00:00:00.000Z";
const BASE_MS = Date.parse(NOW);
const MINUTE_MS = 60_000;
const isoAt = (ms: number) => new Date(ms).toISOString();

function makeThread(
  input: Partial<EnvironmentThreadShell> & Pick<EnvironmentThreadShell, "id" | "title">,
): EnvironmentThreadShell {
  return makeThreadShellFixture({ environmentId, ...input });
}

const working = {
  runtime: {
    status: "running" as const,
    activeRunId: null,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: "Codex",
    lastError: null,
    updatedAt: NOW,
  },
};

const root = makeThread({ id: ThreadId.make("root"), title: "Root" });
const subagentOf = (
  parent: EnvironmentThreadShell,
  id: string,
  input: Partial<EnvironmentThreadShell> = {},
) =>
  makeThread({
    id: ThreadId.make(id),
    title: id,
    lineage: {
      parentThreadId: parent.id,
      rootThreadId: parent.id,
      relationshipToParent: "subagent",
    },
    ...input,
  });
const fork = makeThread({
  id: ThreadId.make("fork"),
  title: "Fork",
  lineage: { parentThreadId: root.id, rootThreadId: root.id, relationshipToParent: "fork" },
});

function listRows(
  threads: EnvironmentThreadShell[],
  input: {
    readonly expandedOverrides?: Readonly<Record<string, boolean>>;
    readonly showAllKeys?: ReadonlySet<string>;
    readonly selectedThreadKey?: string | null;
  } = {},
): ReadonlyArray<ThreadListV2ListItem> {
  const layout = buildThreadListV2Items({
    threads,
    environmentId: null,
    searchQuery: "",
    now: NOW,
    settledShelfExpanded: true,
  });
  const items = buildThreadListV2ListItems({
    items: layout.items,
    pendingTasks: [],
    snoozedCount: layout.snoozedCount,
    snoozedShelfHeaderIndex: layout.snoozedShelfHeaderIndex,
    settledCount: layout.settledCount,
    settledShelfHeaderIndex: layout.settledShelfHeaderIndex,
    settledShelfExpanded: true,
  });
  return withThreadListNesting({
    items,
    threads,
    expandedOverrides: input.expandedOverrides ?? {},
    showAllKeys: input.showAllKeys ?? new Set(),
    selectedThreadKey: input.selectedThreadKey ?? null,
  });
}

const describeRows = (rows: ReadonlyArray<ThreadListV2ListItem>) =>
  rows.map((row) =>
    row.type === "v2-thread"
      ? row.item.thread.id
      : row.type === "v2-nested-thread"
        ? `${"> ".repeat(row.depth)}${row.thread.id}`
        : row.type === "v2-nested-more"
          ? `${"> ".repeat(row.depth)}+${row.hiddenCount}`
          : row.type,
  );

describe("subagent threads nested under their parent", () => {
  it("draws a working subagent under its parent and keeps forks at the top level", () => {
    const child = subagentOf(root, "child", working);
    const grandchild = subagentOf(child, "grandchild", working);
    const rows = listRows([root, child, grandchild, fork]);

    expect(describeRows(rows)).toEqual(["fork", "root", "> child", "> > grandchild"]);
    // Only top-level rows have a jump number.
    expect(threadJumpTarget(rows, "thread.jump.2")).toMatchObject({ type: "v2-thread" });
    expect(threadJumpTarget(rows, "thread.jump.3")).toBeNull();
    expect(rows.every(isThreadListV2ListItem)).toBe(true);
  });

  it("folds finished subagents away but still reports them on the parent", () => {
    const rows = listRows([root, subagentOf(root, "done-a"), subagentOf(root, "done-b")]);

    expect(describeRows(rows)).toEqual(["root"]);
    expect(rows[0]).toMatchObject({ nested: { total: 2, signal: null, expanded: false } });
  });

  it("surfaces a subagent that needs the user on a collapsed parent", () => {
    const threads = [
      root,
      subagentOf(root, "asking", { hasPendingApprovals: true }),
      subagentOf(root, "busy", working),
    ];
    const collapsed = listRows(threads, {
      expandedOverrides: { [`${environmentId}:${root.id}`]: false },
    });

    expect(describeRows(collapsed)).toEqual(["root"]);
    expect(collapsed[0]).toMatchObject({
      nested: { total: 2, signal: "approval", expanded: false },
    });
    expect(describeRows(listRows(threads))).toEqual(["root", "> asking", "> busy"]);
  });

  it("honors an explicit expand of finished subagents", () => {
    const rows = listRows([root, subagentOf(root, "done")], {
      expandedOverrides: { [`${environmentId}:${root.id}`]: true },
    });

    expect(describeRows(rows)).toEqual(["root", "> done"]);
  });

  it("keeps the open subagent visible under a collapsed parent", () => {
    const rows = listRows([root, subagentOf(root, "done-a"), subagentOf(root, "open")], {
      selectedThreadKey: `${environmentId}:open`,
    });

    expect(describeRows(rows)).toEqual(["root", "> open"]);
  });

  it("draws a nested Settled group and preserves its expansion for recycled rows", () => {
    const done = subagentOf(root, "done", { settledOverride: "settled", settledAt: NOW });
    const busy = subagentOf(root, "busy", working);
    const threads = [root, done, busy];
    const folded = listRows(threads);
    expect(describeRows(folded)).toEqual(["root", "> busy", "v2-nested-settled"]);
    const header = folded.at(-1)!;
    expect(header).toMatchObject({
      type: "v2-nested-settled",
      count: 1,
      expanded: false,
      groupKey: `${environmentId}:root:settled`,
    });
    const expanded = listRows(threads, {
      expandedOverrides: { [`${environmentId}:root:settled`]: true },
    });
    expect(describeRows(expanded)).toEqual(["root", "> busy", "v2-nested-settled", "> done"]);
    const openHeader = expanded.find((row) => row.type === "v2-nested-settled")!;
    expect(threadListV2ListItemsAreEqual(header, openHeader)).toBe(false);
    expect(threadListV2ListItemsAreEqual(header, { ...header })).toBe(true);
  });

  it("never nests side chats or archived subagents", () => {
    const sideChat = makeThread({
      id: ThreadId.make("side"),
      title: "Side",
      lineage: {
        parentThreadId: root.id,
        rootThreadId: root.id,
        relationshipToParent: "subagent",
        sideChat: true,
      },
      ...working,
    });
    const archived = subagentOf(root, "archived", { ...working, archivedAt: NOW });

    expect(describeRows(listRows([root, sideChat, archived]))).toEqual(["root"]);
  });

  it("windows a long subagent list behind a more row", () => {
    const children = Array.from({ length: 12 }, (_, index) =>
      subagentOf(root, `done-${String(index).padStart(2, "0")}`, {
        createdAt: isoAt(BASE_MS + index * MINUTE_MS),
      }),
    );
    const expandedOverrides = { [`${environmentId}:${root.id}`]: true };
    const windowed = describeRows(listRows([root, ...children], { expandedOverrides }));

    expect(windowed).toHaveLength(1 + 8 + 1);
    expect(windowed.at(-1)).toBe("> +4");
    expect(windowed.at(-2)).toBe("> done-11");
    expect(
      listRows([root, ...children], {
        expandedOverrides,
        showAllKeys: new Set([`${environmentId}:${root.id}`]),
      }),
    ).toHaveLength(13);
  });

  it("draws one hairline under a family, not between a parent and its subagents", () => {
    const newer = makeThread({ id: ThreadId.make("newer"), title: "Newer", createdAt: NOW });
    const older = makeThread({
      id: ThreadId.make("older"),
      title: "Older",
      createdAt: isoAt(BASE_MS - MINUTE_MS),
    });
    const rows = listRows([
      newer,
      subagentOf(newer, "a", working),
      subagentOf(newer, "b", working),
      older,
    ]);

    expect(describeRows(rows)).toEqual(["newer", "> a", "> b", "older"]);
    expect(
      rows.map((row) => ("showTrailingDivider" in row ? row.showTrailingDivider : null)),
    ).toEqual([false, false, true, false]);
  });

  it("re-renders a parent only when what it reports about its subagents changes", () => {
    const child = subagentOf(root, "child", working);
    const before = listRows([root, child]);
    const unrelated = listRows([root, child, fork]);
    const asking = listRows([root, { ...child, hasPendingApprovals: true }]);
    const parentRow = (rows: ReadonlyArray<ThreadListV2ListItem>) =>
      rows.find((row) => row.type === "v2-thread" && row.item.thread.id === root.id)!;
    const childRow = (rows: ReadonlyArray<ThreadListV2ListItem>) =>
      rows.find((row) => row.type === "v2-nested-thread")!;

    expect(threadListV2ListItemsAreEqual(parentRow(before), parentRow(unrelated))).toBe(true);
    expect(threadListV2ListItemsAreEqual(childRow(before), childRow(unrelated))).toBe(true);
    expect(threadListV2ListItemsAreEqual(parentRow(before), parentRow(asking))).toBe(false);
    expect(threadListV2ListItemsAreEqual(childRow(before), childRow(asking))).toBe(false);
  });
});
