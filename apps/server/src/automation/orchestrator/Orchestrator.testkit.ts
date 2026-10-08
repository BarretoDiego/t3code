import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AUTOMATION_CONTRACT_VERSION,
  type AutomationEvent,
  type AutomationEventScope,
  type AutomationJournalEntry,
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2RuntimeRequest,
  type OrchestratorUpsertInput,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RuntimeRequestId,
  type ServerProvider,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/sql/SqlClient";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as GitWorkflow from "../../git/GitWorkflowService.ts";
import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { withAgentShellEnvironment } from "../../orchestration-v2/AgentShellEnvironment.ts";
import * as CommandReceiptStore from "../../orchestration-v2/CommandReceiptStore.ts";
import * as IdAllocator from "../../orchestration-v2/IdAllocator.ts";
import type {
  ProviderAdapterV2Event,
  ProviderAdapterV2Shape,
  ProviderAdapterV2TurnInput,
} from "../../orchestration-v2/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import {
  layerWithRegistry,
  makeReplayServerConfig,
} from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "../../orchestration-v2/testkit/ReplayFixtureWorkspace.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as ProjectCloneTracker from "../../project/ProjectCloneTracker.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import * as WorktreeSetupTracker from "../../project/WorktreeSetupTracker.ts";
import { layer as layerProviderRegistryMock } from "../../provider/testUtils/providerRegistryMock.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import { unsupported } from "../Caller.ts";
import * as EventJournal from "../EventJournal.ts";
import * as OrchestratorInbox from "../OrchestratorInbox.ts";
import * as OrchestratorService from "../OrchestratorService.ts";
import * as ResponsibilityService from "../ResponsibilityService.ts";
import * as OrchestratorRuntime from "./Runtime.ts";

export const environmentId = EnvironmentId.make("environment:orchestrator-test");
export const projectId = ProjectId.make("project:orchestrator-test");
export const otherProjectId = ProjectId.make("project:orchestrator-other");
const instanceId = ProviderInstanceId.make("codex");
export const otherInstanceId = ProviderInstanceId.make("codex-second");
export const modelSelection = { instanceId, model: "gpt-5.4" } as const;
const driver = ProviderDriverKind.make("codex");
/** An instance of a provider whose agent cannot be given an orchestrator's credential. */
export const unsupportedInstanceId = ProviderInstanceId.make("opencode-test");
const unsupportedDriver = ProviderDriverKind.make("opencode");
/** What a provider process inherits before any thread-specific environment is applied. */
export const PROVIDER_BASE_PATH = "/usr/bin:/bin";

/** One turn as the scripted provider received it. */
export interface ProviderTurnRecord {
  readonly threadId: ThreadId;
  readonly text: string;
  readonly model: string;
  /** The environment the adapter hands the process that runs the agent's commands. */
  readonly environment: NodeJS.ProcessEnv;
}

/** What the scripted provider did, and the switches a test flips to shape the next turn. */
export interface ProviderProbe {
  /** Every turn a provider was asked to run, in order. */
  readonly turns: Ref.Ref<ReadonlyArray<ProviderTurnRecord>>;
  /** When set, the next turn stays running until the deferred completes. */
  readonly holdNextTurn: Ref.Ref<Deferred.Deferred<void> | null>;
  /** Tokens each completed turn reports; null reports nothing, as some providers do. */
  readonly usage: Ref.Ref<{ readonly input: number; readonly output: number } | null>;
}

const makeProviderProbe = Effect.gen(function* () {
  return {
    turns: yield* Ref.make<ReadonlyArray<ProviderTurnRecord>>([]),
    holdNextTurn: yield* Ref.make<Deferred.Deferred<void> | null>(null),
    usage: yield* Ref.make<{ readonly input: number; readonly output: number } | null>(null),
  } satisfies ProviderProbe;
});

const REQUEST_PREFIX = "REQUEST:";

/**
 * A provider that answers every turn at once, unless the turn's text starts
 * with `REQUEST:<kind>`: then it raises a runtime request of that kind and
 * completes only when the request is answered.
 */
function makeScriptedAdapter(
  probe: ProviderProbe,
  adapterInstanceId: ProviderInstanceId,
  driver = ProviderDriverKind.make("codex"),
): ProviderAdapterV2Shape {
  return {
    instanceId: adapterInstanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const scope = yield* Effect.scope;
        const events = yield* PubSub.unbounded<ProviderAdapterV2Event>();
        const now = yield* DateTime.now;
        const providerSession: OrchestrationV2ProviderSession = {
          id: sessionInput.providerSessionId,
          driver,
          providerInstanceId: adapterInstanceId,
          status: "ready",
          cwd: sessionInput.runtimePolicy.cwd ?? process.cwd(),
          model: sessionInput.modelSelection.model,
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };
        const publish = (providerEvents: ReadonlyArray<ProviderAdapterV2Event>) =>
          Effect.forEach(providerEvents, (event) => PubSub.publish(events, event), {
            discard: true,
          });
        const turnInputs = new Map<ProviderTurnId, ProviderAdapterV2TurnInput>();
        const pendingRequests = new Map<
          string,
          { readonly turn: ProviderAdapterV2TurnInput; readonly providerTurnId: ProviderTurnId }
        >();

        const providerTurn = (
          turn: ProviderAdapterV2TurnInput,
          providerTurnId: ProviderTurnId,
          status: "running" | "completed" | "interrupted",
          at: DateTime.Utc,
          usage: { readonly input: number; readonly output: number } | null,
        ): ProviderAdapterV2Event => ({
          type: "provider_turn.updated",
          driver,
          providerTurn: {
            id: providerTurnId,
            providerThreadId: turn.providerThread.id,
            nodeId: turn.rootNodeId,
            runAttemptId: turn.attemptId,
            nativeTurnRef: {
              driver,
              nativeId: `native-turn:${turn.threadId}:${turn.runOrdinal}`,
              strength: "strong",
            },
            ordinal: turn.providerTurnOrdinal,
            status,
            startedAt: at,
            completedAt: status === "running" ? null : at,
            ...(usage === null
              ? {}
              : {
                  turnTokenUsage: {
                    usageScope: "main_agent" as const,
                    hasSubagents: false,
                    usageStatus: "complete" as const,
                    inputTokens: usage.input,
                    outputTokens: usage.output,
                  },
                }),
          },
        });

        const complete = (turn: ProviderAdapterV2TurnInput, providerTurnId: ProviderTurnId) =>
          Effect.gen(function* () {
            const at = yield* DateTime.now;
            yield* publish([
              providerTurn(turn, providerTurnId, "completed", at, yield* Ref.get(probe.usage)),
              {
                type: "turn_item.updated",
                driver,
                turnItem: {
                  id: TurnItemId.make(`turn-item:${turn.threadId}:${turn.runOrdinal}:assistant`),
                  threadId: turn.threadId,
                  runId: turn.runId,
                  nodeId: turn.rootNodeId,
                  providerThreadId: turn.providerThread.id,
                  providerTurnId,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: turn.runOrdinal * 100 + 1,
                  status: "completed",
                  title: null,
                  startedAt: at,
                  completedAt: at,
                  updatedAt: at,
                  type: "assistant_message",
                  messageId: MessageId.make(
                    `message:${turn.threadId}:${turn.runOrdinal}:assistant`,
                  ),
                  text: `Decision for run ${turn.runOrdinal}.`,
                  streaming: false,
                },
              },
              {
                type: "turn.terminal",
                driver,
                providerThreadId: turn.providerThread.id,
                providerTurnId,
                runOrdinal: turn.runOrdinal,
                status: "completed",
                failure: null,
                threadDisposition: "reusable",
              },
            ]);
          });

        return {
          instanceId: adapterInstanceId,
          driver,
          providerSessionId: sessionInput.providerSessionId,
          providerSession,
          events: Stream.fromPubSub(events),
          ensureThread: (threadInput) =>
            Effect.gen(function* () {
              const createdAt = yield* DateTime.now;
              return {
                id: ProviderThreadId.make(
                  `provider-thread:${adapterInstanceId}:${threadInput.threadId}`,
                ),
                driver,
                providerInstanceId: adapterInstanceId,
                providerSessionId: sessionInput.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: {
                  driver,
                  nativeId: `${adapterInstanceId}:${threadInput.threadId}`,
                  strength: "strong",
                },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt,
                updatedAt: createdAt,
              } satisfies OrchestrationV2ProviderThread;
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (turn) =>
            Effect.gen(function* () {
              yield* Ref.update(probe.turns, (turns) => [
                ...turns,
                {
                  threadId: turn.threadId,
                  text: turn.message.text,
                  model: turn.modelSelection.model,
                  // What a real adapter does where it spawns the agent's process.
                  environment: withAgentShellEnvironment(
                    { PATH: PROVIDER_BASE_PATH },
                    turn.threadId,
                  ),
                },
              ]);
              const at = yield* DateTime.now;
              const providerTurnId = ProviderTurnId.make(
                `provider-turn:${adapterInstanceId}:${turn.threadId}:${turn.runOrdinal}`,
              );
              turnInputs.set(providerTurnId, turn);
              yield* publish([providerTurn(turn, providerTurnId, "running", at, null)]);
              if (turn.message.text.startsWith(REQUEST_PREFIX)) {
                const kind = turn.message.text
                  .slice(REQUEST_PREFIX.length)
                  .split(/\s/u)[0] as OrchestrationV2RuntimeRequest["kind"];
                const requestId = RuntimeRequestId.make(
                  `request:${turn.threadId}:${turn.runOrdinal}`,
                );
                pendingRequests.set(requestId, { turn, providerTurnId });
                yield* publish([
                  {
                    type: "runtime_request.updated",
                    driver,
                    threadId: turn.threadId,
                    runtimeRequest: {
                      id: requestId,
                      nodeId: turn.rootNodeId,
                      providerTurnId,
                      nativeRequestRef: null,
                      kind,
                      status: "pending",
                      responseCapability: {
                        type: "live",
                        providerSessionId: sessionInput.providerSessionId,
                      },
                      createdAt: at,
                      resolvedAt: null,
                    },
                  },
                ]);
                return;
              }
              const hold = yield* Ref.getAndSet(probe.holdNextTurn, null);
              if (hold === null) return yield* complete(turn, providerTurnId);
              yield* Deferred.await(hold).pipe(
                Effect.andThen(complete(turn, providerTurnId)),
                Effect.forkIn(scope),
              );
            }),
          steerTurn: () => Effect.void,
          interruptTurn: ({ providerThread, providerTurnId }) =>
            Effect.gen(function* () {
              const turn = turnInputs.get(providerTurnId);
              const at = yield* DateTime.now;
              yield* publish([
                ...(turn === undefined
                  ? []
                  : [providerTurn(turn, providerTurnId, "interrupted", at, null)]),
                {
                  type: "turn.terminal",
                  driver,
                  providerThreadId: providerThread.id,
                  providerTurnId,
                  runOrdinal: turn?.runOrdinal ?? 1,
                  status: "interrupted",
                  failure: null,
                  threadDisposition: "reusable",
                },
              ]);
            }),
          respondToRuntimeRequest: (response) =>
            Effect.suspend(() => {
              const pending = pendingRequests.get(response.requestId);
              if (pending === undefined) return Effect.void;
              pendingRequests.delete(response.requestId);
              return complete(pending.turn, pending.providerTurnId);
            }),
          readThreadSnapshot: () => Effect.die("readThreadSnapshot is unused"),
          rollbackThread: () => Effect.die("rollbackThread is unused"),
          forkThread: () => Effect.die("forkThread is unused"),
        };
      }),
  };
}

const providerSnapshot = (
  providerInstanceId: ProviderInstanceId,
  snapshotDriver = driver,
): ServerProvider => ({
  instanceId: providerInstanceId,
  driver: snapshotDriver,
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-06-17T00:00:00.000Z",
  models: [
    { slug: "gpt-5.4", name: "gpt-5.4", isCustom: false, capabilities: null },
    { slug: "gpt-5.5", name: "gpt-5.5", isCustom: false, capabilities: null },
  ],
  slashCommands: [],
  skills: [],
});

/** The journal as its consumers see it in these tests: appended events, in order. */
export class JournalProbe {
  readonly events: SubscriptionRef.SubscriptionRef<ReadonlyArray<AutomationEvent>>;

  constructor(events: SubscriptionRef.SubscriptionRef<ReadonlyArray<AutomationEvent>>) {
    this.events = events;
  }

  /** Completes once the appended events satisfy the predicate. Never polls. */
  readonly until = (predicate: (events: ReadonlyArray<AutomationEvent>) => boolean) =>
    SubscriptionRef.changes(this.events).pipe(
      Stream.filter(predicate),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    );

  readonly untilTurnsFinished = (count: number) =>
    this.until(
      (events) =>
        events.filter((event) => event.type === "orchestrator.turn.finished").length >= count,
    );
}

/**
 * Stands in for the journal at its boundary. Rows go to `automation_journal`
 * through the same SQL client, so an append made inside a transaction rolls
 * back with it, exactly as the real journal's would.
 */
const makeJournalLayer = (probe: JournalProbe) =>
  Layer.effect(
    EventJournal.EventJournal,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const sequence = yield* Ref.make(0);
      const dedup = new Set<string>();
      const append: EventJournal.EventJournal["Service"]["append"] = (inputs) =>
        Effect.forEach(inputs, (input) =>
          Effect.gen(function* () {
            const now = DateTime.formatIso(yield* DateTime.now);
            const cursor = yield* Ref.updateAndGet(sequence, (value) => value + 1);
            const event: AutomationEvent = {
              version: AUTOMATION_CONTRACT_VERSION,
              eventId: EventId.make(`event:journal-probe:${cursor}`),
              type: input.type,
              origin: { ...input.origin, environmentId },
              originCursor: cursor,
              scope: input.scope,
              aggregate: { ...input.aggregate, revision: cursor },
              occurredAt: input.occurredAt ?? now,
              recordedAt: now,
              correlationId: input.correlationId ?? `correlation:${cursor}`,
              causationId: input.causedBy?.eventId ?? null,
              hops: input.causedBy === undefined ? 0 : input.causedBy.hops + 1,
              payload: input.payload,
            };
            if (input.dedupKey !== undefined && dedup.has(input.dedupKey)) {
              return { cursor, event };
            }
            yield* sql`
              INSERT INTO automation_journal (
                event_id, type, origin_environment_id, origin_cursor, origin_kind,
                orchestrator_id, aggregate_kind, aggregate_id, aggregate_revision,
                correlation_id, hops, occurred_at, recorded_at, event_json
              ) VALUES (
                ${event.eventId}, ${event.type}, ${environmentId}, ${cursor}, ${event.origin.kind},
                ${event.scope.orchestratorId ?? null}, ${event.aggregate.kind},
                ${event.aggregate.id}, ${cursor}, ${event.correlationId}, ${event.hops},
                ${event.occurredAt}, ${event.recordedAt}, '{}'
              )
            `;
            if (input.dedupKey !== undefined) dedup.add(input.dedupKey);
            yield* SubscriptionRef.update(probe.events, (events) => [...events, event]);
            return { cursor, event };
          }),
        ).pipe(Effect.mapError(() => unsupported("journal probe")));
      return EventJournal.EventJournal.of({
        status: Effect.fail(unsupported("journal probe status")),
        read: () => Effect.fail(unsupported("journal probe read")),
        subscribe: () => Stream.fail(unsupported("journal probe subscribe")),
        emit: () => Effect.fail(unsupported("journal probe emit")),
        append,
        importPeerEntries: () => Effect.fail(unsupported("journal probe import")),
        listConsumers: () => Effect.fail(unsupported("journal probe consumers")),
        ackConsumer: () => Effect.fail(unsupported("journal probe ack")),
        deleteConsumer: () => Effect.fail(unsupported("journal probe delete")),
      });
    }),
  );

const makeJournalProbe = SubscriptionRef.make<ReadonlyArray<AutomationEvent>>([]).pipe(
  Effect.map((events) => new JournalProbe(events)),
);

const project = (id: ProjectId, workspaceRoot: string) => ({
  id,
  title: "Orchestrator test",
  workspaceRoot,
  repositoryIdentity: null,
  faviconPath: null,
  defaultModelSelection: modelSelection,
  defaultThreadEnvMode: null,
  scripts: [],
  createdAt: "2026-06-20T00:00:00.000Z",
  updatedAt: "2026-06-20T00:00:00.000Z",
  deletedAt: null,
});

/** Server settings a test starts from, for example the agent profiles that exist. */
export type EngineSettings = Parameters<typeof ServerSettings.layerTest>[0];

/**
 * Everything below the automation services, built once per test: SQLite, the
 * real orchestration engine driven by the scripted provider, thread launch,
 * and the journal probe. It stays up across simulated restarts of the runtime.
 */
export function makeEngineLayer(input: {
  readonly name: string;
  readonly cwd: string;
  readonly provider: ProviderProbe;
  readonly journal: JournalProbe;
  readonly settings?: EngineSettings | undefined;
}) {
  const database = SqlitePersistence.layerMemory;
  const registry = ProviderAdapterRegistry.layerFromAdapters([
    makeScriptedAdapter(input.provider, instanceId),
    makeScriptedAdapter(input.provider, otherInstanceId),
    makeScriptedAdapter(input.provider, unsupportedInstanceId, unsupportedDriver),
  ]);
  const serverConfig = Layer.effect(
    ServerConfig.ServerConfig,
    makeReplayServerConfig(input.name).pipe(Effect.orDie),
  ).pipe(Layer.provide(NodeServices.layer));
  const identity = Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
    getEnvironmentId: Effect.succeed(environmentId),
  });
  // The real session store, so an orchestrator's agent credential is issued,
  // authenticated and revoked exactly as on a server.
  const auth = EnvironmentAuth.layer.pipe(
    Layer.provide(database),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(identity),
    Layer.provide(serverConfig),
    Layer.provide(NodeServices.layer),
    Layer.orDie,
  );
  const engine = layerWithRegistry(
    {
      name: input.name,
      runtimePolicyOverride: {
        cwd: input.cwd,
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "readOnly",
          access: { type: "fullAccess" },
          networkAccess: false,
        },
      },
    },
    registry,
    { databaseLayer: database },
  );
  const threadManagement = ThreadManagement.layer.pipe(Layer.provide(engine));
  const receipts = CommandReceiptStore.layer.pipe(Layer.provide(database));
  const externalServices = Layer.mergeAll(
    WorktreeSetupTracker.layer,
    Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
    Layer.mock(TerminalManager.TerminalManager)({ close: () => Effect.void }),
    Layer.mock(ProjectService.ProjectService)({
      getById: (id) =>
        Effect.succeed(
          id === projectId || id === otherProjectId
            ? Option.some(project(id, input.cwd))
            : Option.none(),
        ),
    }),
    Layer.mock(GitWorkflow.GitWorkflowService)({}),
    Layer.succeed(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
      runForThread: () => Effect.succeed({ status: "no-script" as const }),
    }),
    Layer.mock(TextGeneration.TextGeneration)({}),
    ServerSettings.layerTest(input.settings ?? {}),
    layerProviderRegistryMock([
      providerSnapshot(instanceId),
      providerSnapshot(otherInstanceId),
      providerSnapshot(unsupportedInstanceId, unsupportedDriver),
    ]),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/projects",
      folderForThread: () => Effect.succeed(Option.none()),
    }),
  );
  const launch = ThreadLaunch.layer.pipe(
    Layer.provide(Layer.mergeAll(externalServices, threadManagement, receipts, IdAllocator.layer)),
  );
  return Layer.mergeAll(
    database,
    threadManagement,
    receipts,
    launch,
    externalServices,
    Scheduler.layer,
    makeJournalLayer(input.journal).pipe(Layer.provide(database)),
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(environmentId),
    }),
    identity,
    serverConfig,
    auth,
    NodeServices.layer,
  ).pipe(Layer.provide(NodeServices.layer));
}

/**
 * One life of the automation services over the engine layer. Providing it
 * again builds a new runtime over the same database, which is what a server
 * restart is; `overrides` swaps a dependency for that life only.
 */
export const makeAutomationLayerWith = <Overrides, OverrideError, OverrideRequirements>(
  overrides: Layer.Layer<Overrides, OverrideError, OverrideRequirements>,
) => {
  const responsibility = ResponsibilityService.layerCore;
  const runtime = OrchestratorRuntime.layerCore.pipe(Layer.provide(responsibility));
  const inbox = OrchestratorInbox.layerCore.pipe(Layer.provide(runtime));
  const service = OrchestratorService.layerCore.pipe(Layer.provide(inbox), Layer.provide(runtime));
  return Layer.fresh(
    Layer.mergeAll(responsibility, runtime, inbox, service).pipe(Layer.provide(overrides)),
  );
};

/** One life of the automation services with nothing swapped out. */
export const makeAutomationLayer = () => makeAutomationLayerWith(Layer.empty);

export const orchestratorInput = (
  overrides: Partial<OrchestratorUpsertInput> = {},
): OrchestratorUpsertInput => ({
  name: "Release captain",
  scope: "local",
  projectId,
  modelSelection,
  runtimeMode: "full-access",
  instructions: "",
  permissions: {
    actions: ["thread.read", "thread.send", "task.delegate", "request.answer"],
  },
  budget: {
    maxTokens: null,
    maxTurnsPerTask: null,
    maxTurnsPerHour: null,
    maxConcurrentChildren: null,
    maxChildrenPerTask: null,
    maxTaskAttempts: null,
    maxTurnDurationMs: null,
  },
  responsibilityOrder: [
    "explicit_owner",
    "managing_parent",
    "local_orchestrator",
    "global_orchestrator",
    "user",
  ],
  batchWindowMs: 0,
  ...overrides,
});

let journalEntryCursor = 0;

/** A journal entry as a hook would hand it to the inbox. */
export const journalEntry = (
  type: AutomationEvent["type"],
  scope: AutomationEventScope,
  payload: AutomationEvent["payload"] = {},
): AutomationJournalEntry => {
  journalEntryCursor += 1;
  return {
    cursor: journalEntryCursor,
    event: {
      version: AUTOMATION_CONTRACT_VERSION,
      eventId: EventId.make(`event:delivered:${journalEntryCursor}`),
      type,
      origin: { environmentId, kind: "service" },
      originCursor: journalEntryCursor,
      scope,
      aggregate: { kind: "custom", id: `delivered:${journalEntryCursor}`, revision: 0 },
      occurredAt: "2026-06-20T00:00:00.000Z",
      recordedAt: "2026-06-20T00:00:00.000Z",
      correlationId: `correlation:delivered:${journalEntryCursor}`,
      causationId: null,
      hops: 0,
      payload,
    },
  };
};

/** Waits for a stored thread event, replaying from the start so nothing is missed. */
export const awaitThreadEvent = (
  threadId: ThreadId,
  predicate: (event: OrchestrationV2DomainEvent) => boolean,
) =>
  ThreadManagement.ThreadManagementService.use((threads) =>
    threads.streamStoredEventsFrom({ threadId, afterSequence: 0 }).pipe(
      Stream.filter((stored) => predicate(stored.event)),
      Stream.runHead,
    ),
  );

/** Runs a test body against a fresh engine; the body provides each runtime life itself. */
export const withEngine = <A, E>(
  name: string,
  body: (context: {
    readonly cwd: string;
    readonly provider: ProviderProbe;
    readonly journal: JournalProbe;
  }) => Effect.Effect<A, E, Layer.Success<ReturnType<typeof makeEngineLayer>> | Scope.Scope>,
  options: { readonly settings?: EngineSettings } = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace(name);
      const provider = yield* makeProviderProbe;
      const journal = yield* makeJournalProbe;
      return yield* body({ cwd, provider, journal }).pipe(
        Effect.provide(
          makeEngineLayer({ name, cwd, provider, journal, settings: options.settings }),
        ),
      );
    }),
  );

/** Starts an ordinary thread whose first turn raises a runtime request of `kind`. */
export const startThreadWithRequest = Effect.fn("testkit.startThreadWithRequest")(
  function* (input: {
    readonly threadId: ThreadId;
    readonly kind: OrchestrationV2RuntimeRequest["kind"];
    readonly cwd: string;
    readonly projectId?: ProjectId;
  }) {
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* threads.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`command:${input.threadId}:create`),
      threadId: input.threadId,
      projectId: input.projectId ?? projectId,
      title: "Worker",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: input.cwd,
    });
    yield* threads.dispatch({
      type: "message.dispatch",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`command:${input.threadId}:start`),
      threadId: input.threadId,
      messageId: MessageId.make(`message:${input.threadId}:start`),
      text: `${REQUEST_PREFIX}${input.kind} please`,
      attachments: [],
      dispatchMode: { type: "start_immediately" },
    });
  },
);
