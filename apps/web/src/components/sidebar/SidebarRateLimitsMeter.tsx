import { GaugeIcon, RefreshCwIcon } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { cn } from "../../lib/utils";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatElapsedDurationLabel } from "../../timestampFormat";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import {
  buildSidebarRateLimitsView,
  type SidebarRateLimitProviderView,
  type SidebarRateLimitWindowView,
} from "./sidebarRateLimits.logic";

/**
 * Providers only report plan headroom while they run, so nothing here is a live
 * counter — the meter shows the last observation and how long its windows have
 * left. The tick below keeps those countdowns honest without animating.
 */
const RESET_COUNTDOWN_TICK_MS = 60_000;

const TONE_COLOR = {
  ok: "color-mix(in oklab, var(--color-muted-foreground) 72%, transparent)",
  warning: "var(--color-warning)",
  exhausted: "var(--color-error)",
} as const;

/**
 * The trigger sits in the sidebar's icon row and follows its icon color, while
 * the popup is portalled out of that subtree and cannot read those variables.
 */
const RING_TONE_COLOR = {
  ok: "var(--sidebar-icon-color)",
  warning: "var(--color-warning)",
  exhausted: "var(--color-error)",
} as const;

const RING_TRACK_COLOR = "color-mix(in oklab, var(--sidebar-icon-color) 26%, transparent)";

function useNowMs(enabled: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const intervalId = window.setInterval(() => setNowMs(Date.now()), RESET_COUNTDOWN_TICK_MS);
    return () => window.clearInterval(intervalId);
  }, [enabled]);

  return nowMs;
}

function RateLimitRing({
  percent,
  tone,
}: {
  percent: number | null;
  tone: keyof typeof RING_TONE_COLOR;
}) {
  const radius = 10;
  const circumference = 2 * Math.PI * radius;
  const normalized = Math.max(0, Math.min(100, percent ?? 0));

  return (
    <span className="relative flex size-4 items-center justify-center">
      <svg
        aria-hidden="true"
        className="-rotate-90 absolute inset-0 size-full transform-gpu mx-0!"
        viewBox="0 0 24 24"
      >
        <circle
          cx="12"
          cy="12"
          fill="none"
          r={radius}
          stroke={RING_TRACK_COLOR}
          strokeWidth="2.5"
        />
        {percent === null ? null : (
          <circle
            className="transition-[stroke-dashoffset,stroke] duration-500 ease-out motion-reduce:transition-none"
            cx="12"
            cy="12"
            fill="none"
            r={radius}
            stroke={RING_TONE_COLOR[tone]}
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - normalized / 100)}
            strokeLinecap="round"
            strokeWidth="2.5"
          />
        )}
      </svg>
    </span>
  );
}

function RateLimitWindowRow({ window }: { window: SidebarRateLimitWindowView }) {
  const color = TONE_COLOR[window.status];

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate text-[11px] leading-4 text-secondary-label">{window.label}</span>
        <span className="shrink-0 text-[11px] leading-4 tabular-nums text-secondary-label">
          {window.isReset ? (
            "reset"
          ) : (
            <>
              <span className={cn(window.status !== "ok" && "font-medium")} style={{ color }}>
                {Math.round(window.usedPercent)}%
              </span>
              {window.resetsInLabel ? (
                <span className="text-muted-foreground"> · {window.resetsInLabel} left</span>
              ) : null}
            </>
          )}
        </span>
      </div>
      <div
        aria-label={`${window.label} usage`}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={Math.round(window.usedPercent)}
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
        role="progressbar"
      >
        <div
          className="h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none"
          style={{ backgroundColor: color, width: `${window.usedPercent}%` }}
        />
      </div>
      {window.detail ? (
        <div className="text-[10px] leading-4 text-muted-foreground">{window.detail}</div>
      ) : null}
    </div>
  );
}

/** "just now" reads wrong with a suffix; everything else needs one. */
function formatObservedLabel(observedAt: string, nowMs: number): string {
  const elapsed = formatElapsedDurationLabel(observedAt, nowMs);
  if (elapsed === "" || elapsed === "just now") {
    return elapsed;
  }
  return `${elapsed} ago`;
}

function RateLimitProviderSection({
  provider,
  nowMs,
  isFirst,
}: {
  provider: SidebarRateLimitProviderView;
  nowMs: number;
  isFirst: boolean;
}) {
  return (
    <section className={cn("flex flex-col gap-2", !isFirst && "border-border/60 border-t pt-3")}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-1.5">
          <ProviderInstanceIcon
            className="size-4"
            driverKind={provider.driver}
            displayName={provider.displayName}
            iconClassName="size-4"
            {...(provider.accentColor ? { accentColor: provider.accentColor } : {})}
          />
          <span className="truncate font-medium text-xs">{provider.displayName}</span>
          {provider.planLabel ? (
            <span className="shrink-0 text-[11px] text-muted-foreground">
              · {provider.planLabel}
            </span>
          ) : null}
        </div>
        <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
          {formatObservedLabel(provider.observedAt, nowMs)}
        </span>
      </div>
      {provider.environmentLabel ? (
        <div className="-mt-1 truncate text-[10px] text-muted-foreground">
          {provider.environmentLabel}
        </div>
      ) : null}
      {provider.windows.map((window) => (
        <RateLimitWindowRow key={window.id} window={window} />
      ))}
      {provider.notice ? (
        <div className="text-[11px] leading-4 text-warning-foreground">{provider.notice}</div>
      ) : null}
    </section>
  );
}

export const SidebarRateLimitsMeter = memo(function SidebarRateLimitsMeter() {
  const { environments } = useEnvironments();
  const refreshProviderRateLimits = useAtomCommand(serverEnvironment.refreshProviderRateLimits, {
    reportFailure: false,
  });
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
  const refreshLimits = useCallback(() => {
    if (refreshingRef.current || view.refreshTargets.length === 0) {
      return;
    }
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

  return (
    <SidebarMenuItem className="shrink-0">
      <Popover>
        <PopoverTrigger
          closeDelay={0}
          delay={200}
          openOnHover
          render={
            <SidebarMenuButton
              aria-label={view.summary}
              // The ring is not a direct `svg` child, so it opts into the icon
              // row's hover treatment through the variable the row already uses.
              className="hover:[--sidebar-icon-color:var(--color-sidebar-foreground)]"
              size="icon"
            >
              {view.providers.length === 0 ? (
                <GaugeIcon />
              ) : (
                <RateLimitRing percent={view.peakPercent} tone={view.tone} />
              )}
            </SidebarMenuButton>
          }
        />
        <PopoverPopup
          align="start"
          className="w-72 max-w-none whitespace-normal text-left"
          side="top"
          tooltipStyle
          viewportClassName="p-0"
        >
          <div className="flex flex-col gap-3 p-[var(--floating-content-inset)]">
            <div className="flex items-center justify-between gap-3">
              <div className="font-medium text-muted-foreground text-xs">Plan limits</div>
              {view.refreshTargets.length > 0 ? (
                <Button
                  aria-label="Refresh plan limits"
                  disabled={isRefreshing}
                  onClick={refreshLimits}
                  size="icon-micro"
                  title="Refresh plan limits for connected provider accounts"
                  variant="ghost-muted"
                >
                  <RefreshCwIcon className={cn(isRefreshing && "animate-spin")} />
                </Button>
              ) : null}
            </div>
            {refreshFailed ? (
              <p className="text-[11px] leading-4 text-warning-foreground">
                Some accounts could not refresh. Start a provider session and try again.
              </p>
            ) : null}
            {view.providers.length === 0 ? (
              <p className="text-pretty text-[11px] leading-4 text-muted-foreground">
                No provider has reported plan limits yet. They appear here after a provider runs a
                turn and reports its 5-hour and weekly windows.
              </p>
            ) : (
              view.providers.map((provider, index) => (
                <RateLimitProviderSection
                  key={provider.key}
                  isFirst={index === 0}
                  nowMs={nowMs}
                  provider={provider}
                />
              ))
            )}
          </div>
        </PopoverPopup>
      </Popover>
    </SidebarMenuItem>
  );
});
