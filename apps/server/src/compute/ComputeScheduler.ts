import type { ComputeProviderSnapshot, GenerationRequest } from "@t3tools/contracts";

/**
 * Picks the least queued compatible destination. Hardware metadata is purposely
 * opaque here; future policies may consume it without changing this contract.
 */
export function selectComputeProvider(
  providers: ReadonlyArray<ComputeProviderSnapshot>,
  request: GenerationRequest,
): ComputeProviderSnapshot | undefined {
  return providers
    .filter(({ provider }) => provider.status === "online")
    .filter(
      ({ provider }) => request.providerId === undefined || provider.id === request.providerId,
    )
    .filter(({ provider }) => request.nodeId === undefined || provider.nodeId === request.nodeId)
    .filter(
      ({ provider }) =>
        request.environmentId === undefined || provider.environmentId === request.environmentId,
    )
    .filter(({ capabilities }) =>
      capabilities.some(
        (capability) =>
          capability.id === request.capability && capability.operations.includes(request.operation),
      ),
    )
    .filter(({ capabilities, queueDepth }) => {
      const capability = capabilities.find((candidate) => candidate.id === request.capability)!;
      if (
        capability.limits?.concurrentJobs !== undefined &&
        (queueDepth ?? 0) >= capability.limits.concurrentJobs
      )
        return false;
      if (
        capability.limits?.queueDepth !== undefined &&
        (queueDepth ?? 0) >= capability.limits.queueDepth
      )
        return false;
      if (request.model === undefined && !capability.models?.length) return true;
      return capabilities
        .filter(
          (capability) =>
            capability.id === request.capability &&
            capability.operations.includes(request.operation),
        )
        .flatMap((capability) => capability.models ?? [])
        .some(
          (model) =>
            (request.model === undefined || model.id === request.model) &&
            model.operations.includes(request.operation) &&
            ["available", "ready", "loaded"].includes(model.status),
        );
    })
    .sort((a, b) => {
      const aLoaded = request.model
        ? a.capabilities
            .flatMap((capability) => capability.models ?? [])
            .some((model) => model.id === request.model && model.status === "loaded")
        : false;
      const bLoaded = request.model
        ? b.capabilities
            .flatMap((capability) => capability.models ?? [])
            .some((model) => model.id === request.model && model.status === "loaded")
        : false;
      return (
        Number(bLoaded) - Number(aLoaded) ||
        (a.queueDepth ?? 0) - (b.queueDepth ?? 0) ||
        a.provider.id.localeCompare(b.provider.id)
      );
    })[0];
}
