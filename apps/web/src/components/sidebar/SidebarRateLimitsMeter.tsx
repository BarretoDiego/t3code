import { ChevronDownIcon, GaugeIcon, PinIcon, RefreshCwIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "../../lib/utils";
import { formatElapsedDurationLabel } from "../../timestampFormat";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import {
  partitionRateLimitWindows,
  selectUnpinnedRateLimitProviders,
  type SidebarRateLimitProviderView,
  type SidebarRateLimitWindowView,
} from "./sidebarRateLimits.logic";
import type { SidebarRateLimitsMonitor } from "./useSidebarRateLimitsMonitor";

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
          ) : window.resetCountdownLabel ? (
            <span className="font-medium" style={{ color }}>
              {window.resetCountdownLabel}
            </span>
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
  isPinned,
  isWeeklyCollapsed,
  preferencesHydrated,
  onTogglePinned,
  onToggleWeeklyCollapsed,
}: {
  provider: SidebarRateLimitProviderView;
  nowMs: number;
  isFirst: boolean;
  isPinned: boolean;
  isWeeklyCollapsed: boolean;
  preferencesHydrated: boolean;
  onTogglePinned: () => void;
  onToggleWeeklyCollapsed: () => void;
}) {
  const { weekly, other } = partitionRateLimitWindows(provider.windows);
  const accountContext = provider.environmentLabel ?? provider.instanceId;
  const weeklyPeak = weekly.reduce<SidebarRateLimitWindowView | null>(
    (peak, window) => (peak === null || window.usedPercent > peak.usedPercent ? window : peak),
    null,
  );

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
            {...(provider.icon ? { icon: provider.icon } : {})}
          />
          <span className="truncate font-medium text-xs">{provider.displayName}</span>
          {provider.planLabel ? (
            <span className="shrink-0 text-[11px] text-muted-foreground">
              · {provider.planLabel}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <span className="text-[10px] text-muted-foreground tabular-nums">
            {formatObservedLabel(provider.observedAt, nowMs)}
          </span>
          <Button
            aria-label={`${isPinned ? "Unpin" : "Pin"} ${provider.displayName}, ${accountContext}, plan limits`}
            aria-pressed={isPinned}
            disabled={!preferencesHydrated}
            onClick={onTogglePinned}
            size="icon-micro"
            title={`${isPinned ? "Remove" : "Keep"} this account ${isPinned ? "from" : "in"} the sidebar dock`}
            variant="ghost-muted"
          >
            <PinIcon className={cn("size-3", isPinned && "fill-current")} />
          </Button>
        </div>
      </div>
      {provider.environmentLabel ? (
        <div className="-mt-1 truncate text-[10px] text-muted-foreground">
          {provider.environmentLabel}
        </div>
      ) : null}
      {other.map((window) => (
        <RateLimitWindowRow key={window.id} window={window} />
      ))}
      {weekly.length === 0 ? null : !preferencesHydrated ? (
        <div
          aria-busy="true"
          className="flex min-h-6 w-full items-center gap-1.5 rounded-md px-1 text-[11px] text-secondary-label"
        >
          <ChevronDownIcon aria-hidden className="size-3 shrink-0 opacity-50" />
          <span className="min-w-0 flex-1 truncate">
            Weekly limits{weekly.length > 1 ? ` (${weekly.length})` : ""}
          </span>
          <span className="shrink-0 text-muted-foreground">Loading preference…</span>
        </div>
      ) : (
        <Collapsible
          onOpenChange={(open) => {
            const shouldCollapse = !open;
            if (shouldCollapse !== isWeeklyCollapsed) onToggleWeeklyCollapsed();
          }}
          open={!isWeeklyCollapsed}
        >
          <CollapsibleTrigger
            aria-label={`${isWeeklyCollapsed ? "Show" : "Hide"} weekly limits for ${provider.displayName}`}
            className="group/weekly flex min-h-6 w-full items-center gap-1.5 rounded-md px-1 text-left text-[11px] text-secondary-label outline-hidden ring-ring hover:bg-muted/40 focus-visible:ring-2"
          >
            <ChevronDownIcon
              aria-hidden
              className={cn(
                "size-3 shrink-0 transition-transform motion-reduce:transition-none",
                isWeeklyCollapsed && "-rotate-90",
              )}
            />
            <span className="min-w-0 flex-1 truncate">
              Weekly limits{weekly.length > 1 ? ` (${weekly.length})` : ""}
            </span>
            {weeklyPeak ? (
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {Math.round(weeklyPeak.usedPercent)}% peak
              </span>
            ) : null}
          </CollapsibleTrigger>
          <CollapsiblePanel className="motion-reduce:transition-none">
            <div className="flex flex-col gap-2 pt-2">
              {weekly.map((window) => (
                <RateLimitWindowRow key={window.id} window={window} />
              ))}
            </div>
          </CollapsiblePanel>
        </Collapsible>
      )}
      {provider.notice ? (
        <div className="text-[11px] leading-4 text-warning-foreground">{provider.notice}</div>
      ) : null}
    </section>
  );
}

export const SidebarRateLimitsMeter = memo(function SidebarRateLimitsMeter({
  monitor,
}: {
  monitor: SidebarRateLimitsMonitor;
}) {
  const { view } = monitor;
  const unpinnedProviders = selectUnpinnedRateLimitProviders(
    view.providers,
    monitor.pinnedProviderKeys,
  );
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
                  disabled={monitor.isRefreshing}
                  onClick={monitor.refreshLimits}
                  size="icon-micro"
                  title="Refresh plan limits for connected provider accounts"
                  variant="ghost-muted"
                >
                  <RefreshCwIcon
                    className={cn(
                      monitor.isRefreshing && "animate-spin motion-reduce:animate-none",
                    )}
                  />
                </Button>
              ) : null}
            </div>
            {monitor.refreshFailed ? (
              <p className="text-[11px] leading-4 text-warning-foreground">
                Some accounts could not refresh. Start a provider session and try again.
              </p>
            ) : null}
            {view.providers.length === 0 ? (
              <p className="text-pretty text-[11px] leading-4 text-muted-foreground">
                No provider has reported plan limits yet. They appear here after a provider runs a
                turn and reports its 5-hour and weekly windows.
              </p>
            ) : unpinnedProviders.length === 0 ? (
              <p className="text-pretty text-[11px] leading-4 text-muted-foreground">
                All provider plan limits are pinned in the sidebar dock.
              </p>
            ) : (
              unpinnedProviders.map((provider, index) => (
                <RateLimitProviderSection
                  key={provider.key}
                  isFirst={index === 0}
                  isPinned={monitor.pinnedProviderKeys.has(provider.key)}
                  isWeeklyCollapsed={monitor.collapsedWeeklyProviderKeys.has(provider.key)}
                  nowMs={monitor.nowMs}
                  onTogglePinned={() => monitor.toggleProviderPinned(provider.key)}
                  onToggleWeeklyCollapsed={() =>
                    monitor.toggleProviderWeeklyCollapsed(provider.key)
                  }
                  preferencesHydrated={monitor.preferencesHydrated}
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
