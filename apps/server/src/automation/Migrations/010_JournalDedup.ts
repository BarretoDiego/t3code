import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A stable key a producer attaches to an event so appending it again returns
  // the first entry. Rows are removed together with the journal entry they name.
  yield* sql`CREATE TABLE IF NOT EXISTS automation_journal_dedup (
    dedup_key TEXT PRIMARY KEY NOT NULL,
    cursor INTEGER NOT NULL
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS automation_journal_dedup_cursor
    ON automation_journal_dedup(cursor)`;

  // Per-hook lookups the matcher runs for loop protection and backpressure.
  yield* sql`CREATE INDEX IF NOT EXISTS automation_hook_deliveries_hook_status
    ON automation_hook_deliveries(hook_id, status)`;
  yield* sql`CREATE INDEX IF NOT EXISTS automation_hook_deliveries_correlation
    ON automation_hook_deliveries(hook_id, correlation_id, created_at)`;
  yield* sql`CREATE INDEX IF NOT EXISTS automation_hook_deliveries_task
    ON automation_hook_deliveries(hook_id, task_id)`;
});
