import {
  AUTOMATION_WS_METHODS,
  type AutomationDiagnostics,
  type AutomationPendingWork,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2ArchivedShellSnapshot,
  type OrchestrationV2ShellStreamItem,
  type ScheduledTaskListResult,
  type ServerPendingWorkResult,
  type TerminalMetadataStreamEvent,
  type ComputeJobListInput,
  type GenerationJob,
  type ResourceTelemetrySnapshot,
  type TerminalSummary,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/cli";

import { jsonFlag, printJson, printJsonLine } from "./common.ts";
import { DurationFromString } from "./config.ts";
import {
  type EnvironmentTargetFlags,
  environmentTargetFlags,
  readSavedEnvironments,
  withEnvironmentRpc,
  withSavedEnvironmentStore,
} from "./environmentRpc.ts";
import { buildStatusReport, formatStatusReport } from "./statusReport.ts";
import { loadShell } from "./thread.ts";

type StatusRpcClient = {
  readonly [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: (input: {}) => Stream.Stream<
    OrchestrationV2ShellStreamItem,
    Error
  >;
  readonly [ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot]: (input: {}) => Effect.Effect<
    OrchestrationV2ArchivedShellSnapshot,
    Error
  >;
  readonly [WS_METHODS.subscribeTerminalMetadata]: (input: {}) => Stream.Stream<
    TerminalMetadataStreamEvent,
    Error
  >;
  readonly [WS_METHODS.scheduledTasksList]: (input: {}) => Effect.Effect<
    ScheduledTaskListResult,
    Error
  >;
  readonly [WS_METHODS.computeListJobs]: (
    input: ComputeJobListInput,
  ) => Effect.Effect<ReadonlyArray<GenerationJob>, Error>;
  readonly [WS_METHODS.serverGetPendingWork]: (input: {}) => Effect.Effect<
    ServerPendingWorkResult,
    Error
  >;
  readonly [AUTOMATION_WS_METHODS.diagnostics]: (input: {}) => Effect.Effect<
    AutomationDiagnostics,
    Error
  >;
  readonly [WS_METHODS.subscribeResourceTelemetry]: (input: {}) => Stream.Stream<
    ResourceTelemetrySnapshot,
    Error
  >;
};

class StatusReadError extends Schema.TaggedError<StatusReadError>()("StatusReadError", {
  detail: Schema.String,
}) {
  override get message() {
    return this.detail;
  }
}

class StatusNotReadyError extends Schema.TaggedError<StatusNotReadyError>()("StatusNotReadyError", {
  detail: Schema.String,
}) {
  override get message() {
    return this.detail;
  }
}

/** Exhausts history pages so an older active compute job cannot disappear behind completed jobs. */
const loadJobs = Effect.fn("cli.status.loadJobs")(function* (client: StatusRpcClient) {
  const jobs: GenerationJob[] = [];
  let before: ComputeJobListInput["before"];
  while (true) {
    const page = yield* client[WS_METHODS.computeListJobs]({
      limit: 500,
      ...(before === undefined ? {} : { before }),
    });
    jobs.push(...page);
    if (page.length < 500) return jobs;
    const last = page.at(-1)!;
    if (before?.id === last.id)
      return yield* new StatusReadError({ detail: "Compute history pagination did not advance." });
    before = { id: last.id, createdAt: last.createdAt };
  }
});

const FRESH_SAMPLE_WAIT = Duration.seconds(20);

const sampledAt = (snapshot: ResourceTelemetrySnapshot) =>
  Option.match(snapshot.health.native.lastSampleAt, {
    onNone: () => null,
    onSome: DateTime.toEpochMillis,
  });

/**
 * The server samples processes only while someone is subscribed, so the first
 * snapshot of a new subscription is whatever was cached before it, possibly
 * from hours ago. Waits for one sampled since, and settles for the newest
 * snapshot seen when no new sample arrives, which the report then flags.
 */
const readProcessSnapshot = Effect.fn("cli.status.readProcessSnapshot")(function* (
  client: StatusRpcClient,
) {
  let newest: ResourceTelemetrySnapshot | null = null;
  let cachedSampleAt: number | null = null;
  yield* client[WS_METHODS.subscribeResourceTelemetry]({}).pipe(
    Stream.takeUntil((snapshot) => {
      const first = newest === null;
      newest = snapshot;
      if (first) {
        cachedSampleAt = sampledAt(snapshot);
        return false;
      }
      const at = sampledAt(snapshot);
      return at !== null && at !== cachedSampleAt;
    }),
    Stream.runDrain,
    Effect.timeoutOption(FRESH_SAMPLE_WAIT),
  );
  return newest === null
    ? yield* new StatusReadError({ detail: "Process stream ended without a snapshot." })
    : (newest as ResourceTelemetrySnapshot);
});

/** Reads each source independently, retaining failures alongside the sources that did answer. */
export const readStatus = Effect.fn("cli.status.read")(function* (
  client: StatusRpcClient,
  environment: string,
  includeStopped: boolean,
) {
  const errors: Array<{ source: string; detail: string }> = [];
  const read = <A, E, R>(
    source: string,
    effect: Effect.Effect<A, E, R>,
    fallback: A,
    timeout: Duration.Duration = Duration.seconds(10),
  ) =>
    effect.pipe(
      Effect.timeout(timeout),
      Effect.catchCause((cause) => {
        errors.push({ source, detail: Cause.pretty(cause) });
        return Effect.succeed(fallback);
      }),
    );
  const [shell, archived, terminals, tasks, jobs, pendingWork, automation, telemetry] =
    yield* Effect.all(
      [
        read("threads", loadShell(client), {
          schemaVersion: 1,
          snapshotSequence: 0,
          threads: [],
          archivedThreads: [],
          projects: [],
        }),
        read("archived threads", client[ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot]({}), {
          schemaVersion: 1,
          snapshotSequence: 0,
          threads: [],
          projects: [],
        }),
        read<ReadonlyArray<TerminalSummary>, Error, never>(
          "terminals",
          client[WS_METHODS.subscribeTerminalMetadata]({}).pipe(
            Stream.filterMap((event) =>
              event.type === "snapshot" ? Result.succeed(event.terminals) : Result.fail(event),
            ),
            Stream.runHead,
            Effect.flatMap((snapshot) =>
              Option.isSome(snapshot)
                ? Effect.succeed(snapshot.value)
                : Effect.fail(
                    new StatusReadError({ detail: "Terminal stream ended without a snapshot." }),
                  ),
            ),
          ),
          [],
        ),
        read("scheduled tasks", client[WS_METHODS.scheduledTasksList]({}), { tasks: [] }),
        read("compute jobs", loadJobs(client), []),
        read("server work", client[WS_METHODS.serverGetPendingWork]({}), { effects: [] }),
        read<AutomationPendingWork | null, Error, never>(
          "automation",
          Effect.map(
            client[AUTOMATION_WS_METHODS.diagnostics]({}),
            (diagnostics) => diagnostics.pendingWork,
          ),
          null,
        ),
        read<ResourceTelemetrySnapshot | null, Error, never>(
          "processes",
          readProcessSnapshot(client),
          null,
          // The sampler slows to one sample every 15 seconds on a constrained host.
          Duration.sum(FRESH_SAMPLE_WAIT, Duration.seconds(5)),
        ),
      ],
      { concurrency: 7 },
    );
  return buildStatusReport({
    environment,
    at: yield* DateTime.now,
    threads: [
      ...new Map(
        [...shell.threads, ...shell.archivedThreads, ...archived.threads].map((thread) => [
          thread.id,
          thread,
        ]),
      ).values(),
    ],
    projects: shell.projects,
    terminals,
    scheduledTasks: tasks.tasks,
    jobs,
    pendingWork,
    automation,
    telemetry,
    errors,
    includeStopped,
  });
});

const inspectEnvironment = (
  flags: EnvironmentTargetFlags,
  environment: string,
  includeStopped: boolean,
) =>
  withEnvironmentRpc(flags, (client) => readStatus(client, environment, includeStopped)).pipe(
    Effect.timeout(Duration.seconds(15)),
    Effect.catchCause((cause) =>
      DateTime.now.pipe(
        Effect.map((at) =>
          buildStatusReport({
            environment,
            at,
            threads: [],
            projects: [],
            terminals: [],
            scheduledTasks: [],
            jobs: [],
            pendingWork: { effects: [] },
            automation: null,
            telemetry: null,
            errors: [{ source: "connection", detail: Cause.pretty(cause) }],
            includeStopped,
          }),
        ),
      ),
    ),
  );

export const statusCommand = Command.make("status", {
  ...environmentTargetFlags,
  json: jsonFlag,
  all: Flag.Boolean("all").pipe(
    Flag.withDescription("Inspect the local server and every saved environment."),
    Flag.withDefault(false),
  ),
  includeStopped: Flag.Boolean("include-stopped").pipe(
    Flag.withDescription("Also list completed, interrupted, idle threads and idle terminals."),
    Flag.withDefault(false),
  ),
  check: Flag.Boolean("check").pipe(
    Flag.withDescription("Exit non-zero unless every inspected environment is ready to close."),
    Flag.withDefault(false),
  ),
  watch: Flag.String("watch").pipe(
    Flag.withSchema(DurationFromString),
    Flag.withDescription("Keep reporting at this interval, e.g. 5s or 30s."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription(
    "Show active work, waiting agents, background tasks, terminals and processes before closing T3 Code.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      if (Option.isSome(flags.watch) && Duration.toMillis(flags.watch.value) < 1000)
        return yield* new StatusReadError({ detail: "Use a watch interval of at least 1s." });
      const targets = flags.all
        ? [
            { name: "Local", env: Option.none<string>() },
            ...(yield* withSavedEnvironmentStore(flags, readSavedEnvironments)).map((entry) => ({
              name: entry.label || entry.name,
              env: Option.some(entry.name),
            })),
          ]
        : [{ name: Option.getOrElse(flags.env, () => "Local"), env: flags.env }];
      const report = Effect.gen(function* () {
        const environments = yield* Effect.forEach(
          targets,
          (target) =>
            inspectEnvironment({ ...flags, env: target.env }, target.name, flags.includeStopped),
          { concurrency: 4 },
        );
        const safeToClose = environments.every((environment) => environment.safeToClose);
        const output = { safeToClose, environments };
        yield* flags.json
          ? Option.isSome(flags.watch)
            ? printJsonLine(output)
            : printJson(output)
          : Console.log(environments.map(formatStatusReport).join("\n\n"));
        return safeToClose;
      });
      const safeToClose = yield* report;
      if (Option.isSome(flags.watch)) {
        const interval = flags.watch.value;
        return yield* Effect.forever(Effect.sleep(interval).pipe(Effect.andThen(report)));
      }
      if (flags.check && !safeToClose)
        return yield* new StatusNotReadyError({
          detail:
            "T3 Code has active work or incomplete status information. Inspect the report before closing it.",
        });
    }),
  ),
);
