import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE thread_handoffs (
      handoff_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 0),
      phase TEXT NOT NULL,
      record_json TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX thread_handoffs_one_pending ON thread_handoffs(thread_id)
    WHERE phase NOT IN ('completed', 'failed', 'cancelled')
  `;
  yield* sql`
    CREATE TABLE thread_handoff_heads (
      thread_id TEXT PRIMARY KEY,
      handoff_id TEXT NOT NULL REFERENCES thread_handoffs(handoff_id)
    )
  `;
});
