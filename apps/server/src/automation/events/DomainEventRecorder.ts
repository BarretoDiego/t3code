import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2RunStatus,
  OrchestrationV2RuntimeRequest,
  ProjectId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

import type { EventJournal } from "../EventJournal.ts";
import {
  JOURNAL_TOOL_CALLED_EVENTS,
  mapDomainEvents,
  mappingLookups,
  type ThreadScope,
} from "./domainEventMapping.ts";

const THREAD_SCOPE_CACHE_LIMIT = 5_000;

const JOURNALED_DOMAIN_EVENT_TYPES = new Set<OrchestrationV2DomainEvent["type"]>([
  "thread.created",
  "thread.archived",
  "thread.unarchived",
  "thread.settled",
  "thread.unsettled",
  "thread.snoozed",
  "thread.unsnoozed",
  "thread.pinned",
  "thread.unpinned",
  "thread.deleted",
  "run.created",
  "run.updated",
  "runtime-request.updated",
  // Turn items are examined only when tool calls are journaled at all.
  ...(JOURNAL_TOOL_CALLED_EVENTS ? (["turn-item.updated"] as const) : []),
]);

/**
 * Builds the step the event sink runs inside its write transaction, after the
 * events are appended and before the projections absorb them: it reads the
 * state the projections still hold, maps the events, and appends the result to
 * the journal in that same transaction.
 *
 * Streaming deltas return before any query. A batch that carries a run or
 * request snapshot costs one indexed read per kind, however many events it has.
 */
export const makeDomainEventRecorder = (
  sql: SqlClient.SqlClient,
  journal: EventJournal["Service"],
) => {
  // A thread's project and lineage never change, so they are safe to keep.
  const threadScopes = new Map<ThreadId, ThreadScope>();

  return Effect.fnUntraced(function* (events: ReadonlyArray<OrchestrationV2DomainEvent>) {
    if (!events.some((event) => JOURNALED_DOMAIN_EVENT_TYPES.has(event.type))) return;
    const lookups = mappingLookups(events);

    const runStatuses = new Map<RunId, OrchestrationV2RunStatus>();
    if (lookups.runIds.size > 0) {
      const rows = yield* sql<{
        readonly run_id: RunId;
        readonly status: OrchestrationV2RunStatus;
      }>`
        SELECT run_id, status
        FROM orchestration_v2_projection_runs
        WHERE run_id IN ${sql.in([...lookups.runIds])}
      `;
      for (const row of rows) runStatuses.set(row.run_id, row.status);
    }

    const requestStatuses = new Map<RuntimeRequestId, OrchestrationV2RuntimeRequest["status"]>();
    if (lookups.requestIds.size > 0) {
      const rows = yield* sql<{
        readonly runtime_request_id: RuntimeRequestId;
        readonly status: OrchestrationV2RuntimeRequest["status"];
      }>`
        SELECT runtime_request_id, status
        FROM orchestration_v2_projection_runtime_requests
        WHERE runtime_request_id IN ${sql.in([...lookups.requestIds])}
      `;
      for (const row of rows) requestStatuses.set(row.runtime_request_id, row.status);
    }

    const unknownThreads = [...lookups.threadIds].filter((id) => !threadScopes.has(id));
    if (unknownThreads.length > 0) {
      const rows = yield* sql<{
        readonly thread_id: ThreadId;
        readonly project_id: ProjectId;
        readonly parent_thread_id: ThreadId | null;
        readonly root_thread_id: ThreadId | null;
      }>`
        SELECT
          thread_id,
          project_id,
          json_extract(payload_json, '$.lineage.parentThreadId') AS parent_thread_id,
          json_extract(payload_json, '$.lineage.rootThreadId') AS root_thread_id
        FROM orchestration_v2_projection_threads
        WHERE thread_id IN ${sql.in(unknownThreads)}
      `;
      if (threadScopes.size + rows.length > THREAD_SCOPE_CACHE_LIMIT) threadScopes.clear();
      for (const row of rows) {
        threadScopes.set(row.thread_id, {
          projectId: row.project_id,
          parentThreadId: row.parent_thread_id,
          rootThreadId: row.root_thread_id ?? row.thread_id,
        });
      }
    }

    const mapped = mapDomainEvents(events, {
      threads: threadScopes,
      runStatuses,
      requestStatuses,
    });
    if (mapped.length > 0) yield* journal.append(mapped);
  });
};
