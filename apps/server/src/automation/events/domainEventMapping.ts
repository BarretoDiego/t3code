import type {
  AutomationEventScope,
  OrchestrationV2DomainEvent,
  OrchestrationV2RunStatus,
  OrchestrationV2RuntimeRequest,
  ProjectId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { EventJournalAppend } from "../EventJournal.ts";

/**
 * Journal a `tool.called` event for every finished command or dynamic tool
 * item. Off by default: tool calls are high-volume detail, and nothing wakes on
 * them unless a hook names the type.
 */
export const JOURNAL_TOOL_CALLED_EVENTS: boolean = false;

export interface ThreadScope {
  readonly projectId: ProjectId;
  readonly parentThreadId: ThreadId | null;
  readonly rootThreadId: ThreadId;
}

/** What the projections held before the events being mapped were applied. */
export interface DomainEventMappingContext {
  readonly threads: ReadonlyMap<ThreadId, ThreadScope>;
  /** Absent for a run that did not exist yet. */
  readonly runStatuses: ReadonlyMap<RunId, OrchestrationV2RunStatus>;
  /** Absent for a request that did not exist yet. */
  readonly requestStatuses: ReadonlyMap<RuntimeRequestId, OrchestrationV2RuntimeRequest["status"]>;
}

type OrganizedChange =
  | "settled"
  | "unsettled"
  | "snoozed"
  | "unsnoozed"
  | "pinned"
  | "unpinned"
  | "archived"
  | "unarchived";

const ORGANIZED_CHANGES: Partial<Record<OrchestrationV2DomainEvent["type"], OrganizedChange>> = {
  "thread.settled": "settled",
  "thread.unsettled": "unsettled",
  "thread.snoozed": "snoozed",
  "thread.unsnoozed": "unsnoozed",
  "thread.pinned": "pinned",
  "thread.unpinned": "unpinned",
  "thread.archived": "archived",
  "thread.unarchived": "unarchived",
};

type TurnPhase = "pending" | "started" | "completed" | "failed" | "interrupted" | "closed";

const turnPhase = (status: OrchestrationV2RunStatus): TurnPhase => {
  switch (status) {
    case "preparing":
    case "queued":
    case "starting":
      return "pending";
    case "running":
    case "waiting":
      return "started";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "interrupted":
    case "cancelled":
      return "interrupted";
    case "rolled_back":
      return "closed";
  }
};

const TURN_EVENT_TYPES = {
  started: "turn.started",
  completed: "turn.completed",
  failed: "turn.failed",
  interrupted: "turn.interrupted",
} as const;

const origin = { kind: "service" } as const;

const iso = (value: DateTime.Utc | null | undefined) =>
  value === null || value === undefined ? null : DateTime.formatIso(value);

const threadScope = (threadId: ThreadId, thread: ThreadScope | undefined): AutomationEventScope =>
  thread === undefined
    ? { threadId }
    : {
        threadId,
        projectId: thread.projectId,
        rootThreadId: thread.rootThreadId,
        ...(thread.parentThreadId === null ? {} : { parentThreadId: thread.parentThreadId }),
      };

/**
 * Turns committed V2 domain events into the public events the journal keeps.
 * Only facts something can act on are mapped: thread lifecycle and
 * organization, one event per run phase change, and requests opening and
 * closing. Snapshots that repeat a state, and message, node and turn-item
 * deltas, produce nothing.
 */
export const mapDomainEvents = (
  events: ReadonlyArray<OrchestrationV2DomainEvent>,
  context: DomainEventMappingContext,
  options: { readonly toolCalled?: boolean } = {},
): ReadonlyArray<EventJournalAppend> => {
  const threads = new Map(context.threads);
  const runStatuses = new Map(context.runStatuses);
  const requestStatuses = new Map(context.requestStatuses);
  const journalToolCalls = options.toolCalled ?? JOURNAL_TOOL_CALLED_EVENTS;
  const mapped: Array<EventJournalAppend> = [];

  for (const event of events) {
    const occurredAt = DateTime.formatIso(event.occurredAt);
    switch (event.type) {
      case "thread.created": {
        const thread = event.payload;
        const scope = {
          projectId: thread.projectId,
          parentThreadId: thread.lineage.parentThreadId,
          rootThreadId: thread.lineage.rootThreadId,
        };
        threads.set(thread.id, scope);
        mapped.push({
          type: "thread.created",
          origin,
          scope: threadScope(thread.id, scope),
          aggregate: { kind: "thread", id: thread.id },
          occurredAt,
          payload: {
            title: thread.title,
            createdBy: thread.createdBy,
            creationSource: thread.creationSource,
            relationshipToParent: thread.lineage.relationshipToParent,
          },
        });
        break;
      }
      case "thread.archived":
      case "thread.unarchived":
      case "thread.settled":
      case "thread.unsettled":
      case "thread.snoozed":
      case "thread.unsnoozed":
      case "thread.pinned":
      case "thread.unpinned":
      case "thread.deleted": {
        const thread = event.payload;
        const scope = threadScope(thread.id, {
          projectId: thread.projectId,
          parentThreadId: thread.lineage.parentThreadId,
          rootThreadId: thread.lineage.rootThreadId,
        });
        const change = ORGANIZED_CHANGES[event.type];
        mapped.push(
          change === undefined
            ? {
                type: "thread.deleted",
                origin,
                scope,
                aggregate: { kind: "thread", id: thread.id },
                occurredAt,
                payload: { title: thread.title },
              }
            : {
                type: "thread.organized",
                origin,
                scope,
                aggregate: { kind: "thread", id: thread.id },
                occurredAt,
                payload: {
                  change,
                  settled: thread.settledAt !== null || thread.settledOverride === "settled",
                  snoozedUntil: iso(thread.snoozedUntil),
                  pinned: (thread.pinnedAt ?? null) !== null,
                  archived: thread.archivedAt !== null,
                },
              },
        );
        break;
      }
      case "run.created":
      case "run.updated": {
        const run = event.payload;
        const previousStatus = runStatuses.get(run.id);
        runStatuses.set(run.id, run.status);
        const phase = turnPhase(run.status);
        if (phase === "pending" || phase === "closed") break;
        if (previousStatus !== undefined && turnPhase(previousStatus) === phase) break;
        mapped.push({
          type: TURN_EVENT_TYPES[phase],
          origin,
          scope: { ...threadScope(run.threadId, threads.get(run.threadId)), runId: run.id },
          aggregate: { kind: "thread", id: run.threadId },
          occurredAt,
          payload: {
            status: run.status,
            previousStatus: previousStatus ?? null,
            ordinal: run.ordinal,
            startedAt: iso(run.startedAt),
            completedAt: iso(run.completedAt),
          },
        });
        break;
      }
      case "runtime-request.updated": {
        const request = event.payload;
        const previousStatus = requestStatuses.get(request.id);
        requestStatuses.set(request.id, request.status);
        if (previousStatus === request.status) break;
        // A request first seen already closed still reports its resolution; one
        // that closed earlier and is merely restated does not.
        if (previousStatus !== undefined && previousStatus !== "pending") break;
        const opened = request.status === "pending";
        mapped.push({
          type: opened ? "request.opened" : "request.resolved",
          origin,
          scope: {
            ...threadScope(event.threadId, threads.get(event.threadId)),
            requestId: request.id,
            ...(event.runId === undefined ? {} : { runId: event.runId }),
          },
          aggregate: { kind: "request", id: request.id },
          occurredAt,
          payload: {
            kind: request.kind,
            status: request.status,
            responseCapability: request.responseCapability.type,
            ...(opened
              ? {}
              : {
                  resolvedAt: iso(request.resolvedAt),
                  // What settled it, when the event says: the decision taken, or
                  // that answers were given. The answers themselves stay out.
                  decision: request.decision ?? null,
                  answered: request.answers !== undefined,
                }),
          },
        });
        break;
      }
      case "turn-item.updated": {
        const item = event.payload;
        if (!journalToolCalls) break;
        if (item.type !== "command_execution" && item.type !== "dynamic_tool") break;
        if (item.status !== "completed" && item.status !== "failed") break;
        mapped.push({
          type: "tool.called",
          origin: { kind: "provider" },
          scope: {
            ...threadScope(item.threadId, threads.get(item.threadId)),
            ...(item.runId === null ? {} : { runId: item.runId }),
          },
          aggregate: { kind: "thread", id: item.threadId },
          occurredAt,
          payload: { itemId: item.id, tool: item.type, title: item.title, status: item.status },
          // Items are restated as they stream; the key keeps one event per item.
          dedupKey: `tool.called:${item.id}`,
        });
        break;
      }
      default:
        break;
    }
  }
  return mapped;
};

/** Ids whose earlier state the mapping needs, so the caller can load them in one query each. */
export const mappingLookups = (events: ReadonlyArray<OrchestrationV2DomainEvent>) => {
  const threadIds = new Set<ThreadId>();
  const runIds = new Set<RunId>();
  const requestIds = new Set<RuntimeRequestId>();
  for (const event of events) {
    switch (event.type) {
      case "run.created":
      case "run.updated":
        runIds.add(event.payload.id);
        threadIds.add(event.payload.threadId);
        break;
      case "runtime-request.updated":
        requestIds.add(event.payload.id);
        threadIds.add(event.threadId);
        break;
      default:
        break;
    }
  }
  return { threadIds, runIds, requestIds };
};
