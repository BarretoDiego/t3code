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
const RING_TRACK_COLOR = "color-mix(in oklab, var(--color-sidebar-border) 64%, transparent)";

const STATUS_COLOR = {
  ok: "var(--color-sidebar-foreground)",
  warning: "var(--color-warning)",
  exhausted: "var(--color-error)",
} as const;

function ringColor(window: SidebarRateLimitWindowView, accentColor: string | undefined): string {
  return window.status === "ok" && accentColor ? accentColor : STATUS_COLOR[window.status];
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
  return `${provider.displayName}, ${accountContext(provider)}, ${primary.label}: ${used}% used, ${100 - used}% available. ${resetLabel(primary)}.`;
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
  const weeklyCount = visibleWeekly.length;
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
            aria-valuenow={Math.round(primary.usedPercent)}
            className="relative grid size-13 shrink-0 cursor-default place-items-center rounded-full text-sidebar-foreground outline-hidden ring-ring focus-visible:ring-2 group-data-[collapsible=icon]:size-7"
            role="progressbar"
            tabIndex={0}
          >
            <svg
              aria-hidden="true"
              className="size-full"
              onPointerLeave={() => setHoveredWindowId(null)}
              viewBox="0 0 72 72"
            >
              {rings.map((window, index) => {
                const radius =
                  index === 0
                    ? 20
                    : weeklyCount === 1
                      ? 31
                      : 25 + ((index - 1) * 9) / Math.max(1, weeklyCount - 1);
                const circumference = 2 * Math.PI * radius;
                const normalized = Math.max(0, Math.min(100, window.usedPercent));
                const isActive = window.id === activeWindowId;
                return (
                  <g key={window.id}>
                    <circle
                      cx="36"
                      cy="36"
                      fill="none"
                      onPointerEnter={() => setHoveredWindowId(window.id)}
                      r={radius}
                      stroke={RING_TRACK_COLOR}
                      strokeWidth={isActive ? (index === 0 ? 6 : 4.25) : index === 0 ? 4 : 2.75}
                      style={{ cursor: "help", pointerEvents: "stroke" }}
                    />
                    <circle
                      className="transition-[stroke-dashoffset,stroke] duration-500 ease-out motion-reduce:transition-none"
                      cx="36"
                      cy="36"
                      fill="none"
                      onPointerEnter={() => setHoveredWindowId(window.id)}
                      r={radius}
                      stroke={ringColor(window, provider.accentColor)}
                      strokeDasharray={circumference}
                      strokeDashoffset={circumference * (1 - normalized / 100)}
                      strokeLinecap="round"
                      strokeOpacity={
                        isActive ? 1 : index === 0 ? 0.9 : Math.max(0.58, 0.86 - index * 0.07)
                      }
                      strokeWidth={isActive ? (index === 0 ? 5 : 3.75) : index === 0 ? 4 : 2.75}
                      style={{ cursor: "help", pointerEvents: "stroke" }}
                      transform="rotate(-90 36 36)"
                    />
                  </g>
                );
              })}
              <text
                className="fill-sidebar-foreground font-semibold tabular-nums group-data-[collapsible=icon]:hidden"
                dominantBaseline="central"
                fontSize="13"
                textAnchor="middle"
                x="36"
                y="32"
              >
                {Math.round(primary.usedPercent)}%
              </text>
              <text
                className="fill-sidebar-muted-foreground group-data-[collapsible=icon]:hidden"
                dominantBaseline="central"
                fontSize="6"
                letterSpacing="0.45"
                textAnchor="middle"
                x="36"
                y="43"
              >
                USED
              </text>
            </svg>
          </div>
        }
      />
      <TooltipPopup
        align="start"
        className="w-64 max-w-none whitespace-normal p-1"
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
              const used = Math.round(window.usedPercent);
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
                    style={{ backgroundColor: ringColor(window, provider.accentColor) }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-[11px]">{window.label}</span>
                      <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground">
                        {used}% used · {100 - used}% available
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
  const used = Math.round(primary.usedPercent);
  const context = accountContext(provider);

  return (
    <article
      aria-label={`${provider.displayName}, ${context}, pinned plan limits`}
      className="group/widget relative flex min-h-16 w-full items-center gap-2 rounded-xl border border-sidebar-border/75 bg-sidebar-accent/35 p-2 shadow-xs/5 before:pointer-events-none before:absolute before:inset-px before:rounded-[calc(var(--radius-xl)-1px)] before:border before:border-white/4 group-data-[collapsible=icon]:min-h-8 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:border-transparent group-data-[collapsible=icon]:bg-transparent group-data-[collapsible=icon]:p-0 group-data-[collapsible=icon]:before:hidden"
    >
      <CompactRateLimitRings provider={provider} primary={primary} weekly={weekly} />
      <div className="min-w-0 flex-1 pr-5 group-data-[collapsible=icon]:hidden">
        <div className="flex min-w-0 items-center gap-1.5">
          <ProviderInstanceIcon
            className="size-3.5"
            driverKind={provider.driver}
            displayName={provider.displayName}
            iconClassName="size-3.5"
            {...(provider.accentColor ? { accentColor: provider.accentColor } : {})}
          />
          <span className="truncate font-medium text-[11px] text-sidebar-foreground">
            {provider.displayName}
          </span>
        </div>
        <div className="mt-0.5 truncate text-[10px] text-sidebar-muted-foreground">
          {primary.label} · {100 - used}% available
        </div>
        <div className="truncate text-[10px] tabular-nums text-sidebar-muted-foreground/80">
          {resetLabel(primary)} · {context}
        </div>
      </div>
      <Button
        aria-label={`Unpin ${provider.displayName}, ${context}, plan limits`}
        className="absolute right-1.5 top-1.5 opacity-55 transition-opacity hover:opacity-100 focus-visible:opacity-100 group-data-[collapsible=icon]:hidden motion-reduce:transition-none"
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
        "flex max-h-52 flex-col gap-1.5 overflow-y-auto overscroll-contain pr-0.5",
        "group-data-[collapsible=icon]:max-h-40 group-data-[collapsible=icon]:items-center group-data-[collapsible=icon]:pr-0",
      )}
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
