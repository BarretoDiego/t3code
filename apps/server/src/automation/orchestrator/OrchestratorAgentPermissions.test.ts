import { assert, describe, it } from "@effect/vitest";
import {
  AUTOMATION_WS_METHODS,
  AuthAutomationExecuteScope,
  type AutomationEvent,
  CommandId,
  EnvironmentId,
  ExecutionNodeId,
  IdempotencyKey,
  type JobAction,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2Command,
  type OrchestrationV2RuntimeRequest,
  type Orchestrator,
  type OrchestratorId,
  type OrchestratorPermissions,
  type ProjectId,
  type TaskDelegateInput,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import {
  type AutomationCaller,
  automationError,
  internalCaller,
  type OrchestratorCaller,
} from "../Caller.ts";
import * as EventJournal from "../EventJournal.ts";
import * as JobAuthority from "../jobs/JobAuthority.ts";
import * as JobExecutor from "../jobs/JobExecutor.ts";
import * as JobService from "../JobService.ts";
import * as OrchestratorService from "../OrchestratorService.ts";
import * as PeerService from "../PeerService.ts";
import * as ResponsibilityService from "../ResponsibilityService.ts";
import * as TaskEngine from "../tasks/TaskEngine.ts";
import {
  awaitThreadEvent,
  environmentId,
  makeAutomationLayer,
  modelSelection,
  orchestratorInput,
  otherProjectId,
  projectId,
  startThreadWithRequest,
  withEngine,
} from "./Orchestrator.testkit.ts";
import { operator, orchestratorInTurn } from "./OrchestratorAgent.testkit.ts";
import { makeAutomationMethodGate, makeOrchestratorRpcGate } from "./RpcGate.ts";
import { makeStore } from "./Store.ts";

const TIMEOUT = 60_000;
const user: AutomationCaller = { kind: "client", subject: "user-session", scopes: [] };
const LOCAL = ExecutionNodeId.make("local");
const ALLOWED_PEER = EnvironmentId.make("environment:allowed-peer");
const OTHER_PEER = EnvironmentId.make("environment:other-peer");
const PEER_LINK_DOWN = "The peer link is not part of this test.";

/** Stands in for the network: a delegation that reaches it was allowed to leave. */
const peers = Layer.mock(PeerService.PeerService)({
  enqueue: () => Effect.fail(automationError("ENVIRONMENT_UNAVAILABLE", PEER_LINK_DOWN)),
});

/** Reads permissions from the real orchestrator service; no project has a known root. */
const authority = Layer.effect(
  JobAuthority.JobAuthority,
  Effect.gen(function* () {
    const orchestrators = yield* OrchestratorService.OrchestratorService;
    return JobAuthority.JobAuthority.of({
      orchestratorPermissions: (orchestratorId) =>
        Effect.map(
          orchestrators.list(internalCaller("jobs")),
          (list) => list.find((entry) => entry.id === orchestratorId)?.permissions ?? null,
        ),
      projectRoots: () => Effect.succeed([]),
    });
  }),
);

/** The automation services plus the real task engine and job service over them. */
const makeAgentLayer = () =>
  Layer.mergeAll(
    TaskEngine.layer.pipe(Layer.provide(peers)),
    JobService.layerWithoutExecutor.pipe(
      Layer.provide(JobExecutor.layer),
      Layer.provide(authority),
    ),
  ).pipe(Layer.provideMerge(makeAutomationLayer()));

const permissions = (
  actions: OrchestratorPermissions["actions"],
  rest: Partial<OrchestratorPermissions> = {},
): OrchestratorPermissions => ({ actions, ...rest });

/** Changes what the orchestrator may do, as the operator editing it would. */
const setPermissions = (orchestrator: Orchestrator, next: OrchestratorPermissions) =>
  Effect.gen(function* () {
    const service = yield* OrchestratorService.OrchestratorService;
    const current = (yield* service.list(operator)).find((entry) => entry.id === orchestrator.id)!;
    return yield* service.upsert(operator, {
      ...orchestratorInput({ scope: current.scope, permissions: next }),
      id: current.id,
      expectedRevision: current.revision,
    });
  });

const createThread = (threadId: ThreadId, inProject: ProjectId, cwd: string) =>
  ThreadManagement.ThreadManagementService.use((threads) =>
    threads.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`command:${threadId}:create`),
      threadId,
      projectId: inProject,
      title: "Worker",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: cwd,
    }),
  );

const messageTo = (threadId: ThreadId, key: string): OrchestrationV2Command => ({
  type: "message.dispatch",
  createdBy: "agent",
  creationSource: "server",
  commandId: CommandId.make(`command:${threadId}:${key}`),
  threadId,
  messageId: MessageId.make(`message:${threadId}:${key}`),
  text: `From the orchestrator (${key}).`,
  attachments: [],
  dispatchMode: { type: "start_immediately" },
});

/** A thread command the way the WebSocket route runs it: admitted first, then dispatched. */
const issue = (caller: AutomationCaller, command: OrchestrationV2Command) =>
  Effect.gen(function* () {
    const gate = yield* makeOrchestratorRpcGate;
    const threads = yield* ThreadManagement.ThreadManagementService;
    return yield* Effect.andThen(gate.threadCommand(caller, command), threads.dispatch(command));
  });

const runCount = (threadId: ThreadId) =>
  ThreadManagement.ThreadManagementService.use((threads) =>
    threads.getThreadRecords(threadId, ["runs"]),
  ).pipe(Effect.map((records) => records.runs.length));

const requestIs =
  (status: OrchestrationV2RuntimeRequest["status"]) =>
  (event: { readonly type: string; readonly payload: unknown }) =>
    event.type === "runtime-request.updated" &&
    (event.payload as { readonly status: string }).status === status;

const delegation = (
  key: string,
  overrides: Partial<TaskDelegateInput> = {},
): TaskDelegateInput => ({
  idempotencyKey: IdempotencyKey.make(key),
  target: { projectId, modelSelection },
  contract: {
    title: "Write the notes",
    objective: "Write the release notes.",
    deliverables: ["notes.md"],
    acceptanceCriteria: ["Every merged change is listed."],
  },
  ...overrides,
});

const taskCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count FROM automation_tasks
  `;
  return rows[0]?.count ?? 0;
});

const jobCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly count: number;
  }>`SELECT COUNT(*) AS count FROM automation_jobs`;
  return rows[0]?.count ?? 0;
});

const noop: JobAction = { type: "command", executable: process.execPath, args: ["-e", ""] };

describe("orchestrator agent permissions", () => {
  it.effect(
    "thread commands need the action and a project in scope, and never reach its own thread",
    () =>
      withEngine("agent-permissions-threads", ({ provider, cwd }) =>
        Effect.gen(function* () {
          const inScope = ThreadId.make("thread:in-scope");
          const outOfScope = ThreadId.make("thread:out-of-scope");
          yield* createThread(inScope, projectId, cwd);
          yield* createThread(outOfScope, otherProjectId, cwd);
          const { agent, threadId, release, orchestrator } = yield* orchestratorInTurn(provider, {
            permissions: permissions(["thread.read", "thread.send", "thread.create"], {
              projectIds: [projectId],
            }),
          });
          const gate = yield* makeOrchestratorRpcGate;

          // Allowed: the action is held and the thread's project is in scope.
          yield* issue(agent.caller, messageTo(inScope, "allowed"));
          assert.strictEqual(yield* runCount(inScope), 1);
          // The user's own caller is not this gate's business.
          yield* gate.threadCommand(user, messageTo(outOfScope, "as-user"));

          const refused = (command: OrchestrationV2Command) =>
            issue(agent.caller, command).pipe(
              Effect.flip,
              Effect.map((error) => ("message" in error ? String(error.message) : "")),
            );
          // Missing action.
          assert.include(
            yield* refused({
              type: "run.interrupt",
              commandId: CommandId.make("command:interrupt"),
              threadId: inScope,
              reason: "stop",
            } as OrchestrationV2Command),
            "PERMISSION_DENIED: Orchestrator",
          );
          // Wrong project.
          const wrongProject = yield* refused(messageTo(outOfScope, "wrong-project"));
          assert.include(wrongProject, "PERMISSION_DENIED");
          assert.include(wrongProject, otherProjectId);
          assert.strictEqual(yield* runCount(outOfScope), 0);
          // Its own main thread.
          assert.include(yield* refused(messageTo(threadId, "self")), "own main thread");
          // A command no rule admits, whatever the orchestrator holds.
          assert.include(
            yield* refused({
              type: "thread.delete",
              commandId: CommandId.make("command:delete"),
              threadId: inScope,
            }),
            "may not issue thread.delete",
          );
          assert.strictEqual(yield* runCount(inScope), 1);
          // Launching: the project decides.
          yield* gate.threadLaunch(agent.caller, { projectId });
          assert.include(
            (yield* gate
              .threadLaunch(agent.caller, { projectId: otherProjectId })
              .pipe(Effect.flip)).message,
            "PERMISSION_DENIED",
          );

          // Without thread.send the same command that passed is refused: the
          // check reads the permissions as they are when the command arrives.
          yield* setPermissions(orchestrator, permissions(["thread.read"]));
          assert.include(yield* refused(messageTo(inScope, "after-edit")), "thread.send");
          assert.strictEqual(yield* runCount(inScope), 1);
          yield* release;
        }).pipe(Effect.provide(makeAgentLayer())),
      ),
    TIMEOUT,
  );

  it.effect(
    "an RPC without a rule never runs for an orchestrator's agent",
    () =>
      withEngine("agent-permissions-rpc", ({ provider }) =>
        Effect.gen(function* () {
          const { agent, release } = yield* orchestratorInTurn(provider, {
            permissions: permissions(["task.delegate"]),
          });
          const gate = yield* makeOrchestratorRpcGate;
          const ran = yield* Ref.make<ReadonlyArray<string>>([]);
          const record = (method: string) => Ref.update(ran, (all) => [...all, method]);
          const handlers = {
            [WS_METHODS.terminalOpen]: () => Effect.as(record("terminalOpen"), "opened"),
            [WS_METHODS.serverUpdateSettings]: () => Effect.as(record("updateSettings"), "updated"),
            [WS_METHODS.subscribeTerminalEvents]: () =>
              Stream.fromEffect(Effect.as(record("terminalEvents"), "event")),
            [ORCHESTRATION_V2_WS_METHODS.getThreadProjection]: () =>
              Effect.as(record("projection"), "projection"),
            [WS_METHODS.serverGetConfig]: () => Effect.as(record("config"), "config"),
          };
          // Any other caller gets the handlers untouched.
          assert.strictEqual(gate.guardHandlers(user, handlers), handlers);

          const guarded = gate.guardHandlers(agent.caller, handlers);
          const exits = [
            yield* Effect.exit(guarded[WS_METHODS.terminalOpen]()),
            yield* Effect.exit(guarded[WS_METHODS.serverUpdateSettings]()),
            yield* Effect.exit(Stream.runCollect(guarded[WS_METHODS.subscribeTerminalEvents]())),
            // Listed, but it needs thread.read, which this orchestrator lacks.
            yield* Effect.exit(guarded[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]()),
          ];
          assert.deepStrictEqual(
            exits.map((exit) => exit._tag),
            ["Failure", "Failure", "Failure", "Failure"],
          );
          assert.strictEqual(yield* guarded[WS_METHODS.serverGetConfig](), "config");
          assert.deepStrictEqual(yield* Ref.get(ran), ["config"]);

          // Automation methods: configuration is the operator's, reads are open.
          const sql = yield* SqlClient.SqlClient;
          const admit = makeAutomationMethodGate(makeStore(sql), environmentId);
          const M = AUTOMATION_WS_METHODS;
          for (const method of [
            M.orchestratorsUpsert,
            M.orchestratorsSetState,
            M.orchestratorsDelete,
            M.orchestratorsHandoff,
            M.hooksUpsert,
            M.nodesUpsert,
            M.peersAdd,
            M.peerDeliver,
          ]) {
            const error = yield* admit(agent.caller, method, undefined).pipe(Effect.flip);
            assert.strictEqual(error.code, "PERMISSION_DENIED", method);
          }
          yield* admit(agent.caller, M.tasksList, undefined);
          yield* admit(user, M.orchestratorsUpsert, undefined);
          yield* release;
        }).pipe(Effect.provide(makeAgentLayer())),
      ),
    TIMEOUT,
  );

  it.effect(
    "delegating needs the action, a project in scope and an allowed peer, always as itself",
    () =>
      withEngine("agent-permissions-tasks", ({ provider }) =>
        Effect.gen(function* () {
          const { agent, release, orchestrator, service } = yield* orchestratorInTurn(provider, {
            scope: "global",
            permissions: permissions(["task.delegate", "peer.delegate"], {
              projectIds: [projectId],
              environmentIds: [ALLOWED_PEER],
            }),
          });
          const tasks = yield* TaskEngine.DelegatedTaskEngine;
          const other = yield* service.upsert(operator, orchestratorInput({ name: "Other" }));

          // Allowed, and recorded as this orchestrator's although the body names nobody.
          const { task, created } = yield* tasks.delegate(agent.caller, delegation("allowed"));
          assert.isTrue(created);
          assert.strictEqual(task.orchestratorId, orchestrator.id);
          const before = yield* taskCount;

          const denied = (input: TaskDelegateInput) =>
            tasks.delegate(agent.caller, input).pipe(
              Effect.flip,
              Effect.map((error) => error.code),
            );
          // Acting as another orchestrator.
          assert.strictEqual(
            yield* denied(delegation("as-other", { orchestratorId: other.id })),
            "PERMISSION_DENIED",
          );
          // Wrong project.
          assert.strictEqual(
            yield* denied(
              delegation("wrong-project", {
                target: { projectId: otherProjectId, modelSelection },
              }),
            ),
            "PERMISSION_DENIED",
          );
          // Wrong peer.
          assert.strictEqual(
            yield* denied(
              delegation("wrong-peer", {
                target: { projectId, modelSelection, environmentId: OTHER_PEER },
              }),
            ),
            "PERMISSION_DENIED",
          );
          assert.strictEqual(yield* taskCount, before);
          // An allowed peer passes every permission check and reaches the link.
          const leaving = yield* tasks
            .delegate(
              agent.caller,
              delegation("allowed-peer", {
                target: { projectId, modelSelection, environmentId: ALLOWED_PEER },
              }),
            )
            .pipe(Effect.result);
          if (leaving._tag === "Failure") {
            assert.notStrictEqual(leaving.failure.code, "PERMISSION_DENIED");
          }

          // Cancelling is its own action, and only for tasks it delegated.
          const cancel = (caller: AutomationCaller, key: string, taskId: typeof task.id) =>
            tasks.update(caller, {
              idempotencyKey: IdempotencyKey.make(key),
              taskId,
              action: { type: "cancel" },
            });
          assert.strictEqual(
            (yield* cancel(agent.caller, "cancel-1", task.id).pipe(Effect.flip)).code,
            "PERMISSION_DENIED",
          );
          const foreign = yield* tasks.delegate(operator, delegation("users-task"));
          yield* setPermissions(
            orchestrator,
            permissions(["task.delegate", "task.cancel"], { projectIds: [projectId] }),
          );
          assert.strictEqual(
            (yield* cancel(agent.caller, "cancel-foreign", foreign.task.id).pipe(Effect.flip)).code,
            "PERMISSION_DENIED",
          );
          assert.strictEqual((yield* tasks.get(foreign.task.id)).status, foreign.task.status);
          const cancelled = yield* cancel(agent.caller, "cancel-2", task.id);
          assert.include(["cancel_requested", "cancelled"], cancelled.status);

          // Without task.delegate nothing is stored.
          yield* setPermissions(orchestrator, permissions(["thread.read"]));
          const count = yield* taskCount;
          assert.strictEqual(yield* denied(delegation("no-action")), "PERMISSION_DENIED");
          assert.strictEqual(yield* taskCount, count);
          yield* release;
        }).pipe(Effect.provide(makeAgentLayer())),
      ),
    TIMEOUT,
  );

  it.effect(
    "jobs need job.run and an allowed node; a shell job needs all three grants",
    () =>
      withEngine("agent-permissions-jobs", ({ provider, cwd }) =>
        Effect.gen(function* () {
          const jobs = yield* JobService.JobService;
          const node = (allowShell: boolean) =>
            jobs.upsertNode(operator, {
              id: LOCAL,
              label: "This machine",
              transport: { type: "local" },
              enabled: true,
              workspaceRoots: [cwd],
              allowShell,
            });
          yield* node(false);
          const remote = yield* jobs.upsertNode(operator, {
            label: "Build box",
            transport: { type: "ssh", target: "builder@build.example" },
            enabled: true,
            workspaceRoots: ["/srv/work"],
            allowShell: true,
          });
          const { agent, release, orchestrator } = yield* orchestratorInTurn(provider, {
            permissions: permissions(["job.run"], { nodeIds: [LOCAL] }),
          });
          const submit = (
            caller: AutomationCaller,
            key: string,
            action: JobAction,
            nodeId = LOCAL,
          ) =>
            jobs.submit(caller, {
              idempotencyKey: IdempotencyKey.make(key),
              nodeId,
              cwd: nodeId === LOCAL ? cwd : "/srv/work",
              action,
            });
          const code = (effect: ReturnType<typeof submit>) =>
            effect.pipe(
              Effect.flip,
              Effect.map((error) => error.code),
            );
          const ended = (jobId: Parameters<typeof jobs.get>[1]) =>
            jobs.watch(operator, jobId).pipe(
              Stream.takeUntil((job) => job.finishedAt !== null),
              Stream.runDrain,
            );

          // Allowed: recorded as requested by the orchestrator, not by the user.
          const allowed = yield* submit(agent.caller, "allowed", noop);
          assert.deepStrictEqual(allowed.job.requestedBy, {
            kind: "orchestrator",
            orchestratorId: orchestrator.id,
            environmentId,
          });
          yield* ended(allowed.job.id);
          const before = yield* jobCount;

          // Wrong node.
          assert.strictEqual(
            yield* code(submit(agent.caller, "wrong-node", noop, remote.id)),
            "PERMISSION_DENIED",
          );
          // Configuring nodes is the operator's.
          assert.strictEqual(
            (yield* jobs
              .upsertNode(agent.caller, {
                id: LOCAL,
                label: "Mine now",
                transport: { type: "local" },
                enabled: true,
                workspaceRoots: ["/"],
                allowShell: true,
              })
              .pipe(Effect.flip)).code,
            "PERMISSION_DENIED",
          );

          // A shell job: the node's allowShell, the automation:execute scope on the
          // credential, and the orchestrator's job.shell. Each alone is not enough.
          const shell: JobAction = { type: "shell", script: "true" };
          const withScope: OrchestratorCaller = {
            ...agent.caller,
            scopes: [...agent.caller.scopes, AuthAutomationExecuteScope],
          };
          const run = permissions(["job.run"], { nodeIds: [LOCAL] });
          const runAndShell = permissions(["job.run", "job.shell"], { nodeIds: [LOCAL] });
          const attempts: ReadonlyArray<{
            readonly name: string;
            readonly allowShell: boolean;
            readonly caller: AutomationCaller;
            readonly held: OrchestratorPermissions;
          }> = [
            { name: "nothing", allowShell: false, caller: agent.caller, held: run },
            { name: "node-only", allowShell: true, caller: agent.caller, held: run },
            { name: "scope-only", allowShell: false, caller: withScope, held: run },
            { name: "action-only", allowShell: false, caller: agent.caller, held: runAndShell },
            { name: "no-node", allowShell: false, caller: withScope, held: runAndShell },
            { name: "no-scope", allowShell: true, caller: agent.caller, held: runAndShell },
            { name: "no-action", allowShell: true, caller: withScope, held: run },
          ];
          for (const attempt of attempts) {
            yield* node(attempt.allowShell);
            yield* setPermissions(orchestrator, attempt.held);
            assert.strictEqual(
              yield* code(submit(attempt.caller, `shell-${attempt.name}`, shell)),
              "PERMISSION_DENIED",
              attempt.name,
            );
          }
          assert.strictEqual(yield* jobCount, before);
          yield* node(true);
          yield* setPermissions(orchestrator, runAndShell);
          const shellJob = yield* submit(withScope, "shell-all-three", shell);
          assert.isTrue(shellJob.created);
          yield* ended(shellJob.job.id);

          // Without job.run nothing is submitted, and another requester's job is not its to cancel.
          const usersJob = yield* submit(operator, "users-job", noop);
          yield* ended(usersJob.job.id);
          assert.strictEqual(
            (yield* jobs.cancel(agent.caller, usersJob.job.id).pipe(Effect.flip)).code,
            "PERMISSION_DENIED",
          );
          yield* setPermissions(orchestrator, permissions(["thread.read"]));
          assert.strictEqual(
            yield* code(submit(agent.caller, "no-run", noop)),
            "PERMISSION_DENIED",
          );
          yield* release;
        }).pipe(Effect.provide(makeAgentLayer())),
      ),
    TIMEOUT,
  );

  it.effect(
    "emitting an event needs event.emit and stays inside the orchestrator's scope",
    () =>
      withEngine("agent-permissions-events", ({ provider }) =>
        Effect.gen(function* () {
          const { agent, orchestrator, service } = yield* orchestratorInTurn(provider, {
            permissions: permissions(["thread.read"]),
          });
          const other = yield* service.upsert(operator, orchestratorInput({ name: "Other" }));
          // The real journal, beside the probe the runtime writes through. The
          // turn stays held to the end: the two must not append in turns.
          const journal = Context.get(
            yield* Layer.build(EventJournal.layer),
            EventJournal.EventJournal,
          );
          const emit = (key: string, scope: AutomationEvent["scope"]) =>
            journal
              .emit(agent.caller, {
                idempotencyKey: IdempotencyKey.make(key),
                type: "custom.release.noted" as never,
                scope,
              })
              .pipe(Effect.map((result) => result.entry.event));
          const code = (key: string, scope: AutomationEvent["scope"]) =>
            emit(key, scope).pipe(
              Effect.flip,
              Effect.map((error) => error.code),
            );
          // Missing action.
          const empty = (yield* journal.status).headCursor;
          assert.strictEqual(yield* code("no-action", { projectId }), "PERMISSION_DENIED");
          assert.strictEqual((yield* journal.status).headCursor, empty);

          yield* setPermissions(
            orchestrator,
            permissions(["event.emit"], { projectIds: [projectId] }),
          );
          const emitted = yield* emit("allowed", { projectId });
          // The origin is what the session proves: this orchestrator.
          assert.strictEqual(emitted.origin.actorId, agent.caller.subject);
          const head = (yield* journal.status).headCursor;
          assert.strictEqual(
            yield* code("wrong-project", { projectId: otherProjectId }),
            "PERMISSION_DENIED",
          );
          assert.strictEqual(
            yield* code("as-other", { orchestratorId: other.id as OrchestratorId }),
            "PERMISSION_DENIED",
          );
          assert.strictEqual((yield* journal.status).headCursor, head);
        }).pipe(Effect.provide(makeAgentLayer())),
      ),
    TIMEOUT,
  );
});

describe("orchestrator agent requests", () => {
  const worker = ThreadId.make("thread:worker");

  /** An orchestrator mid-turn, and a worker thread in its project stopped on a request. */
  const scene = (
    provider: Parameters<typeof orchestratorInTurn>[0],
    cwd: string,
    kind: OrchestrationV2RuntimeRequest["kind"],
    held: OrchestratorPermissions,
  ) =>
    Effect.gen(function* () {
      const inTurn = yield* orchestratorInTurn(provider, { permissions: held });
      yield* startThreadWithRequest({ threadId: worker, kind, cwd });
      yield* awaitThreadEvent(worker, requestIs("pending"));
      const responsibility = yield* ResponsibilityService.ResponsibilityService;
      const [request] = yield* responsibility.listRequests(user, { threadId: worker });
      const threads = yield* ThreadManagement.ThreadManagementService;
      const stored = threads
        .getThreadRecords(worker, ["runtimeRequests"])
        .pipe(
          Effect.map(
            (records) =>
              records.runtimeRequests.find(
                (candidate) => candidate.id === request!.requestId,
              ) as OrchestrationV2RuntimeRequest,
          ),
        );
      const decide = (
        caller: AutomationCaller,
        key: string,
        decision: "accept" | "decline",
      ): OrchestrationV2Command => ({
        type: "runtime-request.respond",
        commandId: CommandId.make(`command:decide:${caller.kind}:${key}`),
        threadId: worker,
        requestId: request!.requestId,
        decision,
      });
      return { ...inTurn, request: request!, responsibility, threads, stored, decide };
    });

  it.effect(
    "an approval is refused without a pre-authorization and allowed with a matching one",
    () =>
      withEngine("agent-requests-approval", ({ provider, cwd }) =>
        Effect.gen(function* () {
          const answering = permissions(["thread.read", "request.answer", "request.approve"]);
          const { agent, orchestrator, release, request, stored, decide } = yield* scene(
            provider,
            cwd,
            "command",
            answering,
          );
          assert.deepStrictEqual(request.claim?.owner, {
            kind: "orchestrator",
            orchestratorId: orchestrator.id,
            environmentId,
          });
          const refusal = (command: OrchestrationV2Command) =>
            issue(agent.caller, command).pipe(
              Effect.flip,
              Effect.map((error) => ("message" in error ? String(error.message) : "")),
            );
          // No pre-authorization: the decision is the user's.
          assert.include(
            yield* refusal(decide(agent.caller, "none", "accept")),
            "reserved for the user",
          );
          // A pre-authorization for another decision, or another project, does not cover it.
          yield* setPermissions(orchestrator, {
            ...answering,
            preAuthorizedApprovals: [{ requestKind: "command", decisions: ["decline"] }],
          });
          assert.include(
            yield* refusal(decide(agent.caller, "other", "accept")),
            "PERMISSION_DENIED",
          );
          yield* setPermissions(orchestrator, {
            ...answering,
            preAuthorizedApprovals: [
              { requestKind: "command", decisions: ["accept"], projectIds: [otherProjectId] },
            ],
          });
          assert.include(
            yield* refusal(decide(agent.caller, "project", "accept")),
            "PERMISSION_DENIED",
          );
          assert.strictEqual((yield* stored).status, "pending");

          // A matching one: the orchestrator's agent may decide.
          yield* setPermissions(orchestrator, {
            ...answering,
            preAuthorizedApprovals: [{ requestKind: "command", decisions: ["accept"] }],
          });
          yield* issue(agent.caller, decide(agent.caller, "match", "accept"));
          yield* awaitThreadEvent(worker, requestIs("resolved"));
          assert.strictEqual((yield* stored).decision, "accept");
          yield* release;
        }).pipe(Effect.provide(makeAgentLayer())),
      ),
    TIMEOUT,
  );

  it.effect(
    "a decision the user already made is never overwritten by a pre-authorized orchestrator",
    () =>
      withEngine("agent-requests-user-first", ({ provider, cwd }) =>
        Effect.gen(function* () {
          const { agent, release, threads, stored, decide } = yield* scene(
            provider,
            cwd,
            "command",
            {
              actions: ["thread.read", "request.answer", "request.approve"],
              preAuthorizedApprovals: [
                { requestKind: "command", decisions: ["accept", "decline"] },
              ],
            },
          );
          yield* threads.dispatch(decide(user, "user", "decline"));
          yield* awaitThreadEvent(worker, requestIs("resolved"));
          const late = yield* issue(agent.caller, decide(agent.caller, "late", "accept")).pipe(
            Effect.flip,
          );
          assert.include("message" in late ? String(late.message) : "", "REQUEST_ALREADY_RESOLVED");
          assert.strictEqual((yield* stored).decision, "decline");
          yield* release;
        }).pipe(Effect.provide(makeAgentLayer())),
      ),
    TIMEOUT,
  );

  it.effect(
    "an orchestrator's agent answers and transfers only as itself",
    () =>
      withEngine("agent-requests-identity", ({ provider, cwd, journal }) =>
        Effect.gen(function* () {
          const { agent, orchestrator, release, request, responsibility, service } = yield* scene(
            provider,
            cwd,
            "user_input",
            permissions(["thread.read", "request.answer"]),
          );
          const self = {
            kind: "orchestrator",
            orchestratorId: orchestrator.id,
            environmentId,
          } as const;
          const other = yield* service.upsert(operator, orchestratorInput({ name: "Other" }));
          const respond = (
            key: string,
            responder: Parameters<typeof responsibility.respond>[1]["responder"],
          ) =>
            responsibility.respond(agent.caller, {
              idempotencyKey: IdempotencyKey.make(key),
              threadId: worker,
              requestId: request.requestId,
              responder,
              generation: request.claim!.generation,
              answers: { choice: "orchestrator" },
            });
          // Naming someone else is refused.
          assert.strictEqual(
            (yield* respond("as-other", {
              kind: "orchestrator",
              orchestratorId: other.id,
              environmentId,
            }).pipe(Effect.flip)).code,
            "PERMISSION_DENIED",
          );

          // A transfer it asks for is attributed to it in the journal, not to the user.
          const moved = yield* responsibility.transferClaim(agent.caller, {
            idempotencyKey: IdempotencyKey.make("hand-to-user"),
            subject: { kind: "request", threadId: worker, requestId: request.requestId },
            to: { kind: "user" },
            reason: "needs the user's intent",
          });
          assert.deepStrictEqual(moved.owner, { kind: "user" });
          const transfer = (yield* SubscriptionRef.get(journal.events)).findLast(
            (event) => event.type === "claim.changed",
          )!;
          assert.deepStrictEqual(transfer.origin.kind, "agent");
          assert.strictEqual(transfer.origin.actorId, orchestrator.id);
          assert.deepStrictEqual(transfer.payload.transferredBy, self);

          // It no longer owns the claim: it can neither take it back nor answer.
          assert.strictEqual(
            (yield* responsibility
              .transferClaim(agent.caller, {
                idempotencyKey: IdempotencyKey.make("take-back"),
                subject: { kind: "request", threadId: worker, requestId: request.requestId },
                to: self,
              })
              .pipe(Effect.flip)).code,
            "PERMISSION_DENIED",
          );
          // Claiming to be the user does not make it the user: it answers as itself,
          // and the claim is the user's now.
          assert.strictEqual(
            (yield* respond("as-user", { kind: "user" }).pipe(Effect.flip)).code,
            "NOT_OWNER",
          );
          // The same transfer by the user is recorded as the user's.
          yield* responsibility.transferClaim(user, {
            idempotencyKey: IdempotencyKey.make("back-to-orchestrator"),
            subject: { kind: "request", threadId: worker, requestId: request.requestId },
            to: self,
          });
          const byUser = (yield* SubscriptionRef.get(journal.events)).findLast(
            (event) => event.type === "claim.changed",
          )!;
          assert.strictEqual(byUser.origin.kind, "service");
          assert.deepStrictEqual(byUser.payload.transferredBy, { kind: "user" });
          yield* release;
        }).pipe(Effect.provide(makeAgentLayer())),
      ),
    TIMEOUT,
  );
});
