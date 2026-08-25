import { PinIcon } from "lucide-react";
import { memo, useMemo, useState } from "react";

import { cn } from "../../lib/utils";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  partitionRateLimitWindows,
  selectCompactPrimaryWindow,
  selectPinnedRateLimitProviders,
  type SidebarRateLimitProviderView,
  type SidebarRateLimitWindowView,
} from "./sidebarRateLimits.logic";
import type { SidebarRateLimitsMonitor } from "./useSidebarRateLimitsMonitor";

const MAX_WEEKLY_RING_COUNT = 5;
const RING_COLOR = "var(--color-primary)";
const RING_TRACK_COLOR = "color-mix(in oklab, var(--color-primary) 16%, transparent)";
const RING_STROKE_WIDTH = 3.25;
const RING_PITCH = 5;
const OUTER_RING_RADIUS = 40;

function availablePercent(window: SidebarRateLimitWindowView): number {
  return Math.max(0, Math.min(100, 100 - window.usedPercent));
}

function resetLabel(window: SidebarRateLimitWindowView): string {
  if (window.isReset) return "Reset available";
  if (window.kind === "credits" && window.resetsInLabel === null) return "No scheduled reset";
  return window.resetsInLabel ? `Resets in ${window.resetsInLabel}` : "Reset time unavailable";
}

function accountContext(provider: SidebarRateLimitProviderView): string {
  return provider.environmentLabel ?? provider.instanceId;
}

function accessibilityLabel(
  provider: SidebarRateLimitProviderView,
  primary: SidebarRateLimitWindowView,
): string {
  const used = Math.round(primary.usedPercent);
  return `${provider.displayName}, ${accountContext(provider)}, ${primary.label}: ${Math.round(availablePercent(primary))}% available, ${used}% used. ${resetLabel(primary)}.`;
}

function CompactRateLimitRings({
  provider,
  primary,
  weekly,
}: {
  provider: SidebarRateLimitProviderView;
  primary: SidebarRateLimitWindowView;
  weekly: ReadonlyArray<SidebarRateLimitWindowView>;
}) {
  const visibleWeekly = weekly
    .filter((window) => window.id !== primary.id)
    .slice(0, MAX_WEEKLY_RING_COUNT);
  const rings = [primary, ...visibleWeekly];
  const [hoveredWindowId, setHoveredWindowId] = useState<string | null>(null);
  const activeWindowId = rings.some((window) => window.id === hoveredWindowId)
    ? hoveredWindowId
    : primary.id;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            aria-label={accessibilityLabel(provider, primary)}
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={Math.round(availablePercent(primary))}
            className="relative grid size-11 shrink-0 cursor-default place-items-center rounded-full text-sidebar-foreground outline-hidden ring-ring focus-visible:ring-2 group-data-[collapsible=icon]:size-7"
            role="progressbar"
            tabIndex={0}
          >
            <svg
              aria-hidden="true"
              className="size-full"
              onPointerLeave={() => setHoveredWindowId(null)}
              viewBox="0 0 88 88"
            >
              {rings.map((window, index) => {
                const radius = OUTER_RING_RADIUS - (rings.length - index - 1) * RING_PITCH;
                const circumference = 2 * Math.PI * radius;
                const normalized = availablePercent(window);
                const isActive = window.id === activeWindowId;
                return (
                  <g key={window.id}>
                    <circle
                      cx="44"
                      cy="44"
                      fill="none"
                      r={radius}
                      stroke={RING_TRACK_COLOR}
                      strokeWidth={RING_STROKE_WIDTH}
                    />
                    <circle
                      className="transition-[stroke-dashoffset,stroke] duration-500 ease-out motion-reduce:transition-none"
                      cx="44"
                      cy="44"
                      data-rate-limit-ring={window.id}
                      fill="none"
                      r={radius}
                      stroke={RING_COLOR}
                      strokeDasharray={circumference}
                      strokeDashoffset={circumference * (1 - normalized / 100)}
                      strokeLinecap="round"
                      strokeOpacity={isActive ? 1 : 0.78}
                      strokeWidth={RING_STROKE_WIDTH}
                      transform="rotate(-90 44 44)"
                    />
                    <circle
                      cx="44"
                      cy="44"
                      fill="none"
                      onPointerEnter={() => setHoveredWindowId(window.id)}
                      r={radius}
                      stroke="transparent"
                      strokeWidth={RING_PITCH}
                      style={{ cursor: "help", pointerEvents: "stroke" }}
                    />
                  </g>
                );
              })}
              <text
                className="fill-sidebar-foreground font-semibold tabular-nums group-data-[collapsible=icon]:hidden"
                dominantBaseline="central"
                fontSize="15"
                textAnchor="middle"
                x="44"
                y="39.5"
              >
                {Math.round(availablePercent(primary))}%
              </text>
              <text
                className="fill-sidebar-muted-foreground group-data-[collapsible=icon]:hidden"
                dominantBaseline="central"
                fontSize="7"
                letterSpacing="0.45"
                textAnchor="middle"
                x="44"
                y="52"
              >
                LEFT
              </text>
            </svg>
          </div>
        }
      />
      <TooltipPopup
        align="start"
        className="w-60 max-w-none whitespace-normal p-1"
        side="right"
        sideOffset={8}
      >
        <div className="flex flex-col gap-2">
          <div className="flex min-w-0 items-center gap-1.5 font-medium">
            <ProviderInstanceIcon
              className="size-4"
              driverKind={provider.driver}
              displayName={provider.displayName}
              iconClassName="size-4"
              {...(provider.accentColor ? { accentColor: provider.accentColor } : {})}
            />
            <span className="truncate">{provider.displayName}</span>
            {provider.planLabel ? (
              <span className="shrink-0 text-muted-foreground">· {provider.planLabel}</span>
            ) : null}
          </div>
          <div className="truncate text-[10px] text-muted-foreground">
            {accountContext(provider)}
          </div>
          <div className="flex flex-col gap-1.5">
            {provider.windows.map((window) => {
              return (
                <div
                  className={cn(
                    "-mx-1 flex items-start gap-2 rounded px-1 py-0.5",
                    activeWindowId === window.id && "bg-muted/70",
                  )}
                  data-active={activeWindowId === window.id ? "true" : undefined}
                  data-rate-limit-layer={window.id}
                  key={window.id}
                >
                  <span
                    aria-hidden
                    className="mt-1 size-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: RING_COLOR }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-[11px]">{window.label}</span>
                      <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground">
                        {Math.round(availablePercent(window))}% available
                      </span>
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      {resetLabel(window)}
                      {window.detail ? ` · ${window.detail}` : ""}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          {weekly.length > visibleWeekly.length + (primary.kind === "weekly" ? 1 : 0) ? (
            <div className="text-[10px] text-muted-foreground">
              Additional weekly limits remain available in the full monitor.
            </div>
          ) : null}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

const PinnedProviderWidget = memo(function PinnedProviderWidget({
  provider,
  onUnpin,
}: {
  provider: SidebarRateLimitProviderView;
  onUnpin: () => void;
}) {
  const primary = selectCompactPrimaryWindow(provider.windows);
  const { weekly } = partitionRateLimitWindows(provider.windows);
  if (primary === null) return null;
  const available = Math.round(availablePercent(primary));
  const context = accountContext(provider);

  return (
    <article
      aria-label={`${provider.displayName}, ${context}, pinned plan limits`}
      className="group/widget relative flex min-h-14 min-w-0 items-center gap-1.5 rounded-lg border border-sidebar-border/60 bg-sidebar-row-hover/35 p-1.5 transition-[border-color,background-color] hover:border-primary/30 hover:bg-sidebar-row-hover/65 group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:min-h-8 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:border-transparent group-data-[collapsible=icon]:bg-transparent group-data-[collapsible=icon]:p-0 motion-reduce:transition-none"
      data-rate-limit-widget={provider.key}
    >
      <CompactRateLimitRings provider={provider} primary={primary} weekly={weekly} />
      <div className="min-w-0 flex-1 pr-2.5 group-data-[collapsible=icon]:hidden">
        <div className="flex min-w-0 items-center gap-1">
          <ProviderInstanceIcon
            className="size-3"
            driverKind={provider.driver}
            displayName={provider.displayName}
            iconClassName="size-3"
          />
          <span className="truncate font-medium text-[10px] leading-3.5 text-sidebar-foreground">
            {provider.displayName}
          </span>
        </div>
        <div className="mt-0.5 truncate font-medium text-[10px] leading-3.5 tabular-nums text-sidebar-foreground">
          {available}% available
        </div>
        <div className="truncate text-[9px] leading-3 text-sidebar-muted-foreground">
          {primary.label}
        </div>
      </div>
      <Button
        aria-label={`Unpin ${provider.displayName}, ${context}, plan limits`}
        className="absolute right-0.5 top-0.5 opacity-40 transition-opacity hover:opacity-100 focus-visible:opacity-100 group-data-[collapsible=icon]:hidden motion-reduce:transition-none"
        onClick={onUnpin}
        size="icon-micro"
        title="Remove from the sidebar dock"
        variant="ghost-muted"
      >
        <PinIcon className="size-3 fill-current" />
      </Button>
    </article>
  );
});

export const SidebarPinnedRateLimitsDock = memo(function SidebarPinnedRateLimitsDock({
  monitor,
}: {
  monitor: SidebarRateLimitsMonitor;
}) {
  const providers = useMemo(
    () => selectPinnedRateLimitProviders(monitor.view.providers, monitor.pinnedProviderKeys),
    [monitor.pinnedProviderKeys, monitor.view.providers],
  );
  if (!monitor.preferencesHydrated || providers.length === 0) return null;

  return (
    <section
      aria-label="Pinned provider plan limits"
      className={cn(
        "grid max-h-40 grid-cols-2 gap-1.5 overflow-y-auto overscroll-contain pr-0.5",
        "group-data-[collapsible=icon]:max-h-40 group-data-[collapsible=icon]:grid-cols-1 group-data-[collapsible=icon]:justify-items-center group-data-[collapsible=icon]:pr-0",
      )}
      data-layout="two-column-grid"
    >
      {providers.map((provider) => (
        <PinnedProviderWidget
          key={provider.key}
          onUnpin={() => monitor.toggleProviderPinned(provider.key)}
          provider={provider}
        />
      ))}
    </section>
  );
});
