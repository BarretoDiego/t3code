import { PinIcon } from "lucide-react";
import { memo, useMemo } from "react";

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

const MAX_WEEKLY_BAR_COUNT = 5;
const BAR_COLOR = "var(--color-primary)";
const BAR_TRACK_COLOR = "color-mix(in oklab, var(--color-primary) 16%, transparent)";

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
  window: SidebarRateLimitWindowView,
): string {
  const used = Math.round(window.usedPercent);
  return `${provider.displayName}, ${accountContext(provider)}, ${window.label}: ${Math.round(availablePercent(window))}% available, ${used}% used. ${resetLabel(window)}.`;
}

function CompactRateLimitBar({
  provider,
  window,
  hiddenWhenCollapsed,
}: {
  provider: SidebarRateLimitProviderView;
  window: SidebarRateLimitWindowView;
  hiddenWhenCollapsed: boolean;
}) {
  const available = Math.round(availablePercent(window));

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            aria-label={accessibilityLabel(provider, window)}
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={available}
            className={cn(
              "group/bar min-w-0 cursor-help rounded-sm outline-hidden ring-ring focus-visible:ring-2 group-data-[collapsible=icon]:w-6",
              hiddenWhenCollapsed && "group-data-[collapsible=icon]:hidden",
            )}
            data-available-percent={available}
            data-rate-limit-bar={window.id}
            role="progressbar"
            tabIndex={0}
          >
            <div className="mb-0.5 flex min-w-0 items-baseline justify-between gap-1 text-[9px] leading-3 group-data-[collapsible=icon]:hidden">
              <span className="truncate text-sidebar-muted-foreground">{window.label}</span>
              <span className="shrink-0 font-medium tabular-nums text-sidebar-foreground">
                {available}%
              </span>
            </div>
            <div
              aria-hidden="true"
              className="h-2.5 w-full overflow-hidden rounded-[3px] group-data-[collapsible=icon]:h-1.5"
              style={{ backgroundColor: BAR_TRACK_COLOR }}
            >
              <div
                className="h-full rounded-[3px] transition-[width,opacity] duration-500 ease-out group-hover/bar:opacity-90 motion-reduce:transition-none"
                style={{ backgroundColor: BAR_COLOR, width: `${available}%` }}
              />
            </div>
          </div>
        }
      />
      <TooltipPopup
        align="start"
        className="w-60 max-w-none whitespace-normal p-1"
        side="right"
        sideOffset={8}
      >
        <div className="flex flex-col gap-1.5">
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
          <div className="flex items-start gap-2" data-rate-limit-layer={window.id}>
            <span
              aria-hidden
              className="mt-1 h-2 w-4 shrink-0 rounded-[2px]"
              style={{ backgroundColor: BAR_COLOR }}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-[11px]">{window.label}</span>
                <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground">
                  {available}% available
                </span>
              </div>
              <div className="text-[10px] text-muted-foreground">
                {resetLabel(window)}
                {window.detail ? ` · ${window.detail}` : ""}
              </div>
            </div>
          </div>
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

function CompactRateLimitBars({
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
    .slice(0, MAX_WEEKLY_BAR_COUNT);
  const windows = [primary, ...visibleWeekly];

  return (
    <div className="flex min-w-0 flex-col gap-1.5 group-data-[collapsible=icon]:gap-0">
      {windows.map((window, index) => (
        <CompactRateLimitBar
          hiddenWhenCollapsed={index > 0}
          key={window.id}
          provider={provider}
          window={window}
        />
      ))}
      {weekly.length > visibleWeekly.length + (primary.kind === "weekly" ? 1 : 0) ? (
        <div className="truncate text-[8px] leading-3 text-sidebar-muted-foreground group-data-[collapsible=icon]:hidden">
          More limits in the full monitor
        </div>
      ) : null}
    </div>
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
  const context = accountContext(provider);

  return (
    <article
      aria-label={`${provider.displayName}, ${context}, pinned plan limits`}
      className="group/widget relative flex min-h-14 min-w-0 flex-col gap-1.5 rounded-lg border border-sidebar-border/60 bg-sidebar-row-hover/35 p-1.5 transition-[border-color,background-color] hover:border-primary/30 hover:bg-sidebar-row-hover/65 group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:min-h-8 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:border-transparent group-data-[collapsible=icon]:bg-transparent group-data-[collapsible=icon]:p-1 motion-reduce:transition-none"
      data-rate-limit-widget={provider.key}
    >
      <div className="flex min-w-0 items-center gap-1 pr-3 group-data-[collapsible=icon]:hidden">
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
      <CompactRateLimitBars provider={provider} primary={primary} weekly={weekly} />
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
