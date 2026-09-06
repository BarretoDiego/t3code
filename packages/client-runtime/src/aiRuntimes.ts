import type {
  AiRuntime,
  AiRuntimeConfig,
  AiRuntimeBindInput,
  EnvironmentId,
} from "@t3tools/contracts";

/** Connection health wins over a cached successful runtime probe. */
export function runtimeAvailability(runtime: AiRuntime, nodeConnected: boolean) {
  if (!nodeConnected) return { available: false, label: "Unavailable · node offline" };
  if (runtime.status === "authentication-required")
    return { available: false, label: "Authentication required" };
  if (runtime.status !== "available") return { available: false, label: "Unavailable" };
  const host = new URL(
    runtime.listenOnTailnet && runtime.networkBaseUrl ? runtime.networkBaseUrl : runtime.baseUrl,
  ).hostname;
  const local = host === "localhost" || host === "[::1]" || host.startsWith("127.");
  return {
    available: true,
    label: local ? "Local only" : "Available from this node · direct network",
  };
}

/** Imports an explicitly advertised address. Secrets remain environment-owned. */
export function runtimeForConsumer(runtime: AiRuntime, id: string): AiRuntimeConfig {
  if (!runtime.networkBaseUrl) throw new Error("This runtime has no advertised network address.");
  return {
    id,
    name: runtime.name,
    runtimeKind: runtime.runtimeKind,
    protocol: runtime.protocol,
    baseUrl: runtime.networkBaseUrl,
    networkBaseUrl: runtime.networkBaseUrl,
    authentication: runtime.authentication,
    configuredModels: runtime.configuredModels,
    origin: { environmentId: runtime.environmentId, runtimeId: runtime.id },
  };
}

export function runtimeIdentity(
  runtime: Pick<AiRuntimeConfig, "id">,
  environmentId: EnvironmentId,
) {
  return `${environmentId}/${runtime.id}`;
}

/** Keep forms valid when a refresh removes a model or an edit changes compatibility. */
export function runtimeBindingSelection(
  runtime: Pick<AiRuntime, "protocol" | "models">,
  selected: Pick<AiRuntimeBindInput, "driver" | "model">,
) {
  const drivers: ReadonlyArray<AiRuntimeBindInput["driver"]> =
    runtime.protocol === "ollama"
      ? ["opencode", "codex", "claudeAgent"]
      : runtime.protocol === "openai"
        ? ["opencode", "codex"]
        : runtime.protocol === "anthropic"
          ? ["claudeAgent"]
          : [];
  return {
    drivers,
    driver: drivers.find((driver) => driver === selected.driver) ?? drivers[0],
    model: runtime.models.some((model) => model.id === selected.model) ? selected.model : "",
  };
}
