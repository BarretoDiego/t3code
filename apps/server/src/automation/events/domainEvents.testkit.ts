import {
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const providerInstanceId = ProviderInstanceId.make("codex");
const at = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");

let nextEventId = 0;
const eventId = () => EventId.make(`domain-event-${++nextEventId}`);

export const PROJECT_ID = ProjectId.make("project-1");

export const makeThread = (
  id: string,
  overrides: Partial<OrchestrationV2AppThread> = {},
): OrchestrationV2AppThread => {
  const threadId = ThreadId.make(id);
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: PROJECT_ID,
    title: `Thread ${id}`,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    ...overrides,
  };
};

export const makeChildThread = (id: string, parent: OrchestrationV2AppThread) =>
  makeThread(id, {
    lineage: {
      parentThreadId: parent.id,
      relationshipToParent: "subagent",
      rootThreadId: parent.lineage.rootThreadId,
    },
  });

export const threadEvent = (
  type: Extract<OrchestrationV2DomainEvent, { payload: OrchestrationV2AppThread }>["type"],
  thread: OrchestrationV2AppThread,
): OrchestrationV2DomainEvent => ({
  id: eventId(),
  type,
  threadId: thread.id,
  occurredAt: at,
  payload: thread,
});

export const makeRun = (
  id: string,
  thread: OrchestrationV2AppThread,
  status: OrchestrationV2Run["status"],
  ordinal = 1,
): OrchestrationV2Run => ({
  id: RunId.make(id),
  threadId: thread.id,
  ordinal,
  providerInstanceId,
  modelSelection: thread.modelSelection,
  providerThreadId: null,
  userMessageId: MessageId.make(`message-${id}`),
  rootNodeId: null,
  activeAttemptId: null,
  status,
  requestedAt: at,
  startedAt: null,
  completedAt: null,
  checkpointId: null,
  contextHandoffId: null,
});

export const runEvent = (
  type: "run.created" | "run.updated",
  run: OrchestrationV2Run,
): OrchestrationV2DomainEvent => ({
  id: eventId(),
  type,
  threadId: run.threadId,
  runId: run.id,
  occurredAt: at,
  payload: run,
});

export const makeRequest = (
  id: string,
  status: OrchestrationV2RuntimeRequest["status"],
  overrides: Partial<OrchestrationV2RuntimeRequest> = {},
): OrchestrationV2RuntimeRequest => ({
  id: RuntimeRequestId.make(id),
  nodeId: NodeId.make(`node-${id}`),
  providerTurnId: null,
  nativeRequestRef: null,
  kind: "user_input",
  status,
  responseCapability: { type: "message" },
  createdAt: at,
  resolvedAt: status === "pending" ? null : at,
  ...overrides,
});

export const requestEvent = (
  thread: OrchestrationV2AppThread,
  request: OrchestrationV2RuntimeRequest,
  runId?: string,
): OrchestrationV2DomainEvent => ({
  id: eventId(),
  type: "runtime-request.updated",
  threadId: thread.id,
  ...(runId === undefined ? {} : { runId: RunId.make(runId) }),
  occurredAt: at,
  payload: request,
});
