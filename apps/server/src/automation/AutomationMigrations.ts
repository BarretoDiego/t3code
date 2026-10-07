import * as Effect from "effect/Effect";
import * as Migrator from "effect/unstable/sql/Migrator";

import Migration0001 from "./Migrations/001_AutomationSchema.ts";

/**
 * Automation schema lives in its own ledger. The main ledger keys on the id
 * alone, so a fork migration there is masked by any later upstream migration
 * that takes the same id; a separate table has no ids to collide with.
 *
 * Reserved id ranges, so parallel work never picks the same id: events and
 * hooks 10-19, orchestrators and claims 20-29, tasks 30-39, peers, nodes and
 * jobs 40-49.
 */
export const AUTOMATION_MIGRATIONS_TABLE = "t3_automation_migrations";

export const automationMigrationEntries = [[1, "AutomationSchema", Migration0001]] as const;

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
