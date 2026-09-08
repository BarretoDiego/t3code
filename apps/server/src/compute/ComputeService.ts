import * as NodeUtil from "node:util";

import {
  type ComputeEvent,
  ComputeError,
  type ComputeJobCancelInput,
  type ComputeJobGetInput,
  ComputeJobListInput,
  type ComputeJobSubmitInput,
  ComputeProviderConfig,
  ComputeProviderSnapshot,
  type ComputeSnapshot,
  GenerationJob,
  GenerationRequest,
  type GenerationJobStatus,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { ServerConfig } from "../config.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { ComputeJobRepositoryLive } from "../persistence/Layers/ComputeJobs.ts";
import { ComputeJobRepository } from "../persistence/Services/ComputeJobs.ts";
import { ComputeProviderAdapterRegistry } from "./ComputeProviderAdapter.ts";
import { ComputeProviderAdapterRegistryLive } from "./ComputeProviderAdapters.ts";
import { selectComputeProvider } from "./ComputeScheduler.ts";
import { materializeComputeArtifacts } from "./ComputeArtifacts.ts";
import {
  normalizeGenerationRequest,
  validCapabilityCatalog,
  validateProviderConfiguration,
} from "./ComputeValidation.ts";
import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads.ts";
import { ProjectionThreadRepositoryLive } from "../persistence/Layers/ProjectionThreads.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { ProjectionProjectRepositoryLive } from "../persistence/Layers/ProjectionProjects.ts";

const decodeJob = Schema.decodeUnknownEffect(GenerationJob);
const decodeSnapshot = Schema.decodeUnknownEffect(ComputeProviderSnapshot);
const decodeRequest = Schema.decodeUnknownEffect(GenerationRequest);
const encodeRequest = Schema.encodeEffect(Schema.fromJsonString(GenerationRequest));
const decodeJobList = Schema.decodeUnknownEffect(ComputeJobListInput);
const isComputeError = Schema.is(ComputeError);

const ProviderConfigFile = Schema.Array(ComputeProviderConfig).check(Schema.isMaxLength(64));
const decodeProviderConfigs = Schema.decodeUnknownEffect(Schema.fromJsonString(ProviderConfigFile));
const encodeProviderConfigs = Schema.encodeEffect(Schema.fromJsonString(ProviderConfigFile));

const isTerminal = (status: GenerationJobStatus) =>
  status === "completed" || status === "failed" || status === "cancelled";

const eventForJob = (previous: GenerationJob | undefined, job: GenerationJob): ComputeEvent => {
  if (!previous) return { _tag: "job.created", job };
  if (job.status === "completed") return { _tag: "job.completed", job };
  if (job.status === "failed") return { _tag: "job.failed", job };
  if (job.status === "cancelled") return { _tag: "job.cancelled", job };
  if (
    (job.status === "starting" && previous.status !== "starting") ||
    (job.status === "running" && previous.status === "queued")
  )
    return { _tag: "job.started", job };
  return { _tag: "job.progress", job };
};

export interface ComputeServiceShape {
  readonly list: (refresh?: boolean) => Effect.Effect<ComputeSnapshot, ComputeError>;
  readonly saveProvider: (
    provider: ComputeProviderConfig,
  ) => Effect.Effect<ComputeSnapshot, ComputeError>;
  readonly removeProvider: (providerId: string) => Effect.Effect<ComputeSnapshot, ComputeError>;
  readonly submit: (input: ComputeJobSubmitInput) => Effect.Effect<GenerationJob, ComputeError>;
  readonly getJob: (input: ComputeJobGetInput) => Effect.Effect<GenerationJob, ComputeError>;
  readonly listJobs: (
    input: ComputeJobListInput,
  ) => Effect.Effect<ReadonlyArray<GenerationJob>, ComputeError>;
  readonly cancel: (input: ComputeJobCancelInput) => Effect.Effect<GenerationJob, ComputeError>;
  readonly changes: Stream.Stream<ComputeSnapshot, ComputeError>;
  readonly events: Stream.Stream<ComputeEvent>;
}

const error = (message: string, code?: string) =>
  new ComputeError({ message, ...(code ? { code } : {}) });

export const makeComputeService = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const environment = yield* ServerEnvironment;
  const crypto = yield* Crypto.Crypto;
  const repository = yield* ComputeJobRepository;
  const threads = yield* ProjectionThreadRepository;
  const projects = yield* ProjectionProjectRepository;
  const adapters = yield* ComputeProviderAdapterRegistry;
  const environmentId = yield* environment.getEnvironmentId;
  const directory = path.join(config.baseDir, "compute-providers");
  const configPath = path.join(directory, "providers.json");
  const snapshot = yield* SubscriptionRef.make<ComputeSnapshot>({ providers: [], jobs: [] });
  const events = yield* PubSub.sliding<ComputeEvent>(256);
  const jobGate = yield* Semaphore.make(1);
  const refreshGate = yield* Semaphore.make(1);
  const configurationGate = yield* Semaphore.make(1);
  let configured: readonly ComputeProviderConfig[] | undefined;
  let lastRefresh = -Infinity;

  const now = Effect.gen(function* () {
    return DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
  });
  const load = Effect.fn("ComputeService.load")(
    function* () {
      const stored = (yield* fs.exists(configPath))
        ? yield* fs.readFileString(configPath).pipe(
            Effect.flatMap(decodeProviderConfigs),
            Effect.mapError(() =>
              error("Could not read compute provider configuration.", "config-invalid"),
            ),
          )
        : [];
      if (new Set(stored.map((provider) => provider.id)).size !== stored.length)
        return yield* error("Provider ids must be unique.", "config-invalid");
      const validated = yield* Effect.forEach(stored, validateProviderConfiguration);
      const active = yield* repository.listPendingJobs();
      for (const old of configured ?? []) {
        if (
          NodeUtil.isDeepStrictEqual(
            old,
            validated.find((provider) => provider.id === old.id),
          )
        )
          continue;
        if (active.some((job) => job.providerId === old.id))
          return yield* error(
            "Provider configuration changed while jobs were active.",
            "provider-in-use",
          );
        const adapter = adapters.get(old.type);
        if (adapter) yield* adapter.disconnect(old.id);
      }
      configured = validated;
      return configured;
    },
    Effect.mapError((cause) =>
      isComputeError(cause)
        ? cause
        : error("Could not load compute provider state.", "persistence-failed"),
    ),
  );
  const persist = Effect.fn("ComputeService.persist")(
    function* (next: readonly ComputeProviderConfig[]) {
      const stored = next;
      yield* fs.makeDirectory(directory, { recursive: true });
      const temporary = path.join(directory, `${yield* crypto.randomUUIDv4}.tmp`);
      yield* fs.writeFileString(temporary, yield* encodeProviderConfigs(stored), { mode: 0o600 });
      yield* fs.rename(temporary, configPath);
      configured = stored;
      lastRefresh = -Infinity;
    },
    Effect.mapError(() =>
      error("Could not save compute provider configuration.", "config-write-failed"),
    ),
  );
  const applyJob = Effect.fn("ComputeService.applyJob")(function* (
    input: GenerationJob,
    creating: boolean = false,
  ) {
    let job = yield* decodeJob(input).pipe(
      Effect.mapError(() => error("Invalid provider job state.", "invalid-provider-result")),
    );
    const current = yield* SubscriptionRef.get(snapshot);
    const previous = Option.getOrUndefined(
      yield* repository
        .getJob({ jobId: job.id })
        .pipe(Effect.mapError(() => error("Could not read compute job.", "persistence-failed"))),
    );
    if (!previous && !creating)
      return yield* error("Provider update does not match a submitted job.", "job-not-found");
    if (previous) {
      if (
        !NodeUtil.isDeepStrictEqual(
          [
            previous.request,
            previous.providerId,
            previous.environmentId,
            previous.nodeId,
            previous.execution,
            previous.createdAt,
          ],
          [
            job.request,
            job.providerId,
            job.environmentId,
            job.nodeId,
            job.execution,
            job.createdAt,
          ],
        ) ||
        (previous.remoteOperation &&
          !NodeUtil.isDeepStrictEqual(previous.remoteOperation, job.remoteOperation))
      )
        return yield* error("Provider changed immutable job identity.", "job-identity-mismatch");
      const phase = {
        queued: 0,
        starting: 1,
        loading: 2,
        running: 3,
        postprocessing: 4,
        completed: 5,
        failed: 5,
        cancelled: 5,
      };
      if (
        isTerminal(previous.status) ||
        phase[job.status] < phase[previous.status] ||
        NodeUtil.isDeepStrictEqual(previous, job)
      )
        return previous;
      if (
        previous.progress !== undefined &&
        (job.progress === undefined || job.progress < previous.progress)
      )
        job = { ...job, progress: previous.progress };
    }
    job = yield* materializeComputeArtifacts(job).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ServerConfig, config),
    );
    yield* repository
      .saveJob(job)
      .pipe(
        Effect.mapError(() => error("Could not persist job and artifacts.", "persistence-failed")),
      );
    yield* SubscriptionRef.set(snapshot, {
      ...current,
      jobs: [job, ...current.jobs.filter((candidate) => candidate.id !== job.id)]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
        .slice(0, 100),
    });
    yield* PubSub.publish(events, eventForJob(previous, job));
    for (const artifact of job.outputs ?? [])
      if (!previous?.outputs?.some((candidate) => candidate.id === artifact.id))
        yield* PubSub.publish(events, { _tag: "artifact.created", jobId: job.id, artifact });
    return job;
  }, jobGate.withPermits(1));
  const discoverProvider = (
    provider: ComputeProviderConfig,
  ): Effect.Effect<ComputeProviderSnapshot> => {
    const adapter = adapters.get(provider.type);
    if (!adapter)
      return Effect.succeed<ComputeProviderSnapshot>({
        provider: { ...provider, status: "offline" as const },
        capabilities: [],
        models: [],
      });
    return Effect.gen(function* () {
      const health = yield* adapter
        .connect(provider)
        .pipe(Effect.andThen(adapter.health(provider)));
      const discovery = yield* adapter.discover(provider);
      if (!validCapabilityCatalog(discovery.capabilities))
        return yield* error("Invalid capability catalog.", "discovery-invalid");
      return yield* decodeSnapshot({
        provider: { ...provider, status: health.status },
        capabilities: [...discovery.capabilities],
        models: discovery.capabilities.flatMap((capability) => capability.models ?? []),
        ...(discovery.resources ? { resources: discovery.resources } : {}),
        ...(discovery.queueDepth === undefined ? {} : { queueDepth: discovery.queueDepth }),
        ...(discovery.executionSupport ? { executionSupport: discovery.executionSupport } : {}),
      });
    }).pipe(
      Effect.timeout("10 seconds"),
      Effect.orElseSucceed((): ComputeProviderSnapshot => ({
        provider: { ...provider, status: "error" },
        capabilities: [],
        models: [],
      })),
    );
  };
  const refresh = Effect.fn("ComputeService.refresh")(function* (force: boolean) {
    const currentTime = yield* Clock.currentTimeMillis;
    const previous = yield* SubscriptionRef.get(snapshot);
    if (!force && previous.providers.length > 0 && currentTime - lastRefresh < 10_000)
      return previous;
    const providers = yield* Effect.forEach(yield* load(), discoverProvider, { concurrency: 3 });
    const jobs = yield* repository
      .listPendingJobs()
      .pipe(
        Effect.mapError(() => error("Could not read compute job history.", "persistence-failed")),
      );
    const reconciled = yield* Effect.forEach(providers, (provider) => {
      const adapter = adapters.get(provider.provider.type);
      if (!adapter || !["online", "degraded"].includes(provider.provider.status))
        return Effect.succeed([] as readonly GenerationJob[]);
      return adapter
        .reconcile(
          jobs.filter((job) => job.providerId === provider.provider.id && !isTerminal(job.status)),
        )
        .pipe(
          Effect.timeout("10 seconds"),
          Effect.map((updates) => updates.filter((job) => job.providerId === provider.provider.id)),
          Effect.orElseSucceed(() => [] as readonly GenerationJob[]),
        );
    });
    for (const job of reconciled.flat())
      if (
        jobs.some((candidate) => candidate.id === job.id && candidate.providerId === job.providerId)
      )
        yield* applyJob(job).pipe(
          Effect.catch(() => Effect.logWarning("Ignored invalid compute reconciliation update.")),
        );
    const next = {
      providers,
      jobs: yield* listJobs({}),
    } satisfies ComputeSnapshot;
    yield* jobGate.withPermits(1)(
      Effect.gen(function* () {
        // Re-read under the job lock; subscribed updates may arrive during discovery.
        const updated = { ...next, jobs: yield* listJobs({}) };
        if (!NodeUtil.isDeepStrictEqual(yield* SubscriptionRef.get(snapshot), updated))
          yield* SubscriptionRef.set(snapshot, updated);
      }),
    );
    lastRefresh = yield* Clock.currentTimeMillis;
    for (const removed of previous.providers)
      if (!providers.some((provider) => provider.provider.id === removed.provider.id))
        yield* PubSub.publish(events, {
          _tag: "provider.disconnected",
          providerId: removed.provider.id,
        });
    for (const provider of providers) {
      const old = previous.providers.find(
        (candidate) => candidate.provider.id === provider.provider.id,
      );
      if (old?.provider.status !== provider.provider.status)
        yield* PubSub.publish(events, {
          _tag:
            provider.provider.status === "online" ? "provider.connected" : "provider.disconnected",
          providerId: provider.provider.id,
        });
      if (
        !NodeUtil.isDeepStrictEqual(
          [old?.capabilities, old?.executionSupport],
          [provider.capabilities, provider.executionSupport],
        )
      )
        yield* PubSub.publish(events, {
          _tag: "capabilities.changed",
          providerId: provider.provider.id,
        });
      if (!NodeUtil.isDeepStrictEqual(old?.resources, provider.resources))
        yield* PubSub.publish(events, {
          _tag: "resources.changed",
          providerId: provider.provider.id,
        });
    }
    return next;
  }, refreshGate.withPermits(1));
  const list: ComputeServiceShape["list"] = (force = false) => refresh(force);
  const saveProvider: ComputeServiceShape["saveProvider"] = (input) =>
    Effect.gen(function* () {
      const validated = yield* validateProviderConfiguration(input);
      if (validated.environmentId && validated.environmentId !== environmentId)
        return yield* error(
          "Configure the provider on its owning environment.",
          "environment-mismatch",
        );
      const provider = { ...validated, environmentId };
      const current = yield* load();
      const existing = current.find((candidate) => candidate.id === provider.id);
      if (existing && !NodeUtil.isDeepStrictEqual(existing, provider)) {
        const jobs = yield* repository
          .listPendingJobs()
          .pipe(Effect.mapError(() => error("Could not read active jobs.", "persistence-failed")));
        if (jobs.some((job) => job.providerId === provider.id))
          return yield* error(
            "Provider has unfinished jobs; keep its execution identity stable until they settle.",
            "provider-in-use",
          );
        const adapter = adapters.get(existing.type);
        if (adapter) yield* adapter.disconnect(existing.id);
      }
      yield* persist([...current.filter((candidate) => candidate.id !== provider.id), provider]);
      return yield* refresh(true);
    }).pipe(configurationGate.withPermits(1));
  const removeProvider: ComputeServiceShape["removeProvider"] = (providerId) =>
    Effect.gen(function* () {
      const current = yield* load();
      const provider = current.find((candidate) => candidate.id === providerId);
      if (!provider) return yield* error("Provider not found.", "provider-not-found");
      if (
        (yield* repository
          .listPendingJobs()
          .pipe(
            Effect.mapError(() => error("Could not read active jobs.", "persistence-failed")),
          )).some((job) => job.providerId === providerId)
      )
        return yield* error("Provider has unfinished jobs.", "provider-in-use");
      const adapter = adapters.get(provider.type);
      if (adapter) yield* adapter.disconnect(provider.id);
      yield* persist(current.filter((candidate) => candidate.id !== providerId));
      return yield* refresh(true);
    }).pipe(configurationGate.withPermits(1));
  const submit: ComputeServiceShape["submit"] = (input) =>
    Effect.gen(function* () {
      const current = yield* refresh(false);
      let request = yield* decodeRequest(input.request).pipe(
        Effect.mapError(() => error("Invalid compute request.", "request-invalid")),
      );
      const pending = yield* repository
        .listPendingJobs()
        .pipe(Effect.mapError(() => error("Could not read active jobs.", "persistence-failed")));
      if (pending.length >= 500)
        return yield* error("Environment has reached its active job limit.", "queue-full");
      const destination = selectComputeProvider(
        current.providers.map((provider) => ({
          ...provider,
          queueDepth: Math.max(
            provider.queueDepth ?? 0,
            pending.filter((job) => job.providerId === provider.provider.id).length,
          ),
        })),
        request,
      );
      if (!destination)
        return yield* error(
          "No online compute provider can satisfy the requested capability, operation, and model.",
          "no-compatible-provider",
        );
      request = yield* normalizeGenerationRequest(request, destination);
      if (request.context?.threadId) {
        const thread = yield* threads
          .getById({ threadId: request.context.threadId })
          .pipe(
            Effect.mapError(() => error("Could not read thread context.", "persistence-failed")),
          );
        if (Option.isNone(thread) || thread.value.deletedAt !== null)
          return yield* error("Compute thread not found.", "thread-not-found");
        if (request.context.projectId && request.context.projectId !== thread.value.projectId)
          return yield* error("Project does not own the compute thread.", "context-mismatch");
        request = {
          ...request,
          context: { ...request.context, projectId: thread.value.projectId },
        };
      } else if (request.context?.projectId) {
        const project = yield* projects
          .getById({ projectId: request.context.projectId })
          .pipe(
            Effect.mapError(() => error("Could not read project context.", "persistence-failed")),
          );
        if (Option.isNone(project) || project.value.deletedAt !== null)
          return yield* error("Compute project not found.", "project-not-found");
      }
      const encoded = yield* encodeRequest(request).pipe(
        Effect.mapError(() => error("Request is not serializable.", "request-invalid")),
      );
      if (encoded.length > 65_536)
        return yield* error(
          "Compute request exceeds 64 KiB; use artifact references for media.",
          "request-too-large",
        );
      const adapter = adapters.get(destination.provider.type);
      if (!adapter) return yield* error("Provider adapter is unavailable.", "adapter-unavailable");
      const createdAt = yield* now;
      const id = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError(() =>
          error("Could not allocate a compute job id.", "id-allocation-failed"),
        ),
      );
      const job: GenerationJob = {
        id,
        request: { ...request, providerId: destination.provider.id },
        providerId: destination.provider.id,
        ...(destination.provider.nodeId ? { nodeId: destination.provider.nodeId } : {}),
        ...(destination.provider.environmentId
          ? { environmentId: destination.provider.environmentId }
          : {}),
        status: "queued",
        ...(destination.provider.execution ? { execution: destination.provider.execution } : {}),
        createdAt,
      };
      yield* applyJob(job, true);
      return { job, adapter };
    }).pipe(
      configurationGate.withPermits(1),
      // Release configuration lock after durable reservation; remote jobs may submit concurrently.
      Effect.flatMap(({ job, adapter }) =>
        adapter.submit(job).pipe(
          Effect.timeout("30 seconds"),
          Effect.flatMap((accepted) => applyJob(accepted)),
          Effect.catch(() =>
            Effect.gen(function* () {
              const latest = yield* getJob({ jobId: job.id });
              if (!isTerminal(latest.status))
                yield* applyJob({
                  ...latest,
                  error: {
                    code: "submission-uncertain",
                    message:
                      "Submission acknowledgement was not persisted. Reconcile; do not resubmit.",
                    retryable: false,
                  },
                });
              return yield* new ComputeError({
                code: "submission-uncertain",
                jobId: job.id,
                message:
                  "Submission outcome is uncertain. Inspect the persisted job before retrying.",
              });
            }),
          ),
        ),
      ),
    );
  const getJob: ComputeServiceShape["getJob"] = (input) =>
    repository.getJob(input).pipe(
      Effect.mapError(() => error("Could not read compute job history.", "persistence-failed")),
      Effect.flatMap((job) =>
        Option.match(job, {
          onNone: () => Effect.fail(error("Job not found.", "job-not-found")),
          onSome: Effect.succeed,
        }),
      ),
    );
  const listJobs: ComputeServiceShape["listJobs"] = (input) =>
    decodeJobList(input).pipe(
      Effect.mapError(() => error("Invalid compute history query.", "request-invalid")),
      Effect.flatMap((query) =>
        repository
          .listJobs(query)
          .pipe(
            Effect.mapError(() =>
              error("Could not read compute job history.", "persistence-failed"),
            ),
          ),
      ),
    );
  const cancel: ComputeServiceShape["cancel"] = (input) =>
    Effect.gen(function* () {
      const job = yield* getJob(input);
      if (isTerminal(job.status)) return job;
      const provider = (yield* refresh(false)).providers.find(
        (candidate) => candidate.provider.id === job.providerId,
      );
      const adapter = provider ? adapters.get(provider.provider.type) : undefined;
      if (!adapter || !provider || !["online", "degraded"].includes(provider.provider.status))
        return yield* error("Provider is offline; cancellation was not sent.", "provider-offline");
      yield* adapter.cancel(job).pipe(
        Effect.timeout("10 seconds"),
        Effect.mapError((cause) =>
          isComputeError(cause)
            ? cause
            : error(
                "Cancellation acknowledgement timed out; reconcile the job.",
                "cancel-uncertain",
              ),
        ),
      );
      const updated = yield* adapter.getJob(job).pipe(
        Effect.timeout("10 seconds"),
        Effect.mapError(() =>
          error("Could not confirm cancellation; reconcile the job.", "cancel-uncertain"),
        ),
      );
      if (!updated)
        return yield* error("Provider lost the job during cancellation.", "job-not-found");
      return yield* applyJob(updated);
    });
  const unsubscriptions = yield* Effect.forEach(adapters.all, (adapter) =>
    adapter.subscribe
      ? adapter.subscribe((job) =>
          Effect.gen(function* () {
            if (
              !configured?.some(
                (provider) => provider.id === job.providerId && provider.type === adapter.type,
              )
            )
              return yield* error("Update belongs to another provider.", "provider-mismatch");
            yield* applyJob(job);
          }),
        )
      : Effect.succeed(() => undefined),
  );
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => unsubscriptions.forEach((unsubscribe) => unsubscribe())).pipe(
      Effect.andThen(
        Effect.forEach(
          configured ?? [],
          (provider) => adapters.get(provider.type)?.disconnect(provider.id) ?? Effect.void,
          { discard: true },
        ),
      ),
    ),
  );
  // Server-owned polling continues with no client/view connected. It never submits jobs.
  yield* Effect.forkScoped(
    Effect.forever(
      Effect.gen(function* () {
        yield* Effect.sleep("5 seconds");
        yield* refresh(true).pipe(configurationGate.withPermits(1));
      }).pipe(
        Effect.catch(() =>
          Effect.logWarning("Compute refresh failed; persisted history was preserved."),
        ),
      ),
    ),
  );
  return {
    list,
    saveProvider,
    removeProvider,
    submit,
    getJob,
    listJobs,
    cancel,
    changes: Stream.unwrap(list().pipe(Effect.map(() => SubscriptionRef.changes(snapshot)))),
    events: Stream.fromPubSub(events),
  } satisfies ComputeServiceShape;
});

export class ComputeService extends Context.Service<ComputeService, ComputeServiceShape>()(
  "t3/compute/ComputeService",
) {
  static readonly layer = Layer.effect(ComputeService, makeComputeService).pipe(
    Layer.provide(ComputeJobRepositoryLive),
    Layer.provide(ProjectionThreadRepositoryLive),
    Layer.provide(ProjectionProjectRepositoryLive),
    Layer.provide(ComputeProviderAdapterRegistryLive),
  );
}
