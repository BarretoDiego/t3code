// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  ThreadHandoffDestination,
  ThreadHandoffManifest,
  ThreadHandoffError,
  type OrchestrationProjectShell,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2StoredEvent,
  type ProjectId,
  type ProviderDriverKind,
  type ThreadHandoffRequest,
  type ThreadHandoffResponse,
  type ThreadHandoffRecord,
  type ThreadHandoffSource,
  type ThreadHandoffId,
  type ThreadId,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ServerConfig } from "../config.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { OrchestrationV2EventSinkLayerLive } from "../orchestration-v2/runtimeLayer.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import {
  issueProjectSyncExportUrl,
  issueProjectSyncImportUrl,
} from "../workspace/ProjectSyncTransfer.ts";
import { buildProjectSyncManifest } from "../workspace/ProjectSyncManifest.ts";
import {
  cleanupProjectSyncGitSnapshot,
  runSnapshotGit,
} from "../workspace/ProjectSyncGitSnapshot.ts";
import {
  captureThreadHandoffSnapshot,
  restoreThreadHandoffProjects,
  verifyThreadHandoffSnapshot,
} from "./ThreadHandoffSnapshot.ts";
import { getNativeHandoffDriver } from "./NativeHandoffDrivers.ts";
import { makeHandoffSafePoint } from "./HandoffSafePoint.ts";
import { makeHandoffJournal } from "./HandoffJournal.ts";
import { committedOwner } from "./lifecycle.ts";
import { inspectHandoffRepository, verifyHandoffRepository } from "./HandoffRepositoryIdentity.ts";
import { latestThreadConfiguration, remapThreadHandoffEvents } from "./ThreadHandoffArchive.ts";

const fail = (code: ThreadHandoffError["code"], message: string) =>
  new ThreadHandoffError({ code, message });
const isHandoffError = Schema.is(ThreadHandoffError);
const normalize = (cause: unknown) =>
  isHandoffError(cause)
    ? cause
    : fail("transferFailed", cause instanceof Error ? cause.message : "Thread transfer failed.");
const io = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: normalize });
/** Attachments live in environment-local storage, so they cannot travel yet. */
const carriesAttachments = ({ event }: OrchestrationV2StoredEvent) => {
  const data: object = event.payload;
  return (
    ("attachments" in data && Array.isArray(data.attachments) && data.attachments.length > 0) ||
    ("attachmentsByQuestionId" in data &&
      data.attachmentsByQuestionId != null &&
      typeof data.attachmentsByQuestionId === "object" &&
      Object.values(data.attachmentsByQuestionId).some(
        (items) => Array.isArray(items) && items.length > 0,
      ))
  );
};
function measure<A, E, R>(
  operation: string,
  handoffId: ThreadHandoffId | undefined,
  effect: Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    return yield* effect.pipe(
      Effect.ensuring(
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((endedAt) =>
            Effect.logDebug("Thread handoff timing", {
              operation,
              handoffId,
              durationMs: endedAt - startedAt,
            }),
          ),
        ),
      ),
    );
  });
}
function latestConfiguration(events: readonly OrchestrationV2StoredEvent[]) {
  return latestThreadConfiguration(events.map((stored) => stored.event));
}
const Pending = Schema.Struct({
  destination: ThreadHandoffDestination,
  manifest: Schema.optional(ThreadHandoffManifest),
  ready: Schema.Boolean,
  nativeInstalled: Schema.Boolean,
});
type Pending = typeof Pending.Type;
const decodePending = Schema.decodeUnknownSync(Schema.fromJsonString(Pending));
const encodePending = Schema.encodeSync(Schema.fromJsonString(Pending));
const encodeManifest = Schema.encodeSync(Schema.fromJsonString(ThreadHandoffManifest));
const encodeDestination = Schema.encodeSync(Schema.fromJsonString(ThreadHandoffDestination));
const manifestHash = (manifest: ThreadHandoffManifest) =>
  NodeCrypto.createHash("sha256").update(encodeManifest(manifest)).digest("hex");
// The state directory identifies one server database. This lock also orders
// status with uncertain commit/rollback requests from reconnecting clients.
const serverLocks = new Map<string, Map<string, Semaphore.Semaphore>>();

export class ThreadHandoffService extends Context.Service<
  ThreadHandoffService,
  {
    readonly watch: (
      threadId: ThreadId,
    ) => Stream.Stream<ThreadHandoffRecord | null, ThreadHandoffError>;
    readonly handle: (
      request: ThreadHandoffRequest,
    ) => Effect.Effect<ThreadHandoffResponse, ThreadHandoffError>;
  }
>()("t3/handoff/ThreadHandoffService") {}

/** The thread facts a handoff needs, read from the V2 projection. */
export interface HandoffThread {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly worktreePath: string | null;
  readonly providerInstanceId: ProviderInstanceId;
  /** The root provider thread carrying the conversation, if one exists. */
  readonly providerThread: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly driver: ProviderDriverKind;
    readonly nativeThreadId: string | null;
  } | null;
}

const toHandoffError = (cause: unknown) => normalize(cause);

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const secretStore = yield* ServerSecretStore;
  const identity = yield* ServerEnvironmentIdentity;
  const environmentId = yield* identity.getEnvironmentId;
  const settings = yield* ServerSettingsService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const sql = yield* SqlClient.SqlClient;
  const instances = yield* ProviderInstanceRegistry;
  const journal = yield* makeHandoffJournal;
  const safePoint = yield* makeHandoffSafePoint;
  const changes = yield* PubSub.unbounded<ThreadHandoffRecord>();
  const getThread = Effect.fn("ThreadHandoff.getThread")(function* (threadId: ThreadId) {
    const shell = yield* projections.getThreadShell(threadId);
    if (shell === null) return Option.none<HandoffThread>();
    const records = yield* projections.getThreadRecords(threadId, ["providerThreads"]);
    const providerThread = records.providerThreads.find(
      (candidate) => candidate.id === shell.activeProviderThreadId,
    );
    return Option.some<HandoffThread>({
      id: shell.id,
      projectId: shell.projectId,
      worktreePath: shell.worktreePath,
      providerInstanceId: shell.providerInstanceId,
      providerThread: providerThread
        ? {
            providerInstanceId: providerThread.providerInstanceId,
            driver: providerThread.driver,
            nativeThreadId: providerThread.nativeThreadRef?.nativeId ?? null,
          }
        : null,
    });
  });
  return createThreadHandoffService({
    changes,
    config,
    environmentId,
    settings,
    query: {
      getThread: (threadId) => getThread(threadId).pipe(Effect.mapError(toHandoffError)),
      getProject: (projectId) => projects.getShell(projectId).pipe(Effect.mapError(toHandoffError)),
    },
    history: {
      read: ({ threadId, throughSequence }) =>
        eventSink.latestSequence({ threadId }).pipe(
          Effect.flatMap((latest) => {
            const through = throughSequence ?? latest;
            return through <= 0
              ? Effect.succeed([])
              : eventSink.stream({ threadId, afterSequence: 0 }).pipe(
                  Stream.takeUntil((stored) => stored.sequence >= through),
                  Stream.filter((stored) => stored.sequence <= through),
                  Stream.runCollect,
                );
          }),
          Effect.map((events): ReadonlyArray<OrchestrationV2StoredEvent> => Array.from(events)),
          Effect.mapError(toHandoffError),
        ),
      importThread: ({ threadId, events, record }) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              if ((yield* projections.getThreadShell(threadId)) !== null)
                return yield* fail(
                  "conflict",
                  "Destination thread already exists; reverse handoff replacement is not supported yet.",
                );
              // Ownership and history commit together: a crash leaves either
              // the reservation or the activated thread, never one without the other.
              yield* journal.acceptIncoming(record);
              yield* eventSink.write({ events });
              const restored = yield* projections.getThreadShell(threadId);
              if (!restored || restored.deletedAt !== null)
                return yield* fail(
                  "verificationFailed",
                  "Handoff history must restore a live thread.",
                );
            }),
          )
          .pipe(Effect.mapError(toHandoffError)),
    },
    instances,
    journal,
    safePoint,
    secretStore,
  });
});

export interface ThreadHandoffServicePorts {
  readonly nativeDriver?: typeof getNativeHandoffDriver;
  readonly changes: PubSub.PubSub<ThreadHandoffRecord>;
  readonly config: Pick<ServerConfig["Service"], "stateDir">;
  readonly environmentId: ThreadHandoffRecord["owner"]["environmentId"];
  readonly settings: Pick<ServerSettingsService["Service"], "getSettings">;
  readonly query: {
    readonly getThread: (
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<HandoffThread>, ThreadHandoffError>;
    readonly getProject: (
      projectId: ProjectId,
    ) => Effect.Effect<Option.Option<OrchestrationProjectShell>, ThreadHandoffError>;
  };
  readonly history: {
    /** The thread's stored events, through `throughSequence` when given. */
    readonly read: (input: {
      readonly threadId: ThreadId;
      readonly throughSequence?: number;
    }) => Effect.Effect<ReadonlyArray<OrchestrationV2StoredEvent>, ThreadHandoffError>;
    /** Accepts destination ownership and writes the remapped history atomically. */
    readonly importThread: (input: {
      readonly threadId: ThreadId;
      readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
      readonly record: ThreadHandoffRecord;
    }) => Effect.Effect<void, ThreadHandoffError>;
  };
  readonly instances: Pick<ProviderInstanceRegistry["Service"], "getInstance">;
  readonly journal: Effect.Success<typeof makeHandoffJournal>;
  readonly safePoint: Pick<
    Effect.Success<typeof makeHandoffSafePoint>,
    "waitForCurrentTurn" | "freeze"
  >;
  readonly secretStore: ServerSecretStore["Service"];
}

/** The RPC orchestration uses narrow ports so restart and rollback exercise the
 * same durable journal and filesystem paths in service integration tests. */
export function createThreadHandoffService(
  ports: ThreadHandoffServicePorts,
): ThreadHandoffService["Service"] {
  const {
    config,
    environmentId,
    settings,
    query,
    history,
    instances,
    journal,
    safePoint,
    secretStore,
  } = ports;
  let locks = serverLocks.get(config.stateDir);
  if (!locks) {
    locks = new Map();
    serverLocks.set(config.stateDir, locks);
  }
  const localLocks = locks;
  const requestedCancellations = new Set<ThreadHandoffId>();
  const waitingTurns = new Map<ThreadHandoffId, Deferred.Deferred<void>>();
  const root = (id: ThreadHandoffId) => NodePath.join(config.stateDir, "handoffs", id);
  const payload = (id: ThreadHandoffId) => NodePath.join(root(id), "payload");
  const metadata = (id: ThreadHandoffId) => NodePath.join(root(id), "request.json");
  const preparedRoot = (id: ThreadHandoffId) =>
    NodePath.join(config.stateDir, "handoff-workspaces", id);
  const read = (id: ThreadHandoffId) =>
    io(async () => decodePending(await NodeFSP.readFile(metadata(id), "utf8")));
  const save = (id: ThreadHandoffId, pending: Pending) =>
    io(async () => {
      await NodeFSP.mkdir(root(id), { recursive: true, mode: 0o700 });
      await NodeFSP.writeFile(`${metadata(id)}.tmp`, encodePending(pending), { mode: 0o600 });
      await NodeFSP.rename(`${metadata(id)}.tmp`, metadata(id));
    });
  const requireRecord = Effect.fn("ThreadHandoff.record")(function* (id: ThreadHandoffId) {
    const record = yield* journal.get(id);
    if (!record || (record.localEnvironmentId ?? record.owner.environmentId) !== environmentId)
      return yield* fail("conflict", "Unknown handoff on this environment.");
    const head = yield* journal.head(record.owner.threadId);
    if (head?.handoffId !== id) return yield* fail("notOwner", "This handoff has been superseded.");
    return record;
  });
  const publish = (record: ThreadHandoffRecord) =>
    PubSub.publish(ports.changes, record).pipe(Effect.as(record));
  const advance = (
    record: ThreadHandoffRecord,
    phase: ThreadHandoffRecord["phase"],
    failure?: string,
  ) =>
    DateTime.now.pipe(
      Effect.flatMap((now) =>
        journal
          .advance({
            handoffId: record.handoffId,
            expectedRevision: record.revision,
            phase,
            updatedAt: DateTime.formatIso(now),
            ...(failure ? { failure } : {}),
          })
          .pipe(Effect.flatMap(publish)),
      ),
    );
  const freshProvider = Effect.fn("ThreadHandoff.provider")(function* (
    instanceId: ProviderInstanceId,
    native = true,
  ) {
    const instance = yield* instances.getInstance(instanceId);
    if (!instance || !instance.enabled)
      return yield* fail("unsupported", "Destination provider is missing or disabled.");
    const status = yield* instance.snapshot.refresh;
    if (
      !status.installed ||
      status.availability === "unavailable" ||
      status.status === "error" ||
      status.status === "disabled"
    )
      return yield* fail("unsupported", "Install the provider on this environment first.");
    if (
      status.auth.status === "unauthenticated" ||
      (status.auth.status !== "authenticated" && (native || status.status !== "ready"))
    )
      return yield* fail("incompatible", "Authenticate the provider on this environment first.");
    if (native && !status.version)
      return yield* fail("incompatible", "Provider version could not be verified.");
    return { instance, status, version: status.version ?? "unknown" };
  });
  const driverFor = Effect.fn("ThreadHandoff.driver")(function* (
    source: ThreadHandoffSource,
    sourceInstance = false,
  ) {
    const saved = (yield* settings.getSettings).providerInstances[source.providerInstanceId];
    const configuredHome =
      saved?.config &&
      typeof saved.config === "object" &&
      "homePath" in saved.config &&
      typeof saved.config.homePath === "string"
        ? saved.config.homePath
        : undefined;
    const home =
      saved?.environment?.find((entry) => entry.name === "CLAUDE_CONFIG_DIR")?.value ||
      configuredHome;
    const driver = (ports.nativeDriver ?? getNativeHandoffDriver)({
      driver: source.driver,
      threadId: source.owner.threadId,
      stateDir: config.stateDir,
      ...(sourceInstance && home ? { sourceHomePath: home } : {}),
    });
    if (!driver)
      return yield* fail(
        "unsupported",
        "Native session handoff is not supported by this provider.",
      );
    return driver;
  });
  const inspect = Effect.fn("ThreadHandoff.inspect")(function* (
    threadId: ThreadId,
    projectIds: readonly ProjectId[] = [],
  ) {
    const thread = Option.getOrUndefined(yield* query.getThread(threadId));
    if (!thread) return yield* fail("unsupported", "This thread no longer exists.");
    const head = yield* journal.head(threadId);
    const owner = head ? committedOwner(head) : { threadId, environmentId, generation: 0 };
    if (owner.environmentId !== environmentId)
      return yield* fail("notOwner", `Thread belongs to ${owner.environmentId}.`);
    // The provider thread carrying the conversation owns its native session.
    const providerInstanceId =
      thread.providerThread?.providerInstanceId ?? thread.providerInstanceId;
    const instance = yield* instances.getInstance(providerInstanceId);
    const saved = (yield* settings.getSettings).providerInstances[providerInstanceId];
    const provider = thread.providerThread?.driver ?? instance?.driverKind ?? saved?.driver;
    if (!provider) return yield* fail("unsupported", "Source provider identity is unavailable.");
    const status = instance
      ? yield* instance.snapshot.refresh.pipe(Effect.orElseSucceed(() => undefined))
      : undefined;
    const driver = (ports.nativeDriver ?? getNativeHandoffDriver)({
      driver: provider,
      stateDir: config.stateDir,
      threadId,
    });
    const nativeThreadId = thread.providerThread?.nativeThreadId;
    const sessionId =
      driver && nativeThreadId
        ? yield* Effect.try({
            try: () => driver.sessionIdFromCursor({ resume: nativeThreadId }),
            catch: normalize,
          }).pipe(Effect.catch(() => Effect.succeed(undefined)))
        : undefined;
    const repositories: NonNullable<ThreadHandoffSource["repositories"]>[number][] = [];
    for (const projectId of new Set([thread.projectId, ...projectIds])) {
      const project = Option.getOrUndefined(yield* query.getProject(projectId));
      if (!project) return yield* fail("incompatible", "Source project no longer exists.");
      const cwd =
        projectId === thread.projectId
          ? (thread.worktreePath ?? project.workspaceRoot)
          : project.workspaceRoot;
      repositories.push(yield* io(() => inspectHandoffRepository(cwd, projectId)));
    }
    return {
      repositories,
      owner,
      projectId: thread.projectId,
      providerInstanceId,
      driver: provider,
      version: status?.version ?? "unknown",
      supportsNativeHandoff: !!driver && !!sessionId,
      sessionId,
    } satisfies ThreadHandoffSource;
  });
  const preflight = Effect.fn("ThreadHandoff.preflight")(function* (
    destination: ThreadHandoffDestination,
  ) {
    if (
      destination.environmentId !== environmentId ||
      destination.source.owner.environmentId === environmentId
    )
      return yield* fail("incompatible", "Choose a different execution environment.");
    if (
      !destination.projects.some(
        (project) => project.sourceProjectId === destination.source.projectId,
      ) ||
      new Set(destination.projects.map((p) => p.sourceProjectId)).size !==
        destination.projects.length
    )
      return yield* fail("incompatible", "Map each source repository to a destination project.");
    const existing = Option.getOrUndefined(
      yield* query.getThread(destination.source.owner.threadId),
    );
    if (existing)
      return yield* fail(
        "conflict",
        "Destination already contains this thread. Replacing a previous execution copy is not supported yet.",
      );
    const native = destination.transferMode !== "context";
    const verified = yield* freshProvider(destination.providerInstanceId, native);
    let warnings: readonly string[] = [];
    if (native) {
      if (!destination.source.sessionId)
        return yield* fail(
          "unsupported",
          "Source has no native session; choose conversation context transfer.",
        );
      const driver = yield* driverFor(destination.source);
      const compatibility = driver.preflight(
        {
          driver: destination.source.driver,
          version: destination.source.version,
          authenticated: true,
          cwd: "source",
        },
        {
          driver: verified.status.driver,
          version: verified.version,
          authenticated: true,
          cwd: "destination",
        },
      );
      if (compatibility.mode !== "native")
        return yield* fail(
          "incompatible",
          compatibility.reason ?? "Provider native sessions are incompatible.",
        );
      warnings = compatibility.warnings;
    } else {
      if (
        !destination.modelSelection ||
        destination.modelSelection.instanceId !== destination.providerInstanceId ||
        !verified.status.models.some((model) => model.slug === destination.modelSelection?.model)
      )
        return yield* fail(
          "incompatible",
          "Choose an available model from the destination provider.",
        );
      warnings = [
        "Conversation context transfer creates a new provider session. Native tool and compaction state are not migrated.",
      ];
    }
    const projects: ThreadHandoffDestination["projects"][number][] = [];
    for (const mapping of destination.projects) {
      const project = Option.getOrUndefined(yield* query.getProject(mapping.destinationProjectId));
      if (!project) return yield* fail("incompatible", "A destination project is missing.");
      const facts = destination.source.repositories?.find(
        (repository) => repository.projectId === mapping.sourceProjectId,
      );
      if (!facts)
        return yield* fail(
          "incompatible",
          "Inspect source repository identity before transferring.",
        );
      const available = yield* io(() => verifyHandoffRepository(project.workspaceRoot, facts));
      projects.push({
        sourceProjectId: mapping.sourceProjectId,
        destinationProjectId: mapping.destinationProjectId,
        ...available,
      });
    }
    return { destination: { ...destination, projects }, warnings };
  });
  const destinationPaths = Effect.fn("ThreadHandoff.paths")(function* (
    id: ThreadHandoffId,
    pending: Pending,
  ) {
    if (!pending.manifest) return yield* fail("conflict", "Handoff snapshot is not ready.");
    const destinations = [];
    for (const [index, project] of pending.manifest.projects.entries()) {
      const mapping = pending.destination.projects.find(
        (item) => item.sourceProjectId === project.projectId,
      );
      if (!mapping) return yield* fail("incompatible", "Missing destination repository mapping.");
      const target = Option.getOrUndefined(yield* query.getProject(mapping.destinationProjectId));
      if (!target) return yield* fail("incompatible", "Destination project no longer exists.");
      destinations.push({
        projectId: project.projectId,
        destinationProjectId: mapping.destinationProjectId,
        destinationDirectory: NodePath.join(preparedRoot(id), String(index)),
        existingRepository: target.workspaceRoot,
      });
    }
    return destinations;
  });
  const cleanupPrepared = Effect.fn("ThreadHandoff.cleanupPrepared")(function* (
    id: ThreadHandoffId,
    pending: Pending,
  ) {
    const owned = yield* io(async () => {
      try {
        return (
          (await NodeFSP.readFile(NodePath.join(preparedRoot(id), ".handoff-owner"), "utf8")) === id
        );
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
        throw error;
      }
    });
    if (!owned) return;
    // No provider runs a prepared thread: its first session opens after activation.
    if (pending.manifest) {
      const paths = yield* destinationPaths(id, pending);
      for (const [index, destination] of paths.entries()) {
        yield* io(() =>
          cleanupProjectSyncGitSnapshot({
            ...destination,
            sourceWasWorktree: pending.manifest!.projects[index]!.git.sourceWasWorktree,
          }),
        );
      }
    }
    // Native installation cleanup is provider-owned; prepared stores are never
    // removed after commit or while their native process is running. A
    // conversation transfer installs nothing outside the prepared checkout.
    if (pending.destination.transferMode !== "context") {
      const driver = yield* driverFor(pending.destination.source);
      const sessionId = pending.destination.source.sessionId;
      if (!sessionId) return yield* fail("verificationFailed", "Native session ID is missing.");
      yield* io(() => driver.remove({ sessionId }));
    }
    yield* io(() => NodeFSP.rm(preparedRoot(id), { recursive: true, force: true }));
  });

  const execute = Effect.fn("ThreadHandoff.execute")(function* (request: ThreadHandoffRequest) {
    switch (request.operation) {
      case "inspect":
        return { source: yield* inspect(request.threadId, request.projectIds) };
      case "preflight":
        return yield* preflight(request.destination);
      case "beginRollback": {
        let record = yield* journal.get(request.handoffId);
        if (!record) {
          const head = yield* journal.head(request.threadId);
          const owner = head
            ? committedOwner(head)
            : { threadId: request.threadId, environmentId, generation: 0 };
          if (owner.environmentId !== environmentId)
            return yield* fail("notOwner", "Only the execution source can cancel a handoff.");
          const now = DateTime.formatIso(yield* DateTime.now);
          record = yield* journal.begin({
            handoffId: request.handoffId,
            owner,
            localEnvironmentId: environmentId,
            destinationEnvironmentId: request.destinationEnvironmentId,
            phase: "preflighting",
            revision: 0,
            createdAt: now,
            updatedAt: now,
            failure: null,
          });
          yield* publish(record);
        }
        record = yield* requireRecord(record.handoffId);
        if (
          record.owner.environmentId !== environmentId ||
          record.owner.threadId !== request.threadId ||
          record.destinationEnvironmentId !== request.destinationEnvironmentId
        )
          return yield* fail("conflict", "Cancellation does not match this source handoff.");
        if (
          !["committed", "completed", "rollingBack", "failed", "cancelled"].includes(record.phase)
        )
          record = yield* advance(
            record,
            "rollingBack",
            "Transfer cancelled or destination preparation failed.",
          );
        return { record };
      }
      case "prepareSource": {
        const source = yield* inspect(
          request.destination.source.owner.threadId,
          request.destination.projects.map((mapping) => mapping.sourceProjectId),
        );
        if (
          source.owner.environmentId !== request.destination.source.owner.environmentId ||
          source.providerInstanceId !== request.destination.source.providerInstanceId ||
          source.projectId !== request.destination.source.projectId ||
          source.driver !== request.destination.source.driver ||
          source.owner.generation !== request.destination.source.owner.generation ||
          source.sessionId !== request.destination.source.sessionId ||
          source.version !== request.destination.source.version
        )
          return yield* fail(
            "conflict",
            "Source session changed after preflight; inspect it again.",
          );
        if (
          request.destination.environmentId === environmentId ||
          !request.destination.projects.some(
            (mapping) => mapping.sourceProjectId === source.projectId,
          ) ||
          new Set(request.destination.projects.map((mapping) => mapping.sourceProjectId)).size !==
            request.destination.projects.length
        )
          return yield* fail(
            "incompatible",
            "Choose a different environment and map each source repository exactly once.",
          );
        for (const mapping of request.destination.projects) {
          const project = Option.getOrUndefined(yield* query.getProject(mapping.sourceProjectId));
          if (!project) return yield* fail("incompatible", "Source project no longer exists.");
          const facts = request.destination.source.repositories?.find(
            (repository) => repository.projectId === mapping.sourceProjectId,
          );
          if (!facts)
            return yield* fail(
              "incompatible",
              "Inspect each source repository before transferring.",
            );
          const thread =
            mapping.sourceProjectId === source.projectId
              ? Option.getOrUndefined(yield* query.getThread(source.owner.threadId))
              : undefined;
          yield* io(() =>
            verifyHandoffRepository(thread?.worktreePath ?? project.workspaceRoot, facts),
          );
        }
        if (request.destination.transferMode !== "context") {
          const sourceDriver = yield* driverFor(source, true);
          if (!source.sessionId)
            return yield* fail("unsupported", "Source has no native session to transfer.");
          const sessionId = source.sessionId;
          yield* freshProvider(source.providerInstanceId);
          yield* io(() => sourceDriver.preflightSource({ sessionId }));
        }
        const recorded = yield* history.read({ threadId: source.owner.threadId });
        if (recorded.some(carriesAttachments))
          return yield* fail(
            "unsupported",
            "Threads with attachments cannot be transferred yet. Source remains available.",
          );
        const now = DateTime.formatIso(yield* DateTime.now);
        let record = yield* journal.begin({
          handoffId: request.handoffId,
          owner: source.owner,
          localEnvironmentId: environmentId,
          destinationEnvironmentId: request.destination.environmentId,
          phase: "preflighting",
          revision: 0,
          createdAt: now,
          updatedAt: now,
          failure: null,
        });
        yield* publish(record);
        if (record.phase !== "preflighting") {
          const pending = yield* read(record.handoffId);
          if (pending.manifest && record.phase === "syncingProjects")
            return { record, manifest: pending.manifest };
          return yield* fail(
            "recoveryRequired",
            "Recover the existing handoff before retrying source preparation.",
          );
        }
        yield* save(record.handoffId, {
          destination: request.destination,
          ready: false,
          nativeInstalled: false,
        });
        if (request.mode === "afterTurn") {
          const cancellation = yield* Deferred.make<void>();
          waitingTurns.set(record.handoffId, cancellation);
          if (requestedCancellations.has(record.handoffId))
            yield* Deferred.succeed(cancellation, undefined);
          yield* Effect.raceFirst(
            safePoint
              .waitForCurrentTurn({ threadId: source.owner.threadId })
              .pipe(Effect.interruptible),
            Deferred.await(cancellation).pipe(
              Effect.flatMap(() =>
                fail("conflict", "Transfer cancelled while waiting for the current turn."),
              ),
            ),
          ).pipe(Effect.ensuring(Effect.sync(() => waitingTurns.delete(record.handoffId))));
        }
        record = yield* advance(record, "pausing");
        const settled = yield* measure(
          "pauseAndDrain",
          record.handoffId,
          safePoint.freeze({
            threadId: source.owner.threadId,
            mode: request.mode === "interrupt" ? "interrupt" : "idle",
          }),
        );
        record = yield* advance(record, "checkpointing");
        const events = yield* history.read({
          threadId: source.owner.threadId,
          throughSequence: settled.sequence,
        });
        if (events.some(carriesAttachments))
          return yield* fail(
            "unsupported",
            "Attachments were added while waiting. Cancel this transfer to keep the complete thread on its source.",
          );
        const projects: Array<import("./ThreadHandoffSnapshot.ts").HandoffProjectSource> = [];
        for (const mapping of request.destination.projects) {
          const project = Option.getOrUndefined(yield* query.getProject(mapping.sourceProjectId));
          if (!project) return yield* fail("conflict", "Source project no longer exists.");
          const cwd =
            mapping.sourceProjectId === settled.thread.projectId
              ? (settled.thread.worktreePath ?? project.workspaceRoot)
              : project.workspaceRoot;
          const checkpointRefs =
            mapping.sourceProjectId === settled.thread.projectId
              ? (yield* io(() =>
                  runSnapshotGit(cwd, [
                    "for-each-ref",
                    "--format=%(refname)",
                    `refs/t3/checkpoints/${Buffer.from(source.owner.threadId).toString("base64url")}/`,
                  ]),
                ))
                  .toString()
                  .trim()
                  .split("\n")
                  .filter(Boolean)
              : [];
          projects.push({
            projectId: mapping.sourceProjectId,
            cwd,
            checkpointRefs,
            ...(mapping.availableHead ? { destinationHasHead: mapping.availableHead } : {}),
          });
        }
        const driver =
          request.destination.transferMode === "context"
            ? undefined
            : yield* driverFor(source, true);
        const captured = yield* measure(
          "snapshotGitAndNativeSession",
          record.handoffId,
          io(() =>
            captureThreadHandoffSnapshot({
              record,
              projects,
              events,
              ...(driver ? { driver } : {}),
              transferMode: request.destination.transferMode ?? "native",
              sourceDriver: source.driver,
              ...(source.sessionId ? { sessionId: source.sessionId } : {}),
              providerCwd: projects.find((p) => p.projectId === source.projectId)!.cwd,
              outputDirectory: payload(record.handoffId),
            }),
          ),
        );
        const manifest = {
          ...captured,
          provider: {
            ...captured.provider,
            // The destination resumes this native session by its identity.
            ...(request.destination.transferMode !== "context" && source.sessionId
              ? { resumeCursor: { resume: source.sessionId } }
              : {}),
            version: source.version,
          },
        };
        yield* save(record.handoffId, {
          destination: request.destination,
          manifest,
          ready: false,
          nativeInstalled: false,
        });
        record = yield* advance(record, "syncingProjects");
        return {
          record,
          manifest,
          warnings: [
            "Terminals, dev servers, containers, local MCP services and installed dependencies are not migrated.",
            "Interrupted turns remain idle; no synthetic continuation message is sent.",
          ],
        };
      }
      case "prepareDestination": {
        const id = request.manifest.handoffId;
        const existing = yield* journal.get(id);
        if (!existing) yield* preflight(request.destination);
        if (
          request.manifest.destinationEnvironmentId !== environmentId ||
          request.manifest.owner.threadId !== request.destination.source.owner.threadId ||
          request.manifest.owner.generation !== request.destination.source.owner.generation ||
          request.manifest.owner.environmentId !== request.destination.source.owner.environmentId ||
          request.manifest.provider.driver !== request.destination.source.driver ||
          request.manifest.provider.mode !== (request.destination.transferMode ?? "native") ||
          (request.manifest.provider.mode === "native" &&
            request.manifest.provider.sessionId !== request.destination.source.sessionId)
        )
          return yield* fail(
            "verificationFailed",
            "Destination manifest identity does not match preflight.",
          );
        const now = DateTime.formatIso(yield* DateTime.now);
        const record = yield* journal.reserveIncoming({
          handoffId: id,
          owner: request.manifest.owner,
          destinationEnvironmentId: environmentId,
          localEnvironmentId: environmentId,
          phase: "preflighting",
          revision: 0,
          createdAt: now,
          updatedAt: now,
          failure: null,
        });
        yield* publish(record);
        if (existing) {
          const pending = yield* read(id);
          if (
            encodeDestination(pending.destination) !== encodeDestination(request.destination) ||
            !pending.manifest ||
            manifestHash(pending.manifest) !== manifestHash(request.manifest)
          )
            return yield* fail(
              "conflict",
              "This destination reservation belongs to another snapshot.",
            );
          return { record };
        }
        yield* save(id, {
          destination: request.destination,
          manifest: request.manifest,
          ready: false,
          nativeInstalled: false,
        });
        yield* io(() => NodeFSP.mkdir(payload(id), { recursive: true, mode: 0o700 }));
        return { record };
      }
      case "activate": {
        const record = yield* requireRecord(request.record.handoffId);
        if (
          (request.record.phase !== "committed" && request.record.phase !== "completed") ||
          request.record.owner.environmentId !== record.owner.environmentId ||
          request.record.owner.threadId !== record.owner.threadId ||
          request.record.owner.generation !== record.owner.generation ||
          request.record.destinationEnvironmentId !== environmentId
        )
          return yield* fail(
            "notOwner",
            "Activation does not match the reserved ownership generation.",
          );
        const pending = yield* read(record.handoffId);
        const contextMode = pending.destination.transferMode === "context";
        if (!pending.ready || !pending.manifest)
          return yield* fail("conflict", "Destination has not verified this handoff.");
        if (record.phase === "committed" || record.phase === "completed") {
          const thread = Option.getOrUndefined(yield* query.getThread(record.owner.threadId));
          if (
            !thread ||
            thread.providerInstanceId !== pending.destination.providerInstanceId ||
            !thread.worktreePath
          )
            return yield* fail(
              "recoveryRequired",
              "Activated ownership is missing its thread or provider instance.",
            );
          const completed =
            record.phase === "committed" ? yield* advance(record, "completed") : record;
          yield* io(() => NodeFSP.rm(payload(record.handoffId), { recursive: true, force: true }));
          return { record: completed };
        }
        const paths = yield* destinationPaths(record.handoffId, pending);
        const main = paths.find((path) => path.projectId === pending.destination.source.projectId)!;
        const events = yield* io(() =>
          verifyThreadHandoffSnapshot({
            manifest: pending.manifest!,
            directory: payload(record.handoffId),
          }),
        );
        if (contextMode) yield* freshProvider(pending.destination.providerInstanceId, false);
        const mapped = yield* Effect.try({
          try: () =>
            remapThreadHandoffEvents({
              handoffId: record.handoffId,
              threadId: record.owner.threadId,
              projectId: main.destinationProjectId,
              worktreePath: main.destinationDirectory,
              mode: contextMode ? "context" : "native",
              sourceProviderInstanceId: pending.destination.source.providerInstanceId,
              providerInstanceId: pending.destination.providerInstanceId,
              events,
              ...(pending.destination.modelSelection
                ? { modelSelection: pending.destination.modelSelection }
                : {}),
            }),
          catch: normalize,
        });
        // A native transfer resumes the transferred session on the next turn; a
        // conversation transfer becomes a provider switch, so the orchestrator
        // hands the conversation to a new session of the destination provider.
        yield* history
          .importThread({
            threadId: record.owner.threadId,
            events: mapped,
            record: { ...request.record, localEnvironmentId: environmentId },
          })
          .pipe((effect) => measure("importThreadHistory", record.handoffId, effect));
        const activated = yield* requireRecord(record.handoffId);
        const completed =
          activated.phase === "committed" ? yield* advance(activated, "completed") : activated;
        yield* publish(completed);
        yield* io(() => NodeFSP.rm(payload(record.handoffId), { recursive: true, force: true }));
        return { record: completed };
      }
      case "commit": {
        let record = yield* requireRecord(request.receipt.handoffId);
        if (record.owner.environmentId !== environmentId)
          return yield* fail("notOwner", "Only the source commits ownership.");
        const pending = yield* read(record.handoffId);
        if (
          !pending.manifest ||
          request.receipt.environmentId !== record.destinationEnvironmentId ||
          request.receipt.sessionId !== pending.manifest!.provider.sessionId ||
          request.receipt.manifestHash !== manifestHash(pending.manifest)
        )
          return yield* fail(
            "verificationFailed",
            "Destination readiness receipt does not match this snapshot.",
          );
        if (record.phase === "committed" || record.phase === "completed") return { record };
        if (record.phase !== "syncingProjects")
          return yield* fail("conflict", "Handoff cannot commit from its current phase.");
        for (const phase of ["transferringSession", "verifying", "ready", "committed"] as const)
          record = yield* advance(record, phase);
        return { record };
      }
      default:
        break;
    }
    const id = request.handoffId;
    if (request.operation === "reject" && !(yield* journal.get(id))) return {};
    let record = yield* requireRecord(id);
    if (request.operation === "status") return { record };
    if (request.operation === "rollback") {
      if (
        record.owner.environmentId !== environmentId ||
        record.phase === "committed" ||
        record.phase === "completed"
      )
        return yield* fail("conflict", "Committed ownership must recover on the destination.");
      if (record.phase !== "failed" && record.phase !== "cancelled") {
        if (record.phase !== "rollingBack")
          record = yield* advance(
            record,
            "rollingBack",
            "Transfer cancelled or destination preparation failed.",
          );
        yield* io(() => NodeFSP.rm(payload(id), { recursive: true, force: true }));
        record = yield* advance(record, "failed");
      }
      return { record };
    }
    const pending = yield* read(id);
    if (request.operation === "manifest")
      return {
        record,
        files: yield* buildProjectSyncManifest({ workspaceRoot: payload(id), includeGit: false }),
      };
    if (request.operation === "export") {
      if (record.owner.environmentId !== environmentId || record.phase !== "syncingProjects")
        return yield* fail("conflict", "Source snapshot is not available for export.");
      const allowed = new Map(pending.manifest?.files.map((file) => [file.path, file]));
      if (request.entries.some((entry) => allowed.get(entry.path)?.size !== entry.size))
        return yield* fail(
          "verificationFailed",
          "Export requests files outside the handoff snapshot.",
        );
      return yield* issueProjectSyncExportUrl({
        projectId: id,
        workspaceRoot: payload(id),
        entries: request.entries,
      }).pipe(Effect.provideService(ServerSecretStore, secretStore));
    }
    if (request.operation === "import") {
      if (
        record.destinationEnvironmentId !== environmentId ||
        record.phase !== "preflighting" ||
        pending.ready
      )
        return yield* fail("conflict", "Destination is not accepting files.");
      return yield* issueProjectSyncImportUrl({
        projectId: id,
        workspaceRoot: payload(id),
        fileCount: request.fileCount,
        totalBytes: request.totalBytes,
      }).pipe(Effect.provideService(ServerSecretStore, secretStore));
    }
    if (request.operation === "verify") {
      if (record.destinationEnvironmentId !== environmentId || !pending.manifest)
        return yield* fail("conflict", "Only a prepared destination can verify.");
      if (record.phase !== "preflighting")
        return yield* fail("conflict", "Destination reservation is no longer pending.");
      if (!pending.ready) {
        const events = yield* io(() =>
          verifyThreadHandoffSnapshot({ manifest: pending.manifest!, directory: payload(id) }),
        );
        const paths = yield* destinationPaths(id, pending);
        yield* cleanupPrepared(id, pending);
        yield* io(async () => {
          await NodeFSP.mkdir(NodePath.dirname(preparedRoot(id)), { recursive: true, mode: 0o700 });
          await NodeFSP.mkdir(preparedRoot(id), { recursive: false, mode: 0o700 });
          await NodeFSP.writeFile(NodePath.join(preparedRoot(id), ".handoff-owner"), id, {
            flag: "wx",
            mode: 0o600,
          });
        });
        yield* measure(
          "restoreGitProjects",
          id,
          io(() =>
            restoreThreadHandoffProjects({
              manifest: pending.manifest!,
              directory: payload(id),
              destinations: paths,
            }),
          ),
        );
        const contextMode = pending.destination.transferMode === "context";
        const driver = contextMode ? undefined : yield* driverFor(pending.destination.source);
        let prepared = pending;
        if (driver) {
          const sessionId = pending.manifest!.provider.sessionId;
          if (!sessionId || !pending.manifest!.provider.resumeCursor)
            return yield* fail(
              "verificationFailed",
              "Native session identity is missing from the snapshot.",
            );
          yield* measure(
            "verifyNativeSession",
            id,
            io(() =>
              driver.verify({ sessionId, directory: NodePath.join(payload(id), "provider") }),
            ),
          );
          yield* measure(
            "installNativeSession",
            id,
            io(() =>
              driver.install({ sessionId, directory: NodePath.join(payload(id), "provider") }),
            ),
          );
          prepared = { ...pending, nativeInstalled: true };
          yield* save(id, prepared);
          // The adapter resumes exactly the store registered for this thread and session.
          if (!(yield* io(() => driver.resumable({ sessionId }))))
            return yield* fail(
              "verificationFailed",
              "Provider cannot resume the transferred native session.",
            );
        }
        const configuration = yield* Effect.try({
          try: () => latestConfiguration(events),
          catch: normalize,
        });
        const verified = yield* freshProvider(pending.destination.providerInstanceId, !contextMode);
        const modelSelection = contextMode
          ? pending.destination.modelSelection
          : { ...configuration.modelSelection, instanceId: pending.destination.providerInstanceId };
        if (!modelSelection)
          return yield* fail("verificationFailed", "Destination model is missing.");
        if (
          contextMode &&
          (modelSelection.instanceId !== pending.destination.providerInstanceId ||
            !verified.status.models.some((model) => model.slug === modelSelection.model))
        )
          return yield* fail("incompatible", "Selected destination model is no longer available.");
        yield* save(id, { ...prepared, ready: true });
      }
      return {
        record,
        ready: {
          handoffId: id,
          environmentId,
          ...(pending.manifest.provider.mode === "native"
            ? { sessionId: pending.manifest!.provider.sessionId }
            : {}),
          manifestHash: manifestHash(pending.manifest),
        },
      };
    }
    if (request.operation === "reject") {
      if (record.phase === "cancelled" || record.phase === "failed") return { record };
      if (
        record.destinationEnvironmentId !== environmentId ||
        record.phase === "committed" ||
        record.phase === "completed"
      )
        return yield* fail("conflict", "Committed ownership cannot be cancelled.");
      yield* cleanupPrepared(id, pending);
      record = yield* journal.rejectIncoming(id).pipe(Effect.flatMap(publish));
      yield* io(() => NodeFSP.rm(payload(id), { recursive: true, force: true }));
      return { record };
    }
    if (request.operation === "complete") {
      if (record.owner.environmentId !== environmentId)
        return yield* fail("notOwner", "Only the departed source completes this handoff.");
      if (record.phase === "committed") record = yield* advance(record, "completed");
      if (record.phase !== "completed")
        return yield* fail("conflict", "Ownership has not committed.");
      yield* io(() => NodeFSP.rm(payload(id), { recursive: true, force: true }));
      return { record };
    }
    return yield* fail("unsupported", "Unknown handoff operation.");
  });
  const handle = (request: ThreadHandoffRequest) => {
    const id =
      "handoffId" in request
        ? request.handoffId
        : request.operation === "activate"
          ? request.record.handoffId
          : request.operation === "commit"
            ? request.receipt.handoffId
            : request.operation === "prepareDestination"
              ? request.manifest.handoffId
              : undefined;
    let operation = measure(request.operation, id, execute(request)).pipe(
      Effect.mapError(normalize),
    );
    if (id) {
      let lock = localLocks.get(id);
      if (!lock) {
        lock = Semaphore.makeUnsafe(1);
        localLocks.set(id, lock);
      }
      operation = lock.withPermits(1)(operation);
    }
    operation = operation.pipe(Effect.uninterruptible);
    if (request.operation === "rollback" || request.operation === "beginRollback") {
      requestedCancellations.add(request.handoffId);
      const cancellation = waitingTurns.get(request.handoffId);
      if (cancellation)
        return Deferred.succeed(cancellation, undefined).pipe(Effect.andThen(operation));
    }
    return operation;
  };
  const watch = (threadId: ThreadId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(ports.changes);
        const initial = yield* journal.head(threadId).pipe(Effect.mapError(normalize));
        return Stream.concat(
          Stream.succeed(initial),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((record) => record.owner.threadId === threadId),
          ),
        );
      }),
    );
  return { handle, watch };
}
/** Requires the running orchestrator and provider sessions; the event sink and
 * stores are the same memoized instances the orchestration runtime uses. */
export const layer = Layer.effect(ThreadHandoffService, make).pipe(
  Layer.provide(
    Layer.mergeAll(OrchestrationV2EventSinkLayerLive, ProjectionStore.layer, ProjectStore.layer),
  ),
);
