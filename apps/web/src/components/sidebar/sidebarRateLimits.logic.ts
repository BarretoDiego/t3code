import type {
  RateLimitProviderView,
  RateLimitWindowView,
} from "@t3tools/shared/providerRateLimits";

export {
  buildProviderRateLimitsView as buildSidebarRateLimitsView,
  formatRateLimitResetIn,
  type ProviderRateLimitsEnvironmentInput as SidebarRateLimitsEnvironmentInput,
  type ProviderRateLimitsView as SidebarRateLimitsView,
  type RateLimitProviderView as SidebarRateLimitProviderView,
  type RateLimitWindowView as SidebarRateLimitWindowView,
} from "@t3tools/shared/providerRateLimits";

export function partitionRateLimitWindows(windows: ReadonlyArray<RateLimitWindowView>): {
  readonly weekly: ReadonlyArray<RateLimitWindowView>;
  readonly other: ReadonlyArray<RateLimitWindowView>;
} {
  const weekly: Array<RateLimitWindowView> = [];
  const other: Array<RateLimitWindowView> = [];
  for (const window of windows) {
    (window.kind === "weekly" ? weekly : other).push(window);
  }
  return { weekly, other };
}

function mostUsedLiveWindow(
  windows: ReadonlyArray<RateLimitWindowView>,
): RateLimitWindowView | null {
  let highest: RateLimitWindowView | null = null;
  for (const window of windows) {
    if (window.isReset) continue;
    if (highest === null || window.usedPercent > highest.usedPercent) {
      highest = window;
    }
  }
  return highest;
}

/** Keep the short rolling window at the center, even when a weekly ring is tighter. */
export function selectCompactPrimaryWindow(
  windows: ReadonlyArray<RateLimitWindowView>,
): RateLimitWindowView | null {
  const session = windows.find((window) => window.kind === "session");
  if (session) return session;

  const { weekly, other } = partitionRateLimitWindows(windows);
  return mostUsedLiveWindow(other) ?? mostUsedLiveWindow(weekly) ?? windows[0] ?? null;
}

/** Stored keys may be temporarily absent when an environment is disconnected; ignore, never prune. */
export function selectPinnedRateLimitProviders(
  providers: ReadonlyArray<RateLimitProviderView>,
  pinnedProviderKeys: ReadonlySet<string>,
): ReadonlyArray<RateLimitProviderView> {
  return providers.filter((provider) => pinnedProviderKeys.has(provider.key));
}

/** Pinned accounts already have a persistent dock card, so the popup only shows the rest. */
export function selectUnpinnedRateLimitProviders(
  providers: ReadonlyArray<RateLimitProviderView>,
  pinnedProviderKeys: ReadonlySet<string>,
): ReadonlyArray<RateLimitProviderView> {
  return providers.filter((provider) => !pinnedProviderKeys.has(provider.key));
}

export function toggleRateLimitProviderKey(
  keys: ReadonlyArray<string>,
  providerKey: string,
): ReadonlyArray<string> {
  return keys.includes(providerKey)
    ? keys.filter((key) => key !== providerKey)
    : [...keys, providerKey];
}
