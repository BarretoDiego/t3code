import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // One row per decision turn. `command_id` and `message_id` are fixed when the
  // turn is reserved, so a restart can tell whether the dispatch ever committed
  // by looking up the command receipt instead of guessing.
  yield* sql`CREATE TABLE IF NOT EXISTS automation_orchestrator_turns (
    orchestrator_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    command_id TEXT NOT NULL UNIQUE,
    message_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    run_id TEXT,
    status TEXT NOT NULL,
    outcome TEXT,
    prompt TEXT NOT NULL,
    task_ids_json TEXT NOT NULL,
    interrupt_requested_at TEXT,
    reserved_at TEXT NOT NULL,
    dispatched_at TEXT,
    finished_at TEXT,
    PRIMARY KEY (orchestrator_id, sequence)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS automation_orchestrator_turns_status
    ON automation_orchestrator_turns(orchestrator_id, status)`;

  // Which turn reserved an inbox entry, recorded before the run id is known.
  yield* sql`CREATE TABLE IF NOT EXISTS automation_orchestrator_turn_entries (
    orchestrator_id TEXT NOT NULL,
    turn_sequence INTEGER NOT NULL,
    entry_id TEXT NOT NULL,
    PRIMARY KEY (orchestrator_id, turn_sequence, entry_id)
  )`;

  // The single admitted answer to a runtime request. The primary key is the
  // gate: a second responder cannot insert while a row exists.
  yield* sql`CREATE TABLE IF NOT EXISTS automation_request_responses (
    subject_key TEXT PRIMARY KEY NOT NULL,
    idempotency_key TEXT NOT NULL,
    command_id TEXT NOT NULL,
    responder_json TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`;
});
