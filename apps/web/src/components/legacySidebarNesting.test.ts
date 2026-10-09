import type { ThreadNestingThread } from "@t3tools/client-runtime/state/thread-relationships";
import { describe, expect, it } from "vite-plus/test";

import {
  legacyProjectThreadRows,
  legacyStandaloneRow,
  nestLegacyProjectThreads,
} from "./legacySidebarNesting";

let tick = 0;

function thread(
  id: string,
  options: {
    readonly parent?: string;
    readonly relationship?: "subagent" | "fork";
    readonly archived?: boolean;
    readonly working?: boolean;
    readonly approval?: boolean;
  } = {},
): ThreadNestingThread {
  tick += 1;
  return {
    environmentId: "laptop",
    id,
    createdAt: `2026-01-01T00:00:${String(tick).padStart(2, "0")}.000Z`,
    archivedAt: options.archived ? "2026-01-02T00:00:00.000Z" : null,
    lineage: {
      parentThreadId: options.parent ?? null,
      relationshipToParent:
        options.parent === undefined ? null : (options.relationship ?? "subagent"),
    } as ThreadNestingThread["lineage"],
    forkedFrom: null,
    hasPendingApprovals: options.approval ?? false,
    hasPendingUserInput: false,
    runtime: options.working ? ({ status: "running" } as ThreadNestingThread["runtime"]) : null,
  };
}

function rows(input: {
  readonly sorted: ReadonlyArray<ThreadNestingThread>;
  readonly archived?: ReadonlyArray<ThreadNestingThread>;
  readonly limit?: number;
  readonly expanded?: Readonly<Record<string, boolean>>;
  readonly active?: ReadonlyArray<string>;
}) {
  const { nesting, topLevel } = nestLegacyProjectThreads({
    sortedThreads: input.sorted,
    ...(input.archived ? { archivedThreads: input.archived } : {}),
  });
  return legacyProjectThreadRows({
    nesting,
    topLevel: input.limit === undefined ? topLevel : topLevel.slice(0, input.limit),
    expandedOverrides: input.expanded ?? {},
    activePathKeys: new Set(input.active ?? []),
  }).map((row) => `${"  ".repeat(row.depth)}${row.kind === "thread" ? row.thread.id : "Settled"}`);
}

describe("legacy sidebar nesting", () => {
  it("keeps a project without subagents exactly as it was sorted", () => {
    const sorted = [thread("c"), thread("a"), thread("b")];
    expect(rows({ sorted })).toEqual(["c", "a", "b"]);
    expect(nestLegacyProjectThreads({ sortedThreads: sorted }).topLevel).toEqual(sorted);
  });

  it("puts working subagents under their parent, in spawn order, at any depth", () => {
    const parent = thread("parent");
    const first = thread("first", { parent: "parent", working: true });
    const second = thread("second", { parent: "parent" });
    const grandchild = thread("grandchild", { parent: "first", working: true });
    // The project's own sort order mixes them up; nesting restores the tree.
    expect(rows({ sorted: [grandchild, second, thread("other"), first, parent] })).toEqual([
      "other",
      "parent",
      "  first",
      "    grandchild",
      "  second",
    ]);
  });

  it("folds quiet subagents away until the user opens them", () => {
    const sorted = [thread("parent"), thread("child", { parent: "parent" })];
    expect(rows({ sorted })).toEqual(["parent"]);
    expect(rows({ sorted, expanded: { "laptop:parent": true } })).toEqual(["parent", "  child"]);
    // An explicit collapse wins even while a child is working.
    const busy = [thread("parent"), thread("child", { parent: "parent", working: true })];
    expect(rows({ sorted: busy })).toEqual(["parent", "  child"]);
    expect(rows({ sorted: busy, expanded: { "laptop:parent": false } })).toEqual(["parent"]);
  });

  it("keeps the open thread visible under a collapsed parent", () => {
    const sorted = [
      thread("parent"),
      thread("quiet", { parent: "parent" }),
      thread("open", { parent: "parent" }),
    ];
    expect(rows({ sorted, active: ["laptop:open", "laptop:parent"] })).toEqual([
      "parent",
      "  open",
    ]);
  });

  it("reports the count and state a parent row needs for its toggle", () => {
    const { nesting, topLevel } = nestLegacyProjectThreads({
      sortedThreads: [
        thread("parent"),
        thread("a", { parent: "parent", approval: true }),
        thread("b", { parent: "parent" }),
      ],
    });
    const [parent, child] = legacyProjectThreadRows({
      nesting,
      topLevel,
      expandedOverrides: {},
      activePathKeys: new Set(),
    });
    expect(parent).toMatchObject({ depth: 0, expanded: true });
    expect(parent?.kind === "thread" ? parent.summary : null).toMatchObject({
      total: 2,
      signal: "approval",
    });
    expect(child).toMatchObject({ depth: 1, summary: null });
  });

  it("counts only top-level threads toward the preview limit", () => {
    const sorted = [
      thread("one"),
      thread("child", { parent: "one", working: true }),
      thread("two"),
      thread("three"),
    ];
    expect(nestLegacyProjectThreads({ sortedThreads: sorted }).topLevel.map((t) => t.id)).toEqual([
      "one",
      "two",
      "three",
    ]);
    // Two top-level rows fit; the child comes along with its parent.
    expect(rows({ sorted, limit: 2 })).toEqual(["one", "  child", "two"]);
  });

  it("gives a subagent a top-level row when its parent is in another project", () => {
    expect(rows({ sorted: [thread("orphan", { parent: "elsewhere" }), thread("a")] })).toEqual([
      "orphan",
      "a",
    ]);
  });

  it("leaves forks as their own rows", () => {
    const sorted = [thread("parent"), thread("fork", { parent: "parent", relationship: "fork" })];
    expect(rows({ sorted })).toEqual(["parent", "fork"]);
  });

  it("drops the finished subagents of an archived parent and keeps a live one", () => {
    const archived = [thread("gone", { archived: true })];
    expect(
      rows({
        sorted: [
          thread("quiet", { parent: "gone" }),
          thread("busy", { parent: "gone", working: true }),
        ],
        archived,
      }),
    ).toEqual(["busy"]);
  });

  it("draws a nested thread alone at the top level for a collapsed project", () => {
    expect(legacyStandaloneRow(thread("child", { parent: "parent" }))).toMatchObject({
      key: "laptop:child",
      depth: 0,
      summary: null,
      expanded: false,
    });
  });

  it("returns no rows for an empty project", () => {
    expect(rows({ sorted: [] })).toEqual([]);
  });
});

it("keeps settled descendants grouped without adding shelf headers to thread selections", () => {
  const parent = thread("parent");
  const done = { ...thread("done", { parent: "parent" }), settledOverride: "settled" as const };
  const { nesting, topLevel } = nestLegacyProjectThreads({ sortedThreads: [parent, done] });
  const rows = legacyProjectThreadRows({
    nesting,
    topLevel,
    expandedOverrides: { "laptop:parent": true, "laptop:parent:settled": true },
    activePathKeys: new Set(),
  });
  expect(rows.map((row) => row.kind)).toEqual(["thread", "settled", "thread"]);
  expect(rows.filter((row) => row.kind === "thread").map((row) => row.thread.id)).toEqual([
    "parent",
    "done",
  ]);
});

it("keeps archived subagents under archived parents and expands settled descendants in all-states mode", () => {
  const parent = thread("parent", { archived: true });
  const child = {
    ...thread("child", { parent: "parent", archived: true }),
    settledOverride: "settled" as const,
  };
  const grandchild = thread("deep", { parent: "child" });
  const { nesting, topLevel } = nestLegacyProjectThreads({
    sortedThreads: [grandchild],
    archivedThreads: [parent, child],
    showAllSubthreads: true,
  });
  expect(topLevel.map((thread) => thread.id)).toEqual(["parent"]);
  const visible = legacyProjectThreadRows({
    nesting,
    topLevel,
    expandedOverrides: { "laptop:parent": false },
    activePathKeys: new Set(),
    showAllSubthreads: true,
  });
  expect(
    visible.filter((row) => row.kind === "thread").map((row) => [row.thread.id, row.depth]),
  ).toEqual([
    ["parent", 0],
    ["child", 1],
    ["deep", 2],
  ]);
});

it("keeps a project containing only an archived family nonempty and its selected child available", () => {
  const parent = thread("parent", { archived: true });
  const child = thread("child", { parent: "parent", archived: true });
  const { nesting, topLevel } = nestLegacyProjectThreads({
    sortedThreads: [],
    archivedThreads: [parent, child],
    showAllSubthreads: true,
  });
  expect(topLevel.map((thread) => thread.id)).toEqual(["parent"]);
  const visible = legacyProjectThreadRows({
    nesting,
    topLevel,
    expandedOverrides: {},
    activePathKeys: new Set(),
    showAllSubthreads: true,
  });
  expect(visible.filter((row) => row.kind === "thread").map((row) => row.thread.id)).toEqual([
    "parent",
    "child",
  ]);
  expect(legacyStandaloneRow(child)).toMatchObject({ kind: "thread", thread: child });
});
