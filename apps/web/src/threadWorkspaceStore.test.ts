import type { EnvironmentId } from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { DraftId } from "./composerDraftStore";
import {
  activateThreadWorkspacePane,
  bindThreadWorkspaceRouteTarget,
  closeThreadWorkspaceTab,
  createSavedThreadWorkspace,
  moveThreadWorkspaceTab,
  normalizeThreadWorkspaceModel,
  pruneThreadWorkspaceTargets,
  resizeThreadWorkspace,
  restoreSavedThreadWorkspace,
  selectActiveThreadWorkspaceTarget,
  threadWorkspacePaneCount,
  threadWorkspaceTargetKey,
  type ThreadWorkspacePane,
  type ThreadWorkspaceTarget,
} from "./threadWorkspaceStore";

const target = (id: string): ThreadWorkspaceTarget => ({
  routeKind: "server",
  environmentId: "env-1" as EnvironmentId,
  threadId: ThreadId.make(id),
});

const pane = (
  id: string,
  tabs: readonly ThreadWorkspaceTarget[] = [],
  activeTabKey: string | null = tabs[0] ? threadWorkspaceTargetKey(tabs[0]) : null,
): ThreadWorkspacePane => ({ id, tabs, activeTabKey });

describe("threadWorkspaceStore", () => {
  it("creates the expected number of cells for every layout", () => {
    expect(threadWorkspacePaneCount("single")).toBe(1);
    expect(threadWorkspacePaneCount("two-columns")).toBe(2);
    expect(threadWorkspacePaneCount("three-columns")).toBe(3);
    expect(threadWorkspacePaneCount("four-columns")).toBe(4);
    expect(threadWorkspacePaneCount("two-rows")).toBe(2);
    expect(threadWorkspacePaneCount("three-rows")).toBe(3);
    expect(threadWorkspacePaneCount("grid-2x2")).toBe(4);
  });

  it("makes the first added cell active so the next routed thread fills it", () => {
    const first = target("one");
    const initial = {
      layout: "single" as const,
      panes: [pane("pane-a", [first])],
      activePaneId: "pane-a",
    };

    const expanded = resizeThreadWorkspace(initial, "two-columns");
    const routed = bindThreadWorkspaceRouteTarget(expanded, target("two"));

    expect(expanded.panes).toHaveLength(2);
    expect(expanded.activePaneId).not.toBe("pane-a");
    expect(selectActiveThreadWorkspaceTarget(routed)?.threadId).toBe("two");
    expect(routed.panes[0]?.tabs).toEqual([first]);
    expect(routed.panes[1]?.tabs.map((entry) => entry.threadId)).toEqual(["two"]);
  });

  it("focuses an existing tab instead of opening a duplicate", () => {
    const first = target("one");
    const second = target("two");
    const model = {
      layout: "two-columns" as const,
      panes: [pane("pane-a", [first]), pane("pane-b", [second])],
      activePaneId: "pane-b",
    };

    const routed = bindThreadWorkspaceRouteTarget(model, first);

    expect(routed.activePaneId).toBe("pane-a");
    expect(routed.panes.flatMap((entry) => entry.tabs)).toHaveLength(2);
    expect(selectActiveThreadWorkspaceTarget(routed)).toEqual(first);
  });

  it("replaces a promoted draft descriptor in place by its stable scoped thread key", () => {
    const draft = {
      routeKind: "draft" as const,
      draftId: DraftId.make("draft-one"),
      environmentId: "env-1" as EnvironmentId,
      threadId: ThreadId.make("reserved-thread"),
    } satisfies ThreadWorkspaceTarget;
    const server = target("reserved-thread");
    const model = {
      layout: "single" as const,
      panes: [pane("pane-a", [draft])],
      activePaneId: "pane-a",
    };

    const promoted = bindThreadWorkspaceRouteTarget(model, server);

    expect(promoted.panes[0]?.tabs).toEqual([server]);
  });

  it("merges tabs without loss when reducing the grid", () => {
    const first = target("one");
    const second = target("two");
    const third = target("three");
    const model = {
      layout: "three-columns" as const,
      panes: [pane("pane-a", [first]), pane("pane-b", [second]), pane("pane-c", [third])],
      activePaneId: "pane-c",
    };

    const reduced = resizeThreadWorkspace(model, "single");

    expect(reduced.panes).toHaveLength(1);
    expect(reduced.panes[0]?.tabs.map((entry) => entry.threadId)).toEqual(["one", "two", "three"]);
    expect(selectActiveThreadWorkspaceTarget(reduced)?.threadId).toBe("three");
  });

  it("reshapes four cells between column and grid geometry without touching tabs", () => {
    const first = target("one");
    const fourth = target("four");
    const model = {
      layout: "four-columns" as const,
      panes: [pane("pane-a", [first]), pane("pane-b"), pane("pane-c"), pane("pane-d", [fourth])],
      activePaneId: "pane-d",
    };

    const gridded = resizeThreadWorkspace(model, "grid-2x2");

    expect(gridded.layout).toBe("grid-2x2");
    expect(gridded.panes.map((entry) => entry.tabs)).toEqual(
      model.panes.map((entry) => entry.tabs),
    );
    expect(selectActiveThreadWorkspaceTarget(gridded)?.threadId).toBe("four");
  });

  it("keeps a canonical route target when closing tabs", () => {
    const first = target("one");
    const second = target("two");
    const model = {
      layout: "two-columns" as const,
      panes: [pane("pane-a", [first]), pane("pane-b", [second])],
      activePaneId: "pane-b",
    };

    const closed = closeThreadWorkspaceTab(model, "pane-b", threadWorkspaceTargetKey(second));
    const refusedFinalClose = closeThreadWorkspaceTab(
      closed,
      "pane-a",
      threadWorkspaceTargetKey(first),
    );

    expect(closed.activePaneId).toBe("pane-a");
    expect(selectActiveThreadWorkspaceTarget(closed)).toEqual(first);
    expect(refusedFinalClose).toBe(closed);
  });

  it("allows an empty cell to become the destination for the next routed thread", () => {
    const first = target("one");
    const model = {
      layout: "two-rows" as const,
      panes: [pane("pane-a", [first]), pane("pane-b")],
      activePaneId: "pane-a",
    };

    const activated = activateThreadWorkspacePane(model, "pane-b");
    const routed = bindThreadWorkspaceRouteTarget(activated, target("two"));

    expect(routed.panes[1]?.tabs.map((entry) => entry.threadId)).toEqual(["two"]);
  });

  it("reorders tabs within one pane without changing the active tab", () => {
    const first = target("one");
    const second = target("two");
    const third = target("three");
    const model = {
      layout: "single" as const,
      panes: [pane("pane-a", [first, second, third], threadWorkspaceTargetKey(second))],
      activePaneId: "pane-a",
    };

    const reordered = moveThreadWorkspaceTab(model, threadWorkspaceTargetKey(third), "pane-a", 0);

    expect(reordered.panes[0]?.tabs.map((entry) => entry.threadId)).toEqual([
      "three",
      "one",
      "two",
    ]);
    expect(selectActiveThreadWorkspaceTarget(reordered)).toEqual(second);
  });

  it("moves a tab into another pane at the requested position", () => {
    const first = target("one");
    const second = target("two");
    const third = target("three");
    const model = {
      layout: "two-columns" as const,
      panes: [
        pane("pane-a", [first, second], threadWorkspaceTargetKey(second)),
        pane("pane-b", [third]),
      ],
      activePaneId: "pane-a",
    };

    const moved = moveThreadWorkspaceTab(model, threadWorkspaceTargetKey(second), "pane-b", 0);

    expect(moved.panes[0]?.tabs).toEqual([first]);
    expect(moved.panes[0]?.activeTabKey).toBe(threadWorkspaceTargetKey(first));
    expect(moved.panes[1]?.tabs).toEqual([second, third]);
    expect(moved.activePaneId).toBe("pane-b");
    expect(selectActiveThreadWorkspaceTarget(moved)).toEqual(second);
  });

  it("moves the only tab in a pane into an empty pane", () => {
    const first = target("one");
    const model = {
      layout: "two-rows" as const,
      panes: [pane("pane-a", [first]), pane("pane-b")],
      activePaneId: "pane-a",
    };

    const moved = moveThreadWorkspaceTab(model, threadWorkspaceTargetKey(first), "pane-b", 0);

    expect(moved.panes[0]?.tabs).toEqual([]);
    expect(moved.panes[0]?.activeTabKey).toBeNull();
    expect(moved.panes[1]?.tabs).toEqual([first]);
    expect(selectActiveThreadWorkspaceTarget(moved)).toEqual(first);
  });
});

describe("thread workspace persistence", () => {
  it("repairs a persisted model whose pane count no longer matches its layout", () => {
    const first = target("one");
    const second = target("two");

    const restored = normalizeThreadWorkspaceModel({
      layout: "two-columns",
      panes: [
        { id: "pane-a", tabs: [first], activeTabKey: threadWorkspaceTargetKey(first) },
        { id: "pane-b", tabs: [second], activeTabKey: threadWorkspaceTargetKey(second) },
        { id: "pane-c", tabs: [], activeTabKey: null },
      ],
      activePaneId: "pane-c",
    });

    expect(restored?.panes).toHaveLength(2);
    // "pane-c" was dropped, so the active pane has to fall back to a real one.
    expect(restored?.panes.some((entry) => entry.id === restored.activePaneId)).toBe(true);
  });

  it("drops persisted junk instead of surfacing a broken tab", () => {
    const good = target("good");

    const restored = normalizeThreadWorkspaceModel({
      layout: "single",
      panes: [
        {
          id: "pane-a",
          tabs: [good, { routeKind: "server" }, null, { routeKind: "draft", environmentId: "e" }],
          activeTabKey: "missing-key",
        },
      ],
      activePaneId: "pane-a",
    });

    expect(restored?.panes[0]?.tabs).toEqual([good]);
    // An activeTabKey that survived nothing must point back at a real tab.
    expect(restored?.panes[0]?.activeTabKey).toBe(threadWorkspaceTargetKey(good));
  });

  it("refuses a persisted model with an unknown layout", () => {
    expect(normalizeThreadWorkspaceModel({ layout: "five-columns", panes: [] })).toBeNull();
    expect(normalizeThreadWorkspaceModel(null)).toBeNull();
  });

  it("keeps one tab in one pane when persisted data duplicates it", () => {
    const duplicated = target("dupe");

    const restored = normalizeThreadWorkspaceModel({
      layout: "two-columns",
      panes: [
        { id: "pane-a", tabs: [duplicated], activeTabKey: threadWorkspaceTargetKey(duplicated) },
        { id: "pane-b", tabs: [duplicated], activeTabKey: threadWorkspaceTargetKey(duplicated) },
      ],
      activePaneId: "pane-a",
    });

    expect(restored?.panes[0]?.tabs).toEqual([duplicated]);
    expect(restored?.panes[1]?.tabs).toEqual([]);
  });

  it("round-trips a saved workspace and hands restored panes fresh ids", () => {
    const first = target("one");
    const second = target("two");
    const model = {
      layout: "two-columns" as const,
      panes: [pane("thread-pane-1", [first]), pane("thread-pane-2", [second])],
      activePaneId: "thread-pane-2",
    };

    // Normalizing is what the rehydrate path does, and it is where the pane id
    // generator is told how far the restored ids already reach.
    const live = normalizeThreadWorkspaceModel(model)!;
    const saved = createSavedThreadWorkspace(live, { id: "s1", name: "Refactor", savedAt: 1 });
    const restored = restoreSavedThreadWorkspace(saved);

    expect(saved.activePaneIndex).toBe(1);
    expect(restored.layout).toBe("two-columns");
    expect(restored.panes.map((entry) => entry.tabs)).toEqual([[first], [second]]);
    expect(selectActiveThreadWorkspaceTarget(restored)?.threadId).toBe("two");
    // Restoring twice must not mint panes that alias the live ones or each other.
    const ids = new Set([
      ...live.panes.map((entry) => entry.id),
      ...restored.panes.map((entry) => entry.id),
      ...restoreSavedThreadWorkspace(saved).panes.map((entry) => entry.id),
    ]);
    expect(ids.size).toBe(6);
  });

  it("prunes dropped tabs and repoints the pane that lost its active one", () => {
    const kept = target("kept");
    const dropped = target("dropped");
    const model = {
      layout: "single" as const,
      panes: [pane("pane-a", [kept, dropped], threadWorkspaceTargetKey(dropped))],
      activePaneId: "pane-a",
    };

    const pruned = pruneThreadWorkspaceTargets(
      model,
      (entry) => threadWorkspaceTargetKey(entry) !== threadWorkspaceTargetKey(dropped),
    );

    expect(pruned.panes[0]?.tabs).toEqual([kept]);
    expect(pruned.panes[0]?.activeTabKey).toBe(threadWorkspaceTargetKey(kept));
  });

  it("returns the same model when a prune pass finds nothing to drop", () => {
    const model = {
      layout: "single" as const,
      panes: [pane("pane-a", [target("one")])],
      activePaneId: "pane-a",
    };

    expect(pruneThreadWorkspaceTargets(model, () => true)).toBe(model);
  });
});
