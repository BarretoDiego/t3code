import {
  type AutomationSeverity,
  type AutomationStatusIcon as AutomationStatusIconName,
  type AutomationStatusPresentation,
  type ObservationPresentation,
} from "@t3tools/client-runtime/state/automation-presentation";
import {
  ArrowRightLeftIcon,
  BanIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleHelpIcon,
  CircleSlashIcon,
  ClipboardCheckIcon,
  ClockIcon,
  CloudIcon,
  GaugeIcon,
  HourglassIcon,
  PauseIcon,
  PlayIcon,
  WifiOffIcon,
  type LucideIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const STATUS_ICONS: Record<AutomationStatusIconName, LucideIcon> = {
  idle: CircleDashedIcon,
  queued: ClockIcon,
  running: PlayIcon,
  waiting: HourglassIcon,
  paused: PauseIcon,
  disabled: BanIcon,
  limit: GaugeIcon,
  transfer: ArrowRightLeftIcon,
  remote: CloudIcon,
  error: CircleAlertIcon,
  done: CircleCheckIcon,
  reported: ClipboardCheckIcon,
  cancelled: CircleSlashIcon,
  unknown: CircleHelpIcon,
  offline: WifiOffIcon,
  generic: CircleDotIcon,
};

const SEVERITY_TEXT_CLASS: Record<AutomationSeverity, string> = {
  neutral: "text-muted-foreground",
  info: "text-info",
  success: "text-success",
  warning: "text-warning",
  error: "text-destructive",
  // An unknown outcome is neither a failure nor a success, so it takes neither colour.
  unknown: "text-foreground",
};

const SEVERITY_BADGE_VARIANT = {
  neutral: "secondary",
  info: "info",
  success: "success",
  warning: "warning",
  error: "error",
  unknown: "outline",
} as const satisfies Record<AutomationSeverity, string>;

export function automationSeverityTextClass(severity: AutomationSeverity): string {
  return SEVERITY_TEXT_CLASS[severity];
}

/** The glyph for a status. Decorative: the label next to it carries the meaning. */
export function AutomationStatusGlyph({
  status,
  className,
}: {
  readonly status: Pick<AutomationStatusPresentation, "icon" | "severity">;
  readonly className?: string;
}) {
  const Icon = STATUS_ICONS[status.icon];
  return (
    <Icon aria-hidden className={cn("shrink-0", SEVERITY_TEXT_CLASS[status.severity], className)} />
  );
}

/** A status as icon plus text, with its one-line explanation on hover when it has one. */
export function AutomationStatusBadge({
  status,
  prefix,
}: {
  readonly status: AutomationStatusPresentation;
  readonly prefix?: string;
}) {
  const Icon = STATUS_ICONS[status.icon];
  const badge = (
    <Badge variant={SEVERITY_BADGE_VARIANT[status.severity]} data-automation-status={status.key}>
      <Icon aria-hidden />
      {prefix ? `${prefix} · ${status.label}` : status.label}
    </Badge>
  );
  if (status.description === null) return badge;
  return (
    <Tooltip>
      <TooltipTrigger render={badge} />
      <TooltipPopup side="top">{status.description}</TooltipPopup>
    </Tooltip>
  );
}

/** "Observed 5m ago · Not reachable now": when a remote record was read, and whether its home answers. */
export function ObservationLabel({
  observation,
  className,
}: {
  readonly observation: ObservationPresentation;
  readonly className?: string;
}) {
  const stale = observation.freshness !== "fresh";
  const unreachable = observation.reachable === false;
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1 text-2xs",
        stale || unreachable ? "text-warning" : "text-muted-foreground",
        className,
      )}
      data-freshness={observation.freshness}
    >
      {unreachable ? <WifiOffIcon aria-hidden className="size-3 shrink-0" /> : null}
      {stale && !unreachable ? <ClockIcon aria-hidden className="size-3 shrink-0" /> : null}
      <span className="truncate">
        {observation.freshness === "stale" ? `Stale · ${observation.label}` : observation.label}
        {observation.reachabilityLabel ? ` · ${observation.reachabilityLabel}` : ""}
      </span>
    </span>
  );
}
