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

const parseDateMs = (isoDate: string): number | null => {
  const timestampMs = Date.parse(isoDate);
  return Number.isNaN(timestampMs) ? null : timestampMs;
};

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
