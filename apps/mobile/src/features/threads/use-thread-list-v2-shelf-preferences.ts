import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useCallback, useRef, useState } from "react";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

const NO_NESTED_CHOICES: Readonly<Record<string, boolean>> = {};

/**
 * Shared persisted shelf state for the compact Home list and iPad sidebar.
 * Refs advance before persistence starts so consecutive presses always toggle
 * the latest value, even if React has not rendered the optimistic patch yet.
 */
export function useThreadListV2ShelfPreferences() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const loaded = AsyncResult.isSuccess(preferencesResult);
  const snoozedShelfExpanded =
    loaded && preferencesResult.value.threadListSnoozedShelfExpanded === true;
  const settledShelfExpanded =
    loaded && preferencesResult.value.threadListSettledShelfExpanded === true;
  // Working section beta: off until the preference loads and is enabled.
  const workingShelfEnabled = loaded && preferencesResult.value.workingShelfEnabled === true;
  const workingShelfExpanded =
    loaded && preferencesResult.value.threadListWorkingShelfExpanded === true;
  const snoozedShelfExpandedRef = useRef(snoozedShelfExpanded);
  const settledShelfExpandedRef = useRef(settledShelfExpanded);
  const workingShelfExpandedRef = useRef(workingShelfExpanded);
  snoozedShelfExpandedRef.current = snoozedShelfExpanded;
  settledShelfExpandedRef.current = settledShelfExpanded;
  workingShelfExpandedRef.current = workingShelfExpanded;

  const toggleSnoozedShelf = useCallback(() => {
    if (!loaded) return;
    const expanded = !snoozedShelfExpandedRef.current;
    snoozedShelfExpandedRef.current = expanded;
    savePreferences({ threadListSnoozedShelfExpanded: expanded });
  }, [loaded, savePreferences]);
  const toggleSettledShelf = useCallback(() => {
    if (!loaded) return;
    const expanded = !settledShelfExpandedRef.current;
    settledShelfExpandedRef.current = expanded;
    savePreferences({ threadListSettledShelfExpanded: expanded });
  }, [loaded, savePreferences]);
  const toggleWorkingShelf = useCallback(() => {
    if (!loaded) return;
    const expanded = !workingShelfExpandedRef.current;
    workingShelfExpandedRef.current = expanded;
    savePreferences({ threadListWorkingShelfExpanded: expanded });
  }, [loaded, savePreferences]);

  const nestedExpandedByKey =
    (loaded ? preferencesResult.value.threadListNestedExpandedByKey : undefined) ??
    NO_NESTED_CHOICES;
  const nestedExpandedByKeyRef = useRef(nestedExpandedByKey);
  nestedExpandedByKeyRef.current = nestedExpandedByKey;
  const setNestedExpanded = useCallback(
    (threadKey: string, expanded: boolean) => {
      if (!loaded) return;
      const next = { ...nestedExpandedByKeyRef.current, [threadKey]: expanded };
      nestedExpandedByKeyRef.current = next;
      savePreferences({ threadListNestedExpandedByKey: next });
    },
    [loaded, savePreferences],
  );
  // Opening a long subagent list in full is a glance: it lasts for the session.
  const [nestedShowAllKeys, setNestedShowAllKeys] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const showAllNested = useCallback((parentKey: string) => {
    setNestedShowAllKeys((current) => new Set(current).add(parentKey));
  }, []);

  return {
    loaded,
    nestedExpandedByKey,
    nestedShowAllKeys,
    setNestedExpanded,
    showAllNested,
    settledShelfExpanded,
    snoozedShelfExpanded,
    workingShelfEnabled,
    workingShelfExpanded,
    toggleSettledShelf,
    toggleSnoozedShelf,
    toggleWorkingShelf,
  } as const;
}
