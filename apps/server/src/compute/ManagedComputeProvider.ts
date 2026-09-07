import {
  ComputeError,
  type ComputeProviderConfig,
  type GenerationJob,
  GenerationJob as GenerationJobSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import type {
  ComputeProviderAdapter,
  ComputeProviderDiscovery,
  ComputeProviderHealth,
} from "./ComputeProviderAdapter.ts";

/** Driver results contain public job state only, never credentials or raw vendor responses. */
export interface ManagedComputeOperation {
  readonly id: string;
  readonly status: GenerationJob["status"];
  readonly progress?: number;
  readonly outputs?: GenerationJob["outputs"];
  readonly error?: GenerationJob["error"];
  readonly metrics?: GenerationJob["metrics"];
  readonly startedAt?: string;
  readonly completedAt?: string;
}

/**
 * A connection is scoped to one provider/account/region. Native connectors own
 * SDKs, credential refresh, model payload translation, quotas and artifact import.
 * Repeated connect must not create cloud resources or perform billable inference.
 */
export interface ManagedComputeConnection {
  readonly close: Effect.Effect<void>;
  readonly health: Effect.Effect<ComputeProviderHealth>;
  readonly discover: Effect.Effect<ComputeProviderDiscovery, ComputeError>;
  /** job.id is the durable idempotency key. The core never retries this call. */
  readonly submit: (job: GenerationJob) => Effect.Effect<ManagedComputeOperation, ComputeError>;
  readonly get: (operationId: string) => Effect.Effect<ManagedComputeOperation, ComputeError>;
  /** Read-only recovery of an acknowledgement lost after submission. Never resubmit here. */
  readonly findByRequestId?: (
    jobId: string,
  ) => Effect.Effect<ManagedComputeOperation | undefined, ComputeError>;
  /** Omit when the remote API cannot cancel. Acknowledgement does not imply cancellation. */
  readonly cancel?: (operationId: string) => Effect.Effect<void, ComputeError>;
}

export interface ManagedComputeDriver {
  readonly type: string;
  readonly connect: (
    provider: ComputeProviderConfig,
  ) => Effect.Effect<ManagedComputeConnection, ComputeError>;
}

const decodeJob = Schema.decodeUnknownEffect(GenerationJobSchema);
const terminal = (job: GenerationJob) => ["completed", "failed", "cancelled"].includes(job.status);
const failure = (code: string, message: string) => new ComputeError({ code, message });

/** Stateless job lookup: recreating this adapter needs configuration and persisted jobs only. */
export function makeManagedComputeProvider(driver: ManagedComputeDriver): ComputeProviderAdapter {
  const connections = new Map<string, ManagedComputeConnection>();
  const connectionGate = Semaphore.makeUnsafe(1);
  const connection = (providerId: string) =>
    Effect.suspend(() => {
      const value = connections.get(providerId);
      return value
        ? Effect.succeed(value)
        : Effect.fail(failure("provider-offline", "Managed provider is disconnected."));
    });
  const merge = (job: GenerationJob, remote: ManagedComputeOperation) => {
    if (
      job.remoteOperation &&
      (job.remoteOperation.adapterType !== driver.type || job.remoteOperation.id !== remote.id)
    )
      return Effect.fail(failure("operation-mismatch", "Remote operation identity changed."));
    const { error: _previousError, ...stableJob } = job;
    return decodeJob({
      ...stableJob,
      status: remote.status,
      remoteOperation: { id: remote.id, adapterType: driver.type },
      ...(remote.progress === undefined ? {} : { progress: remote.progress }),
      ...(remote.outputs === undefined ? {} : { outputs: remote.outputs }),
      ...(remote.error === undefined ? {} : { error: remote.error }),
      ...(remote.metrics === undefined ? {} : { metrics: remote.metrics }),
      ...(remote.startedAt === undefined ? {} : { startedAt: remote.startedAt }),
      ...(remote.completedAt === undefined ? {} : { completedAt: remote.completedAt }),
    }).pipe(
      Effect.mapError(() =>
        failure("invalid-remote-operation", "Managed provider returned invalid job state."),
      ),
    );
  };
  const getJob = Effect.fn("ManagedComputeProvider.getJob")(function* (job: GenerationJob) {
    if (terminal(job)) return job;
    if (job.remoteOperation && job.remoteOperation.adapterType !== driver.type)
      return yield* failure("operation-mismatch", "Remote operation belongs to another adapter.");
    const client = yield* connection(job.providerId);
    const operation = job.remoteOperation
      ? yield* client.get(job.remoteOperation.id)
      : client.findByRequestId
        ? yield* client.findByRequestId(job.id)
        : undefined;
    // Missing acknowledgement is not evidence that a paid request failed.
    return operation ? yield* merge(job, operation) : job;
  });
  return {
    type: driver.type,
    connect: Effect.fn("ManagedComputeProvider.connect")(function* (provider) {
      if (provider.type !== driver.type || provider.execution?.kind !== "managed")
        return yield* failure(
          "invalid-managed-provider",
          "Managed provider requires a matching adapter type and managed execution target.",
        );
      const previous = connections.get(provider.id);
      if (previous && (yield* previous.health).status !== "offline") return;
      if (previous) {
        connections.delete(provider.id);
        yield* previous.close;
      }
      connections.set(provider.id, yield* driver.connect(provider));
    }, connectionGate.withPermits(1)),
    disconnect: Effect.fn("ManagedComputeProvider.disconnect")(function* (providerId) {
      const client = connections.get(providerId);
      connections.delete(providerId);
      if (client) yield* client.close;
    }, connectionGate.withPermits(1)),
    health: (provider) =>
      connection(provider.id).pipe(
        Effect.flatMap((client) => client.health),
        Effect.orElseSucceed(() => ({ status: "offline" as const })),
      ),
    discover: (provider) =>
      connection(provider.id).pipe(
        Effect.flatMap((client) =>
          client.discover.pipe(
            Effect.map((discovery) => ({
              ...discovery,
              executionSupport: {
                cancellation: client.cancel ? ("supported" as const) : ("unsupported" as const),
                recovery: client.findByRequestId
                  ? ("request-id" as const)
                  : ("operation-id" as const),
              },
            })),
          ),
        ),
      ),
    submit: Effect.fn("ManagedComputeProvider.submit")(function* (job) {
      if (job.remoteOperation || terminal(job)) return yield* getJob(job);
      const client = yield* connection(job.providerId);
      return yield* merge(job, yield* client.submit(job));
    }),
    getJob,
    cancel: Effect.fn("ManagedComputeProvider.cancel")(function* (job) {
      if (terminal(job)) return;
      const client = yield* connection(job.providerId);
      if (!client.cancel)
        return yield* failure(
          "cancel-unsupported",
          "This managed provider cannot cancel remote execution; the job may continue and incur charges.",
        );
      const current = yield* getJob(job);
      if (terminal(current)) return;
      if (!current.remoteOperation)
        return yield* failure(
          "operation-unresolved",
          "Remote operation identity has not been recovered; cancellation was not sent.",
        );
      yield* client.cancel(current.remoteOperation.id);
    }),
    reconcile: (jobs) =>
      Effect.forEach(jobs, (job) => getJob(job).pipe(Effect.orElseSucceed(() => job)), {
        concurrency: 3,
      }),
  };
}
