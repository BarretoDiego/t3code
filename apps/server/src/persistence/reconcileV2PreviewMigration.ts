import * as Effect from "effect/Effect";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Upstream's published V2 previews recorded `OrchestrationV2` as migration 53,
// then 54, and upstream main renumbers those ledgers to its own 53–56. This
// build keeps the fork's durable history for 49–60 (different migrations under
// the same ids) and records V2 as 61, so renumbering a preview ledger into
// upstream's ids would collide with fork migrations and replay V2 at 61.
// Refuse such databases before any migration runs instead of corrupting them.
// Fork databases never recorded `OrchestrationV2` under 53/54, so this check
// is a no-op for them.
export const reconcileV2PreviewMigration = Effect.fn("reconcileV2PreviewMigration")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
  if (tables.length === 0) return [] as Array<readonly [number, string]>;
  const legacy = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations
    WHERE name = 'OrchestrationV2' AND migration_id IN (53, 54, 55)
  `;
  if (legacy.length === 0) return [] as Array<readonly [number, string]>;
  return yield* new Migrator.MigrationError({
    kind: "BadState",
    message:
      "This database was migrated by an upstream T3 Code V2 build whose migration ids conflict with this build's history; it cannot be upgraded in place.",
  });
});
