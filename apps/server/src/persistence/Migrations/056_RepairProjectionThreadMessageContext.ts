import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_messages)
  `;

  // Repair migration histories that say message context was applied while the
  // physical table is still missing the column. Keep it additive and retry-safe.
  if (!columns.some((column) => column.name === "context_json")) {
    yield* sql`
      ALTER TABLE projection_thread_messages
      ADD COLUMN context_json TEXT
    `;
  }
});
