// @effect-diagnostics nodeBuiltinImport:off -- The documented example file is read from the repository.
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  type DelegatedTask,
  DelegatedTaskId,
  EnvironmentId,
  NodeId,
  TaskDelegateInput,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import { internalCaller } from "../automation/Caller.ts";
import * as TaskEngine from "../automation/tasks/TaskEngine.ts";
import { taskIdFor, taskThreadId } from "../automation/tasks/TaskModel.ts";
import * as TaskReactor from "../automation/tasks/TaskReactor.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { taskCommand } from "./task.ts";
import {
  attachSession,
  awaitRunPrepared,
  HARNESS_ENVIRONMENT_ID,
  HARNESS_MODEL,
  HARNESS_PROJECT_ID,
  makeCliHarness,
  RecordedJournal,
  RecordedPeers,
  runCli,
  seedQuestion,
  setLatestRunStatus,
  writeAssistantMessage,
  writeEvents,
} from "./testkit/CliHarness.ts";
import { threadCommand } from "./thread.ts";

const task = (...args: ReadonlyArray<string>) => runCli(taskCommand, args);
const thread = (...args: ReadonlyArray<string>) => runCli(threadCommand, args);

const contract = {
  title: "Write the notes",
  objective: "Write the release notes.",
  context: "For users.",
  deliverables: ["notes.md"],
  acceptanceCriteria: ["Every change is mentioned", "Each entry links its pull request"],
};

const delegation = (
  key: string,
  overrides: {
    readonly target?: Record<string, unknown>;
    readonly contract?: Record<string, unknown>;
    readonly parentTaskId?: string;
  } = {},
) => ({
  idempotencyKey: key,
  target: { projectId: HARNESS_PROJECT_ID, modelSelection: HARNESS_MODEL, ...overrides.target },
  contract: { ...contract, ...overrides.contract },
  ...(overrides.parentTaskId === undefined ? {} : { parentTaskId: overrides.parentTaskId }),
});

/** Writes `value` to a temporary JSON file and returns its path. */
const jsonFile = Effect.fn("test.jsonFile")(function* (value: unknown) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* fs.makeTempFileScoped({ prefix: "t3-task-", suffix: ".json" });
  yield* fs.writeFileString(
    path,
    yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(value),
  );
  return path;
});

/** `t3 task delegate --file ... --json`, returning what it printed. */
const delegate = Effect.fn("test.delegate")(function* (
  input: ReturnType<typeof delegation>,
  ...flags: ReadonlyArray<string>
) {
  const run = yield* task("delegate", "--file", yield* jsonFile(input), "--json", ...flags);
  assert.equal(run.exitCode, 0, run.stderr.join("\n"));
  const result = run.json<{ task: DelegatedTask; created: boolean }>();
  if (result.task.threadId !== null) yield* awaitRunPrepared(result.task.threadId);
  return result;
});

const show = (taskId: string) =>
  task("show", taskId, "--json").pipe(
    Effect.map((run) => run.json<{ task: DelegatedTask }>().task),
  );

const startReactor = TaskReactor.DelegatedTaskReactor.use((reactor) => reactor.start());
const nextEvent = (type: string) => RecordedJournal.use((journal) => journal.next(type));
const journalTypes = (taskId: string) =>
  RecordedJournal.use((journal) => journal.entries).pipe(
    Effect.map((entries) =>
      entries
        .filter((entry) => entry.event.scope.taskId === taskId)
        .map((entry) => entry.event.type),
    ),
  );

const runsOf = (threadId: ThreadId) =>
  ThreadManagement.ThreadManagementService.use((threads) =>
    threads.getThreadRecords(threadId, ["runs"]),
  ).pipe(Effect.map(({ runs }) => runs.toSorted((left, right) => left.ordinal - right.ordinal)));

const threadCount = ThreadManagement.ThreadManagementService.use((threads) =>
  threads.getShellSnapshot({ location: "active" }),
).pipe(Effect.map((snapshot) => snapshot.threads.length));

/** The child's run starts with a live provider session, as a real turn does. */
const startChildRun = Effect.fn("test.startChildRun")(function* (threadId: ThreadId) {
  yield* attachSession(threadId);
  return yield* setLatestRunStatus(threadId, "running");
});

const provided = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(makeCliHarness()));

describe("t3 task delegate", () => {
  it.effect("the same key returns the same task and thread, never a second thread", () =>
    provided(
      Effect.gen(function* () {
        const first = yield* delegate(delegation("key-1"));
        assert.equal(first.created, true);
        assert.equal(first.task.id, taskIdFor(HARNESS_ENVIRONMENT_ID, "key-1"));
        assert.equal(first.task.threadId, taskThreadId(first.task.id));
        assert.equal(first.task.kind, "managed_thread");
        assert.deepEqual(first.task.capabilities, {
          send: true,
          answer: true,
          cancel: true,
          read: true,
        });
        assert.deepEqual(first.task.contract, contract);
        assert.equal(yield* threadCount, 1);

        // A different contract under the same key is still the first task.
        const second = yield* delegate(
          delegation("key-1", { contract: { title: "Something else" } }),
        );
        assert.equal(second.created, false);
        assert.equal(second.task.id, first.task.id);
        assert.equal(second.task.threadId, first.task.threadId);
        assert.equal(second.task.contract.title, contract.title);
        assert.equal(yield* threadCount, 1);
        assert.lengthOf(yield* runsOf(first.task.threadId!), 1);
        assert.deepEqual(
          (yield* journalTypes(first.task.id)).filter((type) => type === "task.delegated"),
          ["task.delegated"],
        );
      }),
    ),
  );

  it.effect("the managed thread starts with the whole contract and how to report", () =>
    provided(
      Effect.gen(function* () {
        const { task: created } = yield* delegate(delegation("key-prompt"));
        const shown = (yield* thread("show", created.threadId!, "--json")).json();
        const prompt = shown.messages[0].text as string;
        for (const expected of [
          "# Delegated task: Write the notes",
          `Task id: ${created.id}`,
          "## Objective\nWrite the release notes.",
          "## Context\nFor users.",
          "- notes.md",
          "- Every change is mentioned",
          "## How to report",
        ]) {
          assert.include(prompt, expected);
        }
        assert.equal(shown.thread.title, "Write the notes");
      }),
    ),
  );

  it.effect("a deadline in the past expires the task instead of starting it", () =>
    provided(
      Effect.gen(function* () {
        const past = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { hours: 1 }));
        const { task: expired, created } = yield* delegate(
          delegation("key-expired", { contract: { deadline: past } }),
        );
        assert.equal(created, true);
        assert.equal(expired.status, "expired");
        assert.isNull(expired.threadId);
        assert.equal(yield* threadCount, 0);
        assert.deepEqual(yield* journalTypes(expired.id), ["task.delegated", "task.failed"]);
        // Finished tasks are hidden by default and listed with --all.
        assert.deepEqual((yield* task("list", "--json")).json().tasks, []);
        assert.lengthOf((yield* task("list", "--all", "--json")).json().tasks, 1);
      }),
    ),
  );

  it.effect("refuses permissions wider than the delegator's", () =>
    provided(
      Effect.gen(function* () {
        const shell = yield* task(
          "delegate",
          "--file",
          yield* jsonFile(delegation("key-shell", { contract: { permissions: ["job.shell"] } })),
          "--json",
        );
        assert.equal(shell.exitCode, 5);
        assert.equal(shell.errorJson().error.code, "PERMISSION_DENIED");

        const parent = yield* delegate(
          delegation("key-parent", { contract: { permissions: ["thread.read"] } }),
        );
        const wider = yield* task(
          "delegate",
          "--file",
          yield* jsonFile(
            delegation("key-child", {
              parentTaskId: parent.task.id,
              contract: { permissions: ["thread.read", "thread.send"] },
            }),
          ),
          "--json",
        );
        assert.equal(wider.errorJson().error.code, "PERMISSION_DENIED");
        // Refusals stored nothing and started nothing.
        assert.lengthOf((yield* task("list", "--all", "--json")).json().tasks, 1);
        assert.equal(yield* threadCount, 1);

        const within = yield* delegate(
          delegation("key-child-ok", {
            parentTaskId: parent.task.id,
            contract: { permissions: ["thread.read"] },
          }),
        );
        assert.equal(within.task.parentTaskId, parent.task.id);
        assert.equal(within.task.parentThreadId, parent.task.threadId);
      }),
    ),
  );

  it.effect("a remote target is queued for its peer and never reported as accepted", () =>
    provided(
      Effect.gen(function* () {
        const remote = EnvironmentId.make("env-remote");
        const { task: queued } = yield* delegate(
          delegation("key-remote", {
            target: { environmentId: remote },
            contract: { deadline: "2030-01-01T00:00:00.000Z" },
          }),
        );
        assert.equal(queued.status, "pending_delivery");
        assert.isNull(queued.threadId);
        assert.equal(queued.executionEnvironmentId, remote);
        assert.equal(queued.originEnvironmentId, HARNESS_ENVIRONMENT_ID);
        assert.deepEqual(queued.capabilities, {
          send: false,
          answer: false,
          cancel: true,
          read: false,
        });
        assert.equal(yield* threadCount, 0);
        const messages = yield* RecordedPeers.use((peers) => peers.messages);
        assert.lengthOf(messages, 1);
        assert.deepInclude(messages[0], {
          toEnvironmentId: remote,
          expiresAt: "2030-01-01T00:00:00.000Z",
        });
        assert.equal(messages[0]?.body.type, "task.delegate");

        // Repeating the delegation queues nothing new.
        yield* delegate(delegation("key-remote", { target: { environmentId: remote } }));
        assert.lengthOf(yield* RecordedPeers.use((peers) => peers.messages), 1);

        // Only cancel can be asked of it from here.
        const send = yield* task("send", queued.id, "hello", "--json");
        assert.equal(send.exitCode, 7);
        assert.equal(send.errorJson().error.code, "CAPABILITY_UNSUPPORTED");
        const cancelled = (yield* task("cancel", queued.id, "--json")).json().task;
        assert.equal(cancelled.status, "cancel_requested");
        const after = yield* RecordedPeers.use((peers) => peers.messages);
        assert.deepEqual(after.at(-1)?.body, {
          type: "task.cancel",
          taskId: queued.id,
          reason: null,
        });
      }),
    ),
  );

  it.effect("without a peer link a remote delegation stores nothing", () =>
    Effect.gen(function* () {
      const refused = yield* task(
        "delegate",
        "--file",
        yield* jsonFile(
          delegation("key-nolink", { target: { environmentId: EnvironmentId.make("env-x") } }),
        ),
        "--json",
      );
      assert.equal(refused.exitCode, 7);
      assert.equal(refused.errorJson().error.code, "CAPABILITY_UNSUPPORTED");
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql`SELECT task_id FROM automation_tasks`;
      assert.lengthOf(rows, 0);
      // The event rolled back with the task it described.
      assert.lengthOf(yield* RecordedJournal.use((journal) => journal.entries), 0);
    }).pipe(Effect.scoped, Effect.provide(makeCliHarness({ peers: "unsupported" }))),
  );

  it("the documented example is a valid task", () => {
    const example = NodeFS.readFileSync(
      NodeURL.fileURLToPath(
        new URL(
          "../../../../docs/user/examples/automation/task-remote-delegation.json",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    const decoded = Schema.decodeUnknownSync(Schema.fromJsonString(TaskDelegateInput))(example);
    assert.equal(decoded.contract.onParentCancel, "detach");
    assert.isString(decoded.target.environmentId);
    assert.lengthOf(decoded.contract.acceptanceCriteria, 3);
  });
});

describe("task status follows the child thread", () => {
  it.effect("accepted, running, blocked, reported, and only then validated", () =>
    provided(
      Effect.gen(function* () {
        yield* startReactor;
        const { task: created } = yield* delegate(delegation("key-flow"));
        const threadId = created.threadId!;
        assert.equal(created.status, "accepted");

        yield* startChildRun(threadId);
        yield* nextEvent("task.progress");
        assert.equal((yield* show(created.id)).status, "running");

        const requestId = yield* seedQuestion(threadId, [
          { id: "q", header: "Q", question: "Which branch?", options: [] },
        ]);
        yield* nextEvent("task.blocked");
        const blocked = yield* show(created.id);
        assert.equal(blocked.status, "blocked");
        assert.match(blocked.statusReason!, /1 pending request/);
        const tree = (yield* task("tree", created.id, "--json")).json();
        assert.deepInclude(tree.nodes[0], {
          threadId,
          kind: "managed_thread",
          relationship: "delegated",
          taskId: created.id,
          taskStatus: "blocked",
          pendingRequests: 1,
        });

        yield* thread("answer", threadId, "main", "--request", requestId);
        yield* nextEvent("task.progress");
        assert.equal((yield* show(created.id)).status, "running");

        // Answering by message queued a follow-up run; the provider finishes both.
        yield* writeAssistantMessage(threadId, "Notes written to notes.md.");
        for (const run of yield* runsOf(threadId)) {
          yield* writeEvents([
            {
              type: "run.updated",
              threadId,
              runId: run.id,
              providerInstanceId: run.providerInstanceId,
              occurredAt: yield* DateTime.now,
              payload: { ...run, status: "completed", queuePosition: null },
            } as Omit<OrchestrationV2DomainEvent, "id">,
          ]);
        }
        yield* nextEvent("task.reported");
        const reported = yield* show(created.id);
        // A final answer is a report. It is not acceptance.
        assert.equal(reported.status, "reported");
        assert.equal(reported.result?.summary, "Notes written to notes.md.");
        assert.isNull(reported.result?.validatedBy ?? null);
        assert.deepEqual(
          reported.result?.criteria.map((criterion) => criterion.met),
          [null, null],
        );
        assert.notInclude(yield* journalTypes(created.id), "task.validated");

        const short = yield* task(
          "validate",
          created.id,
          "--file",
          yield* jsonFile({ criteria: [{ met: true }] }),
          "--json",
        );
        assert.equal(short.errorJson().error.code, "INVALID_INPUT");
        const unmet = yield* task(
          "validate",
          created.id,
          "--file",
          yield* jsonFile({ criteria: [{ met: true }, { met: false, evidence: "no links" }] }),
          "--json",
        );
        assert.equal(unmet.errorJson().error.code, "INVALID_INPUT");
        assert.equal((yield* show(created.id)).status, "reported");

        const validated = (yield* task(
          "validate",
          created.id,
          "--file",
          yield* jsonFile({
            criteria: [
              { met: true, evidence: "12 of 12 listed" },
              { met: true, evidence: "all linked" },
            ],
          }),
          "--json",
        )).json().task as DelegatedTask;
        assert.equal(validated.status, "validated");
        assert.deepEqual(validated.result?.validatedBy, { kind: "user" });
        assert.deepEqual(validated.result?.criteria, [
          { text: "Every change is mentioned", met: true, evidence: "12 of 12 listed" },
          { text: "Each entry links its pull request", met: true, evidence: "all linked" },
        ]);
        assert.equal(validated.result?.summary, "Notes written to notes.md.");
        assert.include(yield* journalTypes(created.id), "task.validated");

        // A validated task takes no more messages and is not re-validated.
        const late = yield* task("send", created.id, "one more thing", "--json");
        assert.equal(late.errorJson().error.code, "CONFLICT");
      }),
    ),
  );

  it.effect("reject sends the reason to the child and the task runs again", () =>
    provided(
      Effect.gen(function* () {
        yield* startReactor;
        const { task: created } = yield* delegate(delegation("key-reject"));
        const threadId = created.threadId!;
        const early = yield* task("reject", created.id, "not yet", "--json");
        assert.equal(early.errorJson().error.code, "CONFLICT");

        yield* startChildRun(threadId);
        yield* writeAssistantMessage(threadId, "Done.");
        yield* setLatestRunStatus(threadId, "completed");
        yield* nextEvent("task.reported");

        const rejected = (yield* task(
          "reject",
          created.id,
          "Entries are missing links.",
          "--idempotency-key",
          "reject-1",
          "--json",
        )).json().task as DelegatedTask;
        assert.equal(rejected.status, "running");
        assert.equal(rejected.attemptCount, 2);
        assert.match(rejected.statusReason!, /missing links/);
        const runs = yield* runsOf(threadId);
        assert.lengthOf(runs, 2);
        const shown = (yield* thread("show", threadId, "--json")).json();
        assert.isTrue(
          (shown.messages as Array<{ role: string; text: string }>).some(
            (message) =>
              message.role === "user" && message.text.includes("Entries are missing links."),
          ),
        );

        // The same key does not send the reason twice.
        yield* task(
          "reject",
          created.id,
          "Entries are missing links.",
          "--idempotency-key",
          "reject-1",
          "--json",
        );
        assert.lengthOf(yield* runsOf(threadId), 2);
      }),
    ),
  );

  it.effect("a failed run fails the task", () =>
    provided(
      Effect.gen(function* () {
        yield* startReactor;
        const { task: created } = yield* delegate(delegation("key-fail"));
        yield* startChildRun(created.threadId!);
        yield* setLatestRunStatus(created.threadId!, "failed");
        yield* nextEvent("task.failed");
        assert.equal((yield* show(created.id)).status, "failed");
      }),
    ),
  );

  it.effect("cancel is confirmed by the child's run stopping", () =>
    provided(
      Effect.gen(function* () {
        yield* startReactor;
        const { task: created } = yield* delegate(delegation("key-cancel"));
        const threadId = created.threadId!;
        yield* startChildRun(threadId);
        yield* nextEvent("task.progress");

        const requested = (yield* task(
          "cancel",
          created.id,
          "--reason",
          "No longer needed",
          "--json",
        )).json().task as DelegatedTask;
        // With no provider turn to wait for, the orchestrator stops the run at
        // once, and that fact is what makes the task cancelled.
        assert.equal(requested.status, "cancelled");
        assert.equal(requested.statusReason, "No longer needed");
        assert.equal((yield* runsOf(threadId))[0]?.status, "interrupted");
        // The request was recorded first, the confirmation after it.
        const types = yield* journalTypes(created.id);
        assert.deepEqual(types.slice(-2), ["task.progress", "task.cancelled"]);
        const cancelled = yield* show(created.id);
        assert.equal(cancelled.status, "cancelled");
        // Cancelling again changes nothing.
        const again = (yield* task("cancel", created.id, "--json")).json().task;
        assert.equal(again.revision, cancelled.revision);
      }),
    ),
  );

  it.effect(
    "stopping the parent detaches a child by default and cancels one that asks for it",
    () =>
      provided(
        Effect.gen(function* () {
          yield* startReactor;
          const parentId = ThreadId.make(
            (yield* thread(
              "new",
              "Parent work",
              "--project",
              HARNESS_PROJECT_ID,
              "--model",
              `${HARNESS_MODEL.instanceId}/${HARNESS_MODEL.model}`,
              "--json",
            )).json().threadId,
          );
          yield* awaitRunPrepared(parentId);
          yield* startChildRun(parentId);

          const detached = yield* delegate(delegation("key-detached"), "--parent", parentId);
          const bound = yield* delegate(
            delegation("key-bound", { contract: { onParentCancel: "cancel" } }),
            "--parent",
            parentId,
          );
          assert.equal(detached.task.parentThreadId, parentId);
          // A task with no model of its own would inherit the parent's.
          yield* startChildRun(detached.task.threadId!);
          yield* startChildRun(bound.task.threadId!);
          yield* nextEvent("task.progress");
          yield* nextEvent("task.progress");

          const tree = (yield* thread("tree", parentId, "--json")).json().nodes as Array<{
            threadId: string;
            kind: string;
            depth: number;
            taskStatus: string | null;
          }>;
          assert.deepEqual(
            tree.map((node) => [node.threadId, node.kind, node.depth, node.taskStatus]),
            [
              [parentId, "thread", 0, null],
              [detached.task.threadId, "managed_thread", 1, "running"],
              [bound.task.threadId, "managed_thread", 1, "running"],
            ],
          );
          const before = yield* show(detached.task.id);

          // The user stops the parent's turn.
          yield* setLatestRunStatus(parentId, "interrupted");
          const stopped = yield* nextEvent("task.cancelled");
          assert.equal(stopped.event.scope.taskId, bound.task.id);
          // The reactor handles both children in one step; once it is idle the
          // detached child has been considered too.
          yield* TaskReactor.DelegatedTaskReactor.use((reactor) => reactor.drain);
          assert.equal((yield* show(bound.task.id)).status, "cancelled");
          assert.equal((yield* runsOf(bound.task.threadId!))[0]?.status, "interrupted");

          const untouched = yield* show(detached.task.id);
          assert.equal(untouched.status, "running");
          assert.equal(untouched.revision, before.revision);
          assert.equal((yield* runsOf(detached.task.threadId!))[0]?.status, "running");
          const detachedTypes = yield* journalTypes(detached.task.id);
          assert.notInclude(detachedTypes, "task.cancelled");
        }),
      ),
  );

  it.effect("a native provider subagent is listed read-only next to managed tasks", () =>
    provided(
      Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const create = (id: string) =>
          threads.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`create:${id}`),
            threadId: ThreadId.make(id),
            projectId: HARNESS_PROJECT_ID,
            title: id,
            modelSelection: HARNESS_MODEL,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdBy: "user",
            creationSource: "web",
          });
        yield* create("tree-parent");
        yield* create("tree-native");
        const now = yield* DateTime.now;
        yield* writeEvents([
          {
            type: "subagent.updated",
            threadId: ThreadId.make("tree-parent"),
            occurredAt: now,
            payload: {
              id: NodeId.make("node:native"),
              threadId: ThreadId.make("tree-parent"),
              runId: null,
              parentNodeId: NodeId.make("node:root"),
              origin: "provider_native",
              createdBy: "agent",
              driver: "codex",
              providerInstanceId: HARNESS_MODEL.instanceId,
              providerThreadId: null,
              childThreadId: ThreadId.make("tree-native"),
              nativeTaskRef: null,
              prompt: "Explore",
              title: "Explore",
              model: null,
              status: "running",
              result: null,
              startedAt: now,
              completedAt: null,
              updatedAt: now,
            },
          } as Omit<OrchestrationV2DomainEvent, "id">,
        ]);
        const managed = yield* delegate(delegation("key-tree"), "--parent", "tree-parent");
        const nodes = (yield* thread("tree", "tree-parent", "--json")).json().nodes as Array<{
          threadId: string;
          kind: string;
          taskId: string | null;
          relationship: string | null;
        }>;
        assert.deepEqual(
          nodes.map((node) => [node.threadId, node.kind, node.relationship, node.taskId]),
          [
            ["tree-parent", "thread", null, null],
            [managed.task.threadId, "managed_thread", "delegated", managed.task.id],
            ["tree-native", "native_subagent", "subagent", null],
          ],
        );
        // There is no task to drive for the native subagent: it has no id to send to.
        const tasks = (yield* task("list", "--all", "--json")).json().tasks as Array<DelegatedTask>;
        assert.deepEqual(
          tasks.map((entry) => entry.threadId),
          [managed.task.threadId],
        );
      }),
    ),
  );
});

describe("task reconciliation", () => {
  it.effect("a child that finished while the server was down is recorded after restart", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-task-restart-" });
      const database = SqlitePersistence.layerFromPath(path.join(directory, "state.sqlite")).pipe(
        Layer.provide(NodeServices.layer),
      );

      // First server: the task is delegated and its child finishes, but the
      // reactor never ran, as if the server stopped right after the turn.
      const created = yield* Effect.gen(function* () {
        const { task: delegated } = yield* delegate(delegation("key-restart"));
        yield* startChildRun(delegated.threadId!);
        yield* writeAssistantMessage(delegated.threadId!, "Finished while nobody watched.");
        yield* setLatestRunStatus(delegated.threadId!, "completed");
        assert.equal((yield* show(delegated.id)).status, "accepted");
        return delegated;
      }).pipe(Effect.scoped, Effect.provide(makeCliHarness({ database })));

      // Second server on the same database.
      yield* Effect.gen(function* () {
        assert.equal((yield* show(created.id)).status, "accepted");
        yield* startReactor;
        const entry = yield* nextEvent("task.reported");
        assert.equal(entry.event.scope.taskId, created.id);
        assert.equal(entry.event.scope.threadId, created.threadId);
        const reported = yield* show(created.id);
        assert.equal(reported.status, "reported");
        assert.equal(reported.result?.summary, "Finished while nobody watched.");
      }).pipe(Effect.scoped, Effect.provide(makeCliHarness({ database })));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("an active run with no provider behind it is unknown until reconciled", () =>
    provided(
      Effect.gen(function* () {
        const { task: created } = yield* delegate(delegation("key-unknown"));
        const threadId = created.threadId!;
        // The run is marked running, but the provider process is gone.
        yield* setLatestRunStatus(threadId, "running");
        yield* startReactor;
        yield* nextEvent("task.unknown");
        const unknown = yield* show(created.id);
        assert.equal(unknown.status, "unknown");
        assert.match(unknown.statusReason!, /cannot be established/);
        // Nothing was re-run to find out.
        assert.lengthOf(yield* runsOf(threadId), 1);

        // Reconciling re-reads the thread. Nothing changed, so it is still unknown.
        const still = (yield* task("reconcile", created.id, "--json")).json().task;
        assert.equal(still.status, "unknown");
        assert.equal(still.revision, unknown.revision);

        // Once the thread shows an outcome, reconcile records it.
        yield* writeAssistantMessage(threadId, "It had finished.");
        yield* setLatestRunStatus(threadId, "completed");
        const settled = (yield* task("reconcile", created.id, "--json")).json().task;
        assert.equal(settled.status, "reported");
        assert.equal(settled.result.summary, "It had finished.");
        assert.lengthOf(yield* runsOf(threadId), 1);
      }),
    ),
  );
});

describe("remote delegation, both sides", () => {
  const origin = EnvironmentId.make("env-origin");
  const peerCaller = {
    kind: "peer",
    environmentId: origin,
    subject: `peer:${origin}`,
    scopes: ["federation:peer"],
  } as const;

  const incoming = (overrides: Partial<DelegatedTask> = {}): DelegatedTask => ({
    id: DelegatedTaskId.make("task-from-origin"),
    version: 1,
    revision: 1,
    originEnvironmentId: origin,
    executionEnvironmentId: HARNESS_ENVIRONMENT_ID,
    nodeId: null,
    orchestratorId: null,
    parentTaskId: null,
    parentThreadId: ThreadId.make("thread-on-origin"),
    threadId: null,
    kind: "managed_thread",
    capabilities: { send: false, answer: false, cancel: true, read: false },
    target: { projectId: HARNESS_PROJECT_ID, modelSelection: HARNESS_MODEL },
    contract: { ...contract },
    status: "pending_delivery",
    statusReason: null,
    attemptCount: 0,
    claim: null,
    result: null,
    usage: { tokens: null, turns: 0 },
    observedAt: "2026-06-20T00:00:00.000Z",
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
    ...overrides,
  });

  it.effect("the destination accepts a task once and reports its status to the origin", () =>
    provided(
      Effect.gen(function* () {
        const engine = yield* TaskEngine.DelegatedTaskEngine;
        const internal = internalCaller("peer-processing");
        const accepted = yield* engine.acceptRemote(internal, incoming());
        assert.equal(accepted.status, "accepted");
        assert.equal(accepted.threadId, taskThreadId(accepted.id));
        // The origin's parent thread means nothing here.
        assert.isNull(accepted.parentThreadId);
        assert.equal(yield* threadCount, 1);

        const again = yield* engine.acceptRemote(internal, incoming());
        assert.equal(again.threadId, accepted.threadId);
        assert.equal(yield* threadCount, 1);

        const reports = (yield* RecordedPeers.use((peers) => peers.messages)).filter(
          (message) => message.body.type === "task.status",
        );
        assert.isAbove(reports.length, 0);
        assert.isTrue(reports.every((message) => message.toEnvironmentId === origin));
        const last = reports.at(-1)!.body;
        assert.equal(last.type === "task.status" ? last.task.status : null, "accepted");
      }),
    ),
  );

  it.effect("the destination rechecks the deadline and the sender before starting", () =>
    provided(
      Effect.gen(function* () {
        const engine = yield* TaskEngine.DelegatedTaskEngine;
        // Still valid when the origin sent it, past by the time it would start.
        const deadline = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { minutes: 1 }));
        const expired = yield* engine.acceptRemote(
          internalCaller("peer-processing"),
          incoming({
            id: DelegatedTaskId.make("task-late"),
            contract: { ...contract, deadline },
          }),
        );
        assert.equal(expired.status, "expired");
        assert.isNull(expired.threadId);
        assert.equal(yield* threadCount, 0);

        // A peer that is not allowed to delegate here is refused. The harness
        // has no paired peer, so any peer caller is unknown.
        const denied = yield* engine
          .acceptRemote(peerCaller, incoming({ id: DelegatedTaskId.make("task-denied") }))
          .pipe(Effect.flip);
        assert.equal(denied.code, "PERMISSION_DENIED");
        const forged = yield* engine
          .acceptRemote(
            { ...peerCaller, environmentId: EnvironmentId.make("env-other") },
            incoming({ id: DelegatedTaskId.make("task-forged") }),
          )
          .pipe(Effect.flip);
        assert.equal(forged.code, "PERMISSION_DENIED");
        const privileged = yield* engine
          .acceptRemote(
            internalCaller("peer-processing"),
            incoming({
              id: DelegatedTaskId.make("task-privileged"),
              contract: { ...contract, permissions: ["request.approve"] },
            }),
          )
          .pipe(Effect.flip);
        assert.equal(privileged.code, "PERMISSION_DENIED");
        assert.equal(yield* threadCount, 0);
      }),
    ),
  );

  it.effect("the origin applies status reports and ignores older ones", () =>
    provided(
      Effect.gen(function* () {
        const engine = yield* TaskEngine.DelegatedTaskEngine;
        const remote = EnvironmentId.make("env-remote");
        const { task: queued } = yield* delegate(
          delegation("key-origin", { target: { environmentId: remote } }),
        );
        const executor = {
          kind: "peer",
          environmentId: remote,
          subject: `peer:${remote}`,
          scopes: ["federation:peer"],
        } as const;
        const report = (revision: number, status: DelegatedTask["status"]) =>
          engine.applyRemoteStatus(executor, {
            ...queued,
            revision,
            status,
            threadId: ThreadId.make("thread-on-remote"),
            parentThreadId: ThreadId.make("not-ours"),
            contract: { ...queued.contract, title: "Tampered" },
          });

        const running = yield* report(4, "running");
        assert.equal(running.status, "running");
        assert.equal(running.revision, 4);
        assert.equal(running.threadId, "thread-on-remote");
        // The origin keeps its own contract and lineage.
        assert.equal(running.contract.title, contract.title);
        assert.isNull(running.parentThreadId);

        const stale = yield* report(3, "accepted");
        assert.equal(stale.status, "running");
        assert.equal(stale.revision, 4);
        assert.equal((yield* show(queued.id)).status, "running");

        const wrongPeer = yield* engine
          .applyRemoteStatus(
            { ...executor, environmentId: EnvironmentId.make("env-other") },
            { ...queued, revision: 9, status: "validated" },
          )
          .pipe(Effect.flip);
        assert.equal(wrongPeer.code, "PERMISSION_DENIED");
        assert.equal((yield* show(queued.id)).status, "running");
      }),
    ),
  );
});

describe("t3 task wait", () => {
  it.effect("returns when the task reports, without polling", () =>
    provided(
      Effect.gen(function* () {
        yield* startReactor;
        const { task: created } = yield* delegate(delegation("key-wait"));
        yield* startChildRun(created.threadId!);
        yield* nextEvent("task.progress");
        const waiting = yield* task("wait", created.id, "--json").pipe(Effect.forkChild);
        yield* writeAssistantMessage(created.threadId!, "All done.");
        yield* setLatestRunStatus(created.threadId!, "completed");
        const waited = yield* Fiber.join(waiting);
        assert.equal(waited.exitCode, 0);
        assert.equal(waited.json().task.status, "reported");
        assert.equal(waited.json().task.result.summary, "All done.");
      }),
    ),
  );

  it.effect("a timeout leaves the task running and exits with its own code", () =>
    provided(
      Effect.gen(function* () {
        yield* startReactor;
        const { task: created } = yield* delegate(delegation("key-wait-timeout"));
        yield* startChildRun(created.threadId!);
        yield* nextEvent("task.progress");
        const waiting = yield* task("wait", created.id, "--timeout", "10m", "--json").pipe(
          Effect.forkChild,
        );
        yield* TestClock.adjust("10 minutes");
        const timedOut = yield* Fiber.join(waiting);
        assert.equal(timedOut.exitCode, 8);
        assert.deepInclude(timedOut.errorJson().error, { code: "WAIT_TIMEOUT" });
        assert.equal((yield* show(created.id)).status, "running");
        assert.equal((yield* runsOf(created.threadId!))[0]?.status, "running");
      }),
    ),
  );
});
