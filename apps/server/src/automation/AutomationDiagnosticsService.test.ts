import { EnvironmentId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as AutomationDiagnosticsService from "./AutomationDiagnosticsService.ts";
import * as OrchestratorService from "./OrchestratorService.ts";
import * as PeerService from "./PeerService.ts";

const environmentId = EnvironmentId.make("env-test");
const layer = AutomationDiagnosticsService.layer.pipe(
  // Only `list` is read here; an environment with no orchestrators or peers.
  Layer.provide(
    Layer.mock(OrchestratorService.OrchestratorService)({ list: () => Effect.succeed([]) }),
  ),
  Layer.provide(Layer.mock(PeerService.PeerService)({ list: () => Effect.succeed([]) })),
  Layer.provide(
    Layer.succeed(
      ServerEnvironment,
      ServerEnvironment.of({
        getEnvironmentId: Effect.succeed(environmentId),
        getDescriptor: Effect.die("unused"),
      }),
    ),
  ),
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

const now = "2026-01-01T00:00:00.000Z";

it.layer(layer)("AutomationDiagnosticsService", (it) => {
  it.effect("reports an empty runtime as having no work, on a freshly migrated database", () =>
    Effect.gen(function* () {
      const diagnostics = yield* AutomationDiagnosticsService.AutomationDiagnosticsService;
      const result = yield* diagnostics.read;
      assert.strictEqual(result.environmentId, environmentId);
      assert.deepStrictEqual(
        {
          head: result.journal.headCursor,
          oldest: result.journal.oldestCursor,
          retained: result.journal.retainedEntries,
        },
        { head: 0, oldest: null, retained: 0 },
      );
      assert.deepStrictEqual(result.pendingWork, {
        hookDeliveries: { pending: 0, retrying: 0, failed: 0 },
        orchestrators: [],
        activeTasks: 0,
        unknownTasks: 0,
        activeJobs: [],
        peerOutboxPending: 0,
      });
    }),
  );

  it.effect("counts only work that is still in flight", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const delivery = (id: string, status: string) => sql`
        INSERT INTO automation_hook_deliveries (
          delivery_id, hook_id, dedup_key, status, first_cursor, last_cursor, event_ids_json,
          attempt_count, created_at, updated_at
        ) VALUES (${id}, 'hook-1', ${id}, ${status}, 1, 1, '[]', 0, ${now}, ${now})`;
      const task = (id: string, status: string) => sql`
        INSERT INTO automation_tasks (
          task_id, revision, origin_environment_id, execution_environment_id, status, task_json,
          observed_at, created_at, updated_at
        ) VALUES (${id}, 1, ${environmentId}, ${environmentId}, ${status}, '{}', ${now}, ${now}, ${now})`;
      const job = (id: string, status: string) => sql`
        INSERT INTO automation_jobs (job_id, node_id, status, job_json, accepted_at, updated_at)
        VALUES (${id}, 'local', ${status}, '{}', ${now}, ${now})`;
      const outbox = (id: string, sequence: number, status: string) => sql`
        INSERT INTO automation_peer_outbox (
          message_id, peer_environment_id, sequence, status, message_json, attempt_count, updated_at
        ) VALUES (${id}, 'env-peer', ${sequence}, ${status}, '{}', 0, ${now})`;

      yield* Effect.all([
        delivery("d-pending", "pending"),
        delivery("d-delivering", "delivering"),
        delivery("d-retrying", "retrying"),
        delivery("d-failed", "failed"),
        delivery("d-delivered", "delivered"),
        delivery("d-suppressed", "suppressed"),
        task("t-running", "running"),
        task("t-blocked", "blocked"),
        task("t-pending", "pending_delivery"),
        task("t-reported", "reported"),
        task("t-validated", "validated"),
        task("t-unknown", "unknown"),
        job("j-started", "started"),
        job("j-unknown", "unknown"),
        job("j-done", "succeeded"),
        outbox("m-1", 1, "pending_delivery"),
        outbox("m-2", 2, "delivered"),
      ]);

      const diagnostics = yield* AutomationDiagnosticsService.AutomationDiagnosticsService;
      const work = yield* diagnostics.pendingWork;
      assert.deepStrictEqual(work.hookDeliveries, { pending: 2, retrying: 1, failed: 1 });
      assert.strictEqual(work.activeTasks, 3);
      assert.strictEqual(work.unknownTasks, 1);
      assert.deepStrictEqual(
        work.activeJobs.map((entry) => [entry.jobId, entry.status]),
        [
          ["j-started", "started"],
          ["j-unknown", "unknown"],
        ],
      );
      assert.strictEqual(work.peerOutboxPending, 1);
    }),
  );

  it.effect("keeps the journal head after every entry has been pruned", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO automation_journal (
          event_id, type, origin_environment_id, origin_cursor, origin_kind, aggregate_kind,
          aggregate_id, aggregate_revision, correlation_id, hops, occurred_at, recorded_at,
          event_json
        ) VALUES ('e-1', 'thread.created', ${environmentId}, 1, 'service', 'thread', 't-1', 1,
          'c-1', 0, ${now}, ${now}, '{}')`;
      yield* sql`DELETE FROM automation_journal`;
      const diagnostics = yield* AutomationDiagnosticsService.AutomationDiagnosticsService;
      const { journal } = yield* diagnostics.read;
      assert.strictEqual(journal.headCursor, 1);
      assert.strictEqual(journal.oldestCursor, null);
      assert.strictEqual(journal.retainedEntries, 0);
    }),
  );
});
