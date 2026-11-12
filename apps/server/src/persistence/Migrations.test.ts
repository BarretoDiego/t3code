import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, ORCHESTRATION_V2_MIGRATION_ID, runMigrations } from "./Migrations.ts";

// The fork records V2 at 61 (upstream: 55); 60 is the last pre-V2 migration.
const V2 = ORCHESTRATION_V2_MIGRATION_ID;
const PRE_V2 = V2 - 1;

const v2Migrations = migrationManifest.filter(([id]) => id >= V2);
const newerMigrationId = Math.max(...migrationManifest.map(([id]) => id)) + 1;

const history = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  return rows.map((row) => [row.migration_id, row.name] as const);
});

const v2TableCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'orchestration_v2_%'
  `;
  return rows.length;
});

describe("runMigrations", () => {
  it.effect("upgrades the published fork ledger without renumbering existing migrations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 71 });
      const before = yield* history;
      assert.deepStrictEqual(yield* runMigrations(), [
        [72, "CodexUsageNativeTurnIndex"],
        [73, "RepairClientSettlementTimestamps"],
        [74, "WebhookDedupe"],
        [75, "ShellStopRequestIndex"],
        [76, "ThreadMessageSearch"],
        [77, "PeerLinks"],
        [78, "PeerLinkFence"],
        [79, "WaitingLinkRequestIndex"],
        [80, "ActiveTurnItemIndexes"],
        [81, "ExcludeAttachmentPlaceholdersFromSearch"],
        [82, "SubagentDeliveryState"],
        [83, "ProjectionProjectsPinArchive"],
        [84, "RepairBooleanSettledOverride"],
        [85, "DropOrchestrationEventCorrelationIndex"],
        [86, "DelegatedRecoveryIndexes"],
        [87, "ScheduledTaskThreadMode"],
        [88, "ProjectionMessageSearchText"],
        [89, "TurnItemConversationIndex"],
        [90, "CommandReadIndexes"],
        [91, "LastExecutedRunIndex"],
        [92, "TurnItemCounts"],
      ]);
      assert.deepStrictEqual((yield* history).slice(0, before.length), before);
      assert.deepStrictEqual(yield* runMigrations(), []);
      const indexes =
        yield* sql`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'orchestration_v2_provider_turns_codex_native_id_idx'`;
      assert.strictEqual(indexes.length, 1);
      const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(scheduled_tasks)`;
      assert.isTrue(columns.some((column) => column.name === "last_run_webhook_delivery_id"));
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses to start when another migration took a V2 id", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: PRE_V2 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${V2}, 'FutureMainMigration')
      `;
      const before = yield* history;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: PRE_V2 }), []);
      const exit = yield* Effect.exit(runMigrations());

      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(exit), `${V2}_OrchestrationV2 (recorded: FutureMainMigration)`);
      assert.deepStrictEqual(yield* history, before);
      assert.strictEqual(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses to start when a later id would skip V2 migrations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: PRE_V2 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${newerMigrationId}, 'FutureMainMigration')
      `;
      const before = yield* history;

      const exit = yield* Effect.exit(runMigrations());

      assert.isTrue(Exit.isFailure(exit));
      for (const [id, name] of v2Migrations) {
        assert.include(String(exit), `${id}_${name} (recorded: nothing)`);
      }
      assert.deepStrictEqual(yield* history, before);
      assert.strictEqual(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("upgrades a database at the last pre-V2 migration", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: PRE_V2 });
      assert.deepStrictEqual(yield* runMigrations(), v2Migrations);
      assert.deepStrictEqual(yield* history, migrationManifest);
      assert.isAbove(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("drops the unused correlation index and keeps correlation values", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: PRE_V2 });
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
        )
        VALUES (
          'event-1', 'thread', 'thread-1', 0, 'thread.created', '2026-01-01T00:00:00.000Z',
          'command-1', NULL, 'correlation-1', 'client', '{}', '{}'
        )
      `;

      yield* runMigrations();

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND tbl_name = 'orchestration_events' AND sql IS NOT NULL
      `;
      const indexNames = indexes.map((row) => row.name);
      assert.notInclude(indexNames, "idx_orch_events_correlation_id");
      for (const kept of [
        "idx_orch_events_stream_version",
        "idx_orch_events_stream_sequence",
        "idx_orch_events_command_id",
        "idx_orchestration_events_agent_stream_sequence",
      ]) {
        assert.include(indexNames, kept);
      }
      const events = yield* sql<{ readonly correlation_id: string | null }>`
        SELECT correlation_id FROM orchestration_events WHERE event_id = 'event-1'
      `;
      assert.deepStrictEqual(events, [{ correlation_id: "correlation-1" }]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([30, PRE_V2])("still starts with a site-local migration at id %s", (id) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: PRE_V2 });
      yield* sql`
        UPDATE effect_sql_migrations SET name = 'SiteLocalMigration' WHERE migration_id = ${id}
      `;

      assert.deepStrictEqual(yield* runMigrations(), v2Migrations);
      assert.isAbove(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("only checks V2 migrations within the requested limit", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: V2 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${V2 + 1}, 'SiteLocalMigration'), (${newerMigrationId}, 'NewerV2Migration')
      `;
      const before = yield* history;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: V2 }), []);
      const exit = yield* Effect.exit(runMigrations({ toMigrationInclusive: V2 + 1 }));
      assert.isTrue(Exit.isFailure(exit));
      assert.include(
        String(exit),
        `${V2 + 1}_RemoveRedundantProjectionIndexes (recorded: SiteLocalMigration)`,
      );
      assert.notInclude(String(exit), `${V2 + 2}_ScheduledMessagesOrchestrationV2`);
      assert.deepStrictEqual(yield* history, before);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("keeps the migrations that finished before a later one failed", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 88 });
      yield* sql`CREATE TABLE orchestration_v2_projection_turn_item_counts (thread_id TEXT)`;

      const exit = yield* Effect.exit(runMigrations());

      assert.isTrue(Exit.isFailure(exit));
      assert.deepStrictEqual(
        yield* history,
        migrationManifest.filter(([id]) => id <= 91),
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("reapplies peer link migrations whose ledger rows are missing", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 79 });
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id BETWEEN 77 AND 79`;

      assert.deepStrictEqual(
        yield* runMigrations(),
        migrationManifest.filter(([id]) => id >= 77),
      );
      assert.deepStrictEqual(yield* history, migrationManifest);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("still starts after a newer build recorded a later V2 migration", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${newerMigrationId}, 'NewerV2Migration')
      `;

      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});

// The fork registers upstream files under its own ids and names, so compare the directory to the
// imports in Migrations.ts rather than to the manifest's upstream numbering.
it.effect("registers every migration file", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.join(import.meta.dirname, "Migrations");
    const source = yield* fs.readFileString(path.join(import.meta.dirname, "Migrations.ts"));
    const files = (yield* fs.readDirectory(dir)).flatMap((name) =>
      /^\d+_\w+\.ts$/.test(name) ? [name] : [],
    );
    const imports = [...source.matchAll(/"\.\/Migrations\/(\d+_\w+\.ts)"/g)].flatMap((match) =>
      match[1] === undefined ? [] : [match[1]],
    );
    assert.deepStrictEqual(files.toSorted(), imports.toSorted());
  }).pipe(Effect.provide(NodeServices.layer)),
);
