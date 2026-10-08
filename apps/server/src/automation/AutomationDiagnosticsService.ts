import {
  type AutomationDiagnostics,
  type AutomationError,
  type AutomationJournalStatus,
  type AutomationPendingWork,
  ExecutionNodeId,
  JobId,
  JobStatus,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { automationError, internalCaller } from "./Caller.ts";
import * as OrchestratorService from "./OrchestratorService.ts";
import * as PeerService from "./PeerService.ts";

/** Health and backlog of the automation runtime, for `t3 doctor` and `t3 status`. */
export class AutomationDiagnosticsService extends Context.Service<
  AutomationDiagnosticsService,
  {
    readonly read: Effect.Effect<AutomationDiagnostics, AutomationError>;
    /** Work that would be interrupted or left unobserved if the server stopped now. */
    readonly pendingWork: Effect.Effect<AutomationPendingWork, AutomationError>;
  }
>()("t3/automation/AutomationDiagnosticsService") {}

const ACTIVE_TASK_STATUSES = [
  "pending_delivery",
  "accepted",
  "running",
  "blocked",
  "cancel_requested",
];
const ACTIVE_JOB_STATUSES = ["accepted", "started", "cancel_requested", "unknown"];

const isJobStatus = Schema.is(JobStatus);
const caller = internalCaller("automation-diagnostics");

/** A capability that is not wired contributes nothing; any other failure is reported. */
const emptyWhenUnsupported = <A>(effect: Effect.Effect<ReadonlyArray<A>, AutomationError>) =>
  Effect.catchIf(
    effect,
    (error) => error.code === "CAPABILITY_UNSUPPORTED",
    () => Effect.succeed<ReadonlyArray<A>>([]),
  );

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const orchestrators = yield* OrchestratorService.OrchestratorService;
  const peers = yield* PeerService.PeerService;

  const query = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.mapError(effect, () =>
      automationError("INTERNAL", "Failed to read automation diagnostics."),
    );

  const journalStatus = Effect.gen(function* () {
    const [row] = yield* query(
      sql<{
        readonly head: number | null;
        readonly oldest: number | null;
        readonly retained: number;
      }>`SELECT MAX(cursor) AS head, MIN(cursor) AS oldest, COUNT(*) AS retained FROM automation_journal`,
    );
    // AUTOINCREMENT keeps the head even after pruning empties the table.
    const [sequence] = yield* query(
      sql<{
        readonly seq: number;
      }>`SELECT seq FROM sqlite_sequence WHERE name = 'automation_journal'`,
    );
    return {
      environmentId: yield* environment.getEnvironmentId,
      headCursor: Math.max(row?.head ?? 0, sequence?.seq ?? 0),
      oldestCursor: row?.oldest ?? null,
      retainedEntries: row?.retained ?? 0,
      observedAt: DateTime.formatIso(yield* DateTime.now),
    } satisfies AutomationJournalStatus;
  });

  const pendingWork = Effect.gen(function* () {
    const deliveries = yield* query(
      sql<{
        readonly status: string;
        readonly count: number;
      }>`SELECT status, COUNT(*) AS count FROM automation_hook_deliveries
         WHERE status IN ('pending', 'delivering', 'retrying', 'failed') GROUP BY status`,
    );
    const deliveryCount = (...statuses: ReadonlyArray<string>) =>
      deliveries
        .filter((row) => statuses.includes(row.status))
        .reduce((total, row) => total + row.count, 0);
    const tasks = yield* query(
      sql<{
        readonly status: string;
        readonly count: number;
      }>`SELECT status, COUNT(*) AS count FROM automation_tasks GROUP BY status`,
    );
    const taskCount = (statuses: ReadonlyArray<string>) =>
      tasks
        .filter((row) => statuses.includes(row.status))
        .reduce((total, row) => total + row.count, 0);
    const jobs = yield* query(
      sql<{
        readonly job_id: string;
        readonly node_id: string;
        readonly status: string;
      }>`SELECT job_id, node_id, status FROM automation_jobs
         WHERE status IN ${sql.in(ACTIVE_JOB_STATUSES)} ORDER BY accepted_at`,
    );
    const [outbox] = yield* query(
      sql<{
        readonly count: number;
      }>`SELECT COUNT(*) AS count FROM automation_peer_outbox WHERE status = 'pending_delivery'`,
    );
    const hosted = yield* emptyWhenUnsupported(orchestrators.list(caller));
    return {
      hookDeliveries: {
        pending: deliveryCount("pending", "delivering"),
        retrying: deliveryCount("retrying"),
        failed: deliveryCount("failed"),
      },
      orchestrators: hosted
        .filter((orchestrator) => orchestrator.effectiveState !== "not_hosted_here")
        .map((orchestrator) => ({
          orchestratorId: orchestrator.id,
          name: orchestrator.name,
          effectiveState: orchestrator.effectiveState,
          inboxPending: orchestrator.inboxPending,
          activeChildren: orchestrator.usage.activeChildren,
        })),
      activeTasks: taskCount(ACTIVE_TASK_STATUSES),
      unknownTasks: taskCount(["unknown"]),
      activeJobs: jobs.flatMap((job) =>
        isJobStatus(job.status)
          ? [
              {
                jobId: JobId.make(job.job_id),
                nodeId: ExecutionNodeId.make(job.node_id),
                status: job.status,
              },
            ]
          : [],
      ),
      peerOutboxPending: outbox?.count ?? 0,
    } satisfies AutomationPendingWork;
  });

  const read = Effect.gen(function* () {
    return {
      environmentId: yield* environment.getEnvironmentId,
      journal: yield* journalStatus,
      workers: [],
      pendingWork: yield* pendingWork,
      peers: yield* emptyWhenUnsupported(peers.list(caller)),
      observedAt: DateTime.formatIso(yield* DateTime.now),
    } satisfies AutomationDiagnostics;
  });

  return AutomationDiagnosticsService.of({ read, pendingWork });
});

export const layer = Layer.effect(AutomationDiagnosticsService, make);
