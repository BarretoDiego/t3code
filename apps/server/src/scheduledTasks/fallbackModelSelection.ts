import type { ModelSelection, ServerProvider } from "@t3tools/contracts";

const hasExhaustedWindow = (provider: ServerProvider): boolean =>
  (provider.rateLimits?.windows ?? []).some((window) => window.status === "exhausted") ||
  (provider.usageLimits?.windows ?? []).some((window) => window.usedPercent >= 100);

/**
 * The first selection whose provider instance still has quota, or the primary
 * when every candidate is exhausted so the run fails visibly on the intended
 * provider. An instance with no reported quota counts as available.
 */
export const pickModelSelection = (
  primary: ModelSelection,
  fallbacks: ReadonlyArray<ModelSelection>,
  providers: ReadonlyArray<ServerProvider>,
): ModelSelection => {
  const exhausted = new Set(
    providers.filter(hasExhaustedWindow).map((provider) => provider.instanceId),
  );
  return [primary, ...fallbacks].find((s) => !exhausted.has(s.instanceId)) ?? primary;
};
