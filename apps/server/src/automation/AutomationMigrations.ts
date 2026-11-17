import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import Migration0001 from "./Migrations/001_AutomationSchema.ts";
import Migration0010 from "./Migrations/010_JournalDedup.ts";
import Migration0020 from "./Migrations/020_OrchestratorRuntime.ts";
import Migration0030 from "./Migrations/030_ScheduledTaskFallbackModels.ts";

/**
 * Automation schema lives in its own ledger. The main ledger keys on id alone, so a fork migration there is masked by any later upstream migration with the same id.
 * The migrator skips every id at or below the highest one recorded, so a new migration always takes an id above the current maximum.
 */
export const AUTOMATION_MIGRATIONS_TABLE = "t3_automation_migrations";

export const automationMigrationEntries = [
  [1, "AutomationSchema", Migration0001],
  [10, "JournalDedup", Migration0010],
  [20, "OrchestratorRuntime", Migration0020],
  [30, "ScheduledTaskFallbackModels", Migration0030],
] as const;

const run = Migrator.make({});

const latestAutomationMigrationId = Math.max(...automationMigrationEntries.map(([id]) => id));

// The migrator writes even when nothing is pending; CLI startup must not take the write lock for a no-op.
const automationMigrationsPending = Effect.fn("automationMigrationsPending")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${AUTOMATION_MIGRATIONS_TABLE}
  `;
  if (tables.length === 0) return true;
  const [row] = yield* sql<{ readonly latestId: number | null }>`
    SELECT MAX(migration_id) AS latestId FROM ${sql(AUTOMATION_MIGRATIONS_TABLE)}
  `;
  return (row?.latestId ?? 0) < latestAutomationMigrationId;
});

export const runAutomationMigrations = Effect.fn("runAutomationMigrations")(function* () {
  if (!(yield* automationMigrationsPending())) return [];
  const executed = yield* run({
    table: AUTOMATION_MIGRATIONS_TABLE,
    loader: Migrator.fromRecord(
      Object.fromEntries(
        automationMigrationEntries.map(([id, name, migration]) => [`${id}_${name}`, migration]),
      ),
    ),
  });
  if (executed.length > 0) {
    yield* Effect.log("Automation migrations ran successfully").pipe(
      Effect.annotateLogs({ migrations: executed.map(([id, name]) => `${id}_${name}`) }),
    );
  }
  return executed;
});
