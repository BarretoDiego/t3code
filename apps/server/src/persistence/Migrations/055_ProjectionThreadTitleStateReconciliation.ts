import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  // Migration 52 was already used for a fork-only handoff migration. Add the
  // upstream title-state column under a new ID without failing databases that
  // previously received upstream's migration 52.
  if (!columns.some((column) => column.name === "title_state_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN title_state_json TEXT
    `;
  }
});
