import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE scheduled_messages (
    command_id TEXT PRIMARY KEY NOT NULL,
    thread_id TEXT NOT NULL,
    command_json TEXT NOT NULL,
    send_at TEXT NOT NULL,
    error TEXT
  )`;
  yield* sql`CREATE INDEX scheduled_messages_thread ON scheduled_messages(thread_id)`;
});
