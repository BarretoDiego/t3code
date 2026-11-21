import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { useMemo, useState } from "react";

import { appAtomRegistry } from "../../state/atom-registry";
import { environmentThreadShells } from "../../state/threads";
import type { ThreadListV2ListItem } from "./threadListV2";
import { withThreadListNesting } from "./threadListNesting";

/**
 * The user's show/hide choice per parent and per settled group, shared by Home
 * and the iPad sidebar for the session. Without one, subagents show while any
 * of them is working or waiting on the user.
 */
const nestedExpandedAtom = Atom.make<Readonly<Record<string, boolean>>>({}).pipe(Atom.keepAlive);

const NO_KEYS: ReadonlySet<string> = new Set<string>();

export function setThreadListNestedExpanded(key: string, expanded: boolean) {
  appAtomRegistry.set(nestedExpandedAtom, {
    ...appAtomRegistry.get(nestedExpandedAtom),
    [key]: expanded,
  });
}

/** Adds subagent rows under their parents; a search lists only matching top-level threads. */
export function useThreadListNesting(input: {
  readonly items: ReadonlyArray<ThreadListV2ListItem>;
  readonly selectedThreadKey: string | null;
  readonly searchQuery: string;
}) {
  // Navigation shells leave subagents out, so the forest reads every loaded shell.
  const threads = useAtomValue(environmentThreadShells.quietThreadShellsAtom);
  const expandedOverrides = useAtomValue(nestedExpandedAtom);
  // Opening a long subagent list in full is a glance: it lasts while the list is mounted.
  const [showAllKeys, setShowAllKeys] = useState(NO_KEYS);
  const searching = input.searchQuery.trim().length > 0;
  const items = useMemo(
    () =>
      searching
        ? input.items
        : withThreadListNesting({
            items: input.items,
            threads,
            expandedOverrides,
            showAllKeys,
            selectedThreadKey: input.selectedThreadKey,
          }),
    [searching, input.items, threads, expandedOverrides, showAllKeys, input.selectedThreadKey],
  );
  const showAllNested = (groupKey: string) =>
    setShowAllKeys((current) => new Set(current).add(groupKey));
  return { items, showAllNested };
}
