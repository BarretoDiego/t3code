import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS compute_jobs (
      job_id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      thread_id TEXT,
      project_id TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      job_json TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_compute_jobs_provider_status
    ON compute_jobs(provider_id, status, created_at)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_compute_jobs_thread_created
    ON compute_jobs(thread_id, created_at)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS compute_artifacts (
      artifact_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      parent_artifact_ids_json TEXT NOT NULL,
      artifact_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(job_id) REFERENCES compute_jobs(job_id)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_compute_artifacts_job_id
    ON compute_artifacts(job_id)
  `;
});
