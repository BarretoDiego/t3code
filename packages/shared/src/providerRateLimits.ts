import type {
  EnvironmentId,
  ProviderInstanceId,
  ProviderRateLimitStatus,
  ProviderRateLimitWindow,
  ProviderRateLimitWindowKind,
  ServerProvider,
} from "@t3tools/contracts";

export interface RateLimitWindowView {
  readonly id: string;
  readonly label: string;
  readonly kind: ProviderRateLimitWindowKind;
  readonly usedPercent: number;
  readonly status: ProviderRateLimitStatus;
  readonly resetsInLabel: string | null;
  readonly resetCountdownLabel: string | null;
  readonly isReset: boolean;
  readonly detail: string | undefined;
}

export interface RateLimitProviderView {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly driver: ServerProvider["driver"];
  readonly displayName: string;
  readonly accentColor: string | undefined;
  readonly environmentLabel: string | null;
  readonly planLabel: string | undefined;
  readonly notice: string | undefined;
  readonly observedAt: string;
  readonly windows: ReadonlyArray<RateLimitWindowView>;
}

export interface ProviderRateLimitsRefreshTarget {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly mode: NonNullable<ServerProvider["rateLimitsRefresh"]>;
}

export interface ProviderRateLimitsView {
  readonly providers: ReadonlyArray<RateLimitProviderView>;
  readonly refreshTargets: ReadonlyArray<ProviderRateLimitsRefreshTarget>;
  readonly peakPercent: number | null;
  readonly tone: ProviderRateLimitStatus;
  readonly summary: string;
}

export interface ProviderRateLimitsEnvironmentInput {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly providers: ReadonlyArray<ServerProvider>;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const SECOND_MS = 1_000;

const parseDateMs = (isoDate: string): number | null => {
  const timestampMs = Date.parse(isoDate);
  return Number.isNaN(timestampMs) ? null : timestampMs;
};

/**
 * A queued message held back by an exhausted plan window is a waiting intent,
 * not a failure. These helpers let web and mobile share one definition of
 * "waiting for the reset" so both surfaces arm the same timer.
 */

interface ExhaustedWindowLike {
  readonly status: ProviderRateLimitStatus;
  readonly resetsAt: string | null;
}

const isFutureReset = (resetsAt: string | null, nowMs: number): resetsAt is string => {
  if (resetsAt === null) return false;
  const resetMs = parseDateMs(resetsAt);
  return resetMs !== null && resetMs > nowMs;
};

/** Earliest future `resetsAt` among exhausted windows, or null when none waits. */
export function getEarliestExhaustedResetAt(
  windows: ReadonlyArray<ExhaustedWindowLike>,
  nowMs: number,
): string | null {
  let earliest: { readonly iso: string; readonly ms: number } | null = null;
  for (const window of windows) {
    if (window.status !== "exhausted" || !isFutureReset(window.resetsAt, nowMs)) continue;
    const resetMs = parseDateMs(window.resetsAt) ?? Number.POSITIVE_INFINITY;
    if (earliest === null || resetMs < earliest.ms) {
      earliest = { iso: window.resetsAt, ms: resetMs };
    }
  }
  return earliest?.iso ?? null;
}

/**
 * Earliest future reset across providers, optionally scoped to one provider
 * instance. Unscoped callers get the soonest reason a queued send might
 * succeed; firing then and re-checking is cheaper than tracking per-window.
 */
export function getExhaustedRateLimitResetAt(
  providers: ReadonlyArray<{
    readonly instanceId?: ProviderInstanceId | string;
    readonly rateLimits?: { readonly windows: ReadonlyArray<ExhaustedWindowLike> } | null | undefined;
  }>,
  input: { readonly instanceId?: ProviderInstanceId | string | null; readonly nowMs: number },
): string | null {
  const windows = providers
    .filter((provider) => input.instanceId == null || provider.instanceId === input.instanceId)
    .flatMap((provider) => provider.rateLimits?.windows ?? []);
  return getEarliestExhaustedResetAt(windows, input.nowMs);
}

/** Milliseconds until `resetsAt`, floored at zero so a passed reset fires now. */
export function msUntilRateLimitReset(resetsAt: string, nowMs: number): number {
  const resetMs = parseDateMs(resetsAt);
  if (resetMs === null) return 0;
  return Math.max(0, resetMs - nowMs);
}

const USAGE_LIMIT_ERROR_PATTERN =
  /usage limit (reached|exceeded)|you'?ve hit your usage limit|limit resets|rate.?limit.*reset|exhausted.*window/i;

/** True when a send failure reads like an exhausted plan window, not bad payload. */
export function isUsageLimitErrorMessage(message: string | null | undefined): boolean {
  if (!message) return false;
  return USAGE_LIMIT_ERROR_PATTERN.test(message);
}

/** "2h 14m", "45m", "3d 4h" — enough precision to plan around. */
export function formatRateLimitResetIn(isoDate: string, nowMs: number): string | null {
  const timestampMs = parseDateMs(isoDate);
  if (timestampMs === null) {
    return null;
  }
  const remainingMs = timestampMs - nowMs;
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

/** "2h 14m 07s" — second precision while a user is waiting for an exhausted limit. */
export function formatRateLimitResetCountdown(isoDate: string, nowMs: number): string | null {
  const timestampMs = parseDateMs(isoDate);
  if (timestampMs === null) {
    return null;
  }
  const remainingMs = timestampMs - nowMs;
  if (remainingMs <= 0) {
    return null;
  }
  const remainingSeconds = Math.ceil(remainingMs / SECOND_MS);
  const hours = Math.floor(remainingSeconds / 3_600);
  const minutes = Math.floor((remainingSeconds % 3_600) / 60);
  const seconds = remainingSeconds % 60;
  return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
}

const projectWindow = (window: ProviderRateLimitWindow, nowMs: number): RateLimitWindowView => {
  const resetAtMs = window.resetsAt === null ? null : parseDateMs(window.resetsAt);
  const isReset = resetAtMs !== null && resetAtMs <= nowMs;
  return {
    id: window.id,
    label: window.label,
    kind: window.kind,
    usedPercent: isReset ? 0 : Math.max(0, Math.min(100, window.usedPercent)),
    status: isReset ? "ok" : window.status,
    resetsInLabel:
      !isReset && window.resetsAt !== null ? formatRateLimitResetIn(window.resetsAt, nowMs) : null,
    resetCountdownLabel:
      !isReset && window.status === "exhausted" && window.resetsAt !== null
        ? formatRateLimitResetCountdown(window.resetsAt, nowMs)
        : null,
    isReset,
    detail: window.detail,
  };
};

const toneFor = (statuses: ReadonlyArray<ProviderRateLimitStatus>): ProviderRateLimitStatus =>
  statuses.includes("exhausted") ? "exhausted" : statuses.includes("warning") ? "warning" : "ok";

const formatPeakLabel = (percent: number): string =>
  percent >= 10 || percent === 0 ? `${Math.round(percent)}%` : `${percent.toFixed(1)}%`;

/** Collapse every environment's provider snapshots into one cross-client view. */
export function buildProviderRateLimitsView(input: {
  readonly environments: ReadonlyArray<ProviderRateLimitsEnvironmentInput>;
  readonly nowMs: number;
}): ProviderRateLimitsView {
  const refreshTargets = input.environments.flatMap((environment) =>
    environment.providers.flatMap((provider) =>
      provider.enabled && provider.installed && provider.rateLimitsRefresh
        ? [
            {
              key: `${environment.environmentId}:${provider.instanceId}`,
              environmentId: environment.environmentId,
              instanceId: provider.instanceId,
              mode: provider.rateLimitsRefresh,
            } satisfies ProviderRateLimitsRefreshTarget,
          ]
        : [],
    ),
  );
  const environmentsWithLimits = input.environments.filter((environment) =>
    environment.providers.some((provider) => (provider.rateLimits?.windows.length ?? 0) > 0),
  );
  const showEnvironmentLabels = environmentsWithLimits.length > 1;

  const providers: Array<RateLimitProviderView> = [];
  for (const environment of environmentsWithLimits) {
    const driverCounts = new Map<string, number>();
    for (const provider of environment.providers) {
      driverCounts.set(provider.driver, (driverCounts.get(provider.driver) ?? 0) + 1);
    }
    for (const provider of environment.providers) {
      const rateLimits = provider.rateLimits;
      if (!rateLimits || rateLimits.windows.length === 0) {
        continue;
      }
      providers.push({
        key: `${environment.environmentId}:${provider.instanceId}`,
        environmentId: environment.environmentId,
        instanceId: provider.instanceId,
        driver: provider.driver,
        displayName:
          provider.displayName ??
          ((driverCounts.get(provider.driver) ?? 0) > 1 ? provider.instanceId : provider.driver),
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
  const peak = liveWindows.reduce<RateLimitWindowView | null>(
    (highest, window) =>
      highest === null || window.usedPercent > highest.usedPercent ? window : highest,
    null,
  );
  const tone = toneFor(liveWindows.map((window) => window.status));

  return {
    providers,
    refreshTargets,
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
