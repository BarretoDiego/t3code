import {
  AuthAutomationExecuteScope,
  AUTOMATION_CONTRACT_VERSION,
  AutomationError,
  DelegatedTask,
  type DelegatedTaskId,
  type DelegatedTaskStatus,
  type OrchestratorAction,
  type ResponsibilityOwner,
  type TaskDelegateInput,
  type TaskListInput,
  type TaskUpdateInput,
  type ThreadId,
  type ThreadTreeNode,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import { type AutomationCaller, automationError, internalCaller } from "../Caller.ts";
import * as EventJournal from "../EventJournal.ts";
import * as OrchestratorService from "../OrchestratorService.ts";
import * as PeerService from "../PeerService.ts";
import {
  deriveTaskState,
  isTerminalTaskStatus,
  MANAGED_THREAD_CAPABILITIES,
  renderTaskPrompt,
  taskCommandId,
  taskEventType,
  taskIdFor,
  taskMessageId,
  taskThreadFacts,
  taskThreadId,
  type TaskStateChange,
} from "./TaskModel.ts";

/** What the origin of a task running elsewhere can do to it: ask for it to stop. */
const REMOTE_TASK_CAPABILITIES: DelegatedTask["capabilities"] = {
  send: false,
  answer: false,
  cancel: true,
  read: false,
};

/** Actions a peer environment may never grant a task it sends here. */
const PEER_FORBIDDEN_ACTIONS: ReadonlySet<OrchestratorAction> = new Set([
  "request.approve",
  "job.shell",
  "peer.message",
  "peer.delegate",
]);

const SUMMARY_EVENT_LIMIT = 4_000;
const UPDATE_IDEMPOTENCY_SCOPE = "task.update";

const TaskJson = Schema.fromJsonString(DelegatedTask);
const decodeTask = Schema.decodeUnknownEffect(TaskJson);
const encodeTask = Schema.encodeEffect(TaskJson);

const internal = (operation: string) => (cause: unknown) =>
  automationError("INTERNAL", `Delegated task ${operation} failed.`, {
    cause: cause instanceof Error ? cause.message : String(cause),
  });

const isAutomationError = Schema.is(AutomationError);

/** Keeps a failure that already has a code; anything else is an internal one. */
const coded = (operation: string) => (cause: unknown) =>
  isAutomationError(cause) ? cause : internal(operation)(cause);

const notFound = (taskId: DelegatedTaskId) =>
  automationError("NOT_FOUND", `No delegated task ${taskId}.`, { taskId });

/**
 * Delegated tasks: the stored contract, the managed thread that carries it
 * out, and the status that follows from that thread's facts. The public
 * service and the reactor are both views of this engine.
 */
export class DelegatedTaskEngine extends Context.Service<
  DelegatedTaskEngine,
  {
    readonly delegate: (
      caller: AutomationCaller,
      input: TaskDelegateInput,
    ) => Effect.Effect<
      { readonly task: DelegatedTask; readonly created: boolean },
      AutomationError
    >;
    readonly get: (taskId: DelegatedTaskId) => Effect.Effect<DelegatedTask, AutomationError>;
    readonly list: (
      input: TaskListInput,
    ) => Effect.Effect<ReadonlyArray<DelegatedTask>, AutomationError>;
    readonly update: (
      caller: AutomationCaller,
      input: TaskUpdateInput,
    ) => Effect.Effect<DelegatedTask, AutomationError>;
    readonly threadTree: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<ThreadTreeNode>, AutomationError>;
    readonly acceptRemote: (
      caller: AutomationCaller,
      task: DelegatedTask,
    ) => Effect.Effect<DelegatedTask, AutomationError>;
    readonly applyRemoteStatus: (
      caller: AutomationCaller,
      task: DelegatedTask,
    ) => Effect.Effect<DelegatedTask, AutomationError>;
    /** Re-derives the status of the task a thread carries out, if it carries one. */
    readonly syncThread: (
      threadId: ThreadId,
      mode: "live" | "reconcile",
    ) => Effect.Effect<void, AutomationError>;
    /** Applies each child task's `onParentCancel` policy after its parent thread stopped. */
    readonly parentStopped: (threadId: ThreadId) => Effect.Effect<void, AutomationError>;
    /** Re-reads every task this environment executes that is not finished. Run at startup. */
    readonly reconcileAll: Effect.Effect<void, AutomationError>;
  }
>()("t3/automation/tasks/TaskEngine/DelegatedTaskEngine") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const journal = yield* EventJournal.EventJournal;
  const peers = yield* PeerService.PeerService;
  const orchestrators = yield* OrchestratorService.OrchestratorService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const launches = yield* ThreadLaunchService.ThreadLaunchService;
  const localEnvironmentId = yield* (yield* ServerEnvironment.ServerEnvironmentIdentity)
    .getEnvironmentId;
  // One writer at a time: every change is read-modify-write on a task row.
  const writes = yield* Semaphore.make(1);

  const rowsToTasks = (rows: ReadonlyArray<{ readonly task_json: string }>) =>
    Effect.forEach(rows, (row) => decodeTask(row.task_json));

  const readTask = (taskId: DelegatedTaskId) =>
    sql<{ readonly task_json: string }>`
      SELECT task_json FROM automation_tasks WHERE task_id = ${taskId}
    `.pipe(
      Effect.flatMap(rowsToTasks),
      Effect.map((tasks) => Option.fromNullishOr(tasks[0])),
      Effect.mapError(internal("read")),
    );

  const requireTask = (taskId: DelegatedTaskId) =>
    readTask(taskId).pipe(
      Effect.flatMap(
        Option.match({ onNone: () => Effect.fail(notFound(taskId)), onSome: Effect.succeed }),
      ),
    );

  const readAll = sql<{ readonly task_json: string }>`
    SELECT task_json FROM automation_tasks ORDER BY created_at ASC, rowid ASC
  `.pipe(Effect.flatMap(rowsToTasks), Effect.mapError(internal("list")));

  const readByThread = (column: "thread_id" | "parent_thread_id", threadId: ThreadId) =>
    (column === "thread_id"
      ? sql<{ readonly task_json: string }>`
          SELECT task_json FROM automation_tasks WHERE thread_id = ${threadId}
        `
      : sql<{ readonly task_json: string }>`
          SELECT task_json FROM automation_tasks WHERE parent_thread_id = ${threadId}
          ORDER BY created_at ASC, rowid ASC
        `
    ).pipe(Effect.flatMap(rowsToTasks), Effect.mapError(internal("read")));

  const writeTask = (task: DelegatedTask) =>
    encodeTask(task).pipe(
      Effect.flatMap(
        (json) => sql`
          INSERT INTO automation_tasks (
            task_id, revision, origin_environment_id, execution_environment_id,
            orchestrator_id, parent_task_id, parent_thread_id, thread_id, status,
            task_json, observed_at, created_at, updated_at
          ) VALUES (
            ${task.id}, ${task.revision}, ${task.originEnvironmentId},
            ${task.executionEnvironmentId}, ${task.orchestratorId}, ${task.parentTaskId},
            ${task.parentThreadId}, ${task.threadId}, ${task.status}, ${json},
            ${task.observedAt}, ${task.createdAt}, ${task.updatedAt}
          )
          ON CONFLICT(task_id) DO UPDATE SET
            revision = excluded.revision,
            thread_id = excluded.thread_id,
            status = excluded.status,
            task_json = excluded.task_json,
            observed_at = excluded.observed_at,
            updated_at = excluded.updated_at
        `,
      ),
    );

  /** The thread the whole lineage hangs from: the topmost ancestor's parent, or the task's own. */
  const rootThreadId = Effect.fn("DelegatedTaskEngine.rootThreadId")(function* (
    task: DelegatedTask,
  ) {
    let current = task;
    for (let depth = 0; depth < 32 && current.parentTaskId !== null; depth += 1) {
      const parent = yield* readTask(current.parentTaskId);
      if (Option.isNone(parent)) break;
      current = parent.value;
    }
    return current.parentThreadId ?? current.threadId;
  });

  /**
   * Stores a task's state together with the journal event that reports it and,
   * for a task another environment delegated here, the status report back to
   * it. All of it commits or none does.
   */
  const save = Effect.fn("DelegatedTaskEngine.save")(function* (
    task: DelegatedTask,
    options: {
      readonly previousStatus: DelegatedTaskStatus | null;
      /** False for a write that changes no fact worth reporting. */
      readonly emit?: boolean;
      readonly idempotency?: { readonly scope: string; readonly key: string };
    },
  ) {
    const root = yield* rootThreadId(task);
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* writeTask(task);
          if (options.idempotency !== undefined) {
            yield* sql`
              INSERT INTO automation_idempotency (scope, idempotency_key, result_json, created_at)
              VALUES (
                ${options.idempotency.scope}, ${options.idempotency.key},
                ${yield* encodeTask(task)}, ${task.updatedAt}
              )
              ON CONFLICT(scope, idempotency_key) DO NOTHING
            `;
          }
          if (options.emit !== false) {
            yield* journal.append([
              {
                type:
                  options.previousStatus === null ? "task.delegated" : taskEventType(task.status),
                origin: { kind: "service", actorId: "delegated-tasks" },
                aggregate: { kind: "task", id: task.id },
                scope: {
                  projectId: task.target.projectId,
                  taskId: task.id,
                  ...(task.threadId === null ? {} : { threadId: task.threadId }),
                  ...(task.parentThreadId === null ? {} : { parentThreadId: task.parentThreadId }),
                  ...(root === null ? {} : { rootThreadId: root }),
                  ...(task.orchestratorId === null ? {} : { orchestratorId: task.orchestratorId }),
                  ...(task.nodeId === null ? {} : { nodeId: task.nodeId }),
                },
                occurredAt: task.updatedAt,
                correlationId: task.id,
                dedupKey: `task:${task.id}:${task.revision}:${task.status}`,
                payload: {
                  status: task.status,
                  previousStatus: options.previousStatus,
                  revision: task.revision,
                  statusReason: task.statusReason,
                  title: task.contract.title,
                  originEnvironmentId: task.originEnvironmentId,
                  executionEnvironmentId: task.executionEnvironmentId,
                  parentTaskId: task.parentTaskId,
                  ...(task.status === "reported" || task.status === "validated"
                    ? { summary: (task.result?.summary ?? "").slice(0, SUMMARY_EVENT_LIMIT) }
                    : {}),
                },
              },
            ]);
          }
          if (
            task.originEnvironmentId !== localEnvironmentId &&
            task.executionEnvironmentId === localEnvironmentId
          ) {
            yield* peers.enqueue({
              toEnvironmentId: task.originEnvironmentId,
              body: { type: "task.status", task },
              correlationId: task.id,
              dedupKey: `task.status:${task.id}:${task.revision}`,
            });
          }
        }),
      )
      .pipe(Effect.mapError(coded("write")));
    return task;
  });

  /** The next revision of a task: `changes` applied, the clock read once. */
  const revise = Effect.fn("DelegatedTaskEngine.revise")(function* (
    task: DelegatedTask,
    changes: Partial<DelegatedTask>,
  ) {
    const now = DateTime.formatIso(yield* DateTime.now);
    return {
      ...task,
      ...changes,
      revision: task.revision + 1,
      observedAt: now,
      updatedAt: now,
    } satisfies DelegatedTask;
  });

  const applyChange = (task: DelegatedTask, change: TaskStateChange, runCount?: number) =>
    revise(task, {
      status: change.status,
      statusReason: change.statusReason,
      ...(runCount === undefined ? {} : { usage: { ...task.usage, turns: runCount } }),
      ...(change.summary === undefined
        ? {}
        : {
            result: {
              summary: change.summary,
              // A report resets what was checked: the criteria are unverified again.
              criteria: task.contract.acceptanceCriteria.map((text) => ({
                text,
                met: null,
                evidence: null,
              })),
              validatedBy: null,
              refs: task.result?.refs ?? [],
            },
          }),
    });

  const readFacts = (threadId: ThreadId) =>
    threads
      .getThreadRecords(threadId, ["runs", "runtimeRequests", "providerSessions", "messages"], {
        messageRoles: ["user", "assistant"],
      })
      .pipe(Effect.map(taskThreadFacts), Effect.option);

  /** Re-derives one locally executed task from its thread. Callers hold the write lock. */
  const syncTask = Effect.fn("DelegatedTaskEngine.syncTask")(function* (
    task: DelegatedTask,
    mode: "live" | "reconcile",
  ) {
    if (
      task.executionEnvironmentId !== localEnvironmentId ||
      task.threadId === null ||
      isTerminalTaskStatus(task.status)
    ) {
      return task;
    }
    const facts = yield* readFacts(task.threadId);
    if (Option.isNone(facts)) {
      // A thread that cannot be read proves nothing about the work in it.
      if (task.status === "unknown") return task;
      return yield* save(
        yield* revise(task, {
          status: "unknown",
          statusReason: "The task's thread could not be read.",
        }),
        { previousStatus: task.status },
      );
    }
    const change = deriveTaskState(task, facts.value, mode);
    if (change === null) return task;
    const next = yield* save(yield* applyChange(task, change, facts.value.runCount), {
      previousStatus: task.status,
    });
    if (next.status === "validated" || isTerminalTaskStatus(next.status)) {
      yield* releaseDependents(next);
    }
    return next;
  });

  const mutate = <A, E>(effect: Effect.Effect<A, E>) => writes.withPermits(1)(effect);

  const dependenciesOf = (contract: DelegatedTask["contract"]) =>
    Effect.forEach(contract.dependsOn ?? [], (id) =>
      readTask(id).pipe(Effect.map((dependency) => ({ id, dependency }))),
    );

  /**
   * Launches the managed thread of a task this environment executes, or parks
   * the task: expired past its deadline, blocked on dependencies. Thread,
   * message and command ids follow from the task id, so launching twice can
   * only ever find the same thread.
   */
  const startTask: (task: DelegatedTask) => Effect.Effect<DelegatedTask, AutomationError> =
    Effect.fn("DelegatedTaskEngine.startTask")(function* (task: DelegatedTask) {
      const now = yield* DateTime.now;
      const deadline =
        task.contract.deadline === undefined
          ? Option.none()
          : DateTime.make(task.contract.deadline);
      if (
        Option.isSome(deadline) &&
        DateTime.toEpochMillis(deadline.value) <= DateTime.toEpochMillis(now)
      ) {
        return yield* mutate(
          Effect.gen(function* () {
            return yield* save(
              yield* revise(task, {
                status: "expired",
                statusReason: `The deadline ${task.contract.deadline} passed before the task started.`,
              }),
              { previousStatus: task.status },
            );
          }),
        );
      }
      const unmet = (yield* dependenciesOf(task.contract)).filter(
        ({ dependency }) => Option.isNone(dependency) || dependency.value.status !== "validated",
      );
      if (unmet.length > 0) {
        const statusReason = `Waiting on ${unmet.map(({ id }) => id).join(", ")}.`;
        if (task.status === "blocked" && task.statusReason === statusReason) return task;
        return yield* mutate(
          Effect.gen(function* () {
            return yield* save(yield* revise(task, { status: "blocked", statusReason }), {
              previousStatus: task.status,
            });
          }),
        );
      }
      const parent = task.parentThreadId === null ? null : yield* shellOf(task.parentThreadId);
      const modelSelection = task.target.modelSelection ?? parent?.modelSelection;
      if (modelSelection === undefined) {
        return yield* mutate(
          Effect.gen(function* () {
            return yield* save(
              yield* revise(task, {
                status: "failed",
                statusReason:
                  "No model to run on: the task names no target.modelSelection and has no parent thread on this environment to inherit one from.",
              }),
              { previousStatus: task.status },
            );
          }),
        );
      }
      const threadId = taskThreadId(task.id);
      const launched = yield* launches
        .launch({
          commandId: taskCommandId(task.id, "launch"),
          threadId,
          projectId: task.target.projectId,
          title: task.contract.title,
          generateTitle: false,
          modelSelection,
          runtimeMode: task.target.runtimeMode ?? parent?.runtimeMode ?? "approval-required",
          interactionMode: task.target.interactionMode ?? "default",
          workspaceStrategy: task.target.workspaceStrategy ?? { type: "root" },
          initialMessage: {
            messageId: taskMessageId(task.id, "contract"),
            text: renderTaskPrompt({ taskId: task.id, contract: task.contract }),
            attachments: [],
          },
          createdBy: "agent",
          creationSource: "server",
        })
        .pipe(Effect.result);
      return yield* mutate(
        Effect.gen(function* () {
          const current = yield* requireTask(task.id);
          if (launched._tag === "Failure") {
            return yield* save(
              yield* revise(current, {
                status: "failed",
                statusReason: `The thread could not be launched: ${launched.failure.message}`,
              }),
              { previousStatus: current.status },
            );
          }
          const accepted = yield* save(
            yield* revise(current, {
              threadId,
              status: "accepted",
              statusReason: null,
              attemptCount: current.attemptCount + 1,
            }),
            { previousStatus: current.status },
          );
          return yield* syncTask(accepted, "live");
        }),
      );
    });

  /** Starts every task that was only waiting on `finished`, or fails it if that can no longer happen. */
  const releaseDependents: (finished: DelegatedTask) => Effect.Effect<void, AutomationError> =
    Effect.fn("DelegatedTaskEngine.releaseDependents")(function* (finished: DelegatedTask) {
      const waiting = (yield* readAll).filter(
        (task) =>
          task.status === "blocked" &&
          task.threadId === null &&
          task.executionEnvironmentId === localEnvironmentId &&
          (task.contract.dependsOn ?? []).includes(finished.id),
      );
      for (const task of waiting) {
        if (finished.status === "validated") {
          // Launching is slow and takes the write lock itself, so it runs
          // after this change has been written.
          yield* Effect.forkDetach(startTask(task).pipe(Effect.ignore({ log: true })));
          continue;
        }
        yield* save(
          yield* revise(task, {
            status: "failed",
            statusReason: `Dependency ${finished.id} ended as ${finished.status}.`,
          }),
          { previousStatus: task.status },
        );
      }
    });

  const shellOf = (threadId: ThreadId) =>
    threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));

  const ownerOf = (caller: AutomationCaller, task: DelegatedTask): ResponsibilityOwner =>
    caller.kind === "internal" && task.orchestratorId !== null
      ? {
          kind: "orchestrator",
          orchestratorId: task.orchestratorId,
          environmentId: localEnvironmentId,
        }
      : { kind: "user" };

  /** Refuses a contract that grants more than whoever delegates it holds. */
  const checkPermissions = Effect.fn("DelegatedTaskEngine.checkPermissions")(function* (
    caller: AutomationCaller,
    input: TaskDelegateInput,
    parentTask: Option.Option<DelegatedTask>,
    remote: boolean,
  ) {
    const requested = input.contract.permissions ?? [];
    const denied = (message: string, actions: ReadonlyArray<string>) =>
      automationError("PERMISSION_DENIED", message, { actions: [...actions] });
    if (
      requested.includes("job.shell") &&
      caller.kind !== "internal" &&
      !caller.scopes.includes(AuthAutomationExecuteScope)
    ) {
      return yield* denied("Granting job.shell needs the automation:execute scope.", ["job.shell"]);
    }
    if (Option.isSome(parentTask)) {
      const held = parentTask.value.contract.permissions ?? [];
      const extra = requested.filter((action) => !held.includes(action));
      if (extra.length > 0) {
        return yield* denied(
          `A task cannot grant more than its parent task ${parentTask.value.id} holds.`,
          extra,
        );
      }
    }
    if (input.orchestratorId === undefined) return;
    const orchestrator = (yield* orchestrators.list(internalCaller("delegated-tasks"))).find(
      (entry) => entry.id === input.orchestratorId,
    );
    if (orchestrator === undefined) {
      return yield* automationError("NOT_FOUND", `No orchestrator ${input.orchestratorId}.`, {
        orchestratorId: input.orchestratorId,
      });
    }
    const { permissions } = orchestrator;
    const needed: OrchestratorAction = remote ? "peer.delegate" : "task.delegate";
    if (!permissions.actions.includes(needed)) {
      return yield* denied(`Orchestrator ${orchestrator.id} may not delegate tasks.`, [needed]);
    }
    const extra = requested.filter((action) => !permissions.actions.includes(action));
    if (extra.length > 0) {
      return yield* denied(
        `A task cannot grant more than orchestrator ${orchestrator.id} holds.`,
        extra,
      );
    }
    if (
      permissions.projectIds !== undefined &&
      !permissions.projectIds.includes(input.target.projectId)
    ) {
      return yield* denied(
        `Orchestrator ${orchestrator.id} may not act on project ${input.target.projectId}.`,
        [needed],
      );
    }
    if (
      remote &&
      permissions.environmentIds !== undefined &&
      !permissions.environmentIds.includes(input.target.environmentId!)
    ) {
      return yield* denied(
        `Orchestrator ${orchestrator.id} may not address environment ${input.target.environmentId}.`,
        [needed],
      );
    }
  });

  const delegate: DelegatedTaskEngine["Service"]["delegate"] = Effect.fn(
    "DelegatedTaskEngine.delegate",
  )(function* (caller, input) {
    const taskId = taskIdFor(localEnvironmentId, input.idempotencyKey);
    const targetEnvironmentId = input.target.environmentId ?? localEnvironmentId;
    const remote = targetEnvironmentId !== localEnvironmentId;
    if (input.target.nodeId !== undefined) {
      return yield* automationError(
        "CAPABILITY_UNSUPPORTED",
        "A managed thread runs on its environment's own machine. Execution nodes run jobs, not threads.",
        { nodeId: input.target.nodeId },
      );
    }
    if (input.target.profile !== undefined) {
      return yield* automationError(
        "CAPABILITY_UNSUPPORTED",
        "Delegated tasks cannot apply an agent profile yet.",
        { profile: input.target.profile },
      );
    }
    const stored = yield* mutate(
      Effect.gen(function* () {
        const existing = yield* readTask(taskId);
        if (Option.isSome(existing)) return { task: existing.value, created: false };
        const parentTask =
          input.parentTaskId === undefined
            ? Option.none<DelegatedTask>()
            : Option.some(yield* requireTask(input.parentTaskId));
        const parentThreadId =
          input.parentThreadId ?? Option.getOrNull(parentTask)?.threadId ?? null;
        if (parentThreadId !== null && (yield* shellOf(parentThreadId)) === null) {
          return yield* automationError("NOT_FOUND", `No thread ${parentThreadId}.`, {
            threadId: parentThreadId,
          });
        }
        for (const { id, dependency } of yield* dependenciesOf(input.contract)) {
          if (Option.isNone(dependency)) {
            return yield* automationError("INVALID_INPUT", `dependsOn names no task ${id}.`, {
              taskId: id,
            });
          }
        }
        if (
          input.contract.deadline !== undefined &&
          Option.isNone(DateTime.make(input.contract.deadline))
        ) {
          return yield* automationError("INVALID_INPUT", "contract.deadline is not a date-time.");
        }
        yield* checkPermissions(caller, input, parentTask, remote);
        const now = DateTime.formatIso(yield* DateTime.now);
        const task: DelegatedTask = {
          id: taskId,
          version: AUTOMATION_CONTRACT_VERSION,
          revision: 1,
          originEnvironmentId: localEnvironmentId,
          executionEnvironmentId: targetEnvironmentId,
          nodeId: null,
          orchestratorId: input.orchestratorId ?? null,
          parentTaskId: input.parentTaskId ?? null,
          parentThreadId,
          threadId: null,
          kind: "managed_thread",
          capabilities: remote ? REMOTE_TASK_CAPABILITIES : MANAGED_THREAD_CAPABILITIES,
          target: input.target,
          contract: input.contract,
          // Stored, not yet started. A remote task stays here until its
          // destination reports that it accepted it.
          status: "pending_delivery",
          statusReason: null,
          attemptCount: 0,
          claim: null,
          result: null,
          usage: { tokens: null, turns: 0 },
          observedAt: now,
          createdAt: now,
          updatedAt: now,
        };
        if (!remote) {
          yield* save(task, { previousStatus: null });
          return { task, created: true };
        }
        // The task and the message that carries it commit together: either the
        // peer link has it queued, or the task does not exist.
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* save(task, { previousStatus: null });
              yield* peers.enqueue({
                toEnvironmentId: targetEnvironmentId,
                body: { type: "task.delegate", task },
                correlationId: task.id,
                dedupKey: `task.delegate:${task.id}`,
                ...(task.contract.deadline === undefined
                  ? {}
                  : { expiresAt: task.contract.deadline }),
              });
            }),
          )
          .pipe(Effect.mapError(coded("write")));
        return { task, created: true };
      }),
    );
    if (!stored.created || remote) return stored;
    return { task: yield* startTask(stored.task), created: true };
  });

  const list: DelegatedTaskEngine["Service"]["list"] = Effect.fn("DelegatedTaskEngine.list")(
    function* (input) {
      const all = yield* readAll;
      const descendants = (() => {
        if (input.rootTaskId === undefined) return null;
        const ids = new Set<string>([input.rootTaskId]);
        for (let grew = true; grew;) {
          grew = false;
          for (const task of all) {
            if (task.parentTaskId !== null && ids.has(task.parentTaskId) && !ids.has(task.id)) {
              ids.add(task.id);
              grew = true;
            }
          }
        }
        return ids;
      })();
      return all.filter(
        (task) =>
          (input.orchestratorId === undefined || task.orchestratorId === input.orchestratorId) &&
          (input.parentThreadId === undefined || task.parentThreadId === input.parentThreadId) &&
          (descendants === null || descendants.has(task.id)) &&
          (input.statuses === undefined
            ? input.includeTerminal === true || !isTerminalTaskStatus(task.status)
            : input.statuses.includes(task.status)),
      );
    },
  );

  /** Stops a task's thread: the active run is interrupted and queued ones are withdrawn. */
  const stopThread = Effect.fn("DelegatedTaskEngine.stopThread")(function* (
    task: DelegatedTask,
    threadId: ThreadId,
    part: string,
  ) {
    yield* threads
      .interruptThread({
        projectId: task.target.projectId,
        commandId: taskCommandId(task.id, `interrupt:${part}`),
        threadId,
        reason: "Delegated task cancelled.",
      })
      .pipe(Effect.mapError(internal("cancel")));
    const { runs } = yield* threads
      .getThreadRecords(threadId, ["runs"])
      .pipe(Effect.mapError(internal("cancel")));
    for (const run of runs.filter((candidate) => candidate.status === "queued")) {
      yield* threads
        .dispatch({
          type: "queued-run.cancel",
          commandId: taskCommandId(task.id, `cancel-queued:${part}:${run.id}`),
          threadId,
          runId: run.id,
        })
        .pipe(Effect.ignore({ log: true }));
    }
  });

  /**
   * Requests cancellation. The task is `cancelled` only once its thread shows
   * nothing running; until then it is `cancel_requested`. Child tasks follow
   * their own `onParentCancel` policy.
   */
  const cancelTask: (
    task: DelegatedTask,
    reason: string | undefined,
    part: string,
    idempotency?: { readonly scope: string; readonly key: string },
  ) => Effect.Effect<DelegatedTask, AutomationError> = Effect.fn("DelegatedTaskEngine.cancel")(
    function* (task, reason, part, idempotency) {
      if (isTerminalTaskStatus(task.status)) return task;
      const statusReason = reason?.trim() ? reason.trim() : "Cancelled.";
      if (task.executionEnvironmentId !== localEnvironmentId) {
        // The revision belongs to the environment that executes the task, so a
        // request made here does not advance it.
        const requested: DelegatedTask = { ...task, status: "cancel_requested", statusReason };
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* save(requested, {
                previousStatus: task.status,
                ...(idempotency === undefined ? {} : { idempotency }),
              });
              yield* peers.enqueue({
                toEnvironmentId: task.executionEnvironmentId,
                body: { type: "task.cancel", taskId: task.id, reason: reason ?? null },
                correlationId: task.id,
                dedupKey: `task.cancel:${task.id}`,
              });
            }),
          )
          .pipe(Effect.mapError(coded("write")));
        return requested;
      }
      if (task.threadId === null) {
        return yield* save(yield* revise(task, { status: "cancelled", statusReason }), {
          previousStatus: task.status,
          ...(idempotency === undefined ? {} : { idempotency }),
        });
      }
      const requested = yield* save(
        yield* revise(task, { status: "cancel_requested", statusReason }),
        { previousStatus: task.status, ...(idempotency === undefined ? {} : { idempotency }) },
      );
      yield* stopThread(requested, task.threadId, part);
      const settled = yield* syncTask(requested, "live");
      for (const child of (yield* readAll).filter(
        (candidate) =>
          candidate.parentTaskId === task.id && candidate.contract.onParentCancel === "cancel",
      )) {
        yield* cancelTask(child, `Parent task ${task.id} was cancelled.`, `parent:${part}`);
      }
      return settled;
    },
  );

  const update: DelegatedTaskEngine["Service"]["update"] = Effect.fn("DelegatedTaskEngine.update")(
    function* (caller, input) {
      const idempotency = { scope: UPDATE_IDEMPOTENCY_SCOPE, key: input.idempotencyKey };
      return yield* mutate(
        Effect.gen(function* () {
          const repeated = yield* sql<{ readonly result_json: string }>`
            SELECT result_json FROM automation_idempotency
            WHERE scope = ${idempotency.scope} AND idempotency_key = ${idempotency.key}
          `.pipe(
            Effect.flatMap((rows) => Effect.forEach(rows, (row) => decodeTask(row.result_json))),
            Effect.mapError(internal("read")),
          );
          if (repeated[0] !== undefined) return repeated[0];
          const task = yield* requireTask(input.taskId);
          if (caller.kind === "peer" && caller.environmentId !== task.originEnvironmentId) {
            return yield* automationError(
              "PERMISSION_DENIED",
              `Task ${task.id} belongs to another environment.`,
              { taskId: task.id },
            );
          }
          if (input.expectedRevision !== undefined && input.expectedRevision !== task.revision) {
            return yield* automationError(
              "REVISION_MISMATCH",
              `Task ${task.id} is at revision ${task.revision}, not ${input.expectedRevision}.`,
              { taskId: task.id, currentRevision: task.revision },
            );
          }
          const { action } = input;
          if (action.type === "cancel") {
            return yield* cancelTask(task, action.reason, input.idempotencyKey, idempotency);
          }
          if (task.executionEnvironmentId !== localEnvironmentId) {
            return yield* automationError(
              "CAPABILITY_UNSUPPORTED",
              `Task ${task.id} runs on environment ${task.executionEnvironmentId}; only cancel can be requested from here. Run this command against that environment.`,
              { taskId: task.id, executionEnvironmentId: task.executionEnvironmentId },
            );
          }
          const conflict = (message: string) =>
            automationError("CONFLICT", message, { taskId: task.id, status: task.status });
          switch (action.type) {
            case "reconcile": {
              if (isTerminalTaskStatus(task.status)) return task;
              // A launch whose outcome was never recorded: the thread id follows
              // from the task id, so the thread either exists or was never made.
              if (task.threadId === null) {
                if (task.status !== "pending_delivery" && task.status !== "unknown") return task;
                const threadId = taskThreadId(task.id);
                if ((yield* shellOf(threadId)) === null) {
                  return yield* save(
                    yield* revise(task, {
                      status: "failed",
                      statusReason:
                        "The task's thread was never created. Delegate it again with a new idempotency key.",
                    }),
                    { previousStatus: task.status, idempotency },
                  );
                }
                const adopted = yield* save(
                  yield* revise(task, {
                    threadId,
                    status: "accepted",
                    statusReason: null,
                    attemptCount: Math.max(1, task.attemptCount),
                  }),
                  { previousStatus: task.status },
                );
                return yield* syncTask(adopted, "reconcile");
              }
              return yield* syncTask(task, "reconcile");
            }
            case "send": {
              if (!task.capabilities.send || task.threadId === null) {
                return yield* conflict(`Task ${task.id} has no thread that takes messages.`);
              }
              if (isTerminalTaskStatus(task.status)) {
                return yield* conflict(`Task ${task.id} is ${task.status} and takes no messages.`);
              }
              yield* threads
                .sendToThread({
                  projectId: task.target.projectId,
                  commandId: taskCommandId(task.id, `send:${input.idempotencyKey}`),
                  threadId: task.threadId,
                  messageId: taskMessageId(task.id, `send:${input.idempotencyKey}`),
                  text: action.text,
                  attachments: [],
                  mode: "auto",
                  createdBy: caller.kind === "client" ? "user" : "agent",
                  creationSource: "server",
                })
                .pipe(Effect.mapError(internal("send")));
              const synced = yield* syncTask(task, "live");
              return yield* save(synced, {
                previousStatus: synced.status,
                emit: false,
                idempotency,
              });
            }
            case "validate": {
              if (task.status !== "reported") {
                return yield* conflict(
                  `Task ${task.id} is ${task.status}; only a reported task can be validated.`,
                );
              }
              const criteria = task.contract.acceptanceCriteria;
              if (action.criteria.length !== criteria.length) {
                return yield* automationError(
                  "INVALID_INPUT",
                  `Task ${task.id} has ${criteria.length} acceptance criteria; ${action.criteria.length} results were given. Give one per criterion, in order.`,
                  { taskId: task.id, expected: criteria.length },
                );
              }
              const unmet = action.criteria.filter((entry) => !entry.met).length;
              if (unmet > 0) {
                return yield* automationError(
                  "INVALID_INPUT",
                  `${unmet} acceptance criteria are not met, so the task cannot be validated. Reject it with the reason instead.`,
                  { taskId: task.id, unmet },
                );
              }
              const validated = yield* save(
                yield* revise(task, {
                  status: "validated",
                  statusReason: null,
                  result: {
                    summary: action.summary ?? task.result?.summary ?? "",
                    criteria: criteria.map((text, index) => ({
                      text,
                      met: action.criteria[index]!.met,
                      evidence: action.criteria[index]!.evidence ?? null,
                    })),
                    validatedBy: ownerOf(caller, task),
                    refs: task.result?.refs ?? [],
                  },
                }),
                { previousStatus: task.status, idempotency },
              );
              yield* releaseDependents(validated);
              return validated;
            }
            case "reject": {
              if (task.status !== "reported" || task.threadId === null) {
                return yield* conflict(
                  `Task ${task.id} is ${task.status}; only a reported task can be rejected.`,
                );
              }
              // The reason reaches the child as its next message, which opens a
              // new run: the task is running again.
              yield* threads
                .sendToThread({
                  projectId: task.target.projectId,
                  commandId: taskCommandId(task.id, `reject:${input.idempotencyKey}`),
                  threadId: task.threadId,
                  messageId: taskMessageId(task.id, `reject:${input.idempotencyKey}`),
                  text: `Your report for task ${task.id} was not accepted:\n\n${action.reason}\n\nAddress this and report again.`,
                  attachments: [],
                  mode: "auto",
                  createdBy: caller.kind === "client" ? "user" : "agent",
                  creationSource: "server",
                })
                .pipe(Effect.mapError(internal("reject")));
              return yield* save(
                yield* revise(task, {
                  status: "running",
                  statusReason: `Rejected: ${action.reason}`,
                  attemptCount: task.attemptCount + 1,
                }),
                { previousStatus: task.status, idempotency },
              );
            }
          }
        }),
      );
    },
  );

  const threadTree: DelegatedTaskEngine["Service"]["threadTree"] = Effect.fn(
    "DelegatedTaskEngine.threadTree",
  )(function* (rootId) {
    const root = yield* shellOf(rootId);
    if (root === null) {
      return yield* automationError("NOT_FOUND", `No thread ${rootId}.`, { threadId: rootId });
    }
    const tasks = yield* readAll;
    const shells = yield* threads.getShellSnapshot({ location: "active" }).pipe(
      Effect.map((snapshot) => snapshot.threads),
      Effect.mapError(internal("tree")),
    );
    const nodes: Array<ThreadTreeNode> = [];
    const seen = new Set<string>();
    const visit: (
      node: Omit<ThreadTreeNode, "title" | "threadStatus" | "pendingRequests">,
    ) => Effect.Effect<void, AutomationError> = Effect.fn("DelegatedTaskEngine.threadTree.visit")(
      function* (node) {
        if (seen.has(node.threadId) || node.depth > 32) return;
        seen.add(node.threadId);
        const shell = node.threadId === rootId ? root : yield* shellOf(node.threadId);
        const records = yield* threads
          .getThreadRecords(node.threadId, ["runtimeRequests", "subagents"])
          .pipe(Effect.option);
        nodes.push({
          ...node,
          title:
            shell?.title ?? tasks.find((task) => task.id === node.taskId)?.contract.title ?? "",
          // A thread this environment cannot read is on another one, or gone.
          threadStatus: shell?.status ?? "unavailable",
          pendingRequests: Option.match(records, {
            onNone: () => 0,
            onSome: ({ runtimeRequests }) =>
              runtimeRequests.filter(
                (request) => request.status === "pending" && request.kind !== "auth_refresh",
              ).length,
          }),
        });
        const child = { parentThreadId: node.threadId, depth: node.depth + 1 } as const;
        // Managed tasks first: a thread that carries a task is listed as one.
        for (const task of tasks) {
          if (task.parentThreadId !== node.threadId || task.threadId === null) continue;
          yield* visit({
            ...child,
            threadId: task.threadId,
            relationship: "delegated",
            kind: "managed_thread",
            taskId: task.id,
            taskStatus: task.status,
          });
        }
        for (const subagent of Option.match(records, {
          onNone: () => [],
          onSome: ({ subagents }) => subagents,
        })) {
          if (subagent.childThreadId === null) continue;
          yield* visit({
            ...child,
            threadId: subagent.childThreadId,
            relationship: "subagent",
            // The provider runs a native subagent itself: T3 can only read it.
            kind: subagent.origin === "provider_native" ? "native_subagent" : "thread",
            taskId: null,
            taskStatus: null,
          });
        }
        for (const thread of shells) {
          if (thread.lineage.parentThreadId !== node.threadId) continue;
          yield* visit({
            ...child,
            threadId: thread.id,
            relationship: thread.lineage.relationshipToParent,
            kind:
              thread.lineage.relationshipToParent === "subagent" &&
              thread.creationSource === "provider"
                ? "native_subagent"
                : "thread",
            taskId: null,
            taskStatus: null,
          });
        }
      },
    );
    const rootTask = tasks.find((task) => task.threadId === rootId);
    yield* visit({
      threadId: rootId,
      parentThreadId: rootTask?.parentThreadId ?? root.lineage.parentThreadId,
      relationship: rootTask === undefined ? root.lineage.relationshipToParent : "delegated",
      kind: rootTask === undefined ? "thread" : "managed_thread",
      taskId: rootTask?.id ?? null,
      taskStatus: rootTask?.status ?? null,
      depth: 0,
    });
    return nodes;
  });

  const acceptRemote: DelegatedTaskEngine["Service"]["acceptRemote"] = Effect.fn(
    "DelegatedTaskEngine.acceptRemote",
  )(function* (caller, incoming) {
    if (caller.kind === "client") {
      return yield* automationError(
        "PERMISSION_DENIED",
        "Only a peer environment delivers a remote task.",
      );
    }
    if (caller.kind === "peer" && caller.environmentId !== incoming.originEnvironmentId) {
      return yield* automationError(
        "PERMISSION_DENIED",
        `Task ${incoming.id} claims origin ${incoming.originEnvironmentId}, but ${caller.environmentId} delivered it.`,
        { taskId: incoming.id },
      );
    }
    if (
      incoming.executionEnvironmentId !== localEnvironmentId ||
      incoming.originEnvironmentId === localEnvironmentId
    ) {
      return yield* automationError(
        "INVALID_INPUT",
        `Task ${incoming.id} is not addressed to this environment.`,
        { taskId: incoming.id },
      );
    }
    const forbidden = (incoming.contract.permissions ?? []).filter((action) =>
      PEER_FORBIDDEN_ACTIONS.has(action),
    );
    if (forbidden.length > 0) {
      return yield* automationError(
        "PERMISSION_DENIED",
        "A peer cannot grant a task approval, shell, or federation actions on this environment.",
        { taskId: incoming.id, actions: forbidden },
      );
    }
    if (caller.kind === "peer") {
      const peer = (yield* peers.list(internalCaller("delegated-tasks"))).find(
        (entry) => entry.environmentId === caller.environmentId,
      );
      const { permissions } = peer ?? {};
      if (
        peer === undefined ||
        !peer.enabled ||
        permissions === undefined ||
        !permissions.inbound.includes("task.delegate") ||
        (permissions.projectIds !== undefined &&
          !permissions.projectIds.includes(incoming.target.projectId))
      ) {
        return yield* automationError(
          "PERMISSION_DENIED",
          `Environment ${caller.environmentId} may not delegate tasks to project ${incoming.target.projectId} here.`,
          { taskId: incoming.id },
        );
      }
    }
    const stored = yield* mutate(
      Effect.gen(function* () {
        const existing = yield* readTask(incoming.id);
        if (Option.isSome(existing)) return { task: existing.value, created: false };
        const now = DateTime.formatIso(yield* DateTime.now);
        // This environment's own record: it owns the thread and the status. The
        // parent thread lives at the origin, so it means nothing here.
        const task: DelegatedTask = {
          ...incoming,
          revision: 1,
          nodeId: null,
          parentTaskId: null,
          parentThreadId: null,
          threadId: null,
          kind: "managed_thread",
          capabilities: MANAGED_THREAD_CAPABILITIES,
          status: "pending_delivery",
          statusReason: null,
          attemptCount: 0,
          claim: null,
          result: null,
          usage: { tokens: null, turns: 0 },
          observedAt: now,
          updatedAt: now,
        };
        yield* save(task, { previousStatus: null });
        return { task, created: true };
      }),
    );
    // The deadline is checked again here, at the moment the work would start.
    return stored.created ? yield* startTask(stored.task) : stored.task;
  });

  const applyRemoteStatus: DelegatedTaskEngine["Service"]["applyRemoteStatus"] = Effect.fn(
    "DelegatedTaskEngine.applyRemoteStatus",
  )(function* (caller, incoming) {
    if (caller.kind === "client") {
      return yield* automationError(
        "PERMISSION_DENIED",
        "Only a peer environment reports a remote task's status.",
      );
    }
    return yield* mutate(
      Effect.gen(function* () {
        const task = yield* requireTask(incoming.id);
        if (
          task.originEnvironmentId !== localEnvironmentId ||
          (caller.kind === "peer" && caller.environmentId !== task.executionEnvironmentId)
        ) {
          return yield* automationError(
            "PERMISSION_DENIED",
            `Task ${task.id} is not executed by the environment reporting on it.`,
            { taskId: task.id },
          );
        }
        // Reports can arrive late or twice. Only a newer one says anything new.
        if (incoming.revision <= task.revision && task.status !== "pending_delivery") return task;
        const now = DateTime.formatIso(yield* DateTime.now);
        // The executor owns what happened; the contract and lineage stay ours.
        const merged: DelegatedTask = {
          ...task,
          revision: Math.max(task.revision, incoming.revision),
          threadId: incoming.threadId,
          status: incoming.status,
          statusReason: incoming.statusReason,
          attemptCount: incoming.attemptCount,
          result: incoming.result,
          usage: incoming.usage,
          observedAt: now,
          updatedAt: incoming.updatedAt,
        };
        return yield* save(merged, { previousStatus: task.status });
      }),
    );
  });

  const syncThread: DelegatedTaskEngine["Service"]["syncThread"] = (threadId, mode) =>
    mutate(
      Effect.gen(function* () {
        for (const task of yield* readByThread("thread_id", threadId)) yield* syncTask(task, mode);
      }),
    );

  const parentStopped: DelegatedTaskEngine["Service"]["parentStopped"] = (threadId) =>
    mutate(
      Effect.gen(function* () {
        for (const task of yield* readByThread("parent_thread_id", threadId)) {
          // `detach` is the default: work delegated from a thread outlives it.
          if (task.contract.onParentCancel !== "cancel") continue;
          yield* cancelTask(task, `Parent thread ${threadId} was stopped.`, `parent:${threadId}`);
        }
      }),
    );

  const reconcileAll: DelegatedTaskEngine["Service"]["reconcileAll"] = mutate(
    Effect.gen(function* () {
      for (const task of yield* readAll) {
        if (
          task.executionEnvironmentId !== localEnvironmentId ||
          isTerminalTaskStatus(task.status)
        ) {
          continue;
        }
        if (task.threadId !== null) {
          yield* syncTask(task, "reconcile");
          continue;
        }
        // Stored and handed to the launcher, with no outcome recorded: the
        // server stopped in between. Nothing is re-run; `reconcile` settles it.
        if (task.status === "pending_delivery") {
          yield* save(
            yield* revise(task, {
              status: "unknown",
              statusReason:
                "The server stopped while this task's thread was being launched. Reconcile the task to find out whether it started.",
            }),
            { previousStatus: task.status },
          );
        }
      }
    }),
  );

  return DelegatedTaskEngine.of({
    delegate,
    get: requireTask,
    list,
    update,
    threadTree,
    acceptRemote,
    applyRemoteStatus,
    syncThread,
    parentStopped,
    reconcileAll,
  });
});

export const layer = Layer.effect(DelegatedTaskEngine, make);
