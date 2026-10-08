import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  // Migration 48 diverged between the fork and upstream. Re-run this
  // idempotent check as migration 49 so either pre-merge database gains the
  // column it did not previously have.
  if (!columns.some((column) => column.name === "mini_skills_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN mini_skills_json TEXT
    `;
  }

  if (!columns.some((column) => column.name === "branch_pull_request_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN branch_pull_request_json TEXT
    `;
  }
});
