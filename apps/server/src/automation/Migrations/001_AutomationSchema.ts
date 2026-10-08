import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Journal: one row per public automation event. `cursor` is this
  // environment's position; (origin_environment_id, origin_cursor) identifies
  // an event forwarded from a peer so it is stored once.
  yield* sql`CREATE TABLE IF NOT EXISTS automation_journal (
    cursor INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL,
    origin_environment_id TEXT NOT NULL,
    origin_cursor INTEGER NOT NULL,
    origin_kind TEXT NOT NULL,
    project_id TEXT,
    thread_id TEXT,
    parent_thread_id TEXT,
    root_thread_id TEXT,
    orchestrator_id TEXT,
    task_id TEXT,
    node_id TEXT,
    aggregate_kind TEXT NOT NULL,
    aggregate_id TEXT NOT NULL,
    aggregate_revision INTEGER NOT NULL,
    correlation_id TEXT NOT NULL,
    causation_id TEXT,
    hops INTEGER NOT NULL,
    occurred_at TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    event_json TEXT NOT NULL
  )`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS automation_journal_origin
    ON automation_journal(origin_environment_id, origin_cursor)`;
  yield* sql`CREATE INDEX IF NOT EXISTS automation_journal_thread
    ON automation_journal(thread_id, cursor)`;
  yield* sql`CREATE INDEX IF NOT EXISTS automation_journal_type
    ON automation_journal(type, cursor)`;

  yield* sql`CREATE TABLE IF NOT EXISTS automation_aggregate_revisions (
    aggregate_kind TEXT NOT NULL,
    aggregate_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    PRIMARY KEY (aggregate_kind, aggregate_id)
  )`;

  // Results of idempotent mutations, keyed by operation scope and caller key.
  yield* sql`CREATE TABLE IF NOT EXISTS automation_idempotency (
    scope TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (scope, idempotency_key)
  )`;

  yield* sql`CREATE TABLE IF NOT EXISTS automation_consumers (
    consumer_id TEXT PRIMARY KEY NOT NULL,
    cursor INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  )`;

  yield* sql`CREATE TABLE IF NOT EXISTS automation_hooks (
    hook_id TEXT PRIMARY KEY NOT NULL,
    revision INTEGER NOT NULL,
    enabled INTEGER NOT NULL,
    priority INTEGER NOT NULL,
    cursor INTEGER NOT NULL,
    hook_json TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;

  yield* sql`CREATE TABLE IF NOT EXISTS automation_hook_deliveries (
    delivery_id TEXT PRIMARY KEY NOT NULL,
    hook_id TEXT NOT NULL,
    dedup_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    first_cursor INTEGER NOT NULL,
    last_cursor INTEGER NOT NULL,
    event_ids_json TEXT NOT NULL,
    correlation_id TEXT,
    task_id TEXT,
    attempt_count INTEGER NOT NULL,
    next_attempt_at TEXT,
    last_error TEXT,
    suppressed_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS automation_hook_deliveries_due
    ON automation_hook_deliveries(status, next_attempt_at)`;
  yield* sql`CREATE INDEX IF NOT EXISTS automation_hook_deliveries_hook
    ON automation_hook_deliveries(hook_id, created_at)`;

  yield* sql`CREATE TABLE IF NOT EXISTS automation_orchestrators (
    orchestrator_id TEXT PRIMARY KEY NOT NULL,
    revision INTEGER NOT NULL,
    name TEXT NOT NULL,
    scope TEXT NOT NULL,
    host_environment_id TEXT NOT NULL,
    host_generation INTEGER NOT NULL,
    thread_id TEXT,
    desired_state TEXT NOT NULL,
    runtime_state TEXT NOT NULL,
    state_reason TEXT,
    active_run_id TEXT,
    config_json TEXT NOT NULL,
    usage_json TEXT NOT NULL,
    last_turn_at TEXT,
    observed_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS automation_orchestrators_thread
    ON automation_orchestrators(thread_id) WHERE thread_id IS NOT NULL`;

  yield* sql`CREATE TABLE IF NOT EXISTS automation_inbox (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id TEXT NOT NULL UNIQUE,
    orchestrator_id TEXT NOT NULL,
    dedup_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    relevance TEXT NOT NULL,
    entry_json TEXT NOT NULL,
    reserved_by_run_id TEXT,
    received_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (orchestrator_id, dedup_key)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS automation_inbox_pending
    ON automation_inbox(orchestrator_id, status, sequence)`;

  yield* sql`CREATE TABLE IF NOT EXISTS automation_checkpoints (
    orchestrator_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    host_generation INTEGER NOT NULL,
    run_id TEXT,
    checkpoint_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (orchestrator_id, sequence)
  )`;

  yield* sql`CREATE TABLE IF NOT EXISTS automation_orchestrator_handoffs (
    orchestrator_id TEXT PRIMARY KEY NOT NULL,
    phase TEXT NOT NULL,
    handoff_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;

  // One owner per subject. `generation` is the fencing token.
  yield* sql`CREATE TABLE IF NOT EXISTS automation_claims (
    subject_key TEXT PRIMARY KEY NOT NULL,
    subject_json TEXT NOT NULL,
    owner_json TEXT NOT NULL,
    rule TEXT NOT NULL,
    generation INTEGER NOT NULL,
    lease_expires_at TEXT,
    claimed_at TEXT NOT NULL
  )`;

  yield* sql`CREATE TABLE IF NOT EXISTS automation_tasks (
    task_id TEXT PRIMARY KEY NOT NULL,
    revision INTEGER NOT NULL,
    origin_environment_id TEXT NOT NULL,
    execution_environment_id TEXT NOT NULL,
    orchestrator_id TEXT,
    parent_task_id TEXT,
    parent_thread_id TEXT,
    thread_id TEXT,
    status TEXT NOT NULL,
    task_json TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS automation_tasks_thread ON automation_tasks(thread_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS automation_tasks_parent_thread
    ON automation_tasks(parent_thread_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS automation_tasks_orchestrator
    ON automation_tasks(orchestrator_id, status)`;

  yield* sql`CREATE TABLE IF NOT EXISTS automation_nodes (
    node_id TEXT PRIMARY KEY NOT NULL,
    enabled INTEGER NOT NULL,
    node_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;

  yield* sql`CREATE TABLE IF NOT EXISTS automation_jobs (
    job_id TEXT PRIMARY KEY NOT NULL,
    node_id TEXT NOT NULL,
    task_id TEXT,
    status TEXT NOT NULL,
    job_json TEXT NOT NULL,
    executor_ref TEXT,
    log_path TEXT,
    accepted_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS automation_jobs_status ON automation_jobs(status)`;

  yield* sql`CREATE TABLE IF NOT EXISTS automation_peers (
    environment_id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    peer_json TEXT NOT NULL,
    inbound_cursor INTEGER NOT NULL,
    forwarded_cursor INTEGER NOT NULL,
    next_outbound_sequence INTEGER NOT NULL,
    acked_through_sequence INTEGER NOT NULL,
    received_through_sequence INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;

  yield* sql`CREATE TABLE IF NOT EXISTS automation_peer_outbox (
    message_id TEXT PRIMARY KEY NOT NULL,
    peer_environment_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    status TEXT NOT NULL,
    message_json TEXT NOT NULL,
    attempt_count INTEGER NOT NULL,
    last_error TEXT,
    rejection TEXT,
    expires_at TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE (peer_environment_id, sequence)
  )`;

  yield* sql`CREATE TABLE IF NOT EXISTS automation_peer_inbox (
    message_id TEXT PRIMARY KEY NOT NULL,
    peer_environment_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    status TEXT NOT NULL,
    message_json TEXT NOT NULL,
    error TEXT,
    received_at TEXT NOT NULL,
    processed_at TEXT,
    UNIQUE (peer_environment_id, sequence)
  )`;
});
