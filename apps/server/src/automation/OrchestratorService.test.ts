import { assert, describe, it } from "@effect/vitest";
import {
  AUTOMATION_CONTRACT_VERSION,
  CommandId,
  type DelegatedTask,
  DelegatedTaskId,
  EnvironmentId,
  IdempotencyKey,
  type OrchestratorId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { internalCaller } from "./Caller.ts";
import {
  environmentId,
  makeAutomationLayer,
  modelSelection,
  orchestratorInput,
  otherInstanceId,
  otherProjectId,
  projectId,
  withEngine,
} from "./orchestrator/Orchestrator.testkit.ts";
import { ORCHESTRATOR_MINI_SKILL_ID } from "./orchestrator/instructions.ts";
import * as OrchestratorRuntime from "./orchestrator/Runtime.ts";
import * as OrchestratorService from "./OrchestratorService.ts";

const user = internalCaller("test-user");
const TIMEOUT = 60_000;
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const started = Effect.gen(function* () {
  const service = yield* OrchestratorService.OrchestratorService;
  const runtime = yield* OrchestratorRuntime.OrchestratorRuntime;
  yield* runtime.start();
  yield* runtime.drain;
  return { service, runtime, threads: yield* ThreadManagement.ThreadManagementService };
});

const task = (
  orchestratorId: OrchestratorId,
  id: string,
  overrides: Partial<DelegatedTask> = {},
): DelegatedTask => ({
  id: DelegatedTaskId.make(id),
  version: AUTOMATION_CONTRACT_VERSION,
  revision: 1,
  originEnvironmentId: environmentId,
  executionEnvironmentId: environmentId,
  nodeId: null,
  orchestratorId,
  parentTaskId: null,
  parentThreadId: null,
  threadId: null,
  kind: "managed_thread",
  capabilities: { send: true, answer: true, cancel: true, read: true },
  target: { projectId },
  contract: {
    title: "Child work",
    objective: "Do the thing",
    deliverables: [],
    acceptanceCriteria: [],
  },
  status: "running",
  statusReason: null,
  attemptCount: 1,
  claim: null,
  result: null,
  usage: { tokens: null, turns: 0 },
  observedAt: "2026-06-20T00:00:00.000Z",
  createdAt: "2026-06-20T00:00:00.000Z",
  updatedAt: "2026-06-20T00:00:00.000Z",
  ...overrides,
});

/** Stores a task the way the task service would, at the table both services share. */
const storeTask = (value: DelegatedTask) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO automation_tasks (
        task_id, revision, origin_environment_id, execution_environment_id, orchestrator_id,
        parent_task_id, parent_thread_id, thread_id, status, task_json, observed_at, created_at,
        updated_at
      ) VALUES (
        ${value.id}, ${value.revision}, ${value.originEnvironmentId},
        ${value.executionEnvironmentId}, ${value.orchestratorId}, ${value.parentTaskId},
        ${value.parentThreadId}, ${value.threadId}, ${value.status}, ${encodeJson(value)},
        ${value.observedAt}, ${value.createdAt}, ${value.updatedAt}
      )
    `;
  });

describe("OrchestratorService", () => {
  it.effect(
    "creates the main thread through thread launch and marks it as an orchestrator's",
    () =>
      withEngine("orchestrator-create", ({ journal }) =>
        Effect.gen(function* () {
          const { service, threads } = yield* started;
          const created = yield* service.upsert(
            user,
            orchestratorInput({ idempotencyKey: IdempotencyKey.make("create-1") }),
          );
          assert.strictEqual(created.hostEnvironmentId, environmentId);
          assert.strictEqual(created.hostGeneration, 1);
          assert.strictEqual(created.desiredState, "active");
          assert.strictEqual(created.revision, 1);
          assert.isNotNull(created.threadId);

          const { thread } = yield* threads.getThreadRecords(created.threadId!, []);
          assert.strictEqual(thread.projectId, projectId);
          assert.strictEqual(thread.title, "Orchestrator: Release captain");
          assert.strictEqual(thread.createdBy, "system");
          assert.strictEqual(thread.creationSource, "server");
          assert.deepStrictEqual(
            (thread.miniSkills ?? []).map((skill) => skill.skillId),
            [ORCHESTRATOR_MINI_SKILL_ID],
          );

          // Repeating the same create returns the same orchestrator and thread.
          const repeat = yield* service.upsert(
            user,
            orchestratorInput({ idempotencyKey: IdempotencyKey.make("create-1") }),
          );
          assert.strictEqual(repeat.id, created.id);
          assert.strictEqual(repeat.threadId, created.threadId);
          assert.strictEqual((yield* service.list(user)).length, 1);
          const changed = (yield* SubscriptionRef.get(journal.events)).filter(
            (event) => event.type === "orchestrator.changed",
          );
          assert.strictEqual(changed.length, 1);
          assert.strictEqual(changed[0]!.scope.orchestratorId, created.id);
        }).pipe(Effect.provide(makeAutomationLayer())),
      ),
    TIMEOUT,
  );

  it.effect(
    "adopts an existing thread, and refuses a thread that is already taken or in another project",
    () =>
      withEngine("orchestrator-adopt", ({ cwd }) =>
        Effect.gen(function* () {
          const { service, threads } = yield* started;
          const threadId = ThreadId.make("thread:adopted");
          yield* threads.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:adopted:create"),
            threadId,
            projectId,
            title: "My long-running thread",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
          });
          const adopted = yield* service.upsert(user, orchestratorInput({ threadId }));
          assert.strictEqual(adopted.threadId, threadId);
          assert.strictEqual(
            (yield* threads.getThreadRecords(threadId, [])).thread.title,
            "My long-running thread",
          );

          const taken = yield* service
            .upsert(user, orchestratorInput({ name: "Second", threadId }))
            .pipe(Effect.flip);
          assert.strictEqual(taken.code, "CONFLICT");
          const foreign = yield* service
            .upsert(user, orchestratorInput({ projectId: otherProjectId, threadId }))
            .pipe(Effect.flip);
          assert.strictEqual(foreign.code, "INVALID_INPUT");
          const missing = yield* service
            .upsert(user, orchestratorInput({ threadId: ThreadId.make("thread:nope") }))
            .pipe(Effect.flip);
          assert.strictEqual(missing.code, "NOT_FOUND");
          assert.strictEqual((yield* service.list(user)).length, 1);
        }).pipe(Effect.provide(makeAutomationLayer())),
      ),
    TIMEOUT,
  );

  it.effect(
    "edits need the revision that was read, and a stale one changes nothing",
    () =>
      withEngine("orchestrator-edit", () =>
        Effect.gen(function* () {
          const { service } = yield* started;
          const created = yield* service.upsert(user, orchestratorInput());
          const edited = yield* service.upsert(
            user,
            orchestratorInput({
              id: created.id,
              expectedRevision: created.revision,
              name: "Renamed",
              batchWindowMs: 5_000,
            }),
          );
          assert.strictEqual(edited.revision, created.revision + 1);
          assert.strictEqual(edited.name, "Renamed");
          assert.strictEqual(edited.threadId, created.threadId);

          const stale = yield* service
            .upsert(
              user,
              orchestratorInput({
                id: created.id,
                expectedRevision: created.revision,
                name: "Lost update",
              }),
            )
            .pipe(Effect.flip);
          assert.strictEqual(stale.code, "REVISION_MISMATCH");
          assert.strictEqual(stale.detail?.currentRevision, edited.revision);
          const unversioned = yield* service
            .upsert(user, orchestratorInput({ id: created.id, name: "No revision" }))
            .pipe(Effect.flip);
          assert.strictEqual(unversioned.code, "INVALID_INPUT");
          assert.strictEqual((yield* service.list(user))[0]!.name, "Renamed");
        }).pipe(Effect.provide(makeAutomationLayer())),
      ),
    TIMEOUT,
  );

  it.effect(
    "a model change follows the provider: same instance in place, another instance by handoff, unavailable refused",
    () =>
      withEngine("orchestrator-model", () =>
        Effect.gen(function* () {
          const { service, threads } = yield* started;
          const created = yield* service.upsert(user, orchestratorInput());
          const threadId = created.threadId!;

          const sameInstance = yield* service.upsert(
            user,
            orchestratorInput({
              id: created.id,
              expectedRevision: created.revision,
              modelSelection: { ...modelSelection, model: "gpt-5.5" },
            }),
          );
          const afterSet = (yield* threads.getThreadRecords(threadId, [])).thread;
          assert.strictEqual(afterSet.modelSelection.model, "gpt-5.5");
          assert.strictEqual(afterSet.providerInstanceId, modelSelection.instanceId);
          assert.strictEqual(
            (yield* service.checkpoints(user, { orchestratorId: created.id })).length,
            0,
          );

          // A model nobody serves is refused; nothing is substituted for it.
          const unavailable = yield* service
            .upsert(
              user,
              orchestratorInput({
                id: created.id,
                expectedRevision: sameInstance.revision,
                modelSelection: { ...modelSelection, model: "gpt-imaginary" },
              }),
            )
            .pipe(Effect.flip);
          assert.strictEqual(unavailable.code, "CAPABILITY_UNSUPPORTED");
          assert.strictEqual(
            (yield* threads.getThreadRecords(threadId, [])).thread.modelSelection.model,
            "gpt-5.5",
          );
          assert.strictEqual((yield* service.list(user))[0]!.revision, sameInstance.revision);

          // Another provider instance cannot carry the session: checkpoint, then switch.
          const switched = yield* service.upsert(
            user,
            orchestratorInput({
              id: created.id,
              expectedRevision: sameInstance.revision,
              modelSelection: { instanceId: otherInstanceId, model: "gpt-5.4" },
            }),
          );
          assert.strictEqual(switched.modelSelection.instanceId, otherInstanceId);
          const afterSwitch = (yield* threads.getThreadRecords(threadId, [])).thread;
          assert.strictEqual(afterSwitch.modelSelection.instanceId, otherInstanceId);
          const checkpoints = yield* service.checkpoints(user, { orchestratorId: created.id });
          assert.strictEqual(checkpoints.length, 1);
          assert.isNull(checkpoints[0]!.runId);
          assert.include(checkpoints[0]!.state.summary, "successor session");
          assert.strictEqual(switched.threadId, threadId);
        }).pipe(Effect.provide(makeAutomationLayer())),
      ),
    TIMEOUT,
  );

  it.effect(
    "deleting removes the orchestrator and leaves its thread; a remote host is named, not guessed",
    () =>
      withEngine("orchestrator-delete", ({ provider }) =>
        Effect.gen(function* () {
          const { service, runtime, threads } = yield* started;
          const sql = yield* SqlClient.SqlClient;
          const created = yield* service.upsert(user, orchestratorInput());
          const elsewhere = EnvironmentId.make("environment:elsewhere");
          yield* sql`
            UPDATE automation_orchestrators SET host_environment_id = ${elsewhere}
            WHERE orchestrator_id = ${created.id}
          `;
          const remote = (yield* service.list(user))[0]!;
          assert.strictEqual(remote.effectiveState, "not_hosted_here");
          const refused = yield* service
            .send(user, {
              idempotencyKey: IdempotencyKey.make("send-remote"),
              orchestratorId: created.id,
              text: "Hello over there.",
            })
            .pipe(Effect.flip);
          assert.strictEqual(refused.code, "ENVIRONMENT_UNAVAILABLE");
          assert.strictEqual(refused.detail?.hostEnvironmentId, elsewhere);
          yield* runtime.drain;
          assert.strictEqual((yield* Ref.get(provider.turns)).length, 0);
          const handoff = yield* service
            .handoff(user, {
              idempotencyKey: IdempotencyKey.make("handoff"),
              orchestratorId: created.id,
              destinationEnvironmentId: elsewhere,
            })
            .pipe(Effect.flip);
          assert.strictEqual(handoff.code, "CAPABILITY_UNSUPPORTED");

          assert.isTrue(yield* service.delete(user, created.id));
          assert.isFalse(yield* service.delete(user, created.id));
          assert.strictEqual((yield* service.list(user)).length, 0);
          const { thread } = yield* threads.getThreadRecords(created.threadId!, []);
          assert.isNull(thread.deletedAt);
          const gone = yield* service.inbox(user, { orchestratorId: created.id }).pipe(Effect.flip);
          assert.strictEqual(gone.code, "NOT_FOUND");
        }).pipe(Effect.provide(makeAutomationLayer())),
      ),
    TIMEOUT,
  );

  it.effect(
    "delegation is admitted only inside the orchestrator's permissions and child budgets",
    () =>
      withEngine("orchestrator-delegation", () =>
        Effect.gen(function* () {
          const { service } = yield* started;
          const created = yield* service.upsert(
            user,
            orchestratorInput({
              permissions: { actions: ["task.delegate"], projectIds: [projectId] },
              budget: {
                ...orchestratorInput().budget,
                maxConcurrentChildren: 2,
                maxChildrenPerTask: 1,
                maxTaskAttempts: 2,
              },
            }),
          );
          const allow = (input: {
            readonly parentTaskId?: string;
            readonly retryOfTaskId?: string;
          }) =>
            service.authorizeDelegation({
              orchestratorId: created.id,
              action: "task.delegate",
              projectId,
              ...(input.parentTaskId === undefined
                ? {}
                : { parentTaskId: DelegatedTaskId.make(input.parentTaskId) }),
              ...(input.retryOfTaskId === undefined
                ? {}
                : { retryOfTaskId: DelegatedTaskId.make(input.retryOfTaskId) }),
            });
          yield* allow({});

          const outside = yield* service
            .authorizeDelegation({
              orchestratorId: created.id,
              action: "task.delegate",
              projectId: otherProjectId,
            })
            .pipe(Effect.flip);
          assert.strictEqual(outside.code, "PERMISSION_DENIED");
          const noAction = yield* service
            .authorizeDelegation({
              orchestratorId: created.id,
              action: "peer.delegate",
              projectId,
            })
            .pipe(Effect.flip);
          assert.strictEqual(noAction.code, "PERMISSION_DENIED");

          yield* storeTask(task(created.id, "task:parent"));
          yield* storeTask(
            task(created.id, "task:child", {
              parentTaskId: DelegatedTaskId.make("task:parent"),
              attemptCount: 2,
            }),
          );
          const concurrent = yield* allow({}).pipe(Effect.flip);
          assert.strictEqual(concurrent.code, "BUDGET_EXCEEDED");
          assert.strictEqual(concurrent.detail?.limit, "maxConcurrentChildren");
          // Retrying the child does not count it against itself, but its attempts are spent.
          const attempts = yield* allow({ retryOfTaskId: "task:child" }).pipe(Effect.flip);
          assert.strictEqual(attempts.detail?.limit, "maxTaskAttempts");

          // A finished task frees a slot; the per-parent limit still holds.
          yield* storeTask(task(created.id, "task:done", { status: "validated" }));
          const sql = yield* SqlClient.SqlClient;
          yield* sql`DELETE FROM automation_tasks WHERE task_id = 'task:parent'`;
          yield* storeTask(task(created.id, "task:parent", { status: "validated" }));
          const perParent = yield* allow({ parentTaskId: "task:parent" }).pipe(Effect.flip);
          assert.strictEqual(perParent.detail?.limit, "maxChildrenPerTask");
          yield* allow({ parentTaskId: "task:done" });

          yield* service.setState(user, { orchestratorId: created.id, desiredState: "paused" });
          const paused = yield* allow({}).pipe(Effect.flip);
          assert.strictEqual(paused.code, "PAUSED");
          // Pausing never cancels the children already running.
          const listed = (yield* service.list(user))[0]!;
          assert.strictEqual(listed.usage.activeChildren, 1);
          assert.strictEqual(listed.budget.maxConcurrentChildren, 2);
        }).pipe(Effect.provide(makeAutomationLayer())),
      ),
    TIMEOUT,
  );

  it.effect(
    "subscribers get the current list and then every change",
    () =>
      withEngine("orchestrator-subscribe", () =>
        Effect.gen(function* () {
          const { service } = yield* started;
          const seen = yield* SubscriptionRef.make<ReadonlyArray<ReadonlyArray<string>>>([]);
          yield* service.subscribe(user).pipe(
            Stream.runForEach((orchestrators) =>
              SubscriptionRef.update(seen, (all) => [
                ...all,
                orchestrators.map((orchestrator) => orchestrator.desiredState),
              ]),
            ),
            Effect.forkScoped,
          );
          const snapshots = (count: number) =>
            SubscriptionRef.changes(seen).pipe(
              Stream.filter((all) => all.length >= count),
              Stream.runHead,
            );
          yield* snapshots(1);
          const created = yield* service.upsert(user, orchestratorInput());
          yield* service.setState(user, { orchestratorId: created.id, desiredState: "paused" });
          yield* SubscriptionRef.changes(seen).pipe(
            Stream.filter((all) => all.at(-1)?.[0] === "paused"),
            Stream.runHead,
          );
          const all = yield* SubscriptionRef.get(seen);
          assert.deepStrictEqual(all[0], []);
          assert.deepStrictEqual(all.at(-1), ["paused"]);
        }).pipe(Effect.scoped, Effect.provide(makeAutomationLayer())),
      ),
    TIMEOUT,
  );

  it.effect(
    "a peer environment cannot administer an orchestrator",
    () =>
      withEngine("orchestrator-peer", () =>
        Effect.gen(function* () {
          const { service } = yield* started;
          const created = yield* service.upsert(user, orchestratorInput());
          const peer = {
            kind: "peer",
            environmentId: EnvironmentId.make("environment:peer"),
            subject: "peer:environment:peer",
            scopes: [],
          } as const;
          const planted = yield* service
            .upsert(peer, orchestratorInput({ name: "Planted" }))
            .pipe(Effect.flip);
          const disabled = yield* service
            .setState(peer, { orchestratorId: created.id, desiredState: "disabled" })
            .pipe(Effect.flip);
          const deleted = yield* service.delete(peer, created.id).pipe(Effect.flip);
          for (const refusal of [planted, disabled, deleted]) {
            assert.strictEqual(refusal.code, "PERMISSION_DENIED");
          }
          const listed = yield* service.list(user);
          assert.deepStrictEqual(
            listed.map((orchestrator) => [orchestrator.name, orchestrator.desiredState]),
            [["Release captain", "active"]],
          );
        }).pipe(Effect.provide(makeAutomationLayer())),
      ),
    TIMEOUT,
  );
});
