import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  useClientSettings,
  useClientSettingsHydrated,
  useUpdateClientSettings,
} from "../../hooks/useSettings";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  buildSidebarRateLimitsView,
  type SidebarRateLimitsView,
  toggleRateLimitProviderKey,
} from "./sidebarRateLimits.logic";

/** Countdown labels only need minute precision; provider usage itself changes on snapshots. */
const RESET_COUNTDOWN_TICK_MS = 60_000;

const selectPinnedProviderKeys = (settings: {
  readonly sidebarPinnedRateLimitProviderKeys: ReadonlyArray<string>;
}) => settings.sidebarPinnedRateLimitProviderKeys;

const selectCollapsedWeeklyProviderKeys = (settings: {
  readonly sidebarCollapsedRateLimitWeeklyProviderKeys: ReadonlyArray<string>;
}) => settings.sidebarCollapsedRateLimitWeeklyProviderKeys;

function useNowMs(enabled: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) return;
    const intervalId = window.setInterval(() => setNowMs(Date.now()), RESET_COUNTDOWN_TICK_MS);
    return () => window.clearInterval(intervalId);
  }, [enabled]);

  return nowMs;
}

export interface SidebarRateLimitsMonitor {
  readonly view: SidebarRateLimitsView;
  readonly nowMs: number;
  readonly isRefreshing: boolean;
  readonly refreshFailed: boolean;
  readonly preferencesHydrated: boolean;
  readonly pinnedProviderKeys: ReadonlySet<string>;
  readonly collapsedWeeklyProviderKeys: ReadonlySet<string>;
  readonly refreshLimits: () => void;
  readonly toggleProviderPinned: (providerKey: string) => void;
  readonly toggleProviderWeeklyCollapsed: (providerKey: string) => void;
}

/** One subscription, one projection and one timer feed both the popup and pinned dock. */
export function useSidebarRateLimitsMonitor(): SidebarRateLimitsMonitor {
  const { environments } = useEnvironments();
  const refreshProviderRateLimits = useAtomCommand(serverEnvironment.refreshProviderRateLimits, {
    reportFailure: false,
  });
  const updateClientSettings = useUpdateClientSettings();
  const preferencesHydrated = useClientSettingsHydrated();
  const pinnedProviderKeyList = useClientSettings(selectPinnedProviderKeys);
  const collapsedWeeklyProviderKeyList = useClientSettings(selectCollapsedWeeklyProviderKeys);
  const refreshingRef = useRef(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);

  const environmentInputs = useMemo(
    () =>
      environments.map((environment) => ({
        environmentId: environment.environmentId,
        label: environment.label,
        providers: environment.serverConfig?.providers ?? [],
      })),
    [environments],
  );
  const hasSnapshots = environmentInputs.some((environment) =>
    environment.providers.some((provider) => (provider.rateLimits?.windows.length ?? 0) > 0),
  );
  const nowMs = useNowMs(hasSnapshots);
  const view = useMemo(
    () => buildSidebarRateLimitsView({ environments: environmentInputs, nowMs }),
    [environmentInputs, nowMs],
  );
  const pinnedProviderKeys = useMemo(() => new Set(pinnedProviderKeyList), [pinnedProviderKeyList]);
  const collapsedWeeklyProviderKeys = useMemo(
    () => new Set(collapsedWeeklyProviderKeyList),
    [collapsedWeeklyProviderKeyList],
  );

  const refreshLimits = useCallback(() => {
    if (refreshingRef.current || view.refreshTargets.length === 0) return;
    refreshingRef.current = true;
    setIsRefreshing(true);
    setRefreshFailed(false);
    void Promise.all(
      view.refreshTargets.map((target) =>
        refreshProviderRateLimits({
          environmentId: target.environmentId,
          input: { instanceId: target.instanceId },
        }),
      ),
    ).then((results) => {
      refreshingRef.current = false;
      setIsRefreshing(false);
      setRefreshFailed(results.some((result) => result._tag === "Failure"));
    });
  }, [refreshProviderRateLimits, view.refreshTargets]);

  const toggleProviderPinned = useCallback(
    (providerKey: string) => {
      if (!preferencesHydrated) return;
      updateClientSettings({
        sidebarPinnedRateLimitProviderKeys: toggleRateLimitProviderKey(
          pinnedProviderKeyList,
          providerKey,
        ),
      });
    },
    [pinnedProviderKeyList, preferencesHydrated, updateClientSettings],
  );

  const toggleProviderWeeklyCollapsed = useCallback(
    (providerKey: string) => {
      if (!preferencesHydrated) return;
      updateClientSettings({
        sidebarCollapsedRateLimitWeeklyProviderKeys: toggleRateLimitProviderKey(
          collapsedWeeklyProviderKeyList,
          providerKey,
        ),
      });
    },
    [collapsedWeeklyProviderKeyList, preferencesHydrated, updateClientSettings],
  );

  return {
    view,
    nowMs,
    isRefreshing,
    refreshFailed,
    preferencesHydrated,
    pinnedProviderKeys,
    collapsedWeeklyProviderKeys,
    refreshLimits,
    toggleProviderPinned,
    toggleProviderWeeklyCollapsed,
  };
}
