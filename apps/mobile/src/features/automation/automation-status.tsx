import type {
  AutomationSeverity,
  AutomationStatusIcon,
  AutomationStatusPresentation,
  ObservationPresentation,
  OrchestratorThreadMarker,
} from "@t3tools/client-runtime/state/automation-presentation";
import { View } from "react-native";

import { type AppSymbolName, SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";

const STATUS_SYMBOLS: Record<AutomationStatusIcon, AppSymbolName> = {
  idle: "circle",
  queued: "clock",
  running: "play",
  waiting: "timer",
  paused: "pause",
  disabled: "nosign",
  limit: "exclamationmark.triangle",
  transfer: "arrow.left.arrow.right",
  remote: "cloud",
  error: "exclamationmark.circle",
  done: "checkmark.circle",
  reported: "doc.text",
  cancelled: "xmark",
  unknown: "questionmark.circle",
  offline: "wifi.slash",
  generic: "circle",
};

const SEVERITY_TEXT_CLASS: Record<AutomationSeverity, string> = {
  neutral: "text-foreground-muted",
  info: "text-adaptive-sky-600-400",
  success: "text-adaptive-emerald-600-400",
  warning: "text-warning-foreground",
  error: "text-danger-foreground",
  // An unknown outcome is neither a failure nor a success, so it takes neither colour.
  unknown: "text-foreground",
};

const SEVERITY_TINT_CLASS: Record<AutomationSeverity, string> = {
  neutral: "accent-foreground-muted",
  info: "accent-foreground-muted",
  success: "accent-foreground-muted",
  warning: "accent-warning-foreground",
  error: "accent-danger-foreground",
  unknown: "accent-foreground",
};

/** A status as glyph plus text. The text carries the meaning; colour only repeats it. */
export function AutomationStatusLabel(props: {
  readonly status: AutomationStatusPresentation;
  readonly prefix?: string;
  readonly size?: "sm" | "base";
}) {
  const { status } = props;
  const small = props.size !== "base";
  return (
    <View className="flex-row items-center gap-1">
      <SymbolView
        name={STATUS_SYMBOLS[status.icon]}
        size={small ? 11 : 14}
        tintColorClassName={SEVERITY_TINT_CLASS[status.severity]}
        type="monochrome"
      />
      <Text className={cn(small ? "text-xs" : "text-sm", SEVERITY_TEXT_CLASS[status.severity])}>
        {props.prefix ? `${props.prefix} · ${status.label}` : status.label}
      </Text>
    </View>
  );
}

/** Marks an orchestrator's main thread in a thread row: a glyph and its state in words. */
export function OrchestratorRowMarker(props: { readonly marker: OrchestratorThreadMarker }) {
  return (
    <View
      accessible
      accessibilityLabel={props.marker.accessibleLabel}
      className="flex-row items-center gap-1"
    >
      <SymbolView
        name="point.3.connected.trianglepath.dotted"
        size={11}
        tintColorClassName="accent-foreground-muted"
        type="monochrome"
      />
      <AutomationStatusLabel status={props.marker.state} />
    </View>
  );
}

/** When a record from another environment was read, and whether that environment answers now. */
export function ObservationText(props: { readonly observation: ObservationPresentation }) {
  const { observation } = props;
  const attention = observation.freshness !== "fresh" || observation.reachable === false;
  return (
    <Text
      className={cn("text-xs", attention ? "text-warning-foreground" : "text-foreground-muted")}
    >
      {observation.freshness === "stale" ? `Stale · ${observation.label}` : observation.label}
      {observation.reachabilityLabel ? ` · ${observation.reachabilityLabel}` : ""}
    </Text>
  );
}
