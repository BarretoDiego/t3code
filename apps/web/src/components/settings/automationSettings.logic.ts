import { environmentSupportsAutomation } from "@t3tools/client-runtime/state/automation-presentation";
import { EnvironmentId, type HookDelivery, OrchestratorId } from "@t3tools/contracts";

export function validateAutomationSettingsSearch(raw: Record<string, unknown>) {
  return {
    ...(typeof raw.environmentId === "string" && raw.environmentId.trim()
      ? { environmentId: EnvironmentId.make(raw.environmentId) }
      : {}),
    ...(typeof raw.orchestratorId === "string" && raw.orchestratorId.trim()
      ? { orchestratorId: OrchestratorId.make(raw.orchestratorId) }
      : {}),
  };
}

/** The anchors the command palette and settings search jump to. */
export const AUTOMATION_SETTINGS_ANCHORS = {
  orchestrators: "automation-orchestrators",
  hooks: "automation-hooks",
  peers: "automation-peers",
  nodes: "automation-nodes",
} as const;

interface AutomationEnvironmentCandidate {
  readonly environmentId: EnvironmentId;
  readonly connection: { readonly phase: string };
  readonly serverConfig: {
    readonly environment: { readonly capabilities: { readonly automation?: boolean } };
  } | null;
}

export type AutomationEnvironmentAvailability =
  /** Connected and the server speaks automation. */
  | "ready"
  /** The server advertises automation but the client is not connected to it now. */
  | "disconnected"
  /** The server predates automation. It gets no section at all. */
  | "unsupported";

/**
 * Whether an environment gets automation settings. A server from before
 * automation never shows them; one that supports it but is offline keeps its
 * heading so the user knows why the lists are missing.
 */
export function automationEnvironmentAvailability(
  environment: AutomationEnvironmentCandidate,
): AutomationEnvironmentAvailability {
  if (!environmentSupportsAutomation(environment.serverConfig)) return "unsupported";
  return environment.connection.phase === "connected" ? "ready" : "disconnected";
}

export function automationCapableEnvironments<T extends AutomationEnvironmentCandidate>(
  environments: ReadonlyArray<T>,
): ReadonlyArray<T> {
  return environments.filter(
    (environment) => automationEnvironmentAvailability(environment) !== "unsupported",
  );
}

export const HOOK_DELIVERY_FILTERS = [
  { id: "attention", label: "Needs attention", statuses: ["failed", "suppressed", "retrying"] },
  { id: "in-flight", label: "In flight", statuses: ["pending", "delivering"] },
  { id: "delivered", label: "Delivered", statuses: ["delivered"] },
  { id: "all", label: "All", statuses: null },
] as const satisfies ReadonlyArray<{
  readonly id: string;
  readonly label: string;
  readonly statuses: ReadonlyArray<HookDelivery["status"]> | null;
}>;

export type HookDeliveryFilterId = (typeof HOOK_DELIVERY_FILTERS)[number]["id"];

export function hookDeliveryFilterStatuses(
  id: HookDeliveryFilterId,
): ReadonlyArray<HookDelivery["status"]> | null {
  return HOOK_DELIVERY_FILTERS.find((filter) => filter.id === id)?.statuses ?? null;
}

/** Redelivery applies to what did not arrive; dismissing applies to what is still held. */
export function hookDeliveryActions(status: string): {
  readonly canRedeliver: boolean;
  readonly canDismiss: boolean;
} {
  const held = status === "failed" || status === "suppressed";
  return { canRedeliver: held, canDismiss: held || status === "retrying" };
}

/** The tail of a log, cut at a line start so the first line shown is whole. */
export function tailLogText(text: string, maxLines: number): string {
  const lines = text.replace(/\n$/, "").split("\n");
  return lines.length <= maxLines ? lines.join("\n") : lines.slice(-maxLines).join("\n");
}
