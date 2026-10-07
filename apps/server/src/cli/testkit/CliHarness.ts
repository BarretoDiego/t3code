/**
 * Runs the real CLI command handlers against a real in-process orchestrator.
 *
 * The one thing replaced is the socket: `CliRpcClientOverride` hands the
 * handlers an RPC client whose methods call the same services the WebSocket
 * route calls (command intake, thread launch, projections, the automation RPC
 * handlers), on real SQLite and the deterministic test clock. Provider
 * execution is off (no effect worker), so tests state provider facts by
 * writing the events a provider would produce through the event sink.
 *
 * Not exercised: the WebSocket route's own glue in ws.ts (scope checks, its
 * shell stream assembly), the socket transport, and authentication.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AUTOMATION_WS_METHODS,
  AutomationError,
  type AutomationJournalEntry,
  AuthStandardClientScopes,
  EnvironmentId,
  EventId,
  NodeId,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2DispatchCommandError,
  type OrchestrationProjectShell,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2UserInputQuestion,
  type PeerMessage,
  PeerMessageId,
  type ProviderApprovalOption,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  type ProviderRequestKind,
  RuntimeRequestId,
  type ThreadId,
  TurnItemId,
  MessageId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import type * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/unstable/cli";
import type { MigrationError } from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import * as AutomationDiagnosticsService from "../../automation/AutomationDiagnosticsService.ts";
import { type AutomationCaller, automationError } from "../../automation/Caller.ts";
import * as DelegatedTaskService from "../../automation/DelegatedTaskService.ts";
import * as EventJournal from "../../automation/EventJournal.ts";
import * as HookService from "../../automation/HookService.ts";
import * as JobService from "../../automation/JobService.ts";
import * as OrchestratorService from "../../automation/OrchestratorService.ts";
import * as PeerService from "../../automation/PeerService.ts";
import * as ResponsibilityService from "../../automation/ResponsibilityService.ts";
import { makeAutomationRpcHandlers } from "../../automation/rpcHandlers.ts";
import * as SnoozeExpiry from "../../automation/tasks/SnoozeExpiry.ts";
import * as TaskEngine from "../../automation/tasks/TaskEngine.ts";
import * as TaskReactor from "../../automation/tasks/TaskReactor.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as GitWorkflow from "../../git/GitWorkflowService.ts";
import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../../orchestration-v2/CommandReceiptStore.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as IdAllocator from "../../orchestration-v2/IdAllocator.ts";
import type { ProviderAdapterV2Shape } from "../../orchestration-v2/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import {
  buildActiveShellSnapshot,
  shellStreamItemFromThreadShell,
} from "../../orchestration-v2/ShellStream.ts";
import {
  makeOrchestratorV2ReplayLayerWithRegistry,
  makeReplayServerConfig,
} from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadMessageIntake from "../../orchestration-v2/ThreadMessageIntake.ts";
import { userFacingDispatchErrorMessage } from "../../orchestration-v2/UserFacingErrors.ts";
import { projectThreadProjectionForWire } from "../../orchestration-v2/WireProjection.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as ProjectCloneTracker from "../../project/ProjectCloneTracker.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import * as WorktreeSetupTracker from "../../project/WorktreeSetupTracker.ts";
import { makeProviderRegistryLayer } from "../../provider/testUtils/providerRegistryMock.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import { CliFailure, CliRpcClientOverride } from "../common.ts";
import type { EnvironmentRpcClient } from "../environmentRpc.ts";

export const HARNESS_PROJECT_ID = ProjectId.make("project:cli-harness");
export const HARNESS_ENVIRONMENT_ID = EnvironmentId.make("env-local");
export const HARNESS_MODEL = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
} as const;
/** `--model` value that selects the harness model. */
export const HARNESS_MODEL_FLAG = `${HARNESS_MODEL.instanceId}/${HARNESS_MODEL.model}`;

const parseJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const formatJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const CREATED_AT = "2026-06-20T00:00:00.000Z";
const project = {
  id: HARNESS_PROJECT_ID,
  title: "Harness",
  workspaceRoot: "/repo",
  repositoryIdentity: null,
  faviconPath: null,
  defaultModelSelection: HARNESS_MODEL,
  defaultThreadEnvMode: null,
  scripts: [],
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
  deletedAt: null,
} as const;
const projectShell: OrchestrationProjectShell = {
  id: project.id,
  title: project.title,
  workspaceRoot: project.workspaceRoot,
  repositoryIdentity: null,
  defaultModelSelection: HARNESS_MODEL,
  scripts: [],
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
};

const adapter = {
  instanceId: HARNESS_MODEL.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in the CLI harness"),
} as ProviderAdapterV2Shape;

// ---------------------------------------------------------------------------
// Recording doubles for what other parts of the automation layer own

/**
 * A journal that records appends in the test database, so an append rolled
 * back with its transaction leaves no entry, exactly as the real journal would.
 */
export class RecordedJournal extends Context.Service<
  RecordedJournal,
  {
    readonly entries: Effect.Effect<ReadonlyArray<AutomationJournalEntry>>;
    /** Resolves with the next recorded entry of `type`, waiting for it if needed. */
    readonly next: (type: string) => Effect.Effect<AutomationJournalEntry>;
  }
>()("t3/cli/testkit/CliHarness/RecordedJournal") {}

const recordedJournalLayer = Layer.effectContext(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE IF NOT EXISTS test_recorded_journal (
      cursor INTEGER PRIMARY KEY AUTOINCREMENT,
      dedup_key TEXT UNIQUE,
      entry_json TEXT NOT NULL
    )`.pipe(Effect.orDie);
    const appended = yield* Queue.unbounded<AutomationJournalEntry>();
    const live = yield* PubSub.unbounded<AutomationJournalEntry>();
    const unsupported = () =>
      Effect.fail(automationError("CAPABILITY_UNSUPPORTED", "test journal"));
    const failure = (cause: unknown) => automationError("INTERNAL", String(cause));
    const read = sql<{ readonly cursor: number; readonly entry_json: string }>`
      SELECT cursor, entry_json FROM test_recorded_journal ORDER BY cursor ASC
    `.pipe(
      Effect.map((rows) =>
        rows.map((row): AutomationJournalEntry => ({
          cursor: row.cursor,
          event: parseJson(row.entry_json) as AutomationJournalEntry["event"],
        })),
      ),
    );
    const append: EventJournal.EventJournal["Service"]["append"] = (events) =>
      Effect.forEach(events, (event) =>
        Effect.gen(function* () {
          const now = DateTime.formatIso(yield* DateTime.now);
          const body = {
            version: 1,
            eventId: EventId.make(`journal:${event.dedupKey ?? `${event.type}:${now}`}`),
            type: event.type,
            origin: { ...event.origin, environmentId: HARNESS_ENVIRONMENT_ID },
            originCursor: 1,
            scope: event.scope,
            aggregate: { ...event.aggregate, revision: 0 },
            occurredAt: event.occurredAt ?? now,
            recordedAt: now,
            correlationId: event.correlationId ?? "test",
            causationId: event.causedBy?.eventId ?? null,
            hops: event.causedBy === undefined ? 0 : event.causedBy.hops + 1,
            payload: event.payload,
          } as AutomationJournalEntry["event"];
          const dedupKey = event.dedupKey ?? body.eventId;
          const before = yield* sql<{ readonly cursor: number }>`
            SELECT cursor FROM test_recorded_journal WHERE dedup_key = ${dedupKey}
          `.pipe(Effect.mapError(failure));
          if (before[0] !== undefined) return { cursor: before[0].cursor, event: body };
          yield* sql`
            INSERT INTO test_recorded_journal (dedup_key, entry_json)
            VALUES (${dedupKey}, ${formatJson(body)})
          `.pipe(Effect.mapError(failure));
          const stored = yield* sql<{ readonly cursor: number }>`
            SELECT cursor FROM test_recorded_journal WHERE dedup_key = ${dedupKey}
          `.pipe(Effect.mapError(failure));
          const entry = { cursor: stored[0]!.cursor, event: body } satisfies AutomationJournalEntry;
          yield* Queue.offer(appended, entry);
          yield* PubSub.publish(live, entry);
          return entry;
        }),
      );
    return Context.make(EventJournal.EventJournal, {
      status: read.pipe(
        Effect.mapError(failure),
        Effect.flatMap((entries) =>
          DateTime.now.pipe(
            Effect.map((now) => ({
              environmentId: HARNESS_ENVIRONMENT_ID,
              headCursor: entries.at(-1)?.cursor ?? 0,
              oldestCursor: entries[0]?.cursor ?? null,
              retainedEntries: entries.length,
              observedAt: DateTime.formatIso(now),
            })),
          ),
        ),
      ),
      read: unsupported,
      // Replay after the cursor, then live, with the subscription opened first
      // so nothing appended in between is lost.
      subscribe: (_caller, input) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const subscription = yield* PubSub.subscribe(live);
            const replay = (yield* read.pipe(Effect.mapError(failure))).filter(
              (entry) => entry.cursor > (input.afterCursor ?? Number.MAX_SAFE_INTEGER),
            );
            const replayed = replay.at(-1)?.cursor ?? input.afterCursor ?? 0;
            return Stream.concat(
              Stream.fromIterable(replay),
              Stream.fromSubscription(subscription).pipe(
                Stream.filter((entry) => entry.cursor > replayed),
              ),
            ).pipe(
              Stream.filter(
                (entry) =>
                  input.filter?.taskIds === undefined ||
                  (entry.event.scope.taskId !== undefined &&
                    input.filter.taskIds.includes(entry.event.scope.taskId)),
              ),
              Stream.map((entry) => ({ type: "entry" as const, entry })),
            );
          }),
        ),
      emit: unsupported,
      append,
      importPeerEntries: () => Effect.succeed([]),
      listConsumers: () => Effect.succeed([]),
      ackConsumer: unsupported,
      deleteConsumer: () => Effect.succeed(false),
    }).pipe(
      Context.add(RecordedJournal, {
        entries: read.pipe(Effect.orDie),
        next: (type) =>
          Queue.take(appended).pipe(Effect.repeat({ until: (entry) => entry.event.type === type })),
      }),
    );
  }),
);

/** Peer messages the task engine queued, in order. */
export class RecordedPeers extends Context.Service<
  RecordedPeers,
  { readonly messages: Effect.Effect<ReadonlyArray<PeerMessage>> }
>()("t3/cli/testkit/CliHarness/RecordedPeers") {}

const recordedPeersLayer = Layer.effectContext(
  Effect.gen(function* () {
    const messages = yield* Ref.make<ReadonlyArray<PeerMessage>>([]);
    const unsupported = () => Effect.fail(automationError("CAPABILITY_UNSUPPORTED", "test peers"));
    return Context.make(PeerService.PeerService, {
      list: () => Effect.succeed([]),
      add: unsupported,
      update: unsupported,
      remove: unsupported,
      outbox: () => Effect.succeed([]),
      hello: unsupported,
      deliver: unsupported,
      enqueue: (input) =>
        Effect.gen(function* () {
          const existing = (yield* Ref.get(messages)).find(
            (message) => message.messageId === input.dedupKey,
          );
          if (existing !== undefined) return existing;
          const message: PeerMessage = {
            version: 1,
            messageId: PeerMessageId.make(input.dedupKey),
            fromEnvironmentId: HARNESS_ENVIRONMENT_ID,
            toEnvironmentId: input.toEnvironmentId,
            sequence: (yield* Ref.get(messages)).length + 1,
            correlationId: input.correlationId,
            sentAt: DateTime.formatIso(yield* DateTime.now),
            expiresAt: input.expiresAt ?? null,
            body: input.body,
          };
          yield* Ref.update(messages, (current) => [...current, message]);
          return message;
        }),
    }).pipe(Context.add(RecordedPeers, { messages: Ref.get(messages) }));
  }),
);

/** `terminal.close` calls the CLI made: the terminal manager is a process boundary. */
export class TerminalCloses extends Context.Service<
  TerminalCloses,
  Ref.Ref<ReadonlyArray<{ readonly threadId: string; readonly deleteHistory?: boolean }>>
>()("t3/cli/testkit/CliHarness/TerminalCloses") {}

// ---------------------------------------------------------------------------
// The in-process RPC client

const encodeDispatchError = Schema.encodeUnknownEffect(OrchestrationV2DispatchCommandError);
const decodeDispatchError = Schema.decodeUnknownEffect(OrchestrationV2DispatchCommandError);
const encodeAutomationError = Schema.encodeUnknownEffect(AutomationError);
const decodeAutomationError = Schema.decodeUnknownEffect(AutomationError);

const harnessCaller: AutomationCaller = {
  kind: "client",
  subject: "cli-harness",
  scopes: AuthStandardClientScopes,
};

const makeClient = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const eventSink = yield* EventSink.EventSinkV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const terminalCloses = yield* TerminalCloses;
  const intakeContext = yield* Effect.context<
    | ThreadManagement.ThreadManagementService
    | ThreadLaunch.ThreadLaunchService
    | FileSystem.FileSystem
    | ServerConfig.ServerConfig
  >();
  const automation = yield* makeAutomationRpcHandlers({
    caller: harnessCaller,
    observeEffect: (_method, effect) => effect,
    observeStream: (_method, stream) => stream,
  });

  const snapshotSequence = eventSink.latestSequence().pipe(Effect.orDie);

  const dispatchCommand = (command: OrchestrationV2Command) =>
    ThreadMessageIntake.dispatchCommand(
      ThreadManagement.withCreationProvenance(command, {
        createdBy: "user",
        creationSource: "creationSource" in command ? command.creationSource : "web",
      }),
    ).pipe(
      Effect.provide(intakeContext),
      Effect.map((result) => ({ sequence: result.sequence })),
      // The same error the WebSocket route builds, then through its wire
      // encoding, so the handlers see exactly what a socket would deliver.
      Effect.mapError((cause) => {
        const detail = userFacingDispatchErrorMessage(cause);
        return new OrchestrationV2DispatchCommandError({
          commandId: command.commandId,
          commandType: command.type,
          message: detail ?? "Failed to dispatch orchestration V2 command",
          ...(detail === undefined ? {} : { detail }),
          cause,
        });
      }),
      Effect.catch((error) =>
        encodeDispatchError(error).pipe(
          Effect.flatMap(decodeDispatchError),
          Effect.orDie,
          Effect.flatMap(Effect.fail),
        ),
      ),
    );

  const overWire = <A, R>(effect: Effect.Effect<A, AutomationError, R>) =>
    effect.pipe(
      Effect.catch((error) =>
        encodeAutomationError(error).pipe(
          Effect.flatMap(decodeAutomationError),
          Effect.orDie,
          Effect.flatMap(Effect.fail),
        ),
      ),
    );

  const client = {
    ...Object.fromEntries(
      Object.entries(automation).map(([method, handler]) => [
        method,
        method === AUTOMATION_WS_METHODS.eventsSubscribe ||
        method === AUTOMATION_WS_METHODS.orchestratorsSubscribe ||
        method === AUTOMATION_WS_METHODS.jobsWatch
          ? handler
          : (payload: never) =>
              overWire(
                (handler as (payload: never) => Effect.Effect<unknown, AutomationError>)(payload),
              ),
      ]),
    ),
    [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: dispatchCommand,
    [ORCHESTRATION_V2_WS_METHODS.launchThread]: (
      input: Omit<ThreadLaunch.ThreadLaunchInput, "createdBy" | "creationSource"> & {
        readonly creationSource?: ThreadLaunch.ThreadLaunchInput["creationSource"];
      },
    ) =>
      ThreadMessageIntake.launchThread({
        ...input,
        createdBy: "user",
        creationSource: input.creationSource ?? "web",
      }).pipe(
        Effect.provide(intakeContext),
        Effect.map((result) => ({
          ...result,
          projection: projectThreadProjectionForWire(result.projection),
        })),
      ),
    [ORCHESTRATION_V2_WS_METHODS.getThreadProjection]: (input: { readonly threadId: ThreadId }) =>
      threads.getThreadProjection(input.threadId).pipe(Effect.map(projectThreadProjectionForWire)),
    [ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot]: () =>
      Effect.gen(function* () {
        const archived = yield* threads.getShellSnapshot({ location: "archive" });
        return {
          schemaVersion: archived.schemaVersion,
          snapshotSequence: yield* snapshotSequence,
          projects: [projectShell],
          threads: archived.archivedThreads,
        };
      }),
    [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const sequence = yield* snapshotSequence;
          const snapshot = buildActiveShellSnapshot({
            projects: [projectShell],
            threads: yield* threads.getShellSnapshot({ location: "active" }),
            snapshotSequence: sequence,
          });
          const live = threads
            .streamStoredEventsFrom({ afterSequence: sequence })
            .pipe(
              Stream.mapEffect((stored) =>
                threads
                  .getThreadShell(stored.event.threadId)
                  .pipe(Effect.map((shell) => shellStreamItemFromThreadShell({ stored, shell }))),
              ),
            );
          return Stream.concat(Stream.make({ kind: "snapshot" as const, snapshot }), live);
        }),
      ),
    [WS_METHODS.serverGetSettings]: () => settings.getSettings,
    [WS_METHODS.terminalClose]: (input: {
      readonly threadId: string;
      readonly deleteHistory?: boolean;
    }) => Ref.update(terminalCloses, (current) => [...current, input]),
  };
  return client as unknown as EnvironmentRpcClient;
});

// ---------------------------------------------------------------------------
// Layers

export interface CliHarnessOptions {
  /** A database that outlives one harness, for restart tests. Default: a fresh in-memory one. */
  readonly database?: Layer.Layer<
    SqlClient.SqlClient,
    MigrationError | PlatformError.PlatformError | SqlError
  >;
  /** `unsupported` keeps the placeholder peer service, as on a server without federation. */
  readonly peers?: "recorded" | "unsupported";
}

/**
 * Everything a CLI test needs: the orchestrator and thread services, the task
 * engine with its reactor and the snooze expiry worker (not started), the
 * recording doubles, the in-process RPC client, and a captured console.
 */
export function makeCliHarness(options: CliHarnessOptions = {}) {
  const database = (options.database ?? SqlitePersistenceMemory).pipe(Layer.orDie);
  const orchestrator = makeOrchestratorV2ReplayLayerWithRegistry(
    { name: "cli-harness" },
    ProviderAdapterRegistry.makeLayer([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  ).pipe(Layer.orDie);
  const threadManagement = ThreadManagement.layer.pipe(Layer.provide(orchestrator));
  const receipts = CommandReceiptStore.layer.pipe(Layer.provide(database));
  const externalServices = Layer.mergeAll(
    WorktreeSetupTracker.layer,
    Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
    Layer.mock(TerminalManager.TerminalManager)({ close: () => Effect.void }),
    Layer.succeed(ProjectService.ProjectService, {
      create: () => Effect.die("unused"),
      bootstrap: () => Effect.die("unused"),
      update: () => Effect.die("unused"),
      delete: () => Effect.die("unused"),
      getById: (id) =>
        Effect.succeed(id === HARNESS_PROJECT_ID ? Option.some(project) : Option.none()),
      getByWorkspaceRoot: () => Effect.succeed(Option.some(project)),
      snapshot: Effect.die("unused"),
      getShell: () => Effect.die("unused"),
      listShells: () => Effect.die("unused"),
    }),
    Layer.mock(GitWorkflow.GitWorkflowService)({}),
    Layer.succeed(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
      runForThread: () => Effect.succeed({ status: "no-script" as const }),
    }),
    Layer.mock(TextGeneration.TextGeneration)({
      generateThreadTitle: () => Effect.succeed({ title: "Generated title" }),
      generateBranchName: () => Effect.succeed({ branch: "generated-branch" }),
    }),
    ServerSettings.layerTest(),
    makeProviderRegistryLayer(undefined),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/projects",
      folderForThread: () => Effect.succeed(Option.none()),
    }),
  );
  const launch = ThreadLaunch.layer.pipe(
    Layer.provide(Layer.mergeAll(externalServices, threadManagement, receipts, IdAllocator.layer)),
  );
  const serverConfig = Layer.effect(
    ServerConfig.ServerConfig,
    makeReplayServerConfig("cli-harness").pipe(Effect.orDie),
  ).pipe(Layer.provide(NodeServices.layer));
  const identity = Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
    getEnvironmentId: Effect.succeed(HARNESS_ENVIRONMENT_ID),
  });
  const core = Layer.mergeAll(
    orchestrator,
    threadManagement,
    launch,
    database,
    externalServices,
    serverConfig,
    identity,
    NodeServices.layer,
    NetService.layer,
    Scheduler.layer,
  );
  const journal = recordedJournalLayer.pipe(Layer.provide(database));
  const peers: Layer.Layer<PeerService.PeerService | RecordedPeers> =
    options.peers === "unsupported"
      ? Layer.merge(
          PeerService.layer,
          Layer.succeed(RecordedPeers, { messages: Effect.succeed([]) }),
        )
      : recordedPeersLayer;
  const engine = TaskEngine.layer.pipe(
    Layer.provide(Layer.mergeAll(core, journal, peers, OrchestratorService.layer)),
  );
  const automation = Layer.mergeAll(
    DelegatedTaskService.layerFromEngine.pipe(Layer.provide(engine)),
    journal,
    peers,
    OrchestratorService.layer,
    HookService.layer,
    ResponsibilityService.layer,
    JobService.layer,
    AutomationDiagnosticsService.layer,
  );
  const terminalCloses = Layer.effect(
    TerminalCloses,
    Ref.make<ReadonlyArray<{ readonly threadId: string; readonly deleteHistory?: boolean }>>([]),
  );
  const client = Layer.effect(CliRpcClientOverride, makeClient).pipe(
    Layer.provide(Layer.mergeAll(core, automation, terminalCloses)),
  );
  return Layer.mergeAll(
    core,
    automation,
    engine,
    TaskReactor.layer.pipe(Layer.provide(Layer.mergeAll(core, engine))),
    SnoozeExpiry.layer.pipe(Layer.provide(core)),
    terminalCloses,
    client,
    TestConsole.layer,
    // Logs would otherwise land in the captured stdout. T3_TEST_LOGS=1 shows them.
    Logger.layer(
      process.env.T3_TEST_LOGS === "1"
        ? [Logger.map(Logger.formatLogFmt, (line) => void process.stderr.write(`${line}\n`))]
        : [],
      { mergeWithExisting: false },
    ),
  );
}

// ---------------------------------------------------------------------------
// Running commands

export interface CliRun {
  readonly exitCode: number;
  readonly stdout: ReadonlyArray<string>;
  readonly stderr: ReadonlyArray<string>;
  /** The failure the command ended with, if it failed with a coded one. */
  readonly failure: CliFailure | undefined;
  /** stdout parsed as one JSON document. */
  readonly json: <A = any>() => A;
  /** The `{"error":{...}}` document `--json` printed on stderr. */
  readonly errorJson: <A = any>() => A;
}

const isCliFailure = Schema.is(CliFailure);

/** Runs a command group with `args`, as `t3 <group> ...` would, and captures what it printed. */
export const runCli = Effect.fn("CliHarness.runCli")(function* <
  const Name extends string,
  Input,
  ContextInput,
  E,
  R,
>(command: Command.Command<Name, Input, ContextInput, E, R>, args: ReadonlyArray<string>) {
  const stdoutBefore = (yield* TestConsole.logLines).length;
  const stderrBefore = (yield* TestConsole.errorLines).length;
  const exit = yield* Command.runWith(command, { version: "0.0.0" })(args).pipe(Effect.exit);
  const stdout = (yield* TestConsole.logLines).slice(stdoutBefore).map(String);
  const stderr = (yield* TestConsole.errorLines).slice(stderrBefore).map(String);
  const squashed = exit._tag === "Failure" ? Cause.squash(exit.cause) : undefined;
  const failure = isCliFailure(squashed) ? squashed : undefined;
  if (exit._tag === "Failure" && failure === undefined) {
    // Anything but a coded failure is a harness or program defect: surface it.
    return yield* Effect.die(squashed);
  }
  const run: CliRun = {
    exitCode: failure === undefined ? 0 : failure["~effect/Runtime/errorExitCode"],
    stdout,
    stderr,
    failure,
    json: () => parseJson(stdout.join("\n")) as never,
    errorJson: () => parseJson(stderr.join("\n")) as never,
  };
  return run;
});

// ---------------------------------------------------------------------------
// Provider facts

let eventCounter = 0;
const nextId = (prefix: string) => `${prefix}:${(eventCounter += 1)}`;

/** Commits events the way the provider event ingestor does: through the event sink. */
export const writeEvents = Effect.fn("CliHarness.writeEvents")(function* (
  events: ReadonlyArray<Omit<OrchestrationV2DomainEvent, "id">>,
) {
  const eventSink = yield* EventSink.EventSinkV2;
  yield* eventSink
    .write({
      events: events.map(
        (event) => ({ ...event, id: EventId.make(nextId("event")) }) as OrchestrationV2DomainEvent,
      ),
    })
    .pipe(Effect.orDie);
});

/**
 * Resolves once the thread's first run has left workspace preparation, which
 * the launch finishes in the background. Provider facts are stated after it.
 */
export const awaitRunPrepared = Effect.fn("CliHarness.awaitRunPrepared")(function* (
  threadId: ThreadId,
) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  yield* threads.streamStoredEventsFrom({ threadId, afterSequence: 0 }).pipe(
    Stream.filter(
      ({ event }) =>
        (event.type === "run.created" || event.type === "run.updated") &&
        event.payload.status !== "preparing",
    ),
    Stream.runHead,
    Effect.orDie,
  );
});

/** Moves the thread's newest run to `status`, as the provider reporting it would. */
export const setLatestRunStatus = Effect.fn("CliHarness.setLatestRunStatus")(function* (
  threadId: ThreadId,
  status: OrchestrationV2Run["status"],
) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const { runs } = yield* threads.getThreadRecords(threadId, ["runs"]).pipe(Effect.orDie);
  const run = runs.toSorted((left, right) => right.ordinal - left.ordinal)[0];
  if (run === undefined) return yield* Effect.die(`Thread ${threadId} has no run.`);
  const now = yield* DateTime.now;
  const terminal =
    status === "completed" ||
    status === "failed" ||
    status === "interrupted" ||
    status === "cancelled";
  yield* writeEvents([
    {
      type: "run.updated",
      threadId,
      runId: run.id,
      providerInstanceId: run.providerInstanceId,
      occurredAt: now,
      payload: {
        ...run,
        status,
        queuePosition: null,
        ...(terminal ? { completedAt: now } : { startedAt: run.startedAt ?? now }),
      },
    } as Omit<OrchestrationV2DomainEvent, "id">,
  ]);
  return run;
});

/** Attaches a provider session to the thread, as a provider process coming up would. */
export const attachSession = Effect.fn("CliHarness.attachSession")(function* (threadId: ThreadId) {
  const now = yield* DateTime.now;
  const sessionId = ProviderSessionId.make(nextId("session"));
  yield* writeEvents([
    {
      type: "provider-session.attached",
      threadId,
      occurredAt: now,
      payload: {
        id: sessionId,
        driver: adapter.driver,
        providerInstanceId: HARNESS_MODEL.instanceId,
        status: "ready",
        cwd: "/repo",
        model: HARNESS_MODEL.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      },
    } as Omit<OrchestrationV2DomainEvent, "id">,
  ]);
  return sessionId;
});

/** The assistant's final message of the newest run. */
export const writeAssistantMessage = Effect.fn("CliHarness.writeAssistantMessage")(function* (
  threadId: ThreadId,
  text: string,
) {
  const now = yield* DateTime.now;
  yield* writeEvents([
    {
      type: "message.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: MessageId.make(nextId("message")),
        threadId,
        runId: null,
        nodeId: null,
        role: "assistant",
        text,
        attachments: [],
        streaming: false,
        createdBy: "agent",
        creationSource: "provider",
        createdAt: now,
        updatedAt: now,
      },
    } as Omit<OrchestrationV2DomainEvent, "id">,
  ]);
});

/**
 * A pending runtime request with its turn item. A question answered by
 * message needs no provider session; an approval is answered on a live one.
 */
const seedRequest = Effect.fn("CliHarness.seedRequest")(function* (
  threadId: ThreadId,
  input:
    | {
        readonly kind: "user_input";
        readonly questions: ReadonlyArray<OrchestrationV2UserInputQuestion>;
        /** Answered on a live provider session instead of by message. */
        readonly live?: boolean;
      }
    | {
        readonly kind: ProviderRequestKind;
        readonly prompt?: string;
        readonly options?: ReadonlyArray<ProviderApprovalOption>;
      },
) {
  const now = yield* DateTime.now;
  const requestId = RuntimeRequestId.make(nextId("request"));
  const nodeId = NodeId.make(nextId("node"));
  const isQuestion = input.kind === "user_input";
  const providerSessionId =
    input.kind === "user_input" && input.live !== true ? null : yield* attachSession(threadId);
  const threads = yield* ThreadManagement.ThreadManagementService;
  const { turnItems } = yield* threads.getThreadRecords(threadId, ["turnItems"]).pipe(Effect.orDie);
  const itemBase = {
    id: TurnItemId.make(nextId("item")),
    threadId,
    runId: null,
    nodeId,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: Math.max(0, ...turnItems.map((item) => item.ordinal)) + 1,
    status: "waiting",
    title: null,
    startedAt: now,
    completedAt: null,
    updatedAt: now,
  };
  yield* writeEvents([
    {
      type: "runtime-request.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: requestId,
        nodeId,
        providerTurnId: null,
        nativeRequestRef: null,
        kind: input.kind,
        status: "pending",
        responseCapability:
          providerSessionId === null ? { type: "message" } : { type: "live", providerSessionId },
        createdAt: now,
        resolvedAt: null,
      },
    },
    {
      type: "node.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: nodeId,
        threadId,
        runId: null,
        parentNodeId: null,
        rootNodeId: nodeId,
        kind: isQuestion ? "user_input_request" : "approval_request",
        status: "waiting",
        countsForRun: false,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: requestId,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: null,
      },
    },
    {
      type: "turn-item.updated",
      threadId,
      occurredAt: now,
      payload:
        input.kind === "user_input"
          ? { ...itemBase, type: "user_input_request", requestId, questions: input.questions }
          : {
              ...itemBase,
              type: "approval_request",
              requestId,
              requestKind: input.kind,
              ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
              ...(input.options === undefined ? {} : { options: input.options }),
            },
    },
  ] as ReadonlyArray<Omit<OrchestrationV2DomainEvent, "id">>);
  return requestId;
});

export const seedQuestion = (
  threadId: ThreadId,
  questions: ReadonlyArray<OrchestrationV2UserInputQuestion>,
  options: { readonly live?: boolean } = {},
) => seedRequest(threadId, { kind: "user_input", questions, ...options });

export const seedApproval = (
  threadId: ThreadId,
  input: {
    readonly kind?: ProviderRequestKind;
    readonly prompt?: string;
    readonly options?: ReadonlyArray<ProviderApprovalOption>;
  } = {},
) => seedRequest(threadId, { kind: "command", ...input });

/** Marks a pending request as expired, as a provider that gave up on it would. */
export const expireRequest = Effect.fn("CliHarness.expireRequest")(function* (
  threadId: ThreadId,
  requestId: RuntimeRequestId,
) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const { runtimeRequests } = yield* threads
    .getThreadRecords(threadId, ["runtimeRequests"])
    .pipe(Effect.orDie);
  const request = runtimeRequests.find((candidate) => candidate.id === requestId);
  if (request === undefined) return yield* Effect.die(`No request ${requestId}.`);
  const now = yield* DateTime.now;
  yield* writeEvents([
    {
      type: "runtime-request.updated",
      threadId,
      occurredAt: now,
      payload: { ...request, status: "expired", resolvedAt: now },
    } as Omit<OrchestrationV2DomainEvent, "id">,
  ]);
});
