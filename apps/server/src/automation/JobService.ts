import * as NodeCrypto from "node:crypto";

import {
  AuthAutomationExecuteScope,
  AutomationError,
  ExecutionNode,
  ExecutionNodeId,
  type ExecutionNodeUpsertInput,
  JOB_TERMINAL_STATUSES,
  Job,
  JobId,
  type JobLogsInput,
  type JobLogsResult,
  type JobStatus,
  type JobSubmitInput,
  type JobsListInput,
  type ProjectId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { type AutomationCaller, automationError } from "./Caller.ts";
import * as EventJournal from "./EventJournal.ts";
import * as JobAuthority from "./jobs/JobAuthority.ts";
import * as JobExecutor from "./jobs/JobExecutor.ts";
import { makeOrchestratorAccess } from "./orchestrator/Access.ts";
import { makeStore } from "./orchestrator/Store.ts";
import * as OrchestratorService from "./OrchestratorService.ts";

/** Execution nodes and the traceable jobs that run on them. */
export class JobService extends Context.Service<
  JobService,
  {
    readonly listNodes: (
      caller: AutomationCaller,
    ) => Effect.Effect<ReadonlyArray<ExecutionNode>, AutomationError>;
    readonly upsertNode: (
      caller: AutomationCaller,
      input: ExecutionNodeUpsertInput,
    ) => Effect.Effect<ExecutionNode, AutomationError>;
    readonly removeNode: (
      caller: AutomationCaller,
      input: ExecutionNodeId,
    ) => Effect.Effect<boolean, AutomationError>;
    readonly probeNode: (
      caller: AutomationCaller,
      input: ExecutionNodeId,
    ) => Effect.Effect<ExecutionNode, AutomationError>;
    readonly submit: (
      caller: AutomationCaller,
      input: JobSubmitInput,
    ) => Effect.Effect<{ readonly job: Job; readonly created: boolean }, AutomationError>;
    readonly get: (caller: AutomationCaller, input: JobId) => Effect.Effect<Job, AutomationError>;
    readonly list: (
      caller: AutomationCaller,
      input: JobsListInput,
    ) => Effect.Effect<ReadonlyArray<Job>, AutomationError>;
    readonly cancel: (
      caller: AutomationCaller,
      input: JobId,
    ) => Effect.Effect<Job, AutomationError>;
    readonly reconcile: (
      caller: AutomationCaller,
      input: JobId,
    ) => Effect.Effect<Job, AutomationError>;
    readonly logs: (
      caller: AutomationCaller,
      input: JobLogsInput,
    ) => Effect.Effect<JobLogsResult, AutomationError>;
    readonly watch: (caller: AutomationCaller, input: JobId) => Stream.Stream<Job, AutomationError>;
  }
>()("t3/automation/JobService") {}

/**
 * Startup work for jobs, kept apart from the service so that only the server
 * process runs it: a second process opening the same database must never
 * declare the server's live jobs lost.
 */
export class JobRecovery extends Context.Service<
  JobRecovery,
  {
    /**
     * Marks every job that was handed to an executor and has no recorded end
     * as `unknown`, and starts the ones that were stored but never handed off.
     */
    readonly start: () => Effect.Effect<void>;
  }
>()("t3/automation/JobService/JobRecovery") {}

const LOCAL_NODE_ID = ExecutionNodeId.make("local");
export const MAX_JOB_LOG_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const MAX_TIMEOUT_MS = 24 * 60 * 60_000;
const DEFAULT_LOG_READ_BYTES = 64 * 1024;
const MAX_LOG_READ_BYTES = 1024 * 1024;
const DEFAULT_LIST_LIMIT = 100;
const IDEMPOTENCY_SCOPE = "automation.jobs.submit";
/** Recorded before the executor is called: from here on a crash leaves the outcome unknown. */
const HANDOFF_REF = "handoff";

const NodeJson = Schema.fromJsonString(ExecutionNode);
const decodeNode = Schema.decodeUnknownEffect(NodeJson);
const encodeNode = Schema.encodeEffect(NodeJson);
const JobJson = Schema.fromJsonString(Job);
const decodeJob = Schema.decodeUnknownEffect(JobJson);
const encodeJob = Schema.encodeEffect(JobJson);
const isAutomationError = Schema.is(AutomationError);

const isTerminal = (status: JobStatus) => JOB_TERMINAL_STATUSES.includes(status);

const sameTransport = (left: ExecutionNode["transport"], right: ExecutionNode["transport"]) =>
  left.type === "ssh" && right.type === "ssh"
    ? left.target === right.target &&
      left.port === right.port &&
      left.identityFile === right.identityFile
    : left.type === right.type;

interface JobRow {
  readonly job_json: string;
  readonly executor_ref: string | null;
  readonly log_path: string | null;
}

interface LiveJob {
  readonly cancel: Deferred.Deferred<void>;
  logBytes: number;
  logTruncated: boolean;
}

type JobEventType =
  | "job.accepted"
  | "job.started"
  | "job.finished"
  | "job.cancelled"
  | "job.unknown";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const journal = yield* EventJournal.EventJournal;
  const executor = yield* JobExecutor.JobExecutor;
  const authority = yield* JobAuthority.JobAuthority;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scope = yield* Effect.scope;
  const changes = yield* PubSub.unbounded<Job>();
  const live = new Map<JobId, LiveJob>();
  const logDirectory = path.join(config.stateDir, "automation", "jobs");

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  /** Storage and decoding failures become one opaque error; typed refusals pass through. */
  const guarded =
    (operation: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, AutomationError, R> =>
      effect.pipe(
        Effect.catch((cause) =>
          isAutomationError(cause)
            ? Effect.fail(cause)
            : Effect.logError("Job storage failed", { operation, cause }).pipe(
                Effect.andThen(
                  Effect.fail(
                    automationError("INTERNAL", `Job storage failed during ${operation}.`),
                  ),
                ),
              ),
        ),
      );

  const access = makeOrchestratorAccess(makeStore(sql), yield* environment.getEnvironmentId);

  /**
   * A job an orchestrator's agent may steer: one that orchestrator requested,
   * on a node it may use. Any other caller passes untouched.
   */
  const requireOwnJob = (caller: AutomationCaller, job: Job) =>
    Effect.gen(function* () {
      if (caller.kind !== "orchestrator") return;
      yield* access.authorize(caller, "job.run", { nodeId: job.nodeId });
      if (
        job.requestedBy.kind !== "orchestrator" ||
        job.requestedBy.orchestratorId !== caller.orchestratorId
      ) {
        return yield* automationError(
          "PERMISSION_DENIED",
          `Job ${job.id} was not requested by orchestrator ${caller.orchestratorId}.`,
          { jobId: job.id },
        );
      }
    });

  const requireOperator = (caller: AutomationCaller) =>
    caller.kind === "peer"
      ? Effect.fail(
          automationError(
            "PERMISSION_DENIED",
            "A peer environment cannot manage nodes or jobs here. Delegate a task instead.",
          ),
        )
      : Effect.void;

  // -------------------------------------------------------------------------
  // Nodes

  const localNode = Effect.fn("JobService.localNode")(function* () {
    const now = yield* nowIso;
    return {
      id: LOCAL_NODE_ID,
      environmentId: yield* environment.getEnvironmentId,
      label: "This machine",
      transport: { type: "local" },
      enabled: true,
      // Empty on purpose: no directory is a job workspace until the operator names it.
      workspaceRoots: [],
      allowShell: false,
      availability: {
        status: "unknown",
        os: null,
        arch: null,
        tools: [],
        error: null,
        observedAt: null,
      },
      createdAt: now,
      updatedAt: now,
    } satisfies ExecutionNode;
  });

  const writeNode = (node: ExecutionNode) =>
    Effect.gen(function* () {
      const json = yield* encodeNode(node);
      yield* sql`INSERT INTO automation_nodes (node_id, enabled, node_json, created_at, updated_at)
        VALUES (${node.id}, ${node.enabled ? 1 : 0}, ${json}, ${node.createdAt}, ${node.updatedAt})
        ON CONFLICT (node_id) DO UPDATE SET
          enabled = excluded.enabled, node_json = excluded.node_json, updated_at = excluded.updated_at`;
    });

  const loadNodes = Effect.gen(function* () {
    const rows = yield* sql<{ node_json: string }>`SELECT node_json FROM automation_nodes
      ORDER BY created_at ASC, node_id ASC`;
    const nodes = yield* Effect.forEach(rows, (row) => decodeNode(row.node_json));
    if (nodes.some((node) => node.id === LOCAL_NODE_ID)) return nodes;
    // The server's own machine is always a node; it is created the first time anyone looks.
    const local = yield* localNode();
    yield* sql`INSERT OR IGNORE INTO automation_nodes
      (node_id, enabled, node_json, created_at, updated_at)
      VALUES (${local.id}, 1, ${yield* encodeNode(local)}, ${local.createdAt}, ${local.updatedAt})`;
    return [local, ...nodes];
  }).pipe(guarded("loadNodes"));

  const requireNode = Effect.fn("JobService.requireNode")(function* (nodeId: ExecutionNodeId) {
    const node = (yield* loadNodes).find((entry) => entry.id === nodeId);
    if (node === undefined) {
      // Never a fallback to some other node: the request named this one.
      return yield* automationError(
        "NOT_FOUND",
        `No execution node ${nodeId} in this environment.`,
        { nodeId },
      );
    }
    return node;
  });

  const listNodes: JobService["Service"]["listNodes"] = (caller) =>
    Effect.andThen(requireOperator(caller), loadNodes);

  const invalid = (message: string) => Effect.fail(automationError("INVALID_INPUT", message));

  const upsertNode: JobService["Service"]["upsertNode"] = Effect.fn("JobService.upsertNode")(
    function* (caller, input) {
      yield* requireOperator(caller);
      yield* access.operatorOnly(caller, "configure execution nodes");
      const nodes = yield* loadNodes;
      const existing = input.id === undefined ? undefined : nodes.find((n) => n.id === input.id);
      const transport = input.transport;
      if ((input.id === LOCAL_NODE_ID) !== (transport.type === "local")) {
        return yield* invalid(
          "The built-in `local` node is the server's own machine; every other node is reached over SSH.",
        );
      }
      if (transport.type === "ssh") {
        // These values become `ssh` arguments: nothing in them may read as an option.
        if (/^-|\s/u.test(transport.target)) {
          return yield* invalid("The SSH target must be a host or user@host, without options.");
        }
        if (transport.identityFile !== undefined && !path.isAbsolute(transport.identityFile)) {
          return yield* invalid("The SSH identity file must be an absolute path.");
        }
      }
      if (input.workspaceRoots.some((root) => !root.startsWith("/") && !path.isAbsolute(root))) {
        return yield* invalid("Workspace roots must be absolute paths.");
      }
      if (existing !== undefined && existing.transport.type !== transport.type) {
        return yield* invalid("A node's transport type cannot change. Add a new node instead.");
      }
      const now = yield* nowIso;
      const suffix = (yield* Random.nextIntBetween(0, 0xffffff)).toString(16).padStart(6, "0");
      const slug = input.label
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, "-")
        .replace(/^-+|-+$/gu, "")
        .slice(0, 40);
      const node: ExecutionNode = {
        id: input.id ?? ExecutionNodeId.make(`node-${slug.length > 0 ? `${slug}-` : ""}${suffix}`),
        environmentId: yield* environment.getEnvironmentId,
        label: input.label,
        transport,
        enabled: input.enabled,
        workspaceRoots: input.workspaceRoots,
        allowShell: input.allowShell,
        // A changed connection invalidates what the last probe saw.
        availability:
          existing === undefined || !sameTransport(existing.transport, transport)
            ? { status: "unknown", os: null, arch: null, tools: [], error: null, observedAt: null }
            : existing.availability,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      yield* writeNode(node).pipe(guarded("upsertNode"));
      return node;
    },
  );

  const removeNode: JobService["Service"]["removeNode"] = Effect.fn("JobService.removeNode")(
    function* (caller, nodeId) {
      yield* requireOperator(caller);
      yield* access.operatorOnly(caller, "remove execution nodes");
      if (nodeId === LOCAL_NODE_ID) {
        return yield* invalid("The built-in `local` node cannot be removed. Disable it instead.");
      }
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const active = yield* sql<{ count: number }>`SELECT COUNT(*) AS count
              FROM automation_jobs WHERE node_id = ${nodeId}
              AND status IN ('accepted', 'started', 'cancel_requested')`;
            if ((active[0]?.count ?? 0) > 0) {
              return yield* automationError(
                "CONFLICT",
                "The node still has jobs in flight. Cancel them or wait for them to end.",
                { nodeId },
              );
            }
            const rows = yield* sql<{ node_id: string }>`DELETE FROM automation_nodes
              WHERE node_id = ${nodeId} RETURNING node_id`;
            return rows.length > 0;
          }),
        )
        .pipe(guarded("removeNode"));
    },
  );

  const probeNode: JobService["Service"]["probeNode"] = Effect.fn("JobService.probeNode")(
    function* (caller, nodeId) {
      yield* requireOperator(caller);
      yield* access.operatorOnly(caller, "probe execution nodes");
      const node = yield* requireNode(nodeId);
      const probed = yield* executor.probe(node).pipe(Effect.result);
      const observedAt = yield* nowIso;
      // What was seen just now. It says nothing about whether the next job will start.
      const availability: ExecutionNode["availability"] =
        probed._tag === "Success"
          ? {
              status: "available",
              os: probed.success.os,
              arch: probed.success.arch,
              tools: [...probed.success.tools],
              error: null,
              observedAt,
            }
          : {
              status: "unavailable",
              os: null,
              arch: null,
              tools: [],
              error: probed.failure.message,
              observedAt,
            };
      const next: ExecutionNode = { ...node, availability, updatedAt: observedAt };
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* writeNode(next);
            if (node.availability.status !== availability.status) {
              yield* journal.append([
                {
                  type: "node.availability",
                  scope: { nodeId },
                  origin: { kind: "service", nodeId },
                  aggregate: { kind: "node", id: nodeId },
                  payload: {
                    nodeId,
                    status: availability.status,
                    previousStatus: node.availability.status,
                    error: availability.error,
                    observedAt,
                  },
                },
              ]);
            }
          }),
        )
        .pipe(guarded("probeNode"));
      return next;
    },
  );

  // -------------------------------------------------------------------------
  // Job storage

  const overlay = (job: Job): Job => {
    const state = live.get(job.id);
    return state === undefined
      ? job
      : { ...job, logBytes: state.logBytes, logTruncated: state.logTruncated };
  };

  const readRow = (jobId: JobId) =>
    Effect.gen(function* () {
      const rows = yield* sql<JobRow>`SELECT job_json, executor_ref, log_path
        FROM automation_jobs WHERE job_id = ${jobId}`;
      const row = rows[0];
      if (row === undefined) {
        return yield* automationError("NOT_FOUND", `No job ${jobId}.`, { jobId });
      }
      return { job: yield* decodeJob(row.job_json), row };
    });

  const readJob = (jobId: JobId) =>
    readRow(jobId).pipe(
      Effect.map(({ job }) => overlay(job)),
      guarded("readJob"),
    );

  const jobEvent = (type: JobEventType, job: Job) => ({
    type,
    scope: {
      jobId: job.id,
      nodeId: job.nodeId,
      ...(job.taskId === null ? {} : { taskId: job.taskId }),
      ...(job.threadId === null ? {} : { threadId: job.threadId }),
      ...(job.requestedBy.kind === "orchestrator"
        ? { orchestratorId: job.requestedBy.orchestratorId }
        : {}),
    },
    origin: { kind: "service" as const, nodeId: job.nodeId },
    aggregate: { kind: "job" as const, id: job.id },
    payload: {
      jobId: job.id,
      nodeId: job.nodeId,
      status: job.status,
      statusReason: job.statusReason,
      exitCode: job.exitCode,
      logBytes: job.logBytes,
      logTruncated: job.logTruncated,
    },
    ...(job.refs.length === 0 ? {} : { refs: job.refs }),
  });

  /**
   * The one way a job changes: the new row and the event describing it commit
   * together, then watchers are told. `change` returns null to leave the job
   * as it is.
   */
  const transition = (
    jobId: JobId,
    change: (current: Job, now: string) => Job | null,
    options?: { readonly event?: JobEventType; readonly executorRef?: string | null },
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const { job: current } = yield* readRow(jobId);
          const now = yield* nowIso;
          const changed = change(overlay(current), now);
          if (changed === null) return { job: overlay(current), changed: false };
          const next = { ...changed, updatedAt: now };
          yield* sql`UPDATE automation_jobs SET
            status = ${next.status}, job_json = ${yield* encodeJob(next)}, updated_at = ${now}
            WHERE job_id = ${jobId}`;
          if (options?.executorRef !== undefined) {
            yield* sql`UPDATE automation_jobs SET executor_ref = ${options.executorRef}
              WHERE job_id = ${jobId}`;
          }
          if (options?.event !== undefined) {
            yield* journal.append([jobEvent(options.event, next)]);
          }
          return { job: next, changed: true };
        }),
      )
      .pipe(
        guarded("transition"),
        Effect.tap((result) =>
          result.changed ? PubSub.publish(changes, result.job) : Effect.void,
        ),
        Effect.map((result) => result.job),
      );

  // -------------------------------------------------------------------------
  // Running

  const logPathFor = (jobId: JobId) =>
    path.join(
      logDirectory,
      `${NodeCrypto.createHash("sha256").update(jobId).digest("hex").slice(0, 32)}.log`,
    );

  const runJob = (jobId: JobId, node: ExecutionNode) =>
    Effect.scoped(
      Effect.gen(function* () {
        const state = live.get(jobId);
        if (state === undefined) return;
        const logPath = logPathFor(jobId);
        yield* fileSystem.makeDirectory(logDirectory, { recursive: true });
        const log = yield* fileSystem.open(logPath, { flag: "w" });
        // From this write on the executor may have the job. If the server dies
        // before an end is recorded, the outcome is unknown and stays unknown.
        const handed = yield* sql<{ job_id: string }>`UPDATE automation_jobs
          SET executor_ref = ${HANDOFF_REF}, log_path = ${logPath}
          WHERE job_id = ${jobId} AND status IN ('accepted', 'cancel_requested')
          RETURNING job_id`;
        if (handed.length === 0) return;
        const { job } = yield* readRow(jobId);
        const started = yield* executor
          .start({
            node,
            cwd: job.cwd,
            action: job.action,
            env: {
              T3_JOB_ID: job.id,
              T3_NODE_ID: node.id,
              T3_ENVIRONMENT_ID: job.environmentId,
            },
          })
          .pipe(Effect.result);
        if (started._tag === "Failure") {
          // The executor said no: nothing ran, and that is a known outcome.
          yield* transition(
            jobId,
            (current, now) => ({
              ...current,
              status: "failed",
              statusReason: started.failure.message,
              finishedAt: now,
            }),
            { event: "job.finished", executorRef: null },
          );
          return;
        }
        const running = started.success;
        yield* transition(
          jobId,
          (current, now) => ({
            ...current,
            // A cancel that arrived first stays visible until the process confirms it.
            status: current.status === "cancel_requested" ? "cancel_requested" : "started",
            startedAt: now,
          }),
          { event: "job.started", executorRef: running.ref },
        );
        const pump = yield* running.output.pipe(
          Stream.runForEach((chunk) =>
            Effect.suspend(() => {
              const remaining = MAX_JOB_LOG_BYTES - state.logBytes;
              const kept = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
              if (kept.byteLength < chunk.byteLength) state.logTruncated = true;
              if (kept.byteLength === 0) return Effect.void;
              state.logBytes += kept.byteLength;
              return log.writeAll(kept);
            }).pipe(Effect.ignore),
          ),
          Effect.forkScoped,
        );
        const exited = Effect.map(running.exit, (exit) => ({ type: "exit" as const, ...exit }));
        const outcome = yield* Effect.raceAll([
          exited,
          Effect.as(Effect.sleep(job.timeoutMs), { type: "timeout" as const }),
          Effect.as(Deferred.await(state.cancel), { type: "cancel" as const }),
        ]);
        // Only the process ending ends the job. A timeout or a cancel is a
        // request to stop it, confirmed by the exit that follows.
        const exit =
          outcome.type === "exit" ? outcome : yield* Effect.andThen(running.kill, running.exit);
        yield* Fiber.join(pump);
        yield* log.sync.pipe(Effect.ignore);
        const terminal = (current: Job, now: string): Job => {
          const base = {
            ...current,
            exitCode: exit.code,
            logBytes: state.logBytes,
            logTruncated: state.logTruncated,
            finishedAt: now,
          };
          switch (outcome.type) {
            case "timeout":
              return {
                ...base,
                status: "timed_out",
                statusReason: `No exit within ${job.timeoutMs} ms; the process was stopped.`,
              };
            case "cancel":
              return { ...base, status: "cancelled", statusReason: "Cancelled on request." };
            case "exit":
              return {
                ...base,
                status: exit.code === 0 ? "succeeded" : "failed",
                statusReason:
                  exit.code === null
                    ? "The process was ended by a signal."
                    : exit.code === 0
                      ? null
                      : `Exited with code ${exit.code}.`,
              };
          }
        };
        yield* transition(jobId, terminal, {
          event: outcome.type === "cancel" ? "job.cancelled" : "job.finished",
        });
      }),
    ).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logError("Job supervision failed", { jobId, cause }).pipe(
              Effect.andThen(
                transition(
                  jobId,
                  (current) =>
                    isTerminal(current.status)
                      ? null
                      : {
                          ...current,
                          status: "unknown",
                          statusReason: "The server lost track of the process.",
                        },
                  { event: "job.unknown" },
                ),
              ),
              Effect.ignore,
            ),
      ),
      Effect.ensuring(Effect.sync(() => live.delete(jobId))),
    );

  const handOff = (jobId: JobId, node: ExecutionNode) =>
    Effect.gen(function* () {
      live.set(jobId, { cancel: yield* Deferred.make<void>(), logBytes: 0, logTruncated: false });
      yield* Effect.forkIn(runJob(jobId, node), scope);
    });

  // -------------------------------------------------------------------------
  // Submitting

  const within = (root: string, candidate: string, separator: string) =>
    candidate === root ||
    candidate.startsWith(root.endsWith(separator) ? root : `${root}${separator}`);

  /**
   * The directory a job may run in, as the node itself resolves it. Symlinks
   * and `..` are followed first, so a path that only looks like it is inside
   * a workspace root is refused.
   */
  const authorizeDirectory = Effect.fn("JobService.authorizeDirectory")(function* (
    node: ExecutionNode,
    cwd: string,
    projectIds: ReadonlyArray<ProjectId> | undefined,
  ) {
    const separator = node.transport.type === "ssh" ? "/" : path.sep;
    if (node.transport.type === "ssh" ? !cwd.startsWith("/") : !path.isAbsolute(cwd)) {
      return yield* invalid("The job's cwd must be an absolute path.");
    }
    const resolved = yield* executor
      .resolveDirectory(node, cwd)
      .pipe(Effect.mapError((cause) => automationError("INVALID_INPUT", cause.message, { cwd })));
    const resolveAll = (roots: ReadonlyArray<string>) =>
      Effect.forEach(roots, (root) => Effect.option(executor.resolveDirectory(node, root))).pipe(
        Effect.map((options) =>
          options.flatMap((option) => (option._tag === "Some" ? [option.value] : [])),
        ),
      );
    const roots = yield* resolveAll(node.workspaceRoots);
    if (!roots.some((root) => within(root, resolved, separator))) {
      return yield* automationError(
        "PERMISSION_DENIED",
        `${cwd} is outside the workspace roots of node ${node.id}.`,
        { nodeId: node.id, cwd },
      );
    }
    if (projectIds !== undefined) {
      // Project paths are the server machine's. On any other node they prove nothing.
      const projectRoots =
        node.transport.type === "local"
          ? yield* resolveAll(yield* authority.projectRoots(projectIds))
          : [];
      if (!projectRoots.some((root) => within(root, resolved, separator))) {
        return yield* automationError(
          "PERMISSION_DENIED",
          `${cwd} is outside the projects this orchestrator may work in.`,
          { nodeId: node.id, cwd },
        );
      }
    }
    return resolved;
  });

  const submit: JobService["Service"]["submit"] = Effect.fn("JobService.submit")(
    function* (caller, input) {
      yield* requireOperator(caller);
      // An orchestrator's agent submits as its own orchestrator, whatever the body names.
      const orchestratorId = yield* access.actingOrchestratorId(caller, input.orchestratorId);
      if (caller.kind === "orchestrator") yield* access.requireLive(caller);
      const jobId = JobId.make(
        `job_${NodeCrypto.createHash("sha256").update(input.idempotencyKey).digest("hex").slice(0, 32)}`,
      );
      const known = yield* sql<{ result_json: string }>`SELECT result_json
      FROM automation_idempotency
      WHERE scope = ${IDEMPOTENCY_SCOPE} AND idempotency_key = ${input.idempotencyKey}`.pipe(
        guarded("submit"),
      );
      if (known[0] !== undefined) return { job: yield* readJob(jobId), created: false };

      const node = yield* requireNode(input.nodeId);
      if (!node.enabled) {
        return yield* automationError("NODE_UNAVAILABLE", `Node ${node.id} is disabled.`, {
          nodeId: node.id,
        });
      }
      const shell = input.action.type === "shell";
      yield* access.authorize(caller, "job.run", { nodeId: node.id });
      const permissions =
        orchestratorId === undefined
          ? undefined
          : yield* authority.orchestratorPermissions(orchestratorId);
      if (permissions === null) {
        return yield* automationError(
          "NOT_FOUND",
          `No orchestrator ${orchestratorId} is hosted here.`,
        );
      }
      const deny = (message: string) =>
        Effect.fail(automationError("PERMISSION_DENIED", message, { nodeId: node.id }));
      if (permissions !== undefined) {
        if (!permissions.actions.includes("job.run")) {
          return yield* deny("This orchestrator may not run jobs.");
        }
        if (permissions.nodeIds !== undefined && !permissions.nodeIds.includes(node.id)) {
          return yield* deny("This orchestrator may not use that node.");
        }
      }
      if (shell) {
        // Three separate grants. Broad access to the environment is not one of them.
        if (!node.allowShell) {
          return yield* deny(`Node ${node.id} does not allow shell jobs.`);
        }
        if (
          (caller.kind === "client" || caller.kind === "orchestrator") &&
          !caller.scopes.includes(AuthAutomationExecuteScope)
        ) {
          return yield* deny(`Shell jobs need the ${AuthAutomationExecuteScope} scope.`);
        }
        if (permissions !== undefined && !permissions.actions.includes("job.shell")) {
          return yield* deny("Shell jobs for an orchestrator need its job.shell action.");
        }
        if (permissions === undefined && caller.kind === "internal") {
          // The server acting for itself holds no scope; it must name who it acts for.
          return yield* deny("A shell job needs a requester: a scoped client or an orchestrator.");
        }
      }
      const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      if (timeoutMs > MAX_TIMEOUT_MS) {
        return yield* invalid(`A job may run for at most ${MAX_TIMEOUT_MS} ms.`);
      }
      const cwd = yield* authorizeDirectory(node, input.cwd, permissions?.projectIds);
      const self = yield* environment.getEnvironmentId;
      const now = yield* nowIso;
      const job: Job = {
        id: jobId,
        environmentId: self,
        nodeId: node.id,
        requestedBy:
          orchestratorId === undefined
            ? { kind: "user" }
            : { kind: "orchestrator", orchestratorId, environmentId: self },
        requestedByEnvironmentId: self,
        taskId: input.taskId ?? null,
        threadId: input.threadId ?? null,
        cwd,
        action: input.action,
        timeoutMs,
        idempotent: input.idempotent ?? false,
        status: "accepted",
        statusReason: null,
        exitCode: null,
        logBytes: 0,
        logTruncated: false,
        refs: [],
        acceptedAt: now,
        startedAt: null,
        finishedAt: null,
        updatedAt: now,
      };
      // Stored, with its event and its idempotency record, before any executor hears of it.
      const created = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const inserted = yield* sql<{ idempotency_key: string }>`INSERT OR IGNORE
            INTO automation_idempotency (scope, idempotency_key, result_json, created_at)
            VALUES (${IDEMPOTENCY_SCOPE}, ${input.idempotencyKey}, ${jobId}, ${now})
            RETURNING idempotency_key`;
            if (inserted.length === 0) return false;
            yield* sql`INSERT INTO automation_jobs (
            job_id, node_id, task_id, status, job_json, executor_ref, log_path, accepted_at, updated_at
          ) VALUES (
            ${jobId}, ${node.id}, ${job.taskId}, ${job.status}, ${yield* encodeJob(job)},
            NULL, NULL, ${now}, ${now}
          )`;
            yield* journal.append([jobEvent("job.accepted", job)]);
            return true;
          }),
        )
        .pipe(guarded("submit"));
      if (!created) return { job: yield* readJob(jobId), created: false };
      yield* PubSub.publish(changes, job);
      yield* handOff(jobId, node);
      return { job, created: true };
    },
  );

  const get: JobService["Service"]["get"] = (caller, jobId) =>
    Effect.andThen(requireOperator(caller), readJob(jobId));

  const list: JobService["Service"]["list"] = Effect.fn("JobService.list")(
    function* (caller, input) {
      yield* requireOperator(caller);
      const rows = yield* sql<{ job_json: string }>`SELECT job_json FROM automation_jobs
      WHERE ${sql.and([
        input.nodeId === undefined ? sql`1 = 1` : sql`node_id = ${input.nodeId}`,
        input.taskId === undefined ? sql`1 = 1` : sql`task_id = ${input.taskId}`,
        input.statuses === undefined || input.statuses.length === 0
          ? sql`1 = 1`
          : sql`status IN ${sql.in(input.statuses)}`,
      ])}
      ORDER BY accepted_at DESC, job_id ASC LIMIT ${input.limit ?? DEFAULT_LIST_LIMIT}`.pipe(
        Effect.flatMap(Effect.forEach((row) => decodeJob(row.job_json))),
        guarded("list"),
      );
      return rows.map(overlay);
    },
  );

  const cancel: JobService["Service"]["cancel"] = Effect.fn("JobService.cancel")(
    function* (caller, jobId) {
      yield* requireOperator(caller);
      const current = yield* readJob(jobId);
      yield* requireOwnJob(caller, current);
      if (isTerminal(current.status)) return current;
      const state = live.get(jobId);
      if (state === undefined) {
        // No process handle means nothing here can confirm a stop. Saying
        // "cancelled" would be a guess.
        return yield* automationError(
          "RESULT_UNKNOWN",
          "This server holds no handle on the job's process, so it cannot confirm a cancel. Reconcile the job to re-read its state.",
          { jobId, status: current.status },
        );
      }
      const requested = yield* transition(jobId, (job) =>
        job.status === "accepted" || job.status === "started"
          ? { ...job, status: "cancel_requested", statusReason: "Cancel requested." }
          : null,
      );
      yield* Deferred.succeed(state.cancel, undefined);
      return requested;
    },
  );

  const markUnknown = (jobId: JobId, node: ExecutionNode | undefined, ref: string | null) =>
    Effect.gen(function* () {
      const seen =
        node === undefined || ref === null || ref === HANDOFF_REF
          ? ("unverifiable" as const)
          : yield* executor.inspect(node, ref);
      const reason =
        seen === "running"
          ? "Its process is still running without a supervisor, so its exit cannot be recorded."
          : seen === "gone"
            ? "Its process is gone and its exit was never recorded."
            : "Whether its process ran, or still runs, cannot be established.";
      const job = yield* transition(
        jobId,
        (current) =>
          isTerminal(current.status)
            ? null
            : current.status === "unknown" && current.statusReason?.endsWith(reason) === true
              ? null
              : {
                  ...current,
                  status: "unknown",
                  statusReason: `The server restarted while this job was in flight. ${reason}`,
                },
        { event: "job.unknown" },
      );
      return { job, seen };
    });

  const reconcile: JobService["Service"]["reconcile"] = Effect.fn("JobService.reconcile")(
    function* (caller, jobId) {
      yield* requireOperator(caller);
      const { job: stored, row } = yield* readRow(jobId).pipe(guarded("reconcile"));
      yield* requireOwnJob(caller, stored);
      // A job this server is supervising, or one that ended, is already as known as it gets.
      if (live.has(jobId) || isTerminal(stored.status)) return overlay(stored);
      const nodes = yield* loadNodes;
      const node = nodes.find((entry) => entry.id === stored.nodeId);
      const { job, seen } = yield* markUnknown(jobId, node, row.executor_ref);
      if (job.status !== "unknown" || seen === "running" || !job.idempotent) return job;
      if (node === undefined || !node.enabled) {
        return yield* automationError(
          "NODE_UNAVAILABLE",
          `Node ${job.nodeId} is gone or disabled, so the job cannot be run again.`,
          { jobId, nodeId: job.nodeId },
        );
      }
      // Declared idempotent by its requester, and asked for explicitly: run it again.
      const rerun = yield* transition(
        jobId,
        (current) =>
          current.status === "unknown"
            ? {
                ...current,
                status: "accepted",
                statusReason: "Run again by reconcile after an unknown outcome.",
                exitCode: null,
                logBytes: 0,
                logTruncated: false,
                startedAt: null,
                finishedAt: null,
              }
            : null,
        { event: "job.accepted", executorRef: null },
      );
      if (rerun.status === "accepted") yield* handOff(jobId, node);
      return rerun;
    },
  );

  const logs: JobService["Service"]["logs"] = Effect.fn("JobService.logs")(
    function* (caller, input) {
      yield* requireOperator(caller);
      const { job, row } = yield* readRow(input.jobId).pipe(guarded("logs"));
      const after = input.afterByte ?? 0;
      const limit = Math.min(input.maxBytes ?? DEFAULT_LOG_READ_BYTES, MAX_LOG_READ_BYTES);
      const chunks =
        row.log_path === null
          ? []
          : yield* fileSystem.stream(row.log_path, { offset: after, bytesToRead: limit }).pipe(
              Stream.runCollect,
              Effect.orElseSucceed((): Array<Uint8Array> => []),
            );
      const bytes = Buffer.concat(chunks);
      const nextByte = after + bytes.byteLength;
      const size =
        row.log_path === null
          ? 0
          : yield* fileSystem.stat(row.log_path).pipe(
              Effect.map((info) => Number(info.size)),
              Effect.orElseSucceed(() => 0),
            );
      return {
        jobId: job.id,
        text: bytes.toString("utf8"),
        nextByte,
        // Quiet output is not an end: only a recorded terminal status completes the log.
        complete: isTerminal(job.status) && nextByte >= size,
      };
    },
  );

  const watch: JobService["Service"]["watch"] = (caller, jobId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        yield* requireOperator(caller);
        // Subscribe before reading, so no change between the two is missed.
        const subscription = yield* PubSub.subscribe(changes);
        const current = yield* readJob(jobId);
        return Stream.make(current).pipe(
          Stream.concat(
            Stream.fromSubscription(subscription).pipe(Stream.filter((job) => job.id === jobId)),
          ),
          Stream.changesWith(
            (left, right) => left.status === right.status && left.updatedAt === right.updatedAt,
          ),
          Stream.takeUntil((job) => isTerminal(job.status)),
        );
      }),
    );

  const start: JobRecovery["Service"]["start"] = () =>
    Effect.gen(function* () {
      const rows = yield* sql<
        JobRow & { job_id: string }
      >`SELECT job_id, job_json, executor_ref, log_path
        FROM automation_jobs WHERE status IN ('accepted', 'started', 'cancel_requested')`;
      const nodes = yield* loadNodes;
      for (const row of rows) {
        const jobId = JobId.make(row.job_id);
        if (live.has(jobId)) continue;
        const job = yield* decodeJob(row.job_json);
        const node = nodes.find((entry) => entry.id === job.nodeId);
        if (job.status === "accepted" && row.executor_ref === null && node?.enabled === true) {
          // Stored but never handed to an executor: nothing can have run, so start it now.
          yield* handOff(jobId, node);
        } else {
          // Never run again on its own, idempotent or not.
          yield* markUnknown(jobId, node, row.executor_ref);
        }
      }
    }).pipe(Effect.catchCause((cause) => Effect.logError("Job recovery failed", { cause })));

  return Context.make(
    JobService,
    JobService.of({
      listNodes,
      upsertNode,
      removeNode,
      probeNode,
      submit,
      get,
      list,
      cancel,
      reconcile,
      logs,
      watch,
    }),
  ).pipe(Context.add(JobRecovery, JobRecovery.of({ start })));
});

/**
 * For compositions that bring their own `JobExecutor`, `JobAuthority` and
 * `EventJournal`, such as tests and the server once orchestrators are wired.
 */
export const layerWithoutExecutor = Layer.effectContext(make);

/**
 * Needs `SqlClient`, `ServerEnvironment`, `ServerConfig`, `ProjectStoreV2`,
 * `FileSystem`, `Path` and `ChildProcessSpawner`. Provides `JobRecovery` too;
 * call its `start` once when the server starts. It composes whatever
 * `EventJournal.layer` and `OrchestratorService.layer` currently are, so the
 * real ones are picked up as they land; until the orchestrator service exists,
 * a job requested on behalf of an orchestrator is refused.
 */
export const layer = layerWithoutExecutor.pipe(
  Layer.provide(JobExecutor.layer),
  Layer.provide(JobAuthority.layer.pipe(Layer.provide(OrchestratorService.layer))),
  Layer.provide(EventJournal.layer),
);
