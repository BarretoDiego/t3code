import { describe, expect, it } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";

import {
  buildThreadNesting,
  flattenThreadNesting,
  resolveThreadNestingExpanded,
  reuseEqualThreadNestingDisplay,
  threadNestingAncestorKeys,
  type ThreadNesting,
  type ThreadNestingThread,
} from "./threadRelationships.ts";

interface TestThread extends ThreadNestingThread {
  readonly settled?: boolean;
  readonly creationSource?: "provider" | "mcp";
  readonly projectId?: string;
}

type State = "quiet" | "working" | "approval" | "input" | "failed";

let clock = 0;

/** Each fixture spawns one second after the previous one unless it says otherwise. */
function spawnTime(tick: number): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `2026-01-01T${pad(Math.floor(tick / 3600))}:${pad(Math.floor(tick / 60) % 60)}:${pad(tick % 60)}.000Z`;
}

function thread(
  id: string,
  options: {
    readonly parent?: string;
    readonly relationship?: "subagent" | "fork";
    readonly state?: State;
    readonly environmentId?: string;
    readonly archived?: boolean;
    readonly settled?: boolean;
    readonly createdAt?: string;
    readonly creationSource?: "provider" | "mcp";
    readonly projectId?: string;
  } = {},
): TestThread {
  clock += 1;
  const state = options.state ?? "quiet";
  return {
    environmentId: options.environmentId ?? "env",
    id,
    createdAt: options.createdAt ?? spawnTime(clock),
    archivedAt: options.archived ? "2026-02-01T00:00:00.000Z" : null,
    lineage: {
      rootThreadId: ThreadId.make(id),
      parentThreadId: options.parent === undefined ? null : ThreadId.make(options.parent),
      relationshipToParent:
        options.parent === undefined ? null : (options.relationship ?? "subagent"),
    },
    forkedFrom: null,
    hasPendingApprovals: state === "approval",
    hasPendingUserInput: state === "input",
    runtime:
      state === "working"
        ? { status: "running" }
        : state === "failed"
          ? { status: "failed" }
          : { status: "completed" },
    ...(options.settled === undefined ? {} : { settled: options.settled }),
    ...(options.creationSource === undefined ? {} : { creationSource: options.creationSource }),
    ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
  };
}

function build(
  threads: ReadonlyArray<TestThread>,
  isListed: (thread: TestThread) => boolean = (candidate) => candidate.archivedAt === null,
): ThreadNesting<TestThread> {
  return buildThreadNesting({
    threads,
    isListed,
  });
}

/** `parent > child > grandchild` paths for every row, to compare whole forests at a glance. */
function outline(nesting: ThreadNesting<TestThread>): string[] {
  const lines: string[] = [];
  const visit = (key: string, path: string) => {
    const node = nesting.nodeByKey.get(key)!;
    const next = path === "" ? node.thread.id : `${path} > ${node.thread.id}`;
    lines.push(next);
    for (const child of node.children) visit(child.key, next);
  };
  for (const root of nesting.roots) visit(root.key, "");
  return lines;
}

function display(
  nesting: ThreadNesting<TestThread>,
  rootId: string,
  options: {
    readonly overrides?: Record<string, boolean>;
    readonly active?: string;
    readonly childLimit?: number;
    readonly showAll?: ReadonlyArray<string>;
  } = {},
) {
  const activeKey = options.active === undefined ? null : `env:${options.active}`;
  return flattenThreadNesting({
    node: nesting.nodeByKey.get(`env:${rootId}`)!,
    expandedOverrides: options.overrides ?? {},
    activePathKeys: new Set(
      activeKey === null ? [] : [activeKey, ...threadNestingAncestorKeys(nesting, activeKey)],
    ),
    childLimit: options.childLimit ?? 8,
    showAllKeys: new Set((options.showAll ?? []).map((id) => `env:${id}`)),
  });
}

function rowLabels(shown: ReturnType<typeof display>): string[] {
  return (shown?.rows ?? []).map((row) =>
    row.kind === "more"
      ? `${"  ".repeat(row.depth - 1)}+${row.hiddenCount} more`
      : `${"  ".repeat(row.depth - 1)}${row.thread.id}`,
  );
}

describe("thread nesting forest", () => {
  it("leaves threads without children as plain top-level rows", () => {
    const nesting = build([thread("a"), thread("b")]);

    expect(outline(nesting)).toEqual(["a", "b"]);
    expect(nesting.roots.every((root) => root.summary === null && root.detachedFrom === null)).toBe(
      true,
    );
    expect(display(nesting, "a")).toBeNull();
  });

  it("nests one and many subagents under their parent in spawn order", () => {
    const nesting = build([
      thread("solo-parent"),
      thread("busy-parent"),
      thread("late", { parent: "busy-parent", createdAt: "2026-03-01T00:00:03.000Z" }),
      thread("early", { parent: "busy-parent", createdAt: "2026-03-01T00:00:01.000Z" }),
      thread("only", { parent: "solo-parent" }),
      thread("middle", { parent: "busy-parent", createdAt: "2026-03-01T00:00:02.000Z" }),
    ]);

    expect(outline(nesting)).toEqual([
      "solo-parent",
      "solo-parent > only",
      "busy-parent",
      "busy-parent > early",
      "busy-parent > middle",
      "busy-parent > late",
    ]);
    expect(nesting.nodeByKey.get("env:busy-parent")?.summary?.total).toBe(3);
  });

  it("nests provider-native and T3-managed subagents alike", () => {
    const nesting = build([
      thread("orchestrator"),
      thread("native", { parent: "orchestrator", creationSource: "provider" }),
      thread("delegated", { parent: "orchestrator", creationSource: "mcp" }),
    ]);

    expect(outline(nesting)).toEqual([
      "orchestrator",
      "orchestrator > native",
      "orchestrator > delegated",
    ]);
  });

  it("keeps forks at the top level", () => {
    const nesting = build([
      thread("main"),
      thread("fork", { parent: "main", relationship: "fork" }),
    ]);

    expect(outline(nesting)).toEqual(["main", "fork"]);
    expect(nesting.nodeByKey.get("env:fork")?.detachedFrom).toBeNull();
    expect(nesting.nodeByKey.get("env:main")?.summary).toBeNull();
  });

  it("nests grandchildren and counts every depth on each ancestor", () => {
    const nesting = build([
      thread("root"),
      thread("child", { parent: "root" }),
      thread("grandchild", { parent: "child", state: "working" }),
      thread("great", { parent: "grandchild", state: "approval" }),
    ]);

    expect(outline(nesting)).toEqual([
      "root",
      "root > child",
      "root > child > grandchild",
      "root > child > grandchild > great",
    ]);
    expect(nesting.nodeByKey.get("env:root")?.summary).toMatchObject({
      total: 3,
      signal: "approval",
      live: true,
      counts: { working: 1, approval: 1 },
    });
    expect(nesting.nodeByKey.get("env:grandchild")?.depth).toBe(2);
    expect(threadNestingAncestorKeys(nesting, "env:great")).toEqual([
      "env:grandchild",
      "env:child",
      "env:root",
    ]);
  });

  it("shows a child whose parent is not loaded as its own row", () => {
    const nesting = build([thread("orphan", { parent: "gone" }), thread("other")]);

    expect(outline(nesting)).toEqual(["orphan", "other"]);
    expect(nesting.nodeByKey.get("env:orphan")?.detachedFrom).toEqual({
      parentKey: "env:gone",
      parent: null,
      reason: "missing",
    });
  });

  it("keeps every thread of a parent loop and terminates", () => {
    const nesting = build([
      thread("a", { parent: "c", createdAt: "2026-03-01T00:00:02.000Z" }),
      thread("b", { parent: "a", createdAt: "2026-03-01T00:00:01.000Z" }),
      thread("c", { parent: "b", createdAt: "2026-03-01T00:00:03.000Z" }),
      thread("self", { parent: "self" }),
      thread("hanger-on", { parent: "a" }),
    ]);

    // The oldest loop member leads; the rest hang from it in parent order.
    expect(outline(nesting)).toEqual(["b", "b > c", "b > c > a", "b > c > a > hanger-on", "self"]);
    expect(nesting.nodeByKey.get("env:b")?.detachedFrom?.reason).toBe("cycle");
    expect(nesting.nodeByKey.size).toBe(5);
  });

  it("does not match a parent id across environments", () => {
    const nesting = build([
      thread("parent", { environmentId: "env-a" }),
      thread("parent", { environmentId: "env-b" }),
      thread("child", { environmentId: "env-b", parent: "parent" }),
      thread("stray", { environmentId: "env-c", parent: "parent" }),
    ]);

    expect(nesting.nodeByKey.get("env-a:parent")?.summary).toBeNull();
    expect(nesting.nodeByKey.get("env-b:parent")?.children.map((child) => child.key)).toEqual([
      "env-b:child",
    ]);
    expect(nesting.nodeByKey.get("env-c:stray")?.detachedFrom?.reason).toBe("missing");
  });

  it("nests a child under a parent in another project", () => {
    const nesting = build([
      thread("parent", { projectId: "app" }),
      thread("child", { parent: "parent", projectId: "docs" }),
    ]);

    expect(outline(nesting)).toEqual(["parent", "parent > child"]);
  });

  it("gives a child its own row when a filter hides its parent, and drops a filtered child", () => {
    const threads = [
      thread("app-parent", { projectId: "app" }),
      thread("docs-child", { parent: "app-parent", projectId: "docs" }),
      thread("docs-parent", { projectId: "docs" }),
      thread("app-child", { parent: "docs-parent", projectId: "app" }),
    ];
    const nesting = build(threads, (candidate) => candidate.projectId === "docs");

    expect(outline(nesting)).toEqual(["docs-child", "docs-parent"]);
    expect(nesting.nodeByKey.get("env:docs-child")?.detachedFrom).toMatchObject({
      reason: "unlisted",
      parent: threads[0],
    });
    expect(nesting.nodeByKey.get("env:docs-parent")?.summary).toBeNull();
  });
});

describe("children of a parent that is tucked away", () => {
  it("keeps quiet children with a settled parent", () => {
    const nesting = build([
      thread("parent", { settled: true }),
      thread("done", { parent: "parent" }),
      thread("broken", { parent: "parent", state: "failed" }),
    ]);

    expect(outline(nesting)).toEqual(["parent", "parent > done", "parent > broken"]);
    expect(nesting.nodeByKey.get("env:parent")?.summary?.signal).toBe("failed");
  });

  it.each(["working", "approval", "input"] as const)(
    "keeps a %s child grouped under a settled parent",
    (state) => {
      const nesting = build([
        thread("parent", { settled: true }),
        thread("done", { parent: "parent" }),
        thread("live", { parent: "parent", state }),
      ]);

      expect(outline(nesting)).toEqual(["parent", "parent > done", "parent > live"]);
      expect(nesting.nodeByKey.get("env:live")?.detachedFrom).toBeNull();
      // A closed history shelf must not split an active family.
      expect(nesting.nodeByKey.get("env:parent")?.summary).toMatchObject({
        total: 2,
        live: true,
      });
    },
  );

  it("keeps a working grandchild grouped through its quiet parent", () => {
    const nesting = build([
      thread("parent", { settled: true }),
      thread("child", { parent: "parent" }),
      thread("grandchild", { parent: "child", state: "working" }),
    ]);

    expect(outline(nesting)).toEqual(["parent", "parent > child", "parent > child > grandchild"]);
  });

  it("keeps the same hierarchy as a child goes quiet", () => {
    const parent = thread("parent", { settled: true });
    const working = thread("child", { parent: "parent", state: "working" });

    expect(outline(build([parent, working]))).toEqual(["parent", "parent > child"]);
    expect(build([parent, working]).roots[0]?.summary?.live).toBe(true);
    expect(
      build([parent, { ...working, runtime: { status: "completed" } }]).roots[0]?.summary?.live,
    ).toBe(false);
    expect(outline(build([parent, { ...working, runtime: { status: "completed" } }]))).toEqual([
      "parent",
      "parent > child",
    ]);
  });

  it("hides quiet children of an archived parent and surfaces live ones", () => {
    const nesting = build([
      thread("parent", { archived: true }),
      thread("done", { parent: "parent" }),
      thread("asking", { parent: "parent", state: "input" }),
      thread("quiet-branch", { parent: "parent" }),
      thread("deep-worker", { parent: "quiet-branch", state: "working" }),
    ]);

    expect(outline(nesting)).toEqual(["asking", "quiet-branch", "quiet-branch > deep-worker"]);
    expect(nesting.nodeByKey.has("env:done")).toBe(false);
    expect(nesting.nodeByKey.get("env:asking")?.detachedFrom?.reason).toBe("archived");
  });

  it("never lists an archived child", () => {
    const nesting = build([
      thread("parent"),
      thread("child", { parent: "parent", archived: true }),
    ]);

    expect(outline(nesting)).toEqual(["parent"]);
  });
});

describe("what a collapsed parent reports", () => {
  it.each([
    [["working", "quiet"], "working"],
    [["working", "failed"], "failed"],
    [["failed", "input", "working"], "input"],
    [["input", "approval", "failed", "working"], "approval"],
    [["quiet", "quiet"], null],
  ] as const)("children %j surface as %s", (states, signal) => {
    const nesting = build([
      thread("parent"),
      ...states.map((state, index) => thread(`child-${index}`, { parent: "parent", state })),
    ]);
    const summary = nesting.nodeByKey.get("env:parent")?.summary;

    expect(summary?.signal).toBe(signal);
    expect(summary?.total).toBe(states.length);
    // Collapsing changes which rows are drawn, never what the parent reports.
    expect(display(nesting, "parent", { overrides: { "env:parent": false } })?.summary).toEqual(
      summary,
    );
  });

  it("opens by default only while a child is working or waiting on the user", () => {
    const finished = build([
      thread("parent"),
      ...Array.from({ length: 12 }, (_, index) => thread(`done-${index}`, { parent: "parent" })),
    ]);
    const running = build([
      thread("parent"),
      thread("one", { parent: "parent", state: "working" }),
      thread("two", { parent: "parent", state: "working" }),
    ]);
    const failed = build([thread("parent"), thread("bad", { parent: "parent", state: "failed" })]);

    expect(display(finished, "parent")).toMatchObject({ expanded: false, rows: [] });
    expect(rowLabels(display(running, "parent"))).toEqual(["one", "two"]);
    expect(display(failed, "parent")?.expanded).toBe(false);
  });

  it("lets the user's choice outlast status changes", () => {
    const finished = build([thread("parent"), thread("done", { parent: "parent" })]);
    const running = build([
      thread("parent"),
      thread("busy", { parent: "parent", state: "working" }),
    ]);

    expect(rowLabels(display(finished, "parent", { overrides: { "env:parent": true } }))).toEqual([
      "done",
    ]);
    expect(display(running, "parent", { overrides: { "env:parent": false } })).toMatchObject({
      expanded: false,
      rows: [],
      summary: { signal: "working" },
    });
    expect(resolveThreadNestingExpanded(null, true)).toBe(false);
  });

  it("keeps the open thread's row when its ancestors are collapsed", () => {
    const nesting = build([
      thread("root"),
      thread("sibling", { parent: "root" }),
      thread("child", { parent: "root" }),
      thread("cousin", { parent: "child" }),
      thread("open", { parent: "child" }),
    ]);

    expect(rowLabels(display(nesting, "root", { active: "open" }))).toEqual(["child", "  open"]);
    expect(display(nesting, "root", { active: "open" })?.expanded).toBe(false);
  });
});

describe("row order and long child lists", () => {
  it("does not move rows when statuses change", () => {
    const parent = thread("parent");
    const children = ["a", "b", "c"].map((id) =>
      thread(id, { parent: "parent", state: "working" }),
    );
    const before = rowLabels(display(build([parent, ...children]), "parent"));
    const after = rowLabels(
      display(
        build([
          parent,
          { ...children[0]!, runtime: { status: "completed" } },
          { ...children[1]!, hasPendingApprovals: true },
          { ...children[2]!, runtime: { status: "failed" } },
        ]),
        "parent",
      ),
    );

    expect(before).toEqual(["a", "b", "c"]);
    expect(after).toEqual(before);
  });

  it("breaks identical spawn times by id so the order is total", () => {
    const createdAt = "2026-03-01T00:00:00.000Z";
    const forward = build([
      thread("parent"),
      thread("b", { parent: "parent", createdAt, state: "working" }),
      thread("a", { parent: "parent", createdAt }),
    ]);
    const reversed = build([
      thread("parent"),
      thread("a", { parent: "parent", createdAt }),
      thread("b", { parent: "parent", createdAt, state: "working" }),
    ]);

    expect(rowLabels(display(forward, "parent"))).toEqual(["a", "b"]);
    expect(rowLabels(display(reversed, "parent"))).toEqual(["a", "b"]);
  });

  it("windows a long list around what needs attention, then the newest", () => {
    const nesting = build([
      thread("parent"),
      thread("old-failure", { parent: "parent", state: "failed" }),
      ...Array.from({ length: 20 }, (_, index) => thread(`done-${index}`, { parent: "parent" })),
      thread("newest-worker", { parent: "parent", state: "working" }),
    ]);

    expect(rowLabels(display(nesting, "parent", { childLimit: 4 }))).toEqual([
      "old-failure",
      "done-18",
      "done-19",
      "newest-worker",
      "+18 more",
    ]);
    expect(display(nesting, "parent", { childLimit: 4, showAll: ["parent"] })?.rows).toHaveLength(
      22,
    );
    // The open thread stays in the window even when it is old and quiet.
    expect(rowLabels(display(nesting, "parent", { childLimit: 4, active: "done-0" }))).toContain(
      "done-0",
    );
  });

  it("never windows away a child that needs the user, even past the limit", () => {
    const nesting = build([
      thread("parent"),
      ...Array.from({ length: 6 }, (_, index) =>
        thread(`ask-${index}`, { parent: "parent", state: "approval" }),
      ),
      thread("done", { parent: "parent" }),
    ]);

    expect(rowLabels(display(nesting, "parent", { childLimit: 2 }))).toEqual([
      "ask-0",
      "ask-1",
      "ask-2",
      "ask-3",
      "ask-4",
      "ask-5",
      "+1 more",
    ]);
  });
});

describe("reusing an unchanged display", () => {
  it("returns the previous display until a drawn row changes", () => {
    const parent = thread("parent");
    const child = thread("child", { parent: "parent", state: "working" });
    const unrelated = thread("unrelated");
    const first = display(build([parent, child, unrelated]), "parent");
    const sameRows = display(
      build([parent, child, { ...unrelated, runtime: { status: "running" } }]),
      "parent",
    );
    const changedChild = display(
      build([parent, { ...child, hasPendingApprovals: true }, unrelated]),
      "parent",
    );

    expect(reuseEqualThreadNestingDisplay(first, sameRows)).toBe(first);
    expect(reuseEqualThreadNestingDisplay(first, changedChild)).toBe(changedChild);
    expect(reuseEqualThreadNestingDisplay(first, null)).toBeNull();
  });
});
