import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { migrationEntries, runMigrations } from "../persistence/Migrations.ts";
import {
  AUTOMATION_MIGRATIONS_TABLE,
  automationMigrationEntries,
  runAutomationMigrations,
} from "./AutomationMigrations.ts";

it.layer(SqlitePersistence.layerMemory)("automation migrations", (it) => {
  it.effect("records automation schema in its own ledger, leaving the main ledger alone", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const main = yield* sql<{ readonly id: number }>`
        SELECT MAX(migration_id) AS id FROM effect_sql_migrations`;
      assert.strictEqual(main[0]?.id, Math.max(...migrationEntries.map(([id]) => id)));

      const automation = yield* sql<{ readonly migration_id: number }>`
        SELECT migration_id FROM ${sql(AUTOMATION_MIGRATIONS_TABLE)} ORDER BY migration_id`;
      assert.deepStrictEqual(
        automation.map((row) => row.migration_id),
        automationMigrationEntries.map(([id]) => id),
      );
    }),
  );

  it.effect("is a no-op when the database is already current", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* runAutomationMigrations(), []);
      assert.deepStrictEqual(yield* runMigrations(), []);
    }),
  );

  it.effect("adds automation tables to a database that stopped before them", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // An existing install: the main ledger is complete, automation never ran.
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'automation_%'`;
      yield* Effect.forEach(tables, (table) => sql`DROP TABLE ${sql(table.name)}`);
      yield* sql`DROP TABLE ${sql(AUTOMATION_MIGRATIONS_TABLE)}`;

      const executed = yield* runMigrations();
      assert.deepStrictEqual(executed, []);
      const restored = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'automation_%'`;
      assert.strictEqual(restored.length, tables.length);
      assert.isAbove(restored.length, 10);
    }),
  );
});
