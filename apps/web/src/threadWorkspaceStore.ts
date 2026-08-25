import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { DraftId } from "./composerDraftStore";
import { resolveStorage } from "./lib/storage";

export const THREAD_WORKSPACE_LAYOUTS = [
  "single",
  "two-columns",
  "three-columns",
  "four-columns",
  "two-rows",
  "three-rows",
  "grid-2x2",
] as const;

export type ThreadWorkspaceLayout = (typeof THREAD_WORKSPACE_LAYOUTS)[number];

export type ThreadWorkspaceTarget =
  | {
      readonly routeKind: "server";
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
    }
  | {
      readonly routeKind: "draft";
      readonly draftId: DraftId;
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
    };

export interface ThreadWorkspacePane {
  readonly id: string;
  readonly tabs: readonly ThreadWorkspaceTarget[];
  readonly activeTabKey: string | null;
}

interface ThreadWorkspaceModel {
  readonly layout: ThreadWorkspaceLayout;
  readonly panes: readonly ThreadWorkspacePane[];
  readonly activePaneId: string;
}

interface ThreadWorkspaceStoreState extends ThreadWorkspaceModel {
  bindRouteTarget: (target: ThreadWorkspaceTarget) => void;
  setLayout: (layout: ThreadWorkspaceLayout) => void;
  activatePane: (paneId: string) => void;
  activateTab: (paneId: string, tabKey: string) => void;
  closeTab: (paneId: string, tabKey: string) => void;
  moveTab: (tabKey: string, destinationPaneId: string, destinationIndex: number) => void;
}

const THREAD_WORKSPACE_STORAGE_KEY = "t3code:thread-workspace:v1";
const THREAD_WORKSPACE_STORAGE_VERSION = 1;

let nextPaneSequence = 0;

function createPane(): ThreadWorkspacePane {
  nextPaneSequence += 1;
  return {
    id: `thread-pane-${nextPaneSequence}`,
    tabs: [],
    activeTabKey: null,
  };
}

export function threadWorkspacePaneCount(layout: ThreadWorkspaceLayout): number {
  switch (layout) {
    case "single":
      return 1;
    case "two-columns":
    case "two-rows":
      return 2;
    case "three-columns":
    case "three-rows":
      return 3;
    case "four-columns":
    case "grid-2x2":
      return 4;
  }
}

export function threadWorkspaceTargetKey(target: ThreadWorkspaceTarget): string {
  return scopedThreadKey(scopeThreadRef(target.environmentId, target.threadId));
}

function appendUniqueTargets(
  current: readonly ThreadWorkspaceTarget[],
  additions: readonly ThreadWorkspaceTarget[],
): readonly ThreadWorkspaceTarget[] {
  const keys = new Set(current.map(threadWorkspaceTargetKey));
  const next = [...current];
  for (const target of additions) {
    const key = threadWorkspaceTargetKey(target);
    if (keys.has(key)) continue;
    keys.add(key);
    next.push(target);
  }
  return next;
}

export function resizeThreadWorkspace(
  model: ThreadWorkspaceModel,
  layout: ThreadWorkspaceLayout,
): ThreadWorkspaceModel {
  const nextPaneCount = threadWorkspacePaneCount(layout);
  if (model.layout === layout && model.panes.length === nextPaneCount) return model;

  if (nextPaneCount > model.panes.length) {
    const additions = Array.from({ length: nextPaneCount - model.panes.length }, createPane);
    return {
      layout,
      panes: [...model.panes, ...additions],
      // The first new cell is ready to receive the next thread selected from the sidebar.
      activePaneId: additions[0]?.id ?? model.activePaneId,
    };
  }

  const keptPanes = model.panes.slice(0, nextPaneCount);
  const removedPanes = model.panes.slice(nextPaneCount);
  const activeRemovedPane = removedPanes.find((pane) => pane.id === model.activePaneId) ?? null;
  const destinationPane =
    keptPanes.find((pane) => pane.id === model.activePaneId) ?? keptPanes[0] ?? createPane();
  const removedTabs = removedPanes.flatMap((pane) => pane.tabs);
  const mergedTabs = appendUniqueTargets(destinationPane.tabs, removedTabs);
  const removedActiveTabStillExists =
    activeRemovedPane !== null &&
    activeRemovedPane.activeTabKey !== null &&
    mergedTabs.some(
      (target) => threadWorkspaceTargetKey(target) === activeRemovedPane.activeTabKey,
    );
  const activeTabKey = removedActiveTabStillExists
    ? (activeRemovedPane?.activeTabKey ?? destinationPane.activeTabKey)
    : destinationPane.activeTabKey;

  return {
    layout,
    panes: keptPanes.map((pane) =>
      pane.id === destinationPane.id ? { ...pane, tabs: mergedTabs, activeTabKey } : pane,
    ),
    activePaneId: destinationPane.id,
  };
}

export function bindThreadWorkspaceRouteTarget(
  model: ThreadWorkspaceModel,
  target: ThreadWorkspaceTarget,
): ThreadWorkspaceModel {
  const targetKey = threadWorkspaceTargetKey(target);
  const existingPane = model.panes.find((pane) =>
    pane.tabs.some((tab) => threadWorkspaceTargetKey(tab) === targetKey),
  );

  if (existingPane) {
    return {
      ...model,
      activePaneId: existingPane.id,
      panes: model.panes.map((pane) =>
        pane.id === existingPane.id
          ? {
              ...pane,
              activeTabKey: targetKey,
              // Draft promotion keeps the same scoped thread key. Replace its route descriptor
              // in place so the tab survives the draft -> server URL transition.
              tabs: pane.tabs.map((tab) =>
                threadWorkspaceTargetKey(tab) === targetKey ? target : tab,
              ),
            }
          : pane,
      ),
    };
  }

  const activePane =
    model.panes.find((pane) => pane.id === model.activePaneId) ?? model.panes[0] ?? createPane();
  return {
    ...model,
    activePaneId: activePane.id,
    panes: model.panes.map((pane) =>
      pane.id === activePane.id
        ? { ...pane, tabs: [...pane.tabs, target], activeTabKey: targetKey }
        : pane,
    ),
  };
}

export function activateThreadWorkspacePane(
  model: ThreadWorkspaceModel,
  paneId: string,
): ThreadWorkspaceModel {
  return model.panes.some((pane) => pane.id === paneId)
    ? { ...model, activePaneId: paneId }
    : model;
}

export function activateThreadWorkspaceTab(
  model: ThreadWorkspaceModel,
  paneId: string,
  tabKey: string,
): ThreadWorkspaceModel {
  const pane = model.panes.find((candidate) => candidate.id === paneId);
  if (!pane?.tabs.some((target) => threadWorkspaceTargetKey(target) === tabKey)) return model;
  return {
    ...model,
    activePaneId: paneId,
    panes: model.panes.map((candidate) =>
      candidate.id === paneId ? { ...candidate, activeTabKey: tabKey } : candidate,
    ),
  };
}

export function closeThreadWorkspaceTab(
  model: ThreadWorkspaceModel,
  paneId: string,
  tabKey: string,
): ThreadWorkspaceModel {
  const totalTabs = model.panes.reduce((count, pane) => count + pane.tabs.length, 0);
  // The router always needs one canonical thread URL. Closing the final tab would leave the
  // workspace with no route to represent, so keep it until another thread is opened.
  if (totalTabs <= 1) return model;

  const pane = model.panes.find((candidate) => candidate.id === paneId);
  const tabIndex =
    pane?.tabs.findIndex((target) => threadWorkspaceTargetKey(target) === tabKey) ?? -1;
  if (!pane || tabIndex < 0) return model;

  const remainingTabs = pane.tabs.filter((target) => threadWorkspaceTargetKey(target) !== tabKey);
  const nextTab = remainingTabs[Math.min(tabIndex, remainingTabs.length - 1)] ?? null;
  const panes = model.panes.map((candidate) =>
    candidate.id === paneId
      ? {
          ...candidate,
          tabs: remainingTabs,
          activeTabKey:
            candidate.activeTabKey === tabKey
              ? nextTab
                ? threadWorkspaceTargetKey(nextTab)
                : null
              : candidate.activeTabKey,
        }
      : candidate,
  );

  if (model.activePaneId !== paneId || nextTab) {
    return { ...model, panes };
  }

  const fallbackPane = panes.find((candidate) => candidate.activeTabKey !== null);
  return fallbackPane ? { ...model, panes, activePaneId: fallbackPane.id } : model;
}

export function moveThreadWorkspaceTab(
  model: ThreadWorkspaceModel,
  tabKey: string,
  destinationPaneId: string,
  destinationIndex: number,
): ThreadWorkspaceModel {
  const sourcePane = model.panes.find((pane) =>
    pane.tabs.some((target) => threadWorkspaceTargetKey(target) === tabKey),
  );
  const destinationPane = model.panes.find((pane) => pane.id === destinationPaneId);
  if (!sourcePane || !destinationPane) return model;

  const sourceIndex = sourcePane.tabs.findIndex(
    (target) => threadWorkspaceTargetKey(target) === tabKey,
  );
  const movedTarget = sourcePane.tabs[sourceIndex];
  if (!movedTarget) return model;

  if (sourcePane.id === destinationPane.id) {
    const nextIndex = Math.max(0, Math.min(destinationIndex, sourcePane.tabs.length - 1));
    if (sourceIndex === nextIndex) return model;
    const tabs = [...sourcePane.tabs];
    tabs.splice(sourceIndex, 1);
    tabs.splice(nextIndex, 0, movedTarget);
    return {
      ...model,
      panes: model.panes.map((pane) => (pane.id === sourcePane.id ? { ...pane, tabs } : pane)),
    };
  }

  const sourceTabs = sourcePane.tabs.filter(
    (target) => threadWorkspaceTargetKey(target) !== tabKey,
  );
  const nextSourceTarget = sourceTabs[Math.min(sourceIndex, sourceTabs.length - 1)] ?? null;
  const targetTabs = [...destinationPane.tabs];
  const nextIndex = Math.max(0, Math.min(destinationIndex, targetTabs.length));
  targetTabs.splice(nextIndex, 0, movedTarget);

  return {
    ...model,
    activePaneId: destinationPane.id,
    panes: model.panes.map((pane) => {
      if (pane.id === sourcePane.id) {
        return {
          ...pane,
          tabs: sourceTabs,
          activeTabKey:
            pane.activeTabKey === tabKey
              ? nextSourceTarget
                ? threadWorkspaceTargetKey(nextSourceTarget)
                : null
              : pane.activeTabKey,
        };
      }
      if (pane.id === destinationPane.id) {
        return { ...pane, tabs: targetTabs, activeTabKey: tabKey };
      }
      return pane;
    }),
  };
}

export function selectActiveThreadWorkspaceTarget(
  model: Pick<ThreadWorkspaceModel, "panes" | "activePaneId">,
): ThreadWorkspaceTarget | null {
  const pane = model.panes.find((candidate) => candidate.id === model.activePaneId);
  if (!pane?.activeTabKey) return null;
  return pane.tabs.find((target) => threadWorkspaceTargetKey(target) === pane.activeTabKey) ?? null;
}

function createInitialWorkspaceModel(
  layout: ThreadWorkspaceLayout = "single",
): ThreadWorkspaceModel {
  const panes = Array.from({ length: threadWorkspacePaneCount(layout) }, createPane);
  return { layout, panes, activePaneId: panes[0]!.id };
}

function isThreadWorkspaceLayout(value: unknown): value is ThreadWorkspaceLayout {
  return THREAD_WORKSPACE_LAYOUTS.includes(value as ThreadWorkspaceLayout);
}

export const useThreadWorkspaceStore = create<ThreadWorkspaceStoreState>()(
  persist(
    (set) => ({
      ...createInitialWorkspaceModel(),
      bindRouteTarget: (target) => set((state) => bindThreadWorkspaceRouteTarget(state, target)),
      setLayout: (layout) => set((state) => resizeThreadWorkspace(state, layout)),
      activatePane: (paneId) => set((state) => activateThreadWorkspacePane(state, paneId)),
      activateTab: (paneId, tabKey) =>
        set((state) => activateThreadWorkspaceTab(state, paneId, tabKey)),
      closeTab: (paneId, tabKey) => set((state) => closeThreadWorkspaceTab(state, paneId, tabKey)),
      moveTab: (tabKey, destinationPaneId, destinationIndex) =>
        set((state) => moveThreadWorkspaceTab(state, tabKey, destinationPaneId, destinationIndex)),
    }),
    {
      name: THREAD_WORKSPACE_STORAGE_KEY,
      version: THREAD_WORKSPACE_STORAGE_VERSION,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      // Open tabs are session state and are rebuilt from the canonical route. Only the user's
      // chosen geometry survives a reload, avoiding stale or deleted thread tabs.
      partialize: (state) => ({ layout: state.layout }),
      merge: (persisted, current) => {
        const layout =
          persisted &&
          typeof persisted === "object" &&
          "layout" in persisted &&
          isThreadWorkspaceLayout(persisted.layout)
            ? persisted.layout
            : current.layout;
        const resized = resizeThreadWorkspace(current, layout);
        return {
          ...current,
          ...resized,
          activePaneId: resized.panes[0]?.id ?? resized.activePaneId,
        };
      },
    },
  ),
);
