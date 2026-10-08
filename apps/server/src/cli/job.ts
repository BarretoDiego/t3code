/**
 * `t3 job` - commands run on execution nodes, and what is actually known about each.
 *
 * A job's status comes from the executor: an exit code when the process ended,
 * `unknown` when the server lost track of it. Waiting and reading logs are
 * observations; neither changes the job.
 */
import {
  AUTOMATION_WS_METHODS,
  DelegatedTaskId,
  ExecutionNodeId,
  type Job,
  JobStatus,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { Argument, Command, Flag } from "effect/cli";

import { jsonFlag, printJson, timeoutFlag, withClient } from "./common.ts";
import { type EnvironmentRpcClient, environmentTargetFlags } from "./environmentRpc.ts";

const M = AUTOMATION_WS_METHODS;
const LOG_FOLLOW_INTERVAL = Duration.millis(500);
const isJobStatus = Schema.is(JobStatus);

export class JobCliError extends Schema.TaggedError<JobCliError>()("JobCliError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

const fail = (detail: string) => Effect.fail(new JobCliError({ detail }));

/** The action as one readable line; a shell line is shown as what it is. */
function describeAction(job: Job): string {
  return job.action.type === "shell"
    ? `sh -c ${job.action.script}`
    : [job.action.executable, ...job.action.args].join(" ");
}

export function formatJobLine(job: Job): string {
  return [
    job.id,
    job.nodeId,
    job.exitCode === null ? job.status : `${job.status} (exit ${job.exitCode})`,
    job.acceptedAt,
    describeAction(job),
  ].join("  ");
}

export function formatJob(job: Job): string {
  return [
    `${job.id}  ${job.status}${job.statusReason === null ? "" : ` - ${job.statusReason}`}`,
    `  node:      ${job.nodeId}`,
    `  cwd:       ${job.cwd}`,
    `  action:    ${describeAction(job)}`,
    // Absent until the executor reports it. Silence in the log is not an exit.
    `  exit code: ${job.exitCode ?? "not reported"}`,
    `  accepted:  ${job.acceptedAt}`,
    `  started:   ${job.startedAt ?? "-"}`,
    `  finished:  ${job.finishedAt ?? "-"}`,
    `  log:       ${job.logBytes} bytes${job.logTruncated ? " (truncated at the size cap)" : ""}`,
    `  re-run:    ${job.idempotent ? "allowed by `t3 job reconcile` after an unknown outcome" : "never automatic; not declared idempotent"}`,
    ...(job.taskId === null ? [] : [`  task:      ${job.taskId}`]),
    ...(job.threadId === null ? [] : [`  thread:    ${job.threadId}`]),
  ].join("\n");
}

/** Resolves a job by id or unique id prefix. */
const resolveJob = Effect.fn("cli.job.resolveJob")(function* (
  client: EnvironmentRpcClient,
  identifier: string,
) {
  const wanted = identifier.trim();
  const { jobs } = yield* client[M.jobsList]({ limit: 1000 });
  const exact = jobs.filter((job) => job.id === wanted);
  const matches =
    exact.length > 0 ? exact : jobs.filter((job) => wanted.length > 0 && job.id.startsWith(wanted));
  if (matches.length === 1) return matches[0]!;
  return yield* fail(
    matches.length === 0
      ? `No job matches '${wanted}'. Run \`t3 job list\` to see them.`
      : `'${wanted}' matches ${matches.length} jobs. Use more of the id.`,
  );
});

/**
 * Follows a job until the executor reports an end, the outcome becomes
 * unknown, or the time runs out. Giving up waiting leaves the job running:
 * it is never a cancel.
 */
export const waitForJob = Effect.fn("cli.job.waitForJob")(function* (
  client: EnvironmentRpcClient,
  jobId: Job["id"],
  timeout: Option.Option<Duration.Duration>,
) {
  const last = client[M.jobsWatch]({ jobId }).pipe(
    Stream.takeUntil((job) => job.status === "unknown"),
    Stream.runLast,
  );
  const settled = yield* Option.isSome(timeout)
    ? Effect.timeoutOption(last, timeout.value)
    : Effect.asSome(last);
  if (Option.isSome(settled) && Option.isSome(settled.value)) {
    return { job: settled.value.value, waited: true as const };
  }
  return { job: yield* client[M.jobsGet]({ jobId }), waited: false as const };
});

/** Prints the outcome and fails unless the job succeeded, so scripts can branch on it. */
export const reportWaited = Effect.fn("cli.job.reportWaited")(function* (
  result: Effect.Success<ReturnType<typeof waitForJob>>,
  json: boolean,
) {
  const { job } = result;
  yield* json ? printJson({ job, timedOut: !result.waited }) : Console.log(formatJob(job));
  if (!result.waited) {
    return yield* fail(
      `Stopped waiting: ${job.id} is still ${job.status}. It was not cancelled; use \`t3 job cancel\` for that.`,
    );
  }
  if (job.status === "succeeded") return;
  return yield* fail(
    job.status === "unknown"
      ? `${job.id} has an unknown outcome. \`t3 job reconcile ${job.id}\` re-reads it.`
      : `${job.id} ended as ${job.status}${job.exitCode === null ? "" : ` with exit code ${job.exitCode}`}.`,
  );
});

const jobArgument = Argument.String("job").pipe(
  Argument.withDescription("Job id or unique id prefix."),
);

const showCommand = Command.make("show", {
  ...environmentTargetFlags,
  job: jobArgument,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Show one job: status, exit code if reported, and where it ran."),
  Command.withHandler(
    withClient(
      Effect.fn("cli.job.show")(function* (client, flags) {
        const job = yield* resolveJob(client, flags.job);
        yield* flags.json ? printJson(job) : Console.log(formatJob(job));
      }),
    ),
  ),
);

const listCommand = Command.make("list", {
  ...environmentTargetFlags,
  node: Flag.String("node").pipe(Flag.withDescription("Only jobs on this node."), Flag.optional),
  task: Flag.String("task").pipe(
    Flag.withDescription("Only jobs of this delegated task."),
    Flag.optional,
  ),
  status: Flag.String("status").pipe(
    Flag.withDescription(
      "Only these statuses, comma-separated: accepted, started, succeeded, failed, timed_out, cancel_requested, cancelled, unknown.",
    ),
    Flag.optional,
  ),
  limit: Flag.Int("limit").pipe(Flag.withDescription("Most jobs to print."), Flag.optional),
  json: jsonFlag,
}).pipe(
  Command.withDescription("List jobs, newest first."),
  Command.withHandler(
    withClient(
      Effect.fn("cli.job.list")(function* (client, flags) {
        const statuses = Option.isSome(flags.status)
          ? flags.status.value.split(",").map((entry) => entry.trim())
          : [];
        const unknown = statuses.filter((status) => !isJobStatus(status));
        if (unknown.length > 0) return yield* fail(`Not a job status: ${unknown.join(", ")}.`);
        const { jobs } = yield* client[M.jobsList]({
          ...(Option.isSome(flags.node) ? { nodeId: ExecutionNodeId.make(flags.node.value) } : {}),
          ...(Option.isSome(flags.task) ? { taskId: DelegatedTaskId.make(flags.task.value) } : {}),
          ...(statuses.length === 0 ? {} : { statuses: statuses.filter(isJobStatus) }),
          ...(Option.isSome(flags.limit) ? { limit: flags.limit.value } : {}),
        });
        if (flags.json) return yield* printJson(jobs);
        yield* Console.log(jobs.length === 0 ? "No jobs." : jobs.map(formatJobLine).join("\n"));
      }),
    ),
  ),
);

const waitCommand = Command.make("wait", {
  ...environmentTargetFlags,
  job: jobArgument,
  timeout: timeoutFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Block until the job ends or its outcome becomes unknown. Exits non-zero unless it succeeded. A timeout stops the waiting, not the job.",
  ),
  Command.withHandler(
    withClient(
      Effect.fn("cli.job.wait")(function* (client, flags) {
        const job = yield* resolveJob(client, flags.job);
        yield* reportWaited(yield* waitForJob(client, job.id, flags.timeout), flags.json);
      }),
    ),
  ),
);

const logsCommand = Command.make("logs", {
  ...environmentTargetFlags,
  job: jobArgument,
  follow: Flag.Boolean("follow").pipe(
    Flag.withDescription("Keep printing new output until the job ends."),
    Flag.withDefault(false),
  ),
  after: Flag.Int("after").pipe(
    Flag.withDescription("Start after this byte offset. Default: the beginning."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription(
    "Print a job's combined output. The log is capped; `t3 job show` says if it was cut.",
  ),
  Command.withHandler(
    withClient(
      Effect.fn("cli.job.logs")(function* (client, flags) {
        const job = yield* resolveJob(client, flags.job);
        const stdio = yield* Stdio.Stdio;
        const write = (text: string) =>
          text.length === 0
            ? Effect.void
            : Stream.run(Stream.encodeText(Stream.make(text)), stdio.stdout());
        let afterByte = Option.getOrElse(flags.after, () => 0);
        for (;;) {
          const page = yield* client[M.jobsLogs]({ jobId: job.id, afterByte });
          yield* write(page.text);
          const progressed = page.nextByte > afterByte;
          afterByte = page.nextByte;
          if (page.complete) return;
          if (progressed) continue;
          if (!flags.follow) return;
          // No output and no end: only the job's status can say which it is.
          const current = yield* client[M.jobsGet]({ jobId: job.id });
          if (current.status === "unknown") {
            return yield* fail(
              `${job.id} has an unknown outcome; its log may be incomplete and will not grow.`,
            );
          }
          yield* Effect.sleep(LOG_FOLLOW_INTERVAL);
        }
      }),
    ),
  ),
);

const cancelCommand = Command.make("cancel", {
  ...environmentTargetFlags,
  job: jobArgument,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Ask a job to stop. It shows cancel_requested until its process confirms; `t3 job wait` follows that.",
  ),
  Command.withHandler(
    withClient(
      Effect.fn("cli.job.cancel")(function* (client, flags) {
        const job = yield* resolveJob(client, flags.job);
        const updated = yield* client[M.jobsCancel]({ jobId: job.id });
        yield* flags.json ? printJson(updated) : Console.log(formatJob(updated));
      }),
    ),
  ),
);

const reconcileCommand = Command.make("reconcile", {
  ...environmentTargetFlags,
  job: jobArgument,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Re-read a job whose outcome is unknown. Runs it again only if it was submitted as idempotent and its process is not still running.",
  ),
  Command.withHandler(
    withClient(
      Effect.fn("cli.job.reconcile")(function* (client, flags) {
        const job = yield* resolveJob(client, flags.job);
        const updated = yield* client[M.jobsReconcile]({ jobId: job.id });
        yield* flags.json ? printJson(updated) : Console.log(formatJob(updated));
      }),
    ),
  ),
);

export const jobCommand = Command.make("job").pipe(
  Command.withDescription("Inspect, follow, and cancel jobs running on execution nodes."),
  Command.withSubcommands([
    showCommand,
    listCommand,
    waitCommand,
    logsCommand,
    cancelCommand,
    reconcileCommand,
  ]),
);
