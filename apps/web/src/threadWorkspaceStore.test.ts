import type { EnvironmentId } from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { DraftId } from "./composerDraftStore";
import {
  activateThreadWorkspacePane,
  bindThreadWorkspaceRouteTarget,
  closeThreadWorkspaceTab,
  moveThreadWorkspaceTab,
  resizeThreadWorkspace,
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
