import type {
  ComputeCapability,
  ComputeError,
  ComputeProviderConfig,
  ComputeResources,
  ComputeExecutionSupport,
  GenerationJob,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface ComputeProviderDiscovery {
  readonly capabilities: ReadonlyArray<ComputeCapability>;
  readonly resources?: ComputeResources | undefined;
  readonly queueDepth?: number | undefined;
  readonly executionSupport?: ComputeExecutionSupport | undefined;
}

export interface ComputeProviderHealth {
  readonly status: "online" | "offline" | "degraded";
}

/**
 * Provider boundary. Adapters own protocol details; the compute core owns
 * scheduling, durable history, events, and cross-provider selection.
 */
export interface ComputeProviderAdapter {
  readonly type: string;
  readonly connect: (provider: ComputeProviderConfig) => Effect.Effect<void, ComputeError>;
  readonly disconnect: (providerId: string) => Effect.Effect<void>;
  readonly health: (provider: ComputeProviderConfig) => Effect.Effect<ComputeProviderHealth>;
  readonly discover: (
    provider: ComputeProviderConfig,
  ) => Effect.Effect<ComputeProviderDiscovery, ComputeError>;
  readonly submit: (job: GenerationJob) => Effect.Effect<GenerationJob, ComputeError>;
  readonly cancel: (job: GenerationJob) => Effect.Effect<void, ComputeError>;
  readonly getJob: (job: GenerationJob) => Effect.Effect<GenerationJob | undefined, ComputeError>;
  readonly reconcile: (
    jobs: ReadonlyArray<GenerationJob>,
  ) => Effect.Effect<ReadonlyArray<GenerationJob>, ComputeError>;
  readonly subscribe?: (
    handler: (job: GenerationJob) => Effect.Effect<void, ComputeError>,
  ) => Effect.Effect<() => void>;
}

export interface ComputeProviderAdapterRegistryShape {
  readonly get: (type: string) => ComputeProviderAdapter | undefined;
  readonly all: ReadonlyArray<ComputeProviderAdapter>;
}

export class ComputeProviderAdapterRegistry extends Context.Service<
  ComputeProviderAdapterRegistry,
  ComputeProviderAdapterRegistryShape
>()("t3/compute/ComputeProviderAdapter/ComputeProviderAdapterRegistry") {}
