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

/**
 * A named snapshot the user can come back to.
 *
 * Pane identity is deliberately absent: ids only have to be unique inside the
 * one live model, so a snapshot stores geometry by position and hands out
 * fresh ids on restore. That way restoring the same snapshot twice, or
 * restoring one saved in an older session, can never alias a live pane.
 */
export interface SavedThreadWorkspace {
  readonly id: string;
  readonly name: string;
  readonly savedAt: number;
  readonly layout: ThreadWorkspaceLayout;
  readonly panes: ReadonlyArray<{
    readonly tabs: readonly ThreadWorkspaceTarget[];
    readonly activeTabKey: string | null;
  }>;
  readonly activePaneIndex: number;
}

interface ThreadWorkspaceStoreState extends ThreadWorkspaceModel {
  readonly saved: readonly SavedThreadWorkspace[];
  bindRouteTarget: (target: ThreadWorkspaceTarget) => void;
  setLayout: (layout: ThreadWorkspaceLayout) => void;
  activatePane: (paneId: string) => void;
  activateTab: (paneId: string, tabKey: string) => void;
  closeTab: (paneId: string, tabKey: string) => void;
  moveTab: (tabKey: string, destinationPaneId: string, destinationIndex: number) => void;
  pruneTargets: (retain: (target: ThreadWorkspaceTarget) => boolean) => void;
  saveWorkspace: (name: string) => void;
  deleteWorkspace: (id: string) => void;
  restoreWorkspace: (id: string) => void;
}

const THREAD_WORKSPACE_STORAGE_KEY = "t3code:thread-workspace:v1";
const THREAD_WORKSPACE_STORAGE_VERSION = 2;

export const MAX_SAVED_THREAD_WORKSPACES = 20;

let nextPaneSequence = 0;

function createPane(): ThreadWorkspacePane {
  nextPaneSequence += 1;
  return {
    id: `thread-pane-${nextPaneSequence}`,
    tabs: [],
    activeTabKey: null,
  };
}

// Restored panes keep the ids they were saved with, so the generator has to
// start above the highest one or the next created pane would collide with a
// pane already on screen.
function reservePaneSequence(panes: readonly ThreadWorkspacePane[]): void {
  for (const pane of panes) {
    const match = /^thread-pane-(\d+)$/.exec(pane.id);
    if (!match) continue;
    const value = Number(match[1]);
    if (Number.isSafeInteger(value) && value > nextPaneSequence) nextPaneSequence = value;
  }
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

/**
 * Drops tabs the caller no longer considers live.
 *
 * `retain` answers for one target only, and the caller owns the hard part:
 * an environment that has not finished loading, or is merely offline, must
 * answer `true` or a reconnect would come back to an emptied workspace. The
 * routed target has to be retained for the same reason — the router always
 * needs one tab to represent.
 *
 * Returns the same reference when nothing was dropped so a prune pass that
 * finds everything healthy does not re-render the workspace.
 */
export function pruneThreadWorkspaceTargets(
  model: ThreadWorkspaceModel,
  retain: (target: ThreadWorkspaceTarget) => boolean,
): ThreadWorkspaceModel {
  let removed = false;
  const panes = model.panes.map((pane) => {
    const tabs = pane.tabs.filter((target) => retain(target));
    if (tabs.length === pane.tabs.length) return pane;
    removed = true;
    const activeTabKey =
      pane.activeTabKey !== null &&
      tabs.some((target) => threadWorkspaceTargetKey(target) === pane.activeTabKey)
        ? pane.activeTabKey
        : tabs[0]
          ? threadWorkspaceTargetKey(tabs[0])
          : null;
    return { ...pane, tabs, activeTabKey };
  });
  return removed ? { ...model, panes } : model;
}

export function createSavedThreadWorkspace(
  model: ThreadWorkspaceModel,
  input: { readonly id: string; readonly name: string; readonly savedAt: number },
): SavedThreadWorkspace {
  const activePaneIndex = model.panes.findIndex((pane) => pane.id === model.activePaneId);
  return {
    id: input.id,
    name: input.name,
    savedAt: input.savedAt,
    layout: model.layout,
    panes: model.panes.map((pane) => ({ tabs: pane.tabs, activeTabKey: pane.activeTabKey })),
    activePaneIndex: activePaneIndex < 0 ? 0 : activePaneIndex,
  };
}

export function restoreSavedThreadWorkspace(saved: SavedThreadWorkspace): ThreadWorkspaceModel {
  const paneCount = threadWorkspacePaneCount(saved.layout);
  const panes = Array.from({ length: paneCount }, (_, index) => {
    const source = saved.panes[index];
    const pane = createPane();
    return source ? { ...pane, tabs: source.tabs, activeTabKey: source.activeTabKey } : pane;
  });
  const activePane = panes[saved.activePaneIndex] ?? panes[0]!;
  const model = { layout: saved.layout, panes, activePaneId: activePane.id };
  return normalizeThreadWorkspaceModel(model) ?? model;
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

// Persisted JSON has already lost its branded types, and a hand-edited or
// half-written localStorage entry must never crash the workspace. Everything
// below rebuilds a usable model from whatever survived, rather than trusting
// the shape.
function isThreadWorkspaceTarget(value: unknown): value is ThreadWorkspaceTarget {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (!isNonEmptyString(candidate.environmentId) || !isNonEmptyString(candidate.threadId)) {
    return false;
  }
  if (candidate.routeKind === "server") return true;
  return candidate.routeKind === "draft" && isNonEmptyString(candidate.draftId);
}

/**
 * Repairs an untrusted model into one that satisfies every invariant the rest
 * of this module assumes: pane count matches the layout, pane ids are unique,
 * a tab key appears in exactly one pane, and both `activePaneId` and each
 * `activeTabKey` point at something that exists.
 */
export function normalizeThreadWorkspaceModel(candidate: unknown): ThreadWorkspaceModel | null {
  if (!candidate || typeof candidate !== "object") return null;
  const source = candidate as Record<string, unknown>;
  if (!isThreadWorkspaceLayout(source.layout)) return null;
  if (!Array.isArray(source.panes)) return null;

  const seenTabKeys = new Set<string>();
  const seenPaneIds = new Set<string>();
  const parsedPanes: ThreadWorkspacePane[] = [];
  for (const entry of source.panes) {
    if (!entry || typeof entry !== "object") continue;
    const paneSource = entry as Record<string, unknown>;
    const tabs = Array.isArray(paneSource.tabs)
      ? paneSource.tabs.filter(isThreadWorkspaceTarget).filter((target) => {
          const key = threadWorkspaceTargetKey(target);
          if (seenTabKeys.has(key)) return false;
          seenTabKeys.add(key);
          return true;
        })
      : [];
    const id =
      isNonEmptyString(paneSource.id) && !seenPaneIds.has(paneSource.id)
        ? paneSource.id
        : createPane().id;
    seenPaneIds.add(id);
    const activeTabKey =
      isNonEmptyString(paneSource.activeTabKey) &&
      tabs.some((target) => threadWorkspaceTargetKey(target) === paneSource.activeTabKey)
        ? paneSource.activeTabKey
        : tabs[0]
          ? threadWorkspaceTargetKey(tabs[0])
          : null;
    parsedPanes.push({ id, tabs, activeTabKey });
  }

  reservePaneSequence(parsedPanes);

  const paneCount = threadWorkspacePaneCount(source.layout);
  const panes =
    parsedPanes.length === paneCount
      ? parsedPanes
      : parsedPanes.length > paneCount
        ? // Collapsing a too-long list is the same problem `resizeThreadWorkspace`
          // solves, so reuse it rather than inventing a second merge rule.
          resizeThreadWorkspace(
            {
              layout: source.layout,
              panes: parsedPanes,
              activePaneId: parsedPanes[0]?.id ?? "",
            },
            source.layout,
          ).panes
        : [...parsedPanes, ...Array.from({ length: paneCount - parsedPanes.length }, createPane)];

  const activePaneId =
    isNonEmptyString(source.activePaneId) && panes.some((pane) => pane.id === source.activePaneId)
      ? source.activePaneId
      : (panes[0]?.id ?? null);
  if (activePaneId === null) return null;

  return { layout: source.layout, panes, activePaneId };
}

function normalizeSavedThreadWorkspaces(candidate: unknown): readonly SavedThreadWorkspace[] {
  if (!Array.isArray(candidate)) return [];
  const seenIds = new Set<string>();
  const saved: SavedThreadWorkspace[] = [];
  for (const entry of candidate) {
    if (!entry || typeof entry !== "object") continue;
    const source = entry as Record<string, unknown>;
    if (!isNonEmptyString(source.id) || seenIds.has(source.id)) continue;
    if (!isNonEmptyString(source.name)) continue;
    const model = normalizeThreadWorkspaceModel({
      layout: source.layout,
      // A snapshot stores no pane ids, so mint throwaway ones just to reuse the
      // same repair rules the live model goes through.
      panes: Array.isArray(source.panes)
        ? source.panes.map((pane, index) => ({
            ...(pane && typeof pane === "object" ? pane : {}),
            id: `saved-pane-${index}`,
          }))
        : [],
      activePaneId: `saved-pane-${
        typeof source.activePaneIndex === "number" ? source.activePaneIndex : 0
      }`,
    });
    if (!model) continue;
    seenIds.add(source.id);
    saved.push(
      createSavedThreadWorkspace(model, {
        id: source.id,
        name: source.name,
        savedAt: typeof source.savedAt === "number" ? source.savedAt : 0,
      }),
    );
  }
  return saved.slice(0, MAX_SAVED_THREAD_WORKSPACES);
}

let nextSavedWorkspaceSequence = 0;

function createSavedWorkspaceId(): string {
  nextSavedWorkspaceSequence += 1;
  return `saved-workspace-${Date.now()}-${nextSavedWorkspaceSequence}`;
}

export const useThreadWorkspaceStore = create<ThreadWorkspaceStoreState>()(
  persist(
    (set) => ({
      ...createInitialWorkspaceModel(),
      saved: [],
      bindRouteTarget: (target) => set((state) => bindThreadWorkspaceRouteTarget(state, target)),
      setLayout: (layout) => set((state) => resizeThreadWorkspace(state, layout)),
      activatePane: (paneId) => set((state) => activateThreadWorkspacePane(state, paneId)),
      activateTab: (paneId, tabKey) =>
        set((state) => activateThreadWorkspaceTab(state, paneId, tabKey)),
      closeTab: (paneId, tabKey) => set((state) => closeThreadWorkspaceTab(state, paneId, tabKey)),
      moveTab: (tabKey, destinationPaneId, destinationIndex) =>
        set((state) => moveThreadWorkspaceTab(state, tabKey, destinationPaneId, destinationIndex)),
      pruneTargets: (retain) => set((state) => pruneThreadWorkspaceTargets(state, retain)),
      saveWorkspace: (name) =>
        set((state) => {
          const trimmed = name.trim();
          if (trimmed.length === 0) return state;
          const entry = createSavedThreadWorkspace(state, {
            id: createSavedWorkspaceId(),
            name: trimmed,
            savedAt: Date.now(),
          });
          // Saving over a name the user already used reads as "update this
          // one", not "keep two entries I cannot tell apart".
          const withoutSameName = state.saved.filter((candidate) => candidate.name !== trimmed);
          return { saved: [entry, ...withoutSameName].slice(0, MAX_SAVED_THREAD_WORKSPACES) };
        }),
      deleteWorkspace: (id) =>
        set((state) => ({ saved: state.saved.filter((entry) => entry.id !== id) })),
      restoreWorkspace: (id) =>
        set((state) => {
          const entry = state.saved.find((candidate) => candidate.id === id);
          return entry ? restoreSavedThreadWorkspace(entry) : state;
        }),
    }),
    {
      name: THREAD_WORKSPACE_STORAGE_KEY,
      version: THREAD_WORKSPACE_STORAGE_VERSION,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      // The whole workspace survives a reload so work can be picked up where it
      // was left. Tabs pointing at threads that are gone are dropped later by
      // `pruneTargets`, once the owning environment has actually loaded and can
      // tell "deleted" apart from "not connected yet".
      partialize: (state) => ({
        layout: state.layout,
        panes: state.panes,
        activePaneId: state.activePaneId,
        saved: state.saved,
      }),
      migrate: (persisted, version) => {
        // v1 persisted geometry only. Its panes were never written, so there is
        // nothing to carry beyond the layout the user had chosen.
        if (version < 2 && persisted && typeof persisted === "object") {
          return { layout: (persisted as { layout?: unknown }).layout };
        }
        return persisted;
      },
      merge: (persisted, current) => {
        const source =
          persisted && typeof persisted === "object" ? (persisted as Record<string, unknown>) : {};
        const restored = normalizeThreadWorkspaceModel(source);
        if (restored) {
          return { ...current, ...restored, saved: normalizeSavedThreadWorkspaces(source.saved) };
        }
        const layout = isThreadWorkspaceLayout(source.layout) ? source.layout : current.layout;
        const resized = resizeThreadWorkspace(current, layout);
        return {
          ...current,
          ...resized,
          activePaneId: resized.panes[0]?.id ?? resized.activePaneId,
          saved: normalizeSavedThreadWorkspaces(source.saved),
        };
      },
    },
  ),
);
