import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // ALTER has no IF NOT EXISTS, and this ledger can be dropped and replayed over the existing column.
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(scheduled_tasks)`;
  if (columns.some((column) => column.name === "fallback_model_selections_json")) return;
  // Lives in this ledger because the main one shares ids with upstream.
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN fallback_model_selections_json TEXT NOT NULL DEFAULT '[]'`;
});
