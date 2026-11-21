import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  buildThreadNesting,
  type ThreadNestingNode,
  type ThreadNestingSummary,
} from "@t3tools/client-runtime/state/thread-nesting";
import { Atom } from "effect/reactivity";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../../lib/storage";
import { environmentThreadShells } from "../../state/threads";

type SidebarNestingNode = ThreadNestingNode<EnvironmentThreadShell>;

function sameSummary(left: ThreadNestingSummary | null, right: ThreadNestingSummary | null) {
  if (left === null || right === null) return left === right;
  return (
    left.total === right.total &&
    left.counts.approval === right.counts.approval &&
    left.counts.input === right.counts.input &&
    left.counts.failed === right.counts.failed &&
    left.counts.working === right.counts.working
  );
}

/**
 * Whether two builds of a top-level row draw the same nested rows. The row's own
 * shell is not compared: the row draws it, the nested list does not.
 */
export function sameNestedChildren<T>(
  left: ThreadNestingNode<T>,
  right: ThreadNestingNode<T>,
): boolean {
  if (!sameSummary(left.summary, right.summary)) return false;
  if (left.children.length !== right.children.length) return false;
  return left.children.every((child, index) => {
    const other = right.children[index]!;
    return (
      child.key === other.key && child.thread === other.thread && sameNestedChildren(child, other)
    );
  });
}

// Subagents hang from the row that spawned them. Side chats open from their
// parent's panel and archived threads leave the list, so neither nests.
const sidebarThreadNestingAtom = Atom.make((get) =>
  buildThreadNesting({
    threads: get(environmentThreadShells.quietThreadShellsAtom),
    isListed: (thread) => thread.archivedAt === null && thread.lineage.sideChat !== true,
  }),
).pipe(Atom.withLabel("sidebar-thread-nesting"));

/**
 * One row's place in the forest. It keeps its identity while its nested rows
 * are unchanged, so a shell update elsewhere does not re-render this row's list.
 */
export const sidebarThreadNestingNodeAtom = Atom.family((threadKey: string) => {
  let previous: SidebarNestingNode | null = null;
  return Atom.make((get) => {
    const node = get(sidebarThreadNestingAtom).nodeByKey.get(threadKey) ?? null;
    const next = node === null || node.parentKey !== null || node.summary === null ? null : node;
    if (previous !== null && next !== null && sameNestedChildren(previous, next)) return previous;
    previous = next;
    return next;
  }).pipe(Atom.withLabel(`sidebar-thread-nesting:${threadKey}`));
});

interface SidebarThreadNestingState {
  /** The user's show/hide choice per parent row and per settled group. */
  readonly expandedByKey: Readonly<Record<string, boolean>>;
  readonly setExpanded: (key: string, expanded: boolean) => void;
}

export const useSidebarThreadNestingStore = create<SidebarThreadNestingState>()(
  persist(
    (set) => ({
      expandedByKey: {},
      setExpanded: (key, expanded) =>
        set((state) => ({ expandedByKey: { ...state.expandedByKey, [key]: expanded } })),
    }),
    {
      name: "t3code:sidebar:nested-expanded:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: ({ expandedByKey }) => ({ expandedByKey }),
    },
  ),
);
