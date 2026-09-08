# Jobs, reconciliation, and events

Every submission creates a durable `GenerationJob` before the adapter accepts
work. Jobs survive client reloads, reconnects, view changes, and server restarts
in the `compute_jobs` table.

On discovery refresh the server asks each adapter to reconcile the local jobs
for that provider. Valid updates advance the local record and emit the
corresponding lifecycle event. Updates cannot change job identity or destination,
regress progress/phases, or overwrite terminal state. Job and artifact records
commit in one transaction before notifications. If a provider is unavailable, history remains
available and no job is silently removed.

The event stream includes provider connection, capability/resource changes, job
creation/start/progress/completion/failure/cancellation, and artifact creation.
Subscribers should treat jobs as authoritative state and events as incremental
notifications; a reconnect can always recover through `compute.list` and
`compute.listJobs`.

Notifications use a bounded sliding buffer (256), not a durable event log.
Slow consumers must resynchronize. Snapshots contain the latest 100 jobs;
`compute.listJobs` supports a stable `before: {createdAt, id}` cursor and a
`limit` of 1–500 (default 100). Pending-job reconciliation is independent of
history pagination. Admission is capped at 500 unfinished jobs per environment.

The server refreshes all configured providers every five seconds without needing
a connected client. Discovery/reconciliation and cancellation calls have
10-second deadlines; submission has a 30-second deadline. A failed or timed-out
submission acknowledgement reports `submission-uncertain` with the durable
`jobId`. It does not prove remote rejection: never automatically resubmit paid
work. Recovery depends on the adapter's read-only lookup support.
