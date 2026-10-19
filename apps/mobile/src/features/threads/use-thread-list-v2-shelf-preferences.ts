import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

const NO_NESTED_CHOICES: Readonly<Record<string, boolean>> = {};

/**
 * Shared persisted shelf state for the compact Home list and iPad sidebar.
 * Preference transforms read the latest optimistic patch, so consecutive
 * presses stay ordered even before React renders the persisted choices.
 */
export function useThreadListV2ShelfPreferences() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const loaded = AsyncResult.isSuccess(preferencesResult);
  const snoozedShelfExpanded =
    loaded && preferencesResult.value.threadListSnoozedShelfExpanded === true;
  const settledShelfExpanded =
    loaded && preferencesResult.value.threadListSettledShelfExpanded === true;
  const workingShelfEnabled = loaded && preferencesResult.value.workingShelfEnabled === true;
  const workingShelfExpanded =
    loaded && preferencesResult.value.threadListWorkingShelfExpanded === true;

  // A transform reads the optimistic value, so two presses before the next
  // render still toggle twice instead of writing the same value.
  const toggleSnoozedShelf = () => {
    if (!loaded) return;
    savePreferences({
      transform: (current) => ({
        threadListSnoozedShelfExpanded: current.threadListSnoozedShelfExpanded !== true,
      }),
    });
  };
  const toggleSettledShelf = () => {
    if (!loaded) return;
    savePreferences({
      transform: (current) => ({
        threadListSettledShelfExpanded: current.threadListSettledShelfExpanded !== true,
      }),
    });
  };
  const toggleWorkingShelf = () => {
    if (!loaded) return;
    savePreferences({
      transform: (current) => ({
        threadListWorkingShelfExpanded: current.threadListWorkingShelfExpanded !== true,
      }),
    });
  };

  const nestedExpandedByKey =
    (loaded ? preferencesResult.value.threadListNestedExpandedByKey : undefined) ??
    NO_NESTED_CHOICES;
  const setNestedExpanded = (threadKey: string, expanded: boolean) => {
    if (!loaded) return;
    savePreferences({
      transform: (current) => ({
        threadListNestedExpandedByKey: {
          ...current.threadListNestedExpandedByKey,
          [threadKey]: expanded,
        },
      }),
    });
  };
  // Opening a long subagent list in full is a glance: it lasts for the session.
  const [nestedShowAllKeys, setNestedShowAllKeys] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const showAllNested = (parentKey: string) => {
    setNestedShowAllKeys((current) => new Set(current).add(parentKey));
  };

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
