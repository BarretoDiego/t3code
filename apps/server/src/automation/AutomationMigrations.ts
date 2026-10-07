import * as Effect from "effect/Effect";
import * as Migrator from "effect/unstable/sql/Migrator";

import Migration0001 from "./Migrations/001_AutomationSchema.ts";
import Migration0010 from "./Migrations/010_JournalDedup.ts";
import Migration0020 from "./Migrations/020_OrchestratorRuntime.ts";

/**
 * Automation schema lives in its own ledger. The main ledger keys on the id
 * alone, so a fork migration there is masked by any later upstream migration
 * that takes the same id; a separate table has no ids to collide with.
 *
 * The migrator skips every id at or below the highest one recorded, so a new
 * migration always takes an id above the current maximum, whatever it is about.
 */
export const AUTOMATION_MIGRATIONS_TABLE = "t3_automation_migrations";

export const automationMigrationEntries = [
  [1, "AutomationSchema", Migration0001],
  [10, "JournalDedup", Migration0010],
  [20, "OrchestratorRuntime", Migration0020],
] as const;

const run = Migrator.make({});

export const runAutomationMigrations = Effect.fn("runAutomationMigrations")(function* () {
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
