import type {
  ProviderRateLimitStatus,
  ProviderRateLimitWindow,
  ServerProvider,
} from "@t3tools/contracts";

import { parseTimestampDate } from "~/timestampFormat";

/**
 * View model behind the sidebar's plan-limit meter.
 *
 * The server hands us the last observation each provider reported. Two things
 * have to happen before it can be rendered: a window whose reset instant has
 * passed no longer describes anything (the window rolled over and nobody has
 * run a turn since), and windows from every environment and provider have to
 * collapse into one number for the collapsed icon.
 */

export interface SidebarRateLimitWindowView {
  readonly id: string;
  readonly label: string;
  /** 0-100. Zero for a window that has rolled over since it was observed. */
  readonly usedPercent: number;
  readonly status: ProviderRateLimitStatus;
  /** "resets in 2h 14m", or null when the provider reported no reset. */
  readonly resetsInLabel: string | null;
  /** The window rolled over after we observed it, so the number is spent. */
  readonly isReset: boolean;
  readonly detail: string | undefined;
}

export interface SidebarRateLimitProviderView {
  readonly key: string;
  readonly instanceId: string;
  readonly driver: ServerProvider["driver"];
  readonly displayName: string;
  readonly accentColor: string | undefined;
  /** Set only when more than one environment reports limits. */
  readonly environmentLabel: string | null;
  readonly planLabel: string | undefined;
  readonly notice: string | undefined;
  readonly observedAt: string;
  readonly windows: ReadonlyArray<SidebarRateLimitWindowView>;
}

export interface SidebarRateLimitsView {
  readonly providers: ReadonlyArray<SidebarRateLimitProviderView>;
  /** Highest live usage across every provider, or null when nothing is live. */
  readonly peakPercent: number | null;
  readonly tone: ProviderRateLimitStatus;
  /** Accessible summary for the trigger button. */
  readonly summary: string;
}

export interface SidebarRateLimitsEnvironmentInput {
  readonly environmentId: string;
  readonly label: string;
  readonly providers: ReadonlyArray<ServerProvider>;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** "2h 14m", "45m", "3d 4h" — enough precision to plan around, never a clock. */
export function formatRateLimitResetIn(isoDate: string, nowMs: number): string | null {
  const date = parseTimestampDate(isoDate);
  if (!date) {
    return null;
  }
  const remainingMs = date.getTime() - nowMs;
  if (remainingMs <= 0) {
    return null;
  }
  if (remainingMs < MINUTE_MS) {
    return "under a minute";
  }
  if (remainingMs < HOUR_MS) {
    return `${Math.floor(remainingMs / MINUTE_MS)}m`;
  }
  if (remainingMs < DAY_MS) {
    const hours = Math.floor(remainingMs / HOUR_MS);
    const minutes = Math.floor((remainingMs % HOUR_MS) / MINUTE_MS);
    return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  }
  const days = Math.floor(remainingMs / DAY_MS);
  const hours = Math.floor((remainingMs % DAY_MS) / HOUR_MS);
  return hours === 0 ? `${days}d` : `${days}d ${hours}h`;
}

const hasWindowReset = (window: ProviderRateLimitWindow, nowMs: number): boolean => {
  if (window.resetsAt === null) {
    return false;
  }
  const date = parseTimestampDate(window.resetsAt);
  return date !== null && date.getTime() <= nowMs;
};

const projectWindow = (
  window: ProviderRateLimitWindow,
  nowMs: number,
): SidebarRateLimitWindowView => {
  const isReset = hasWindowReset(window, nowMs);
  return {
    id: window.id,
    label: window.label,
    usedPercent: isReset ? 0 : Math.max(0, Math.min(100, window.usedPercent)),
    status: isReset ? "ok" : window.status,
    resetsInLabel:
      !isReset && window.resetsAt !== null ? formatRateLimitResetIn(window.resetsAt, nowMs) : null,
    isReset,
    detail: window.detail,
  };
};

const toneFor = (statuses: ReadonlyArray<ProviderRateLimitStatus>): ProviderRateLimitStatus =>
  statuses.includes("exhausted") ? "exhausted" : statuses.includes("warning") ? "warning" : "ok";

const formatPeakLabel = (percent: number): string =>
  percent >= 10 || percent === 0 ? `${Math.round(percent)}%` : `${percent.toFixed(1)}%`;

/**
 * Collapse every environment's provider snapshots into one view.
 *
 * Providers that never reported limits are absent rather than shown empty:
 * "no data" for a provider that has no concept of plan limits would be noise.
 */
export function buildSidebarRateLimitsView(input: {
  readonly environments: ReadonlyArray<SidebarRateLimitsEnvironmentInput>;
  readonly nowMs: number;
}): SidebarRateLimitsView {
  const environmentsWithLimits = input.environments.filter((environment) =>
    environment.providers.some((provider) => (provider.rateLimits?.windows.length ?? 0) > 0),
  );
  const showEnvironmentLabels = environmentsWithLimits.length > 1;

  const providers: Array<SidebarRateLimitProviderView> = [];
  for (const environment of environmentsWithLimits) {
    for (const provider of environment.providers) {
      const rateLimits = provider.rateLimits;
      if (!rateLimits || rateLimits.windows.length === 0) {
        continue;
      }
      providers.push({
        key: `${environment.environmentId}:${provider.instanceId}`,
        instanceId: provider.instanceId,
        driver: provider.driver,
        displayName: provider.displayName ?? provider.driver,
        accentColor: provider.accentColor,
        environmentLabel: showEnvironmentLabels ? environment.label : null,
        planLabel: rateLimits.planLabel,
        notice: rateLimits.notice,
        observedAt: rateLimits.observedAt,
        windows: rateLimits.windows.map((window) => projectWindow(window, input.nowMs)),
      });
    }
  }

  const liveWindows = providers.flatMap((provider) =>
    provider.windows.filter((window) => !window.isReset),
  );
  const peak = liveWindows.reduce<SidebarRateLimitWindowView | null>(
    (highest, window) =>
      highest === null || window.usedPercent > highest.usedPercent ? window : highest,
    null,
  );

  const tone = toneFor(liveWindows.map((window) => window.status));

  return {
    providers,
    peakPercent: peak?.usedPercent ?? null,
    tone,
    summary:
      providers.length === 0
        ? "Plan limits: no data yet"
        : peak
          ? `Plan limits: ${peak.label} ${formatPeakLabel(peak.usedPercent)} used`
          : "Plan limits: all windows reset",
  };
}
