/**
 * Two or more complete environments in one test process.
 *
 * Each environment gets its own state directory, SQLite file, secret store,
 * environment id and real session store. What the fronts that own them have
 * not built yet (journal, delegated tasks, orchestrator inbox) is a small
 * recording layer whose state outlives a simulated restart. The network
 * between environments is the one test double of the federation code itself:
 * it authenticates the bearer token against the destination's real session
 * store, derives the caller with the production `callerFromSession`, enforces
 * the production scope table, round-trips every payload through its wire
 * schema, and can be told to refuse connections or lose a response.
 */
import {
  AUTOMATION_WS_METHODS,
  AuthAdministrativeScopes,
  AuthFederationPeerScope,
  type AutomationError,
  type AutomationJournalEntry,
  type DelegatedTask,
  EnvironmentId,
  EventId,
  type ExecutionEnvironmentDescriptor,
  FEDERATION_PROTOCOL_VERSION,
  type InboxEntry,
  InboxEntryId,
  PeerDeliverInput,
  PeerDeliverResult,
  PeerHelloInput,
  PeerHelloResult,
  type PeerPermissions,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as EnvironmentAuth from "../../../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as SessionStore from "../../../auth/SessionStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import { makeSqlitePersistenceLive } from "../../../persistence/Layers/Sqlite.ts";
import * as Scheduler from "../../../scheduling/Scheduler.ts";
import {
  type AutomationCaller,
  automationError,
  peerSessionSubject,
  unsupported,
} from "../../Caller.ts";
import * as DelegatedTaskService from "../../DelegatedTaskService.ts";
import * as EventJournal from "../../EventJournal.ts";
import * as OrchestratorInbox from "../../OrchestratorInbox.ts";
import * as PeerService from "../../PeerService.ts";
import { callerFromSession } from "../../rpcHandlers.ts";
import { AUTOMATION_RPC_REQUIRED_SCOPES } from "../../rpcScopes.ts";
import * as FederationReactor from "../FederationReactor.ts";
import * as PeerOrchestratorMessages from "../PeerOrchestratorMessages.ts";
import { eventTypeMatches } from "../PeerProtocol.ts";
import * as PeerStore from "../PeerStore.ts";
import * as PeerTransport from "../PeerTransport.ts";

/** State that belongs to an environment's disk, so it survives `restart`. */
export interface EnvironmentWorld {
  readonly id: EnvironmentId;
  readonly label: string;
  readonly origin: string;
  readonly baseDir: string;
  readonly journal: {
    readonly entries: Array<AutomationJournalEntry>;
    readonly dedup: Map<string, AutomationJournalEntry>;
  };
  readonly tasks: {
    readonly byId: Map<string, DelegatedTask>;
    /** Every `acceptRemote` call, including repeats. */
    acceptCalls: number;
    /** Tasks actually created: the number of executions. */
    created: number;
    readonly remoteStatuses: Array<DelegatedTask>;
    /** Errors `acceptRemote` fails with, one per call, before it works again. */
    readonly failures: Array<AutomationError>;
  };
  readonly inbox: { readonly entries: Array<InboxEntry> };
}

type EnvironmentServices =
  | FederationReactor.FederationReactor
  | PeerService.PeerService
  | PeerStore.PeerStore
  | EventJournal.EventJournal
  | EnvironmentAuth.EnvironmentAuth
  | SessionStore.SessionStore
  | ServerSecretStore.ServerSecretStore
  | ServerEnvironment.ServerEnvironment
  | ServerConfig.ServerConfig
  | PeerTransport.PeerTransport
  | SqlClient.SqlClient;

export interface RunningEnvironment {
  readonly world: EnvironmentWorld;
  readonly run: <A, E>(
    effect: Effect.Effect<A, E, EnvironmentServices | Scope.Scope>,
  ) => Effect.Effect<A, E, Scope.Scope>;
  /** Stops the process without any orderly hand-over, as a crash would. */
  readonly stop: Effect.Effect<void>;
}

export interface Network {
  readonly nodes: Map<string, Context.Context<EnvironmentServices>>;
  /** Origins nobody can reach. */
  readonly unreachable: Set<string>;
  /** Per origin: how many `deliver` calls are processed there and then lose their response. */
  readonly lostResponses: Map<string, number>;
  readonly helloOverrides: Map<string, (result: PeerHelloResult) => PeerHelloResult>;
  readonly descriptorOverrides: Map<string, Partial<PeerTransport.PeerDescriptor>>;
  /** Every call that reached an origin's handler. */
  readonly calls: Array<{
    readonly to: string;
    readonly method: "hello" | "deliver";
    readonly messages: number;
  }>;
}

export const makeNetwork = (): Network => ({
  nodes: new Map(),
  unreachable: new Set(),
  lostResponses: new Map(),
  helloOverrides: new Map(),
  descriptorOverrides: new Map(),
  calls: [],
});

export const operator: AutomationCaller = {
  kind: "client",
  subject: "test-operator",
  scopes: AuthAdministrativeScopes,
};

export const makeWorld = Effect.fn("makeWorld")(function* (name: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return {
    id: EnvironmentId.make(`env-${name}`),
    label: `Environment ${name}`,
    origin: `http://${name}.test:3773`,
    baseDir: yield* fileSystem.makeTempDirectoryScoped({ prefix: `t3-federation-${name}-` }),
    journal: { entries: [], dedup: new Map() },
    tasks: { byId: new Map(), acceptCalls: 0, created: 0, remoteStatuses: [], failures: [] },
    inbox: { entries: [] },
  } satisfies EnvironmentWorld;
});

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

// ---------------------------------------------------------------------------
// Recording layers for the services other fronts own

const journalLayer = (world: EnvironmentWorld) =>
  Layer.succeed(EventJournal.EventJournal, {
    status: Effect.map(nowIso, (observedAt) => ({
      environmentId: world.id,
      headCursor: world.journal.entries.length,
      oldestCursor: world.journal.entries.length === 0 ? null : 1,
      retainedEntries: world.journal.entries.length,
      observedAt,
    })),
    read: (_caller, input) =>
      Effect.map(nowIso, (observedAt) => {
        const after = input.afterCursor ?? 0;
        const window = world.journal.entries
          .filter((entry) => entry.cursor > after)
          .slice(0, input.limit ?? 100);
        const types = input.filter?.types;
        const origins = input.filter?.originEnvironmentIds;
        return {
          entries: window.filter(
            (entry) =>
              (types === undefined || eventTypeMatches(types, entry.event.type)) &&
              (origins === undefined || origins.includes(entry.event.origin.environmentId)),
          ),
          nextCursor: window.at(-1)?.cursor ?? after,
          status: {
            environmentId: world.id,
            headCursor: world.journal.entries.length,
            oldestCursor: world.journal.entries.length === 0 ? null : 1,
            retainedEntries: world.journal.entries.length,
            observedAt,
          },
        };
      }),
    subscribe: () => Stream.fail(unsupported("EventJournal.subscribe")),
    emit: (caller, input) =>
      Effect.map(nowIso, (now) => {
        const known = world.journal.dedup.get(`emit:${input.idempotencyKey}`);
        if (known !== undefined) return { entry: known, created: false };
        const cursor = world.journal.entries.length + 1;
        const eventId = EventId.make(`evt-${world.id}-${cursor}`);
        const entry: AutomationJournalEntry = {
          cursor,
          event: {
            version: 1,
            eventId,
            type: input.type,
            // Assigned here, from the authenticated caller: nothing in the input names an origin.
            origin: {
              environmentId: world.id,
              kind: "custom",
              actorId: caller.subject,
              ...(input.nodeId === undefined ? {} : { nodeId: input.nodeId }),
            },
            originCursor: cursor,
            scope: input.scope ?? {},
            aggregate: { kind: "custom", id: input.type, revision: 0 },
            occurredAt: now,
            recordedAt: now,
            correlationId: input.correlationId ?? eventId,
            causationId: input.causationId ?? null,
            hops: 0,
            payload: input.payload ?? {},
          },
        };
        world.journal.entries.push(entry);
        world.journal.dedup.set(`emit:${input.idempotencyKey}`, entry);
        return { entry, created: true };
      }),
    append: (events) =>
      Effect.map(nowIso, (now) =>
        events.map((event) => {
          const known =
            event.dedupKey === undefined ? undefined : world.journal.dedup.get(event.dedupKey);
          if (known !== undefined) return known;
          const cursor = world.journal.entries.length + 1;
          const eventId = EventId.make(`evt-${world.id}-${cursor}`);
          const entry: AutomationJournalEntry = {
            cursor,
            event: {
              version: 1,
              eventId,
              type: event.type,
              origin: { environmentId: world.id, ...event.origin },
              originCursor: cursor,
              scope: event.scope,
              aggregate: { ...event.aggregate, revision: 0 },
              occurredAt: event.occurredAt ?? now,
              recordedAt: now,
              correlationId: event.correlationId ?? event.causedBy?.correlationId ?? eventId,
              causationId: event.causedBy?.eventId ?? null,
              hops: event.causedBy === undefined ? 0 : event.causedBy.hops + 1,
              payload: event.payload,
              ...(event.refs === undefined ? {} : { refs: event.refs }),
            },
          };
          world.journal.entries.push(entry);
          if (event.dedupKey !== undefined) world.journal.dedup.set(event.dedupKey, entry);
          return entry;
        }),
      ),
    importPeerEntries: (entries) =>
      Effect.sync(() =>
        entries.flatMap((entry) => {
          const key = `import:${entry.event.origin.environmentId}:${entry.event.originCursor}`;
          if (world.journal.dedup.has(key)) return [];
          const imported = { cursor: world.journal.entries.length + 1, event: entry.event };
          world.journal.entries.push(imported);
          world.journal.dedup.set(key, imported);
          return [imported];
        }),
      ),
    listConsumers: () => Effect.fail(unsupported("EventJournal.listConsumers")),
    ackConsumer: () => Effect.fail(unsupported("EventJournal.ackConsumer")),
    deleteConsumer: () => Effect.fail(unsupported("EventJournal.deleteConsumer")),
  });

const tasksLayer = (world: EnvironmentWorld) =>
  Layer.succeed(DelegatedTaskService.DelegatedTaskService, {
    delegate: () => Effect.fail(unsupported("DelegatedTaskService.delegate")),
    list: () => Effect.fail(unsupported("DelegatedTaskService.list")),
    threadTree: () => Effect.fail(unsupported("DelegatedTaskService.threadTree")),
    get: (_caller, taskId) => {
      const task = world.tasks.byId.get(taskId);
      return task === undefined
        ? Effect.fail(automationError("NOT_FOUND", `No task ${taskId}.`))
        : Effect.succeed(task);
    },
    update: (_caller, input) =>
      Effect.gen(function* () {
        const task = world.tasks.byId.get(input.taskId);
        if (task === undefined) {
          return yield* automationError("NOT_FOUND", `No task ${input.taskId}.`);
        }
        const next: DelegatedTask =
          input.action.type === "cancel" && task.status !== "cancelled"
            ? { ...task, status: "cancelled", revision: task.revision + 1 }
            : task;
        world.tasks.byId.set(task.id, next);
        return next;
      }),
    acceptRemote: (_caller, task) =>
      Effect.gen(function* () {
        world.tasks.acceptCalls += 1;
        const failure = world.tasks.failures.shift();
        if (failure !== undefined) return yield* failure;
        const known = world.tasks.byId.get(task.id);
        if (known !== undefined) return known;
        world.tasks.created += 1;
        const accepted: DelegatedTask = {
          ...task,
          status: "accepted",
          threadId: ThreadId.make(`thread-${task.id}`),
          revision: task.revision + 1,
          observedAt: yield* nowIso,
        };
        world.tasks.byId.set(task.id, accepted);
        return accepted;
      }),
    applyRemoteStatus: (_caller, task) =>
      Effect.sync(() => {
        world.tasks.remoteStatuses.push(task);
        world.tasks.byId.set(task.id, task);
        return task;
      }),
  });

const inboxLayer = (world: EnvironmentWorld) =>
  Layer.succeed(OrchestratorInbox.OrchestratorInbox, {
    deliver: (input) =>
      Effect.map(nowIso, (now) => {
        const known = world.inbox.entries.find(
          (entry) =>
            entry.orchestratorId === input.orchestratorId && entry.dedupKey === input.dedupKey,
        );
        if (known !== undefined) return { entry: known, created: false };
        const entry: InboxEntry = {
          ...input,
          id: InboxEntryId.make(`inbox-${world.inbox.entries.length + 1}`),
          status: "pending",
          reservedByRunId: null,
          receivedAt: now,
          updatedAt: now,
        };
        world.inbox.entries.push(entry);
        return { entry, created: true };
      }),
  });

// ---------------------------------------------------------------------------
// Network

const viaWire =
  <S extends Schema.Top>(schema: S) =>
  (value: S["Type"]) => {
    const codec = Schema.fromJsonString(schema);
    return Schema.encodeEffect(codec)(value).pipe(
      Effect.flatMap(Schema.decodeEffect(codec)),
      Effect.orDie,
    );
  };

const transportLayer = (network: Network) =>
  Layer.succeed(PeerTransport.PeerTransport, {
    describe: (httpBaseUrl) =>
      Effect.gen(function* () {
        const node = network.nodes.get(httpBaseUrl);
        if (node === undefined || network.unreachable.has(httpBaseUrl)) {
          return yield* new PeerTransport.PeerTransportError({
            reason: "unreachable",
            origin: httpBaseUrl,
          });
        }
        const descriptor = yield* Context.get(node, ServerEnvironment.ServerEnvironment)
          .getDescriptor;
        return {
          environmentId: descriptor.environmentId,
          label: descriptor.label,
          automation: descriptor.capabilities.automation === true,
          federationProtocolVersions: descriptor.capabilities.federationProtocolVersions ?? [],
          ...network.descriptorOverrides.get(httpBaseUrl),
        };
      }),
    exchangePairing: (httpBaseUrl, credential) =>
      Effect.gen(function* () {
        const node = network.nodes.get(httpBaseUrl);
        if (node === undefined || network.unreachable.has(httpBaseUrl)) {
          return yield* new PeerTransport.PeerTransportError({
            reason: "unreachable",
            origin: httpBaseUrl,
          });
        }
        const result = yield* Context.get(node, EnvironmentAuth.EnvironmentAuth)
          .exchangeBootstrapCredentialForAccessToken(credential, [AuthFederationPeerScope], {
            deviceType: "bot",
          })
          .pipe(
            Effect.mapError(
              () =>
                new PeerTransport.PeerTransportError({
                  reason: "unauthorized",
                  origin: httpBaseUrl,
                }),
            ),
          );
        return result.access_token;
      }),
    open: (httpBaseUrl, token) =>
      Effect.gen(function* () {
        const unreachable = new PeerTransport.PeerTransportError({
          reason: "unreachable",
          origin: httpBaseUrl,
        });
        const unauthorized = new PeerTransport.PeerTransportError({
          reason: "unauthorized",
          origin: httpBaseUrl,
        });
        const reach = Effect.suspend(() => {
          const node = network.nodes.get(httpBaseUrl);
          return node === undefined || network.unreachable.has(httpBaseUrl)
            ? Effect.fail(unreachable)
            : Effect.succeed(node);
        });
        // As on a real socket, the session is verified once, when the link opens.
        const session = yield* Effect.flatMap(reach, (node) =>
          Context.get(node, SessionStore.SessionStore)
            .verify(token)
            .pipe(Effect.mapError(() => unauthorized)),
        );
        const caller = callerFromSession(session);
        const authorize = (method: keyof typeof AUTOMATION_RPC_REQUIRED_SCOPES) =>
          session.scopes.includes(AUTOMATION_RPC_REQUIRED_SCOPES[method])
            ? Effect.void
            : Effect.fail(unauthorized);
        return {
          hello: (input) =>
            Effect.gen(function* () {
              const node = yield* reach;
              yield* authorize(AUTOMATION_WS_METHODS.peerHello);
              network.calls.push({ to: httpBaseUrl, method: "hello", messages: 0 });
              const result = yield* Context.get(node, PeerService.PeerService)
                .hello(caller, yield* viaWire(PeerHelloInput)(input))
                .pipe(Effect.flatMap(viaWire(PeerHelloResult)));
              return network.helloOverrides.get(httpBaseUrl)?.(result) ?? result;
            }),
          deliver: (input) =>
            Effect.gen(function* () {
              const node = yield* reach;
              yield* authorize(AUTOMATION_WS_METHODS.peerDeliver);
              network.calls.push({
                to: httpBaseUrl,
                method: "deliver",
                messages: input.messages.length,
              });
              const result = yield* Context.get(node, PeerService.PeerService)
                .deliver(caller, yield* viaWire(PeerDeliverInput)(input))
                .pipe(Effect.flatMap(viaWire(PeerDeliverResult)));
              const lost = network.lostResponses.get(httpBaseUrl) ?? 0;
              if (lost > 0) {
                network.lostResponses.set(httpBaseUrl, lost - 1);
                return yield* unreachable;
              }
              return result;
            }),
        } satisfies PeerTransport.PeerLink;
      }),
  });

// ---------------------------------------------------------------------------
// Environments

const descriptorOf = (world: EnvironmentWorld): ExecutionEnvironmentDescriptor => ({
  environmentId: world.id,
  label: world.label,
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.0-test",
  capabilities: {
    repositoryIdentity: true,
    automation: true,
    federationProtocolVersions: [FEDERATION_PROTOCOL_VERSION],
  },
});

const environmentLayer = (world: EnvironmentWorld, network: Network) =>
  FederationReactor.layer.pipe(
    Layer.provideMerge(PeerService.layerWithoutTransport),
    Layer.provideMerge(
      Layer.mergeAll(
        PeerStore.layer,
        transportLayer(network),
        journalLayer(world),
        tasksLayer(world),
        inboxLayer(world),
        PeerOrchestratorMessages.layerUnsupported,
        // Tests drive passes themselves; nothing runs on a timer.
        Layer.succeed(Scheduler.Scheduler, { register: () => Effect.void }),
      ),
    ),
    Layer.provideMerge(EnvironmentAuth.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        ServerSecretStore.layer,
        Layer.unwrap(
          Effect.map(ServerConfig.ServerConfig, (config) =>
            makeSqlitePersistenceLive(config.dbPath),
          ),
        ),
        Layer.succeed(ServerEnvironment.ServerEnvironment, {
          getEnvironmentId: Effect.succeed(world.id),
          getDescriptor: Effect.succeed(descriptorOf(world)),
        }),
        Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(world.id),
        }),
      ),
    ),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), world.baseDir)),
  );

/** Starts an environment on its state directory and joins it to the network. */
export const boot = Effect.fn("boot")(function* (world: EnvironmentWorld, network: Network) {
  const scope = yield* Scope.make();
  const context = yield* Layer.buildWithScope(environmentLayer(world, network), scope).pipe(
    Effect.orDie,
  );
  network.nodes.set(world.origin, context);
  const stop = Effect.suspend(() => {
    if (network.nodes.get(world.origin) === context) network.nodes.delete(world.origin);
    return Scope.close(scope, Exit.void);
  });
  yield* Effect.addFinalizer(() => stop);
  return {
    world,
    run: (effect) => Effect.provide(effect, context),
    stop,
  } satisfies RunningEnvironment;
});

/**
 * The operator steps of one direction of a pairing: the remote side mints a
 * credential for `from`, and `from` adds the remote with it.
 */
export const addPeer = Effect.fn("addPeer")(function* (
  from: RunningEnvironment,
  to: RunningEnvironment,
  permissions: PeerPermissions,
) {
  const link = yield* to.run(
    Effect.flatMap(EnvironmentAuth.EnvironmentAuth, (auth) =>
      auth.createPairingLink({
        subject: peerSessionSubject(from.world.id),
        scopes: [AuthFederationPeerScope],
        label: `peer ${from.world.label}`,
      }),
    ),
  );
  return yield* from.run(
    Effect.flatMap(PeerService.PeerService, (peers) =>
      peers.add(operator, {
        name: to.world.label,
        pairingUrl: `${to.world.origin}/pair#token=${link.credential}`,
        permissions,
      }),
    ),
  );
});

export const noPermissions: PeerPermissions = { inbound: [], forwardEventTypes: [] };

/** Pairs both directions, which is what delegation with a status report back needs. */
export const pair = Effect.fn("pair")(function* (
  left: RunningEnvironment,
  right: RunningEnvironment,
  permissions: {
    /** What `left` lets `right` ask of it, and what it forwards to `right`. */
    readonly left?: PeerPermissions;
    readonly right?: PeerPermissions;
  } = {},
) {
  yield* addPeer(left, right, permissions.left ?? noPermissions);
  yield* addPeer(right, left, permissions.right ?? noPermissions);
});

export const syncPeer = (from: RunningEnvironment, to: RunningEnvironment) =>
  from.run(
    Effect.flatMap(FederationReactor.FederationReactor, (reactor) => reactor.syncPeer(to.world.id)),
  );

export const processInbox = (environment: RunningEnvironment) =>
  environment.run(
    Effect.flatMap(FederationReactor.FederationReactor, (reactor) => reactor.processInbox),
  );
