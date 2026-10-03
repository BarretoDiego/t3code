// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadShell,
  type ServerProvider,
  type ServerSettings,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadHandoffId,
  ThreadHandoffManifest,
  ThreadId,
  type ThreadHandoffRecord,
  type ThreadHandoffDestination,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import { runSnapshotGit } from "../workspace/ProjectSyncGitSnapshot.ts";
import { getNativeHandoffDriver } from "./NativeHandoffDrivers.ts";
import { openTransferredClaudeSession } from "./TransferredClaudeSession.ts";
import { makeHandoffJournal } from "./HandoffJournal.ts";
import {
  createThreadHandoffService,
  type HandoffThread,
  type ThreadHandoffServicePorts,
} from "./ThreadHandoffService.ts";

const now = "2026-09-08T12:00:00.000Z";
const source = EnvironmentId.make("work-mac");
const destination = EnvironmentId.make("home-server");
const record: ThreadHandoffRecord = {
  handoffId: ThreadHandoffId.make("transfer-1"),
  owner: { threadId: ThreadId.make("thread-1"), environmentId: source, generation: 0 },
  destinationEnvironmentId: destination,
  localEnvironmentId: source,
  phase: "preflighting",
  revision: 0,
  createdAt: now,
  updatedAt: now,
  failure: null,
};
const manifest: ThreadHandoffManifest = {
  version: 1,
  handoffId: record.handoffId,
  owner: record.owner,
  destinationEnvironmentId: destination,
  createdAt: now,
  projects: [],
  provider: {
    driver: ProviderDriverKind.make("claudeAgent"),
    mode: "native",
    directory: "provider",
    sessionId: "11111111-1111-4111-8111-111111111111",
  },
  threadFile: "thread.json",
  files: [],
};
const target: ThreadHandoffDestination = {
  environmentId: destination,
  providerInstanceId: ProviderInstanceId.make("claude-destination"),
  source: {
    owner: record.owner,
    projectId: ProjectId.make("project"),
    providerInstanceId: ProviderInstanceId.make("claude-source"),
    driver: manifest.provider.driver,
    version: "1.0",
    sessionId: manifest.provider.sessionId!,
  },
  projects: [],
};
// Unused ports throw immediately: transaction metadata operations must never
// touch a native provider, project checkout, or credential store.
function unused<T>(): T {
  return new Proxy(
    {},
    {
      get(_target, key) {
        throw new Error(`Unexpected dependency: ${String(key)}`);
      },
    },
  ) as T;
}
const encodeUnknown = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeManifest = Schema.encodeSync(Schema.fromJsonString(ThreadHandoffManifest));
const fixture = Effect.gen(function* () {
  const stateDir = yield* Effect.acquireRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "handoff-rpc-"))),
    (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
  const journal = yield* makeHandoffJournal;
  const changes = yield* PubSub.unbounded<ThreadHandoffRecord>();
  const ports: ThreadHandoffServicePorts = {
    config: { stateDir },
    environmentId: source,
    journal,
    changes,
    settings: unused(),
    query: unused(),
    history: unused(),
    instances: unused(),
    safePoint: unused(),
    secretStore: unused(),
  };
  const pendingPath = NodePath.join(stateDir, "handoffs", record.handoffId, "request.json");
  const writePending = Effect.promise(async () => {
    await NodeFSP.mkdir(NodePath.dirname(pendingPath), { recursive: true });
    await NodeFSP.writeFile(
      pendingPath,
      encodeUnknown({
        destination: target,
        manifest,
        ready: false,
        nativeInstalled: false,
      }),
    );
  });
  return { ports, journal, writePending, service: createThreadHandoffService(ports) };
});
const test = <E>(
  body: Effect.Effect<
    void,
    E,
    import("effect/Scope").Scope | import("effect/unstable/sql/SqlClient").SqlClient
  >,
) => body.pipe(Effect.scoped, Effect.provide(SqlitePersistenceMemory));

it.effect("rejecting an unacknowledged destination reservation is idempotent", () =>
  test(
    Effect.gen(function* () {
      const { service, journal } = yield* fixture;
      expect(yield* service.handle({ operation: "reject", handoffId: record.handoffId })).toEqual(
        {},
      );
      expect(yield* journal.head(record.owner.threadId)).toBeNull();
    }),
  ),
);

it.effect("commit persists departure across service recreation and refuses rollback", () =>
  test(
    Effect.gen(function* () {
      const f = yield* fixture;
      let current = yield* f.journal.begin(record);
      for (const phase of ["pausing", "checkpointing", "syncingProjects"] as const)
        current = yield* f.journal.advance({
          handoffId: record.handoffId,
          expectedRevision: current.revision,
          phase,
          updatedAt: now,
        });
      yield* f.writePending;
      const receipt = {
        handoffId: record.handoffId,
        environmentId: destination,
        sessionId: manifest.provider.sessionId!,
        manifestHash: NodeCrypto.createHash("sha256")
          .update(encodeManifest(manifest))
          .digest("hex"),
      };
      const subscribed = yield* Deferred.make<void>();
      const observed = yield* f.service.watch(record.owner.threadId).pipe(
        Stream.tap(() => Deferred.succeed(subscribed, undefined)),
        Stream.take(5),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(subscribed);
      const committed = yield* f.service.handle({ operation: "commit", receipt });
      expect((yield* Fiber.join(observed)).map((item) => item?.phase)).toEqual([
        "syncingProjects",
        "transferringSession",
        "verifying",
        "ready",
        "committed",
      ]);
      expect(committed.record?.phase).toBe("committed");
      const recovered = createThreadHandoffService(f.ports);
      expect(yield* recovered.handle({ operation: "commit", receipt })).toEqual(committed);
      expect(
        yield* Effect.flip(
          recovered.handle({ operation: "rollback", handoffId: record.handoffId }),
        ),
      ).toMatchObject({ code: "conflict" });
      expect(
        (yield* recovered.handle({ operation: "complete", handoffId: record.handoffId })).record
          ?.phase,
      ).toBe("completed");
      expect((yield* f.journal.head(record.owner.threadId))?.phase).toBe("completed");
    }),
  ),
);

it.effect("a mismatched readiness receipt cannot release source ownership", () =>
  test(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.journal.begin(record);
      yield* f.writePending;
      expect(
        yield* Effect.flip(
          f.service.handle({
            operation: "commit",
            receipt: {
              handoffId: record.handoffId,
              environmentId: destination,
              sessionId: manifest.provider.sessionId!,
              manifestHash: "wrong",
            },
          }),
        ),
      ).toMatchObject({ code: "verificationFailed" });
      expect((yield* f.journal.head(record.owner.threadId))?.phase).toBe("preflighting");
    }),
  ),
);

it.effect(
  "activation rejects a stale generation before touching destination files or providers",
  () =>
    test(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.journal.reserveIncoming({ ...record, localEnvironmentId: destination });
        const service = createThreadHandoffService({ ...f.ports, environmentId: destination });
        expect(
          yield* Effect.flip(
            service.handle({
              operation: "activate",
              record: { ...record, phase: "committed", owner: { ...record.owner, generation: 7 } },
            }),
          ),
        ).toMatchObject({ code: "notOwner" });
      }),
    ),
);

it.effect("watch hydrates durable ownership after reconnect without polling", () =>
  test(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.journal.begin(record);
      expect(
        yield* Stream.runCollect(f.service.watch(record.owner.threadId).pipe(Stream.take(1))),
      ).toEqual([record]);
    }),
  ),
);

function stub<T>(values: Partial<T>): T {
  return new Proxy(values, {
    get(target, key) {
      if (Reflect.has(target, key)) return Reflect.get(target, key);
      throw new Error(`Unexpected dependency: ${String(key)}`);
    },
  }) as T;
}
const at = DateTime.makeUnsafe(now);
const providerThreadId = ProviderThreadId.make("provider-thread-1");
const appThread = (
  overrides: Partial<OrchestrationV2AppThread> = {},
): OrchestrationV2AppThread => ({
  createdBy: "user",
  creationSource: "web",
  id: record.owner.threadId,
  projectId: target.source.projectId,
  title: "Scheduling",
  providerInstanceId: target.source.providerInstanceId,
  modelSelection: { instanceId: target.source.providerInstanceId, model: "sonnet" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "feature/private",
  worktreePath: null,
  activeProviderThreadId: providerThreadId,
  lineage: {
    parentThreadId: null,
    relationshipToParent: null,
    rootThreadId: record.owner.threadId,
  },
  forkedFrom: null,
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
  ...overrides,
});
const stored = (
  sequence: number,
  event: Omit<OrchestrationV2DomainEvent, "id" | "threadId" | "occurredAt">,
): OrchestrationV2StoredEvent => ({
  sequence,
  commandId: null,
  event: {
    ...event,
    id: EventId.make(`event-${sequence}`),
    threadId: record.owner.threadId,
    occurredAt: at,
  } as OrchestrationV2DomainEvent,
});
const sourceHistory = (driver: ProviderDriverKind): OrchestrationV2StoredEvent[] => [
  stored(1, { type: "thread.created", payload: appThread() }),
  stored(2, {
    type: "thread.model-selection-updated",
    payload: appThread({
      modelSelection: { instanceId: target.source.providerInstanceId, model: "opus" },
    }),
  }),
  stored(3, {
    type: "thread.runtime-mode-updated",
    payload: appThread({
      modelSelection: { instanceId: target.source.providerInstanceId, model: "opus" },
      runtimeMode: "approval-required",
    }),
  }),
  stored(4, {
    type: "provider-session.detached",
    providerInstanceId: target.source.providerInstanceId,
    payload: {
      providerSessionId: ProviderSessionId.make("source-session"),
      detachedAt: at,
    },
  }),
  stored(5, {
    type: "provider-thread.updated",
    driver,
    providerInstanceId: target.source.providerInstanceId,
    payload: {
      id: providerThreadId,
      driver,
      providerInstanceId: target.source.providerInstanceId,
      providerSessionId: ProviderSessionId.make("source-session"),
      appThreadId: record.owner.threadId,
      ownerNodeId: null,
      nativeThreadRef: { driver, nativeId: manifest.provider.sessionId!, strength: "strong" },
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: 1,
      lastRunOrdinal: 1,
      handoffIds: [],
      forkedFrom: null,
      createdAt: at,
      updatedAt: at,
    },
  }),
];
const makeTwoServices = (contextDriver?: string) =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const sourceDriver = contextDriver ? ProviderDriverKind.make("codex") : target.source.driver;
    const sourceRoot = NodePath.join(f.ports.config.stateDir, "mac-repository");
    const destinationRoot = NodePath.join(f.ports.config.stateDir, "linux-repository");
    yield* Effect.promise(async () => {
      await NodeFSP.mkdir(sourceRoot);
      await runSnapshotGit(sourceRoot, ["init", "-b", "feature/private"]);
      await runSnapshotGit(sourceRoot, ["config", "user.name", "Handoff test"]);
      await runSnapshotGit(sourceRoot, ["config", "user.email", "test@example.invalid"]);
      await NodeFSP.writeFile(NodePath.join(sourceRoot, "file.txt"), "original\n");
      await runSnapshotGit(sourceRoot, ["add", "."]);
      await runSnapshotGit(sourceRoot, ["commit", "-m", "Local commit"]);
      await runSnapshotGit(sourceRoot, ["clone", "--no-local", sourceRoot, destinationRoot]);
      await NodeFSP.writeFile(NodePath.join(sourceRoot, "file.txt"), "staged\n");
      await runSnapshotGit(sourceRoot, ["add", "file.txt"]);
      await NodeFSP.writeFile(NodePath.join(sourceRoot, "file.txt"), "unstaged\n");
      await NodeFSP.writeFile(NodePath.join(sourceRoot, "notes.txt"), "untracked\n");
    });
    const destinationDb = yield* Layer.build(Layer.fresh(SqlitePersistenceMemory));
    const destinationJournal = yield* makeHandoffJournal.pipe(Effect.provide(destinationDb));
    const destinationChanges = yield* PubSub.unbounded<ThreadHandoffRecord>();
    const events = sourceHistory(sourceDriver);
    const thread: HandoffThread = {
      id: record.owner.threadId,
      projectId: target.source.projectId,
      worktreePath: null,
      providerInstanceId: target.source.providerInstanceId,
      providerThread: {
        providerInstanceId: target.source.providerInstanceId,
        driver: sourceDriver,
        nativeThreadId: contextDriver ? null : manifest.provider.sessionId!,
      },
    };
    const status: ServerProvider = {
      instanceId: target.source.providerInstanceId,
      driver: target.source.driver,
      installed: true,
      models: [{ slug: "opus", name: "Test model", isCustom: false, capabilities: null }],
      slashCommands: [],
      skills: [],
      enabled: true,
      version: "1.0",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: now,
    };
    const instance = stub<ProviderInstance>({
      enabled: true,
      driverKind: sourceDriver,
      snapshot: stub<ProviderInstance["snapshot"]>({
        refresh: Effect.succeed(
          contextDriver
            ? {
                ...status,
                driver: sourceDriver,
                installed: false,
                version: null,
                auth: { status: "unauthenticated" },
              }
            : status,
        ),
      }),
    });
    const project = (cwd: string) => ({
      id: thread.projectId,
      title: "Project",
      workspaceRoot: cwd,
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    });
    const counters = { freeze: 0, wrongResume: false, imports: 0 };
    const nativeDriver: typeof getNativeHandoffDriver = (input) => {
      const driver = getNativeHandoffDriver(input, {
        claudeExportSession: async (id, store) => {
          await store.append({ projectKey: "mac-source", sessionId: id }, [
            { type: "user", uuid: "native-user", message: { content: "Keep the same session" } },
            {
              type: "system",
              subtype: "compact_boundary",
              compactMetadata: { trigger: "auto", preTokens: 30000 },
            },
          ]);
        },
      });
      return driver
        ? {
            ...driver,
            resumable: async (request) =>
              !counters.wrongResume && (await driver.resumable(request)),
          }
        : undefined;
    };
    const destinationState = NodePath.join(f.ports.config.stateDir, "destination-state");
    const common = {
      nativeDriver,
      settings: { getSettings: Effect.succeed(stub<ServerSettings>({ providerInstances: {} })) },
      instances: { getInstance: () => Effect.succeed(instance) },
    };
    const sourcePorts: ThreadHandoffServicePorts = {
      ...f.ports,
      ...common,
      query: {
        getThread: () => Effect.succeed(Option.some(thread)),
        getProject: () => Effect.succeed(Option.some(project(sourceRoot))),
      },
      history: {
        read: ({ throughSequence }) =>
          Effect.succeed(
            events.filter(
              (event) => throughSequence === undefined || event.sequence <= throughSequence,
            ),
          ),
        importThread: () => Effect.die(new Error("The source never imports history.")),
      },
      safePoint: {
        waitForCurrentTurn: () => Effect.die(new Error("Unexpected wait")),
        freeze: () =>
          Effect.sync(() => {
            counters.freeze++;
            return {
              thread: stub<OrchestrationV2ThreadShell>({
                projectId: thread.projectId,
                worktreePath: null,
              }),
              sequence: events.length,
            };
          }),
      },
    };
    let activatedThread: HandoffThread | undefined;
    let imported: ReadonlyArray<OrchestrationV2DomainEvent> = [];
    const destinationPorts: ThreadHandoffServicePorts = {
      ...f.ports,
      ...common,
      instances: {
        getInstance: () =>
          Effect.succeed(
            stub<ProviderInstance>({
              enabled: true,
              driverKind: contextDriver ? ProviderDriverKind.make(contextDriver) : status.driver,
              snapshot: stub<ProviderInstance["snapshot"]>({
                refresh: Effect.succeed({
                  ...status,
                  driver: contextDriver ? ProviderDriverKind.make(contextDriver) : status.driver,
                }),
              }),
            }),
          ),
      },
      config: { stateDir: destinationState },
      environmentId: destination,
      journal: destinationJournal,
      changes: destinationChanges,
      query: {
        getThread: () => Effect.sync(() => Option.fromUndefinedOr(activatedThread)),
        getProject: () => Effect.succeed(Option.some(project(destinationRoot))),
      },
      history: {
        read: () => Effect.succeed([]),
        importThread: (input) =>
          Effect.gen(function* () {
            expect(input.events[0]?.type).toBe("thread.created");
            expect(input.threadId).toBe(thread.id);
            yield* destinationJournal.acceptIncoming(input.record).pipe(Effect.orDie);
            const latest = input.events.findLast((event) => event.type.startsWith("thread."));
            if (!latest || !("modelSelection" in latest.payload))
              throw new Error("Missing thread configuration");
            const payload = latest.payload as OrchestrationV2AppThread;
            activatedThread = {
              id: thread.id,
              projectId: payload.projectId,
              worktreePath: payload.worktreePath,
              providerInstanceId: payload.providerInstanceId,
              providerThread: null,
            };
            imported = input.events;
            counters.imports++;
          }),
      },
    };
    const sourceService = createThreadHandoffService(sourcePorts);
    const destinationService = createThreadHandoffService(destinationPorts);
    const inspected = yield* sourceService.handle({ operation: "inspect", threadId: thread.id });
    if (!inspected.source) throw new Error("Missing repository inspection");
    const checked = yield* destinationService.handle({
      operation: "preflight",
      destination: {
        ...target,
        ...(contextDriver
          ? {
              transferMode: "context" as const,
              modelSelection: { instanceId: target.providerInstanceId, model: "opus" },
            }
          : {}),
        source: inspected.source,
        projects: [{ sourceProjectId: thread.projectId, destinationProjectId: thread.projectId }],
      },
    });
    if (!checked.destination) throw new Error("Missing repository preflight");
    const destinationMapping = checked.destination;
    const prepare = Effect.gen(function* () {
      yield* destinationService.handle({ operation: "preflight", destination: destinationMapping });
      const captured = yield* sourceService.handle({
        operation: "prepareSource",
        handoffId: record.handoffId,
        destination: destinationMapping,
        mode: "idle",
      });
      if (!captured.manifest) throw new Error("Missing source manifest");
      expect(captured.manifest.projects[0]?.git.bundle).toBeNull();
      yield* destinationService.handle({
        operation: "prepareDestination",
        manifest: captured.manifest,
        destination: destinationMapping,
      });
      yield* Effect.promise(() =>
        NodeFSP.cp(
          NodePath.join(sourcePorts.config.stateDir, "handoffs", record.handoffId, "payload"),
          NodePath.join(destinationState, "handoffs", record.handoffId, "payload"),
          { recursive: true },
        ),
      );
    });
    return {
      ...f,
      sourcePorts,
      destinationPorts,
      sourceService,
      destinationService,
      destinationJournal,
      counters,
      prepare,
      sourceRoot,
      destinationState,
      destinationMapping,
      events,
      imported: () => imported,
    };
  });
const twoServices = makeTwoServices();

it.effect(
  "two services preserve dirty Git and native session identity through restart activation",
  () =>
    test(
      Effect.gen(function* () {
        const f = yield* twoServices;
        yield* f.prepare;
        const verified = yield* f.destinationService.handle({
          operation: "verify",
          handoffId: record.handoffId,
        });
        if (!verified.ready) throw new Error("Missing destination receipt");
        expect(
          yield* Effect.promise(() =>
            openTransferredClaudeSession({
              stateDir: f.destinationState,
              threadId: record.owner.threadId,
              sessionId: manifest.provider.sessionId!,
            }),
          ),
        ).toBeDefined();
        const committed = yield* f.sourceService.handle({
          operation: "commit",
          receipt: verified.ready,
        });
        if (!committed.record) throw new Error("Missing commit");
        // Process memory was lost; the persisted snapshot remains.
        const recovered = createThreadHandoffService(f.destinationPorts);
        yield* recovered.handle({ operation: "activate", record: committed.record });
        expect(f.counters.imports).toBe(1);
        const imported = f.imported();
        // Environment-local provider sessions never transfer.
        expect(imported.some((event) => event.type.startsWith("provider-session."))).toBe(false);
        const providerThread = imported.find((event) => event.type === "provider-thread.updated");
        // The native session resumes on the destination instance with a fresh process.
        expect(providerThread?.payload).toMatchObject({
          providerInstanceId: target.providerInstanceId,
          providerSessionId: null,
          nativeThreadRef: { nativeId: manifest.provider.sessionId },
        });
        expect(imported.at(-2)?.payload).toMatchObject({
          providerInstanceId: target.providerInstanceId,
          modelSelection: { instanceId: target.providerInstanceId, model: "opus" },
          runtimeMode: "approval-required",
          worktreePath: NodePath.join(
            f.destinationState,
            "handoff-workspaces",
            record.handoffId,
            "0",
          ),
        });
        const archive = NodePath.join(f.destinationState, "handoffs", record.handoffId, "payload");
        expect(
          yield* Effect.promise(() =>
            NodeFSP.access(archive).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false);
        yield* createThreadHandoffService(f.destinationPorts).handle({
          operation: "activate",
          record: committed.record,
        });
        expect(f.counters.imports).toBe(1);
        expect((yield* f.destinationJournal.head(record.owner.threadId))?.phase).toBe("completed");
        yield* f.destinationJournal.begin({
          ...record,
          handoffId: ThreadHandoffId.make("move-again"),
          owner: { threadId: record.owner.threadId, environmentId: destination, generation: 1 },
          localEnvironmentId: destination,
          destinationEnvironmentId: EnvironmentId.make("third-node"),
        });
        expect(
          yield* Effect.flip(recovered.handle({ operation: "activate", record: committed.record })),
        ).toMatchObject({ code: "notOwner" });
        const restored = NodePath.join(
          f.destinationState,
          "handoff-workspaces",
          record.handoffId,
          "0",
        );
        for (const args of [
          ["status", "--porcelain=v1", "-z"],
          ["diff", "--binary"],
          ["diff", "--cached", "--binary"],
          ["rev-parse", "HEAD"],
        ]) {
          const actual = yield* Effect.promise(() => runSnapshotGit(restored, args));
          expect(actual).toEqual(yield* Effect.promise(() => runSnapshotGit(f.sourceRoot, args)));
        }
      }),
    ),
);

it.effect("a wrong native resume is rejected, then rollback leaves source Git unchanged", () =>
  test(
    Effect.gen(function* () {
      const f = yield* twoServices;
      yield* f.prepare;
      f.counters.wrongResume = true;
      expect(
        yield* Effect.flip(
          f.destinationService.handle({ operation: "verify", handoffId: record.handoffId }),
        ),
      ).toMatchObject({ code: "verificationFailed" });
      yield* f.destinationService.handle({ operation: "reject", handoffId: record.handoffId });
      expect(
        yield* Effect.promise(() =>
          openTransferredClaudeSession({
            stateDir: f.destinationState,
            threadId: record.owner.threadId,
            sessionId: manifest.provider.sessionId!,
          }),
        ),
      ).toBeUndefined();
      expect(
        (yield* f.sourceService.handle({ operation: "rollback", handoffId: record.handoffId }))
          .record?.phase,
      ).toBe("failed");
      expect(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(f.sourceRoot, "file.txt"), "utf8"),
        ),
      ).toBe("unstaged\n");
    }),
  ),
);

it.effect("retrying native verification replaces only its own preparation", () =>
  test(
    Effect.gen(function* () {
      const f = yield* twoServices;
      yield* f.prepare;
      f.counters.wrongResume = true;
      yield* Effect.flip(
        f.destinationService.handle({ operation: "verify", handoffId: record.handoffId }),
      );
      f.counters.wrongResume = false;
      const retried = yield* f.destinationService.handle({
        operation: "verify",
        handoffId: record.handoffId,
      });
      expect(retried.ready?.sessionId).toBe(manifest.provider.sessionId);
      expect(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(f.sourceRoot, "file.txt"), "utf8"),
        ),
      ).toBe("unstaged\n");
    }),
  ),
);

it.effect("cancelling after-turn preparation wakes the wait before any source freeze", () =>
  test(
    Effect.gen(function* () {
      const f = yield* twoServices;
      const waiting = yield* Deferred.make<void>();
      const service = createThreadHandoffService({
        ...f.sourcePorts,
        safePoint: {
          ...f.sourcePorts.safePoint,
          waitForCurrentTurn: () =>
            Deferred.succeed(waiting, undefined).pipe(Effect.andThen(Effect.never)),
        },
      });
      const preparation = yield* service
        .handle({
          operation: "prepareSource",
          handoffId: record.handoffId,
          destination: f.destinationMapping,
          mode: "afterTurn",
        })
        .pipe(Effect.exit, Effect.forkChild);
      yield* Deferred.await(waiting);
      expect(
        (yield* service.handle({ operation: "rollback", handoffId: record.handoffId })).record
          ?.phase,
      ).toBe("failed");
      expect((yield* Fiber.join(preparation))._tag).toBe("Failure");
      expect(f.counters.freeze).toBe(0);
    }),
  ),
);

it.effect("cancellation tombstone rejects a delayed source prepare before freezing", () =>
  test(
    Effect.gen(function* () {
      const f = yield* twoServices;
      const cancelling = yield* f.sourceService.handle({
        operation: "beginRollback",
        handoffId: record.handoffId,
        threadId: record.owner.threadId,
        destinationEnvironmentId: destination,
      });
      expect(cancelling.record?.phase).toBe("rollingBack");
      expect(
        (yield* f.sourceService.handle({ operation: "rollback", handoffId: record.handoffId }))
          .record?.phase,
      ).toBe("failed");
      yield* Effect.flip(
        f.sourceService.handle({
          operation: "prepareSource",
          handoffId: record.handoffId,
          destination: f.destinationMapping,
          mode: "idle",
        }),
      );
      expect(f.counters.freeze).toBe(0);
    }),
  ),
);

it.effect("a source commit racing cancellation has one durable winner", () =>
  test(
    Effect.gen(function* () {
      const f = yield* twoServices;
      yield* f.prepare;
      const verified = yield* f.destinationService.handle({
        operation: "verify",
        handoffId: record.handoffId,
      });
      if (!verified.ready) throw new Error("Missing receipt");
      const receipt = verified.ready;
      yield* Effect.all(
        [
          f.sourceService.handle({ operation: "commit", receipt }).pipe(Effect.exit),
          f.sourceService
            .handle({
              operation: "beginRollback",
              handoffId: record.handoffId,
              threadId: record.owner.threadId,
              destinationEnvironmentId: destination,
            })
            .pipe(Effect.exit),
        ],
        { concurrency: "unbounded" },
      );
      const final = yield* f.journal.head(record.owner.threadId);
      expect(["committed", "rollingBack"]).toContain(final?.phase);
      if (final?.phase === "committed") {
        expect(
          (yield* f.sourceService.handle({
            operation: "beginRollback",
            handoffId: record.handoffId,
            threadId: record.owner.threadId,
            destinationEnvironmentId: destination,
          })).record?.phase,
        ).toBe("committed");
      } else {
        expect(
          yield* Effect.flip(f.sourceService.handle({ operation: "commit", receipt })),
        ).toMatchObject({ code: "conflict" });
      }
    }),
  ),
);

it.effect("custom Claude environment home is rejected before pausing", () =>
  test(
    Effect.gen(function* () {
      const f = yield* twoServices;
      const service = createThreadHandoffService({
        ...f.sourcePorts,
        settings: {
          getSettings: Effect.succeed(
            stub<ServerSettings>({
              providerInstances: {
                [target.source.providerInstanceId]: stub<
                  ServerSettings["providerInstances"][ProviderInstanceId]
                >({
                  config: {},
                  environment: [
                    {
                      name: "CLAUDE_CONFIG_DIR",
                      value: NodePath.join(f.sourceRoot, "custom-home"),
                      sensitive: false,
                    },
                  ],
                }),
              },
            }),
          ),
        },
      });
      expect(
        yield* Effect.flip(
          service.handle({
            operation: "prepareSource",
            handoffId: record.handoffId,
            destination: f.destinationMapping,
            mode: "idle",
          }),
        ),
      ).toMatchObject({ code: "unsupported" });
      expect(f.counters.freeze).toBe(0);
      expect(yield* f.journal.head(record.owner.threadId)).toBeNull();
    }),
  ),
);

it.effect("attachment history is blocked before freeze rather than silently discarded", () =>
  test(
    Effect.gen(function* () {
      const f = yield* twoServices;
      const attachmentEvent = stored(f.events.length + 1, {
        type: "message.updated",
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: MessageId.make("with-image"),
          threadId: record.owner.threadId,
          runId: null,
          nodeId: null,
          role: "user",
          text: "See design",
          streaming: false,
          createdAt: at,
          updatedAt: at,
          attachments: [
            {
              type: "image",
              id: "design",
              name: "design.png",
              mimeType: "image/png",
              sizeBytes: 20,
            },
          ],
        },
      });
      const service = createThreadHandoffService({
        ...f.sourcePorts,
        history: {
          ...f.sourcePorts.history,
          read: () => Effect.succeed([...f.events, attachmentEvent]),
        },
      });
      expect(
        yield* Effect.flip(
          service.handle({
            operation: "prepareSource",
            handoffId: record.handoffId,
            destination: f.destinationMapping,
            mode: "idle",
          }),
        ),
      ).toMatchObject({ code: "unsupported" });
      expect(f.counters.freeze).toBe(0);
      expect(yield* f.journal.head(record.owner.threadId)).toBeNull();
    }),
  ),
);

it.effect.each(["claudeAgent", "codex", "cursor", "grok", "opencode", "antigravity"])(
  "context handoff from Codex starts a new %s session and survives destination restart",
  (provider) =>
    test(
      Effect.gen(function* () {
        const f = yield* makeTwoServices(provider);
        yield* f.prepare;
        const verified = yield* f.destinationService.handle({
          operation: "verify",
          handoffId: record.handoffId,
        });
        if (!verified.ready) throw new Error("Missing context readiness");
        expect(verified.ready.sessionId).toBeUndefined();
        const committed = yield* f.sourceService.handle({
          operation: "commit",
          receipt: verified.ready,
        });
        if (!committed.record) throw new Error("Missing commit");
        const result = yield* createThreadHandoffService(f.destinationPorts).handle({
          operation: "activate",
          record: committed.record,
        });
        expect(result.record?.phase).toBe("completed");
        expect(f.counters.imports).toBe(1);
        const imported = f.imported();
        // The thread moves to the chosen model; its history stays attributed to
        // the source provider, so the next turn hands the conversation over.
        expect(imported.at(-2)?.payload).toMatchObject({
          providerInstanceId: target.providerInstanceId,
          modelSelection: { instanceId: target.providerInstanceId, model: "opus" },
        });
        expect(
          imported.find((event) => event.type === "provider-thread.updated")?.payload,
        ).toMatchObject({
          providerInstanceId: target.source.providerInstanceId,
          providerSessionId: null,
        });
        expect(yield* f.journal.head(record.owner.threadId)).toMatchObject({
          phase: "committed",
        });
      }),
    ),
);

it.effect("context preflight rejects a model from another instance before pausing source", () =>
  test(
    Effect.gen(function* () {
      const f = yield* makeTwoServices("opencode");
      const result = yield* f.destinationService
        .handle({
          operation: "preflight",
          destination: {
            ...f.destinationMapping,
            modelSelection: { instanceId: target.source.providerInstanceId, model: "opus" },
          },
        })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(f.counters.freeze).toBe(0);
    }),
  ),
);

it.effect(
  "failed context activation preparation can be revoked without changing source history",
  () =>
    test(
      Effect.gen(function* () {
        const f = yield* makeTwoServices("opencode");
        yield* f.prepare;
        yield* f.destinationService.handle({ operation: "verify", handoffId: record.handoffId });
        yield* f.destinationService.handle({ operation: "reject", handoffId: record.handoffId });
        yield* f.sourceService.handle({ operation: "rollback", handoffId: record.handoffId });
        expect(yield* f.journal.head(record.owner.threadId)).toMatchObject({
          phase: "failed",
          owner: record.owner,
        });
        expect(
          yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(f.sourceRoot, "file.txt"), "utf8"),
          ),
        ).toBe("unstaged\n");
      }),
    ),
);

it.effect(
  "context inspection survives absent native binding and unavailable source installation",
  () =>
    test(
      Effect.gen(function* () {
        const f = yield* makeTwoServices("opencode");
        const service = createThreadHandoffService({
          ...f.sourcePorts,
          query: {
            ...f.sourcePorts.query,
            getThread: (threadId) =>
              f.sourcePorts.query
                .getThread(threadId)
                .pipe(Effect.map(Option.map((thread) => ({ ...thread, providerThread: null })))),
          },
        });
        const result = yield* service.handle({
          operation: "inspect",
          threadId: record.owner.threadId,
        });
        expect(result.source).toMatchObject({
          driver: "codex",
          version: "unknown",
          supportsNativeHandoff: false,
        });
        expect(result.source?.sessionId).toBeUndefined();
      }),
    ),
);

it.effect(
  "context preflight supports a ready local runtime without account authentication and rejects unknown models",
  () =>
    test(
      Effect.gen(function* () {
        const f = yield* makeTwoServices("opencode");
        const original = yield* f.destinationPorts.instances.getInstance(target.providerInstanceId);
        if (!original) throw new Error("Missing fixture instance");
        const status = yield* original.snapshot.refresh;
        const local = stub<ProviderInstance>({
          enabled: true,
          driverKind: status.driver,
          snapshot: stub<ProviderInstance["snapshot"]>({
            refresh: Effect.succeed({ ...status, auth: { status: "unknown" }, version: null }),
          }),
        });
        const service = createThreadHandoffService({
          ...f.destinationPorts,
          instances: { getInstance: () => Effect.succeed(local) },
        });
        expect(
          (yield* service.handle({ operation: "preflight", destination: f.destinationMapping }))
            .destination,
        ).toBeDefined();
        const invalid = yield* service
          .handle({
            operation: "preflight",
            destination: {
              ...f.destinationMapping,
              modelSelection: { instanceId: target.providerInstanceId, model: "not-installed" },
            },
          })
          .pipe(Effect.result);
        expect(invalid._tag).toBe("Failure");
        expect(f.counters.freeze).toBe(0);
      }),
    ),
);

it.effect("restart rollback removes a verified context preparation", () =>
  test(
    Effect.gen(function* () {
      const f = yield* makeTwoServices("opencode");
      yield* f.prepare;
      yield* f.destinationService.handle({ operation: "verify", handoffId: record.handoffId });
      const prepared = NodePath.join(f.destinationState, "handoff-workspaces", record.handoffId);
      expect(yield* Effect.promise(() => NodeFSP.stat(prepared))).toBeDefined();
      const restarted = createThreadHandoffService(f.destinationPorts);
      const rejected = yield* restarted.handle({
        operation: "reject",
        handoffId: record.handoffId,
      });
      expect(rejected.record?.phase).toBe("cancelled");
      yield* Effect.promise(async () => {
        await expect(NodeFSP.stat(prepared)).rejects.toMatchObject({ code: "ENOENT" });
      });
      yield* f.sourceService.handle({ operation: "rollback", handoffId: record.handoffId });
      expect(yield* f.journal.head(record.owner.threadId)).toMatchObject({
        phase: "failed",
        owner: record.owner,
      });
    }),
  ),
);
