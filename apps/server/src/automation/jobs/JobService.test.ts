import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AuthAdministrativeScopes,
  AuthAutomationExecuteScope,
  DelegatedTaskId,
  EnvironmentId,
  type ExecutionEnvironmentDescriptor,
  ExecutionNodeId,
  IdempotencyKey,
  type JobAction,
  type JobSubmitInput,
  OrchestratorId,
  type OrchestratorPermissions,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { type AutomationCaller, internalCaller, peerSessionSubject } from "../Caller.ts";
import * as EventJournal from "../EventJournal.ts";
import {
  type EnvironmentWorld,
  journalLayer,
  makeWorld,
} from "../federation/testkit/FederationTestKit.ts";
import * as JobService from "../JobService.ts";
import * as JobAuthority from "./JobAuthority.ts";
import * as JobExecutor from "./JobExecutor.ts";

const operator: AutomationCaller = {
  kind: "client",
  subject: "operator",
  scopes: AuthAdministrativeScopes,
};
const shellOperator: AutomationCaller = {
  kind: "client",
  subject: "shell-operator",
  scopes: [...AuthAdministrativeScopes, AuthAutomationExecuteScope],
};

const ORCHESTRATOR = OrchestratorId.make("orch-1");
const PROJECT = ProjectId.make("project-1");
const NODE = process.execPath;

/** Appends a line to the file named by its first argument: one line per real execution. */
const MARK_RUN = "require('node:fs').appendFileSync(process.argv[1], 'run\\n')";
/** Stays alive until the file named by its first argument exists, then prints and exits 0. */
const WAIT_FOR_GATE =
  "const fs = require('node:fs'); const timer = setInterval(() => { if (fs.existsSync(process.argv[1])) { clearInterval(timer); console.log('released'); } }, 10)";
const RUN_FOREVER = "setInterval(() => {}, 1000)";

interface Authority {
  permissions: OrchestratorPermissions | null;
  projectRoots: ReadonlyArray<string>;
}

type Services =
  | JobService.JobService
  | JobService.JobRecovery
  | EventJournal.EventJournal
  | SqlClient.SqlClient;

interface World {
  readonly world: EnvironmentWorld;
  readonly authority: Authority;
  /** Where jobs are allowed to run. */
  readonly workspace: string;
  /** A directory outside every workspace root. */
  readonly outside: string;
}

const descriptor = (environmentId: EnvironmentId): ExecutionEnvironmentDescriptor => ({
  environmentId,
  label: "Jobs",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.0-test",
  capabilities: { repositoryIdentity: true },
});

const layerFor = (input: World) =>
  JobService.layerWithoutExecutor.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        JobExecutor.layer,
        journalLayer(input.world),
        Layer.succeed(JobAuthority.JobAuthority, {
          orchestratorPermissions: () => Effect.sync(() => input.authority.permissions),
          projectRoots: () => Effect.sync(() => input.authority.projectRoots),
        }),
      ),
    ),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.unwrap(
          Effect.map(ServerConfig.ServerConfig, (config) =>
            SqlitePersistence.layerFromPath(config.dbPath),
          ),
        ),
        Layer.succeed(ServerEnvironment.ServerEnvironment, {
          getEnvironmentId: Effect.succeed(input.world.id),
          getDescriptor: Effect.succeed(descriptor(input.world.id)),
        }),
      ),
    ),
    Layer.provide(ServerConfig.layerTest(process.cwd(), input.world.baseDir)),
  );

const makeJobWorld = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const world = yield* makeWorld("jobs");
  // Real paths, as the service compares them: temp directories are often behind a symlink.
  const workspace = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-job-workspace-" }),
  );
  const outside = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-job-outside-" }),
  );
  const result: World = {
    world,
    authority: { permissions: null, projectRoots: [] },
    workspace,
    outside,
  };
  return result;
});

/** One server process over the world's state directory. `stop` ends it without any hand-over. */
const boot = Effect.fn("boot")(function* (input: World) {
  const scope = yield* Scope.make();
  const context: Context.Context<Services> = yield* Layer.buildWithScope(
    layerFor(input),
    scope,
  ).pipe(Effect.orDie);
  const stop = Scope.close(scope, Exit.void);
  yield* Effect.addFinalizer(() => stop);
  const jobs = Context.get(context, JobService.JobService);
  return {
    jobs,
    recovery: Context.get(context, JobService.JobRecovery),
    journal: Context.get(context, EventJournal.EventJournal),
    sql: Context.get(context, SqlClient.SqlClient),
    stop,
  };
});

type Running = Effect.Success<ReturnType<typeof boot>>;

const LOCAL = ExecutionNodeId.make("local");

const allowWorkspace = (running: Running, input: World, options?: { allowShell?: boolean }) =>
  running.jobs.upsertNode(operator, {
    id: LOCAL,
    label: "This machine",
    transport: { type: "local" },
    enabled: true,
    workspaceRoots: [input.workspace],
    allowShell: options?.allowShell ?? false,
  });

const nodeScript = (script: string, ...args: ReadonlyArray<string>): JobAction => ({
  type: "command",
  executable: NODE,
  args: ["-e", script, ...args],
});

const jobInput = (
  input: World,
  key: string,
  action: JobAction,
  overrides?: Partial<JobSubmitInput>,
): JobSubmitInput => ({
  idempotencyKey: IdempotencyKey.make(key),
  nodeId: LOCAL,
  cwd: input.workspace,
  action,
  ...overrides,
});

/** Follows the job to its recorded end and returns every status it went through. */
const follow = (running: Running, jobId: Parameters<Running["jobs"]["get"]>[1]) =>
  Stream.runCollect(running.jobs.watch(operator, jobId));

const waitFor = (running: Running, jobId: Parameters<Running["jobs"]["get"]>[1], status: string) =>
  running.jobs.watch(operator, jobId).pipe(
    Stream.takeUntil((job) => job.status === status),
    Stream.runDrain,
  );

const eventsOf = (input: World, prefix: string) =>
  input.world.journal.entries.filter((entry) => entry.event.type.startsWith(prefix));

const runs = (path: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const text = yield* fileSystem.readFileString(path).pipe(Effect.orElseSucceed(() => ""));
    return text.split("\n").filter((line) => line === "run").length;
  });

it.layer(NodeServices.layer)("jobs on execution nodes", (it) => {
  it.effect("returns the same job for a repeated submit and runs it once", () =>
    Effect.gen(function* () {
      const input = yield* makeJobWorld;
      const path = yield* Path.Path;
      const running = yield* boot(input);
      yield* allowWorkspace(running, input);
      const marker = path.join(input.workspace, "runs.txt");
      const submitted = jobInput(input, "build-1", nodeScript(MARK_RUN, marker), {
        taskId: DelegatedTaskId.make("task-1"),
        threadId: ThreadId.make("thread-1"),
      });

      const first = yield* running.jobs.submit(operator, submitted);
      assert.isTrue(first.created);
      // Stored as accepted before any executor is involved.
      assert.strictEqual(first.job.status, "accepted");
      const again = yield* running.jobs.submit(operator, submitted);
      assert.isFalse(again.created);
      assert.strictEqual(again.job.id, first.job.id);

      const history = yield* follow(running, first.job.id);
      assert.strictEqual(history.at(-1)!.status, "succeeded");
      assert.strictEqual(history.at(-1)!.exitCode, 0);
      const afterTheEnd = yield* running.jobs.submit(operator, submitted);
      assert.isFalse(afterTheEnd.created);
      assert.strictEqual(afterTheEnd.job.status, "succeeded");
      assert.strictEqual(yield* runs(marker), 1);
      assert.strictEqual((yield* running.jobs.list(operator, {})).length, 1);

      // Each status change left its event, scoped to the task, thread and node.
      const events = eventsOf(input, "job.");
      assert.deepStrictEqual(
        events.map((entry) => entry.event.type),
        ["job.accepted", "job.started", "job.finished"],
      );
      assert.deepStrictEqual(events[2]!.event.scope, {
        jobId: first.job.id,
        nodeId: LOCAL,
        taskId: DelegatedTaskId.make("task-1"),
        threadId: ThreadId.make("thread-1"),
      });
      assert.strictEqual(events[2]!.event.payload["exitCode"], 0);
      assert.strictEqual(events[2]!.event.origin.nodeId, LOCAL);
    }),
  );

  it.effect("refuses a cwd outside the node's workspace roots, however it is spelled", () =>
    Effect.gen(function* () {
      const input = yield* makeJobWorld;
      const path = yield* Path.Path;
      const fileSystem = yield* FileSystem.FileSystem;
      const running = yield* boot(input);
      const action = nodeScript(MARK_RUN, path.join(input.outside, "runs.txt"));

      // The built-in node starts with no workspace at all.
      const unconfigured = yield* running.jobs
        .submit(operator, jobInput(input, "k0", action))
        .pipe(Effect.flip);
      assert.strictEqual(unconfigured.code, "PERMISSION_DENIED");

      yield* allowWorkspace(running, input);
      yield* fileSystem.makeDirectory(path.join(input.workspace, "sub"));
      yield* fileSystem.symlink(input.outside, path.join(input.workspace, "escape"));
      const sibling = `${input.workspace}-other`;
      yield* Effect.acquireRelease(fileSystem.makeDirectory(sibling), () =>
        Effect.ignore(fileSystem.remove(sibling, { recursive: true })),
      );
      const attempts: ReadonlyArray<readonly [string, string, string]> = [
        ["outside", input.outside, "PERMISSION_DENIED"],
        [
          "traversal",
          `${input.workspace}/sub/../../${path.basename(input.outside)}`,
          "PERMISSION_DENIED",
        ],
        ["symlink", path.join(input.workspace, "escape"), "PERMISSION_DENIED"],
        // A sibling whose name merely starts with the root's name is not inside it.
        ["prefix", sibling, "PERMISSION_DENIED"],
        ["relative", "sub", "INVALID_INPUT"],
        ["missing", path.join(input.workspace, "nope"), "INVALID_INPUT"],
      ];
      for (const [key, cwd, code] of attempts) {
        const refused = yield* running.jobs
          .submit(operator, jobInput(input, key, action, { cwd }))
          .pipe(Effect.flip);
        assert.strictEqual(refused.code, code, key);
      }
      // Refused means nothing happened: no row, no event, no process.
      assert.strictEqual((yield* running.jobs.list(operator, {})).length, 0);
      assert.strictEqual(eventsOf(input, "job.").length, 0);
      assert.strictEqual(yield* runs(path.join(input.outside, "runs.txt")), 0);

      const inside = yield* running.jobs.submit(
        operator,
        jobInput(input, "ok", nodeScript("process.exit(0)"), {
          cwd: `${input.workspace}/sub/../sub`,
        }),
      );
      assert.strictEqual(inside.job.cwd, path.join(input.workspace, "sub"));
      yield* follow(running, inside.job.id);
    }),
  );

  it.effect(
    "runs a shell line only with the node flag, the scope and the orchestrator action",
    () =>
      Effect.gen(function* () {
        const input = yield* makeJobWorld;
        const running = yield* boot(input);
        const shell: JobAction = { type: "shell", script: "echo from-shell && exit 3" };
        const submit = (
          caller: AutomationCaller,
          key: string,
          overrides?: Partial<JobSubmitInput>,
        ) => running.jobs.submit(caller, jobInput(input, key, shell, overrides));

        yield* allowWorkspace(running, input, { allowShell: false });
        assert.strictEqual(
          (yield* submit(shellOperator, "no-flag").pipe(Effect.flip)).code,
          "PERMISSION_DENIED",
        );

        yield* allowWorkspace(running, input, { allowShell: true });
        // Administrative access to the environment is not the right to run a shell.
        assert.strictEqual(
          (yield* submit(operator, "no-scope").pipe(Effect.flip)).code,
          "PERMISSION_DENIED",
        );
        assert.strictEqual(
          (yield* submit(internalCaller("server"), "no-requester").pipe(Effect.flip)).code,
          "PERMISSION_DENIED",
        );
        input.authority.permissions = { actions: ["job.run"] };
        assert.strictEqual(
          (yield* submit(shellOperator, "no-action", { orchestratorId: ORCHESTRATOR }).pipe(
            Effect.flip,
          )).code,
          "PERMISSION_DENIED",
        );
        input.authority.permissions = { actions: ["thread.read"] };
        assert.strictEqual(
          (yield* running.jobs
            .submit(
              operator,
              jobInput(input, "no-run", nodeScript("process.exit(0)"), {
                orchestratorId: ORCHESTRATOR,
              }),
            )
            .pipe(Effect.flip)).code,
          "PERMISSION_DENIED",
        );
        assert.strictEqual((yield* running.jobs.list(operator, {})).length, 0);

        input.authority.permissions = { actions: ["job.run", "job.shell"] };
        const allowed = yield* submit(shellOperator, "allowed", { orchestratorId: ORCHESTRATOR });
        assert.deepStrictEqual(allowed.job.requestedBy, {
          kind: "orchestrator",
          orchestratorId: ORCHESTRATOR,
          environmentId: input.world.id,
        });
        const history = yield* follow(running, allowed.job.id);
        assert.strictEqual(history.at(-1)!.status, "failed");
        assert.strictEqual(history.at(-1)!.exitCode, 3);
        const log = yield* running.jobs.logs(operator, { jobId: allowed.job.id });
        assert.strictEqual(log.text, "from-shell\n");
        assert.isTrue(log.complete);
        assert.strictEqual(
          eventsOf(input, "job.").at(-1)!.event.scope.orchestratorId,
          ORCHESTRATOR,
        );
      }),
  );

  it.effect("limits an orchestrator to its nodes and its projects", () =>
    Effect.gen(function* () {
      const input = yield* makeJobWorld;
      const path = yield* Path.Path;
      const fileSystem = yield* FileSystem.FileSystem;
      const running = yield* boot(input);
      yield* allowWorkspace(running, input);
      const project = path.join(input.workspace, "project");
      yield* fileSystem.makeDirectory(project);
      const action = nodeScript("process.exit(0)");
      const asOrchestrator = (key: string, cwd: string) =>
        running.jobs.submit(
          internalCaller("orchestrator-runtime"),
          jobInput(input, key, action, { cwd, orchestratorId: ORCHESTRATOR }),
        );

      input.authority.permissions = null;
      assert.strictEqual(
        (yield* asOrchestrator("gone", project).pipe(Effect.flip)).code,
        "NOT_FOUND",
      );

      input.authority.permissions = {
        actions: ["job.run"],
        nodeIds: [ExecutionNodeId.make("elsewhere")],
      };
      assert.strictEqual(
        (yield* asOrchestrator("node", project).pipe(Effect.flip)).code,
        "PERMISSION_DENIED",
      );

      input.authority.permissions = { actions: ["job.run"], projectIds: [PROJECT] };
      input.authority.projectRoots = [project];
      // Inside the node's workspace, but not inside a project the orchestrator may use.
      assert.strictEqual(
        (yield* asOrchestrator("project", input.workspace).pipe(Effect.flip)).code,
        "PERMISSION_DENIED",
      );
      const allowed = yield* asOrchestrator("ok", project);
      assert.strictEqual((yield* follow(running, allowed.job.id)).at(-1)!.status, "succeeded");
    }),
  );

  it.effect("records the real exit code, a start failure, and a timeout as different facts", () =>
    Effect.gen(function* () {
      const input = yield* makeJobWorld;
      const running = yield* boot(input);
      yield* allowWorkspace(running, input);

      const failing = yield* running.jobs.submit(
        operator,
        jobInput(input, "exit-7", nodeScript("console.error('boom'); process.exit(7)")),
      );
      const failed = (yield* follow(running, failing.job.id)).at(-1)!;
      assert.strictEqual(failed.status, "failed");
      assert.strictEqual(failed.exitCode, 7);
      assert.isNotNull(failed.startedAt);
      assert.isNotNull(failed.finishedAt);
      assert.strictEqual(
        (yield* running.jobs.logs(operator, { jobId: failing.job.id })).text,
        "boom\n",
      );

      const missing = yield* running.jobs.submit(
        operator,
        jobInput(input, "missing", {
          type: "command",
          executable: "t3-no-such-executable",
          args: [],
        }),
      );
      const notStarted = (yield* follow(running, missing.job.id)).at(-1)!;
      assert.strictEqual(notStarted.status, "failed");
      // Nothing ran, so there is no exit code and no start time to report.
      assert.isNull(notStarted.exitCode);
      assert.isNull(notStarted.startedAt);
      assert.include(notStarted.statusReason ?? "", "could not be started");

      const slow = yield* running.jobs.submit(
        operator,
        jobInput(input, "slow", nodeScript(RUN_FOREVER), { timeoutMs: 60_000 }),
      );
      yield* waitFor(running, slow.job.id, "started");
      yield* TestClock.adjust("59 seconds");
      assert.strictEqual((yield* running.jobs.get(operator, slow.job.id)).status, "started");
      yield* TestClock.adjust("2 seconds");
      const timedOut = (yield* follow(running, slow.job.id)).at(-1)!;
      assert.strictEqual(timedOut.status, "timed_out");
      assert.isNull(timedOut.exitCode);
      assert.deepStrictEqual(
        eventsOf(input, "job.finished").map((entry) => entry.event.payload["status"]),
        ["failed", "failed", "timed_out"],
      );
    }),
  );

  it.effect("cancels only when the process confirms it has stopped", () =>
    Effect.gen(function* () {
      const input = yield* makeJobWorld;
      const running = yield* boot(input);
      yield* allowWorkspace(running, input);
      const submitted = yield* running.jobs.submit(
        operator,
        jobInput(input, "cancel-me", nodeScript(RUN_FOREVER)),
      );
      yield* waitFor(running, submitted.job.id, "started");

      const requested = yield* running.jobs.cancel(operator, submitted.job.id);
      assert.strictEqual(requested.status, "cancel_requested");
      const history = yield* follow(running, submitted.job.id);
      const cancelled = history.at(-1)!;
      assert.strictEqual(cancelled.status, "cancelled");
      assert.isNotNull(cancelled.finishedAt);
      assert.deepStrictEqual(
        eventsOf(input, "job.").map((entry) => entry.event.type),
        ["job.accepted", "job.started", "job.cancelled"],
      );
      // Cancelling something that already ended changes nothing.
      const again = yield* running.jobs.cancel(operator, submitted.job.id);
      assert.strictEqual(again.status, "cancelled");
      assert.strictEqual(eventsOf(input, "job.").length, 3);
    }),
  );

  it.effect("marks a job in flight at a restart unknown and never runs it again by itself", () =>
    Effect.gen(function* () {
      const input = yield* makeJobWorld;
      const path = yield* Path.Path;
      const first = yield* boot(input);
      yield* allowWorkspace(first, input);
      const once = path.join(input.workspace, "once.txt");
      const twice = path.join(input.workspace, "twice.txt");
      const script = `${MARK_RUN}; ${RUN_FOREVER}`;
      const plain = yield* first.jobs.submit(
        operator,
        jobInput(input, "plain", nodeScript(script, once)),
      );
      const repeatable = yield* first.jobs.submit(
        operator,
        jobInput(input, "repeatable", nodeScript(MARK_RUN, twice), { idempotent: true }),
      );
      yield* waitFor(first, plain.job.id, "started");
      yield* follow(first, repeatable.job.id);
      // The repeatable one is rewound to "started, end not recorded", as a crash would leave it.
      yield* first.sql`UPDATE automation_jobs SET status = 'started' WHERE job_id = ${repeatable.job.id}`;
      yield* first.sql`UPDATE automation_jobs SET job_json = json_set(job_json, '$.status', 'started', '$.exitCode', NULL, '$.finishedAt', NULL)
        WHERE job_id = ${repeatable.job.id}`;
      yield* first.stop;
      const ranBefore = yield* runs(once);

      const second = yield* boot(input);
      // Before recovery runs nothing has been decided, and nothing has been started.
      assert.strictEqual((yield* second.jobs.get(operator, plain.job.id)).status, "started");
      yield* second.recovery.start();
      yield* second.recovery.start();
      for (const jobId of [plain.job.id, repeatable.job.id]) {
        const job = yield* second.jobs.get(operator, jobId);
        assert.strictEqual(job.status, "unknown");
        assert.isNull(job.exitCode);
      }
      assert.strictEqual(eventsOf(input, "job.unknown").length, 2);
      assert.strictEqual(yield* runs(once), ranBefore);
      assert.strictEqual(yield* runs(twice), 1);

      // Without a process handle a cancel cannot be confirmed, so it is not claimed.
      const cancel = yield* second.jobs.cancel(operator, plain.job.id).pipe(Effect.flip);
      assert.strictEqual(cancel.code, "RESULT_UNKNOWN");

      // Reconcile re-reads. A job not declared idempotent stays unknown and is not run.
      const stillUnknown = yield* second.jobs.reconcile(operator, plain.job.id);
      assert.strictEqual(stillUnknown.status, "unknown");
      assert.strictEqual(yield* runs(once), ranBefore);

      // A job declared idempotent runs again, and only because reconcile was called.
      const rerun = yield* second.jobs.reconcile(operator, repeatable.job.id);
      assert.strictEqual(rerun.status, "accepted");
      const finished = (yield* follow(second, repeatable.job.id)).at(-1)!;
      assert.strictEqual(finished.status, "succeeded");
      assert.strictEqual(yield* runs(twice), 2);
    }),
  );

  it.effect("starts a stored job that was never handed to an executor", () =>
    Effect.gen(function* () {
      const input = yield* makeJobWorld;
      const path = yield* Path.Path;
      const first = yield* boot(input);
      yield* allowWorkspace(first, input);
      const marker = path.join(input.workspace, "runs.txt");
      const done = yield* first.jobs.submit(
        operator,
        jobInput(input, "stored", nodeScript(MARK_RUN, marker)),
      );
      yield* follow(first, done.job.id);
      // Rewind to the instant after the durable write and before the hand-off.
      yield* first.sql`UPDATE automation_jobs SET status = 'accepted', executor_ref = NULL,
        job_json = json_set(job_json, '$.status', 'accepted', '$.exitCode', NULL, '$.startedAt', NULL, '$.finishedAt', NULL)
        WHERE job_id = ${done.job.id}`;
      yield* first.stop;

      const second = yield* boot(input);
      yield* second.recovery.start();
      const finished = (yield* follow(second, done.job.id)).at(-1)!;
      assert.strictEqual(finished.status, "succeeded");
      assert.strictEqual(yield* runs(marker), 2);
      assert.strictEqual(eventsOf(input, "job.unknown").length, 0);
    }),
  );

  it.effect("reads logs incrementally and never treats quiet output as the end", () =>
    Effect.gen(function* () {
      const input = yield* makeJobWorld;
      const path = yield* Path.Path;
      const fileSystem = yield* FileSystem.FileSystem;
      const running = yield* boot(input);
      yield* allowWorkspace(running, input);
      const gate = path.join(input.workspace, "gate");
      const quiet = yield* running.jobs.submit(
        operator,
        jobInput(input, "quiet", nodeScript(WAIT_FOR_GATE, gate)),
      );
      yield* waitFor(running, quiet.job.id, "started");
      const silent = yield* running.jobs.logs(operator, { jobId: quiet.job.id });
      assert.strictEqual(silent.text, "");
      assert.isFalse(silent.complete);
      assert.isNull((yield* running.jobs.get(operator, quiet.job.id)).exitCode);

      yield* fileSystem.writeFileString(gate, "");
      yield* follow(running, quiet.job.id);
      const head = yield* running.jobs.logs(operator, { jobId: quiet.job.id, maxBytes: 4 });
      assert.strictEqual(head.text, "rele");
      assert.strictEqual(head.nextByte, 4);
      assert.isFalse(head.complete);
      const tail = yield* running.jobs.logs(operator, {
        jobId: quiet.job.id,
        afterByte: head.nextByte,
      });
      assert.strictEqual(tail.text, "ased\n");
      assert.isTrue(tail.complete);
      const beyond = yield* running.jobs.logs(operator, {
        jobId: quiet.job.id,
        afterByte: tail.nextByte,
      });
      assert.strictEqual(beyond.text, "");
      assert.isTrue(beyond.complete);

      const loud = yield* running.jobs.submit(
        operator,
        jobInput(
          input,
          "loud",
          nodeScript(`process.stdout.write('x'.repeat(${JobService.MAX_JOB_LOG_BYTES + 4096}))`),
        ),
      );
      const capped = (yield* follow(running, loud.job.id)).at(-1)!;
      assert.strictEqual(capped.status, "succeeded");
      assert.isTrue(capped.logTruncated);
      assert.strictEqual(capped.logBytes, JobService.MAX_JOB_LOG_BYTES);
    }),
  );

  it.effect("gives a job a minimal environment and its events a server-assigned origin", () =>
    Effect.gen(function* () {
      const input = yield* makeJobWorld;
      const running = yield* boot(input);
      yield* allowWorkspace(running, input);
      const printed = yield* running.jobs.submit(
        operator,
        jobInput(
          input,
          "env",
          nodeScript("for (const name of Object.keys(process.env).sort()) console.log(name)"),
        ),
      );
      yield* follow(running, printed.job.id);
      const names = (yield* running.jobs.logs(operator, { jobId: printed.job.id })).text
        .trim()
        .split("\n");
      assert.includeMembers(names, ["PATH", "T3_ENVIRONMENT_ID", "T3_JOB_ID", "T3_NODE_ID"]);
      assert.notInclude(names, "T3CODE_SERVER_SECRET");
      assert.notInclude(names, "ANTHROPIC_API_KEY");

      // What a process on the node publishes is attributed by the server, from
      // the session it used; the request has no field that could say otherwise.
      const emitted = yield* running.journal.emit(
        { kind: "client", subject: "ci-runner", scopes: AuthAdministrativeScopes },
        {
          idempotencyKey: IdempotencyKey.make("ci-1"),
          type: "custom.ci.finished",
          nodeId: LOCAL,
          scope: { jobId: printed.job.id },
          payload: { origin: { environmentId: "env-forged" } },
        },
      );
      assert.deepStrictEqual(emitted.entry.event.origin, {
        environmentId: input.world.id,
        kind: "custom",
        actorId: "ci-runner",
        nodeId: LOCAL,
      });
    }).pipe(
      Effect.provideService(HostProcessEnvironment, {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        T3CODE_SERVER_SECRET: "hunter2",
        ANTHROPIC_API_KEY: "sk-secret",
      }),
    ),
  );

  it.effect("keeps nodes explicit: a built-in local node, validated SSH nodes, honest probes", () =>
    Effect.gen(function* () {
      const input = yield* makeJobWorld;
      const running = yield* boot(input);
      const nodes = yield* running.jobs.listNodes(operator);
      assert.deepStrictEqual(
        nodes.map((node) => [node.id, node.transport.type, node.availability.status]),
        [["local", "local", "unknown"]],
      );
      assert.strictEqual(nodes[0]!.environmentId, input.world.id);
      assert.strictEqual(
        (yield* running.jobs.removeNode(operator, LOCAL).pipe(Effect.flip)).code,
        "INVALID_INPUT",
      );

      const ssh = (target: string, identityFile?: string) =>
        running.jobs.upsertNode(operator, {
          label: "Build box",
          transport: {
            type: "ssh",
            target,
            ...(identityFile === undefined ? {} : { identityFile }),
          },
          enabled: true,
          workspaceRoots: ["/srv/build"],
          allowShell: false,
        });
      // Anything that would read as an ssh option is refused before it is stored.
      for (const target of ["-oProxyCommand=evil", "host name"]) {
        assert.strictEqual((yield* ssh(target).pipe(Effect.flip)).code, "INVALID_INPUT");
      }
      assert.strictEqual((yield* ssh("build", "keys/id").pipe(Effect.flip)).code, "INVALID_INPUT");
      const added = yield* ssh("dev@build");
      assert.match(added.id, /^node-build-box-[0-9a-f]{6}$/u);
      assert.strictEqual(added.availability.status, "unknown");

      const probed = yield* running.jobs.probeNode(operator, LOCAL);
      assert.strictEqual(probed.availability.status, "available");
      assert.strictEqual(probed.availability.os, yield* HostProcessPlatform);
      assert.isNotNull(probed.availability.observedAt);
      assert.deepStrictEqual(
        probed.availability.tools.map((tool) => tool.name),
        ["git", "node"],
      );
      yield* running.jobs.probeNode(operator, LOCAL);
      // One event for the change, none for seeing the same thing again.
      assert.strictEqual(eventsOf(input, "node.availability").length, 1);

      // A job names its node. An unknown or disabled one is an error, never a substitute.
      const elsewhere = yield* running.jobs
        .submit(
          operator,
          jobInput(input, "elsewhere", nodeScript("process.exit(0)"), {
            nodeId: ExecutionNodeId.make("node-missing"),
          }),
        )
        .pipe(Effect.flip);
      assert.strictEqual(elsewhere.code, "NOT_FOUND");
      yield* running.jobs.upsertNode(operator, {
        id: LOCAL,
        label: "This machine",
        transport: { type: "local" },
        enabled: false,
        workspaceRoots: [input.workspace],
        allowShell: false,
      });
      const disabled = yield* running.jobs
        .submit(operator, jobInput(input, "disabled", nodeScript("process.exit(0)")))
        .pipe(Effect.flip);
      assert.strictEqual(disabled.code, "NODE_UNAVAILABLE");
      assert.isTrue(yield* running.jobs.removeNode(operator, added.id));

      const peer: AutomationCaller = {
        kind: "peer",
        environmentId: EnvironmentId.make("env-peer"),
        subject: peerSessionSubject(EnvironmentId.make("env-peer")),
        scopes: ["federation:peer"],
      };
      assert.strictEqual(
        (yield* running.jobs.listNodes(peer).pipe(Effect.flip)).code,
        "PERMISSION_DENIED",
      );
    }),
  );

  it("builds one quoted remote command for an SSH node", () => {
    const spec = {
      cwd: "/srv/my build",
      env: { T3_JOB_ID: "job_1" },
      action: { type: "command", executable: "npm", args: ["run", "it's; rm -rf /"] },
    } as const;
    assert.strictEqual(
      JobExecutor.remoteJobCommand(spec),
      `cd '/srv/my build' && exec env -i PATH="$PATH" HOME="$HOME" T3_JOB_ID='job_1' 'npm' 'run' 'it'"'"'s; rm -rf /'`,
    );
    assert.deepStrictEqual(
      JobExecutor.sshJobArgs(
        { type: "ssh", target: "dev@build", port: 2222, identityFile: "/keys/id" },
        spec,
      ),
      [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
        "-p",
        "2222",
        "-i",
        "/keys/id",
        "dev@build",
        JobExecutor.remoteJobCommand(spec),
      ],
    );
    assert.include(
      JobExecutor.remoteJobCommand({
        cwd: "/srv",
        env: {},
        action: { type: "shell", script: "make && make test" },
      }),
      `'sh' '-c' 'make && make test'`,
    );
  });
});
