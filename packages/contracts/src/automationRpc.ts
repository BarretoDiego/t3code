import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import { EnvironmentAuthorizationError } from "./auth.ts";
import {
  AutomationDiagnostics,
  AutomationError,
  AutomationEventEmitInput,
  AutomationEventEmitResult,
  AutomationEventsReadInput,
  AutomationEventsReadResult,
  AutomationEventsStreamItem,
  AutomationEventsSubscribeInput,
  AutomationJournalStatus,
  ClaimTransferInput,
  DelegatedTask,
  DelegatedTaskId,
  EventConsumer,
  EventConsumerAckInput,
  EventConsumerId,
  ExecutionNode,
  ExecutionNodeId,
  ExecutionNodeUpsertInput,
  Hook,
  HookDelivery,
  HookDeliveryId,
  HookDeliveryStatus,
  HookId,
  HookTestResult,
  HookUpsertInput,
  IdempotencyKey,
  InboxEntry,
  InboxEntryId,
  InboxEntryStatus,
  Job,
  JobId,
  JobLogsInput,
  JobLogsResult,
  JobStatus,
  JobSubmitInput,
  Orchestrator,
  OrchestratorCheckpoint,
  OrchestratorHandoff,
  OrchestratorId,
  OrchestratorSendInput,
  OrchestratorSendResult,
  OrchestratorSetStateInput,
  OrchestratorUpsertInput,
  Peer,
  PeerAddInput,
  PeerDeliverInput,
  PeerDeliverResult,
  PeerHelloInput,
  PeerHelloResult,
  PeerOutboxEntry,
  PeerUpdateInput,
  PendingRequestSummary,
  PendingRequestsListInput,
  RequestRespondInput,
  RequestRespondResult,
  ResponsibilityClaim,
  TaskDelegateInput,
  TaskListInput,
  TaskUpdateInput,
  ThreadTreeNode,
} from "./automation.ts";
import { EnvironmentId, NonNegativeInt, PositiveInt, ThreadId } from "./baseSchemas.ts";

export const AUTOMATION_WS_METHODS = {
  eventsStatus: "automation.events.status",
  eventsRead: "automation.events.read",
  eventsSubscribe: "automation.events.subscribe",
  eventsEmit: "automation.events.emit",
  consumersList: "automation.consumers.list",
  consumersAck: "automation.consumers.ack",
  consumersDelete: "automation.consumers.delete",

  hooksList: "automation.hooks.list",
  hooksUpsert: "automation.hooks.upsert",
  hooksSetEnabled: "automation.hooks.setEnabled",
  hooksDelete: "automation.hooks.delete",
  hooksTest: "automation.hooks.test",
  hooksDeliveries: "automation.hooks.deliveries",
  hooksRedeliver: "automation.hooks.redeliver",
  hooksDismissDelivery: "automation.hooks.dismissDelivery",

  requestsList: "automation.requests.list",
  requestsRespond: "automation.requests.respond",
  claimsTransfer: "automation.claims.transfer",

  orchestratorsList: "automation.orchestrators.list",
  orchestratorsSubscribe: "automation.orchestrators.subscribe",
  orchestratorsUpsert: "automation.orchestrators.upsert",
  orchestratorsSetState: "automation.orchestrators.setState",
  orchestratorsDelete: "automation.orchestrators.delete",
  orchestratorsSend: "automation.orchestrators.send",
  orchestratorsInbox: "automation.orchestrators.inbox",
  orchestratorsResolveInbox: "automation.orchestrators.resolveInbox",
  orchestratorsCheckpoints: "automation.orchestrators.checkpoints",
  orchestratorsHandoff: "automation.orchestrators.handoff",
  orchestratorsHandoffStatus: "automation.orchestrators.handoffStatus",

  tasksDelegate: "automation.tasks.delegate",
  tasksGet: "automation.tasks.get",
  tasksList: "automation.tasks.list",
  tasksUpdate: "automation.tasks.update",
  threadTree: "automation.threads.tree",

  nodesList: "automation.nodes.list",
  nodesUpsert: "automation.nodes.upsert",
  nodesRemove: "automation.nodes.remove",
  nodesProbe: "automation.nodes.probe",
  jobsSubmit: "automation.jobs.submit",
  jobsGet: "automation.jobs.get",
  jobsList: "automation.jobs.list",
  jobsCancel: "automation.jobs.cancel",
  jobsReconcile: "automation.jobs.reconcile",
  jobsLogs: "automation.jobs.logs",
  jobsWatch: "automation.jobs.watch",

  peersList: "automation.peers.list",
  peersAdd: "automation.peers.add",
  peersUpdate: "automation.peers.update",
  peersRemove: "automation.peers.remove",
  peersOutbox: "automation.peers.outbox",
  peerHello: "automation.peer.hello",
  peerDeliver: "automation.peer.deliver",

  diagnostics: "automation.diagnostics",
} as const;

const AutomationRpcError = Schema.Union([AutomationError, EnvironmentAuthorizationError]);
const Empty = Schema.Struct({});
const Removed = Schema.Struct({ removed: Schema.Boolean });

const make = <const Tag extends string, Payload extends Schema.Top, Success extends Schema.Top>(
  tag: Tag,
  payload: Payload,
  success: Success,
) => Rpc.make(tag, { payload, success, error: AutomationRpcError });

const makeStream = <
  const Tag extends string,
  Payload extends Schema.Top,
  Success extends Schema.Top,
>(
  tag: Tag,
  payload: Payload,
  success: Success,
) => Rpc.make(tag, { payload, success, error: AutomationRpcError, stream: true });

const M = AUTOMATION_WS_METHODS;

export const HooksDeliveriesInput = Schema.Struct({
  hookId: Schema.optional(HookId),
  statuses: Schema.optional(Schema.Array(HookDeliveryStatus)),
  limit: Schema.optional(PositiveInt),
});
export type HooksDeliveriesInput = typeof HooksDeliveriesInput.Type;

export const HooksTestInput = Schema.Struct({
  hookId: HookId,
  /** Journal range to match against. Defaults to the most recent entries. */
  afterCursor: Schema.optional(NonNegativeInt),
  limit: Schema.optional(PositiveInt),
  /** Send for real. Off by default: a test is a dry run. */
  deliver: Schema.optional(Schema.Boolean),
});
export type HooksTestInput = typeof HooksTestInput.Type;

export const OrchestratorsInboxInput = Schema.Struct({
  orchestratorId: OrchestratorId,
  statuses: Schema.optional(Schema.Array(InboxEntryStatus)),
  limit: Schema.optional(PositiveInt),
});
export type OrchestratorsInboxInput = typeof OrchestratorsInboxInput.Type;

/** Settle an inbox entry by hand: dismiss it, or put an `unknown` one back in the queue. */
export const OrchestratorsResolveInboxInput = Schema.Struct({
  orchestratorId: OrchestratorId,
  entryId: InboxEntryId,
  resolution: Schema.Literals(["dismiss", "requeue"]),
});
export type OrchestratorsResolveInboxInput = typeof OrchestratorsResolveInboxInput.Type;

export const OrchestratorsHandoffInput = Schema.Struct({
  idempotencyKey: IdempotencyKey,
  orchestratorId: OrchestratorId,
  destinationEnvironmentId: EnvironmentId,
  cancel: Schema.optional(Schema.Boolean),
});
export type OrchestratorsHandoffInput = typeof OrchestratorsHandoffInput.Type;

export const JobsListInput = Schema.Struct({
  nodeId: Schema.optional(ExecutionNodeId),
  taskId: Schema.optional(DelegatedTaskId),
  statuses: Schema.optional(Schema.Array(JobStatus)),
  limit: Schema.optional(PositiveInt),
});
export type JobsListInput = typeof JobsListInput.Type;

export const PeersOutboxInput = Schema.Struct({
  environmentId: Schema.optional(EnvironmentId),
  includeDelivered: Schema.optional(Schema.Boolean),
  limit: Schema.optional(PositiveInt),
});
export type PeersOutboxInput = typeof PeersOutboxInput.Type;

export const AutomationRpcGroup = RpcGroup.make(
  make(M.eventsStatus, Empty, AutomationJournalStatus),
  make(M.eventsRead, AutomationEventsReadInput, AutomationEventsReadResult),
  makeStream(M.eventsSubscribe, AutomationEventsSubscribeInput, AutomationEventsStreamItem),
  make(M.eventsEmit, AutomationEventEmitInput, AutomationEventEmitResult),
  make(M.consumersList, Empty, Schema.Struct({ consumers: Schema.Array(EventConsumer) })),
  make(M.consumersAck, EventConsumerAckInput, EventConsumer),
  make(M.consumersDelete, Schema.Struct({ consumerId: EventConsumerId }), Removed),

  make(M.hooksList, Empty, Schema.Struct({ hooks: Schema.Array(Hook) })),
  make(M.hooksUpsert, HookUpsertInput, Hook),
  make(M.hooksSetEnabled, Schema.Struct({ hookId: HookId, enabled: Schema.Boolean }), Hook),
  make(M.hooksDelete, Schema.Struct({ hookId: HookId }), Removed),
  make(M.hooksTest, HooksTestInput, HookTestResult),
  make(
    M.hooksDeliveries,
    HooksDeliveriesInput,
    Schema.Struct({ deliveries: Schema.Array(HookDelivery) }),
  ),
  make(M.hooksRedeliver, Schema.Struct({ deliveryId: HookDeliveryId }), HookDelivery),
  make(M.hooksDismissDelivery, Schema.Struct({ deliveryId: HookDeliveryId }), HookDelivery),

  make(
    M.requestsList,
    PendingRequestsListInput,
    Schema.Struct({ requests: Schema.Array(PendingRequestSummary) }),
  ),
  make(M.requestsRespond, RequestRespondInput, RequestRespondResult),
  make(M.claimsTransfer, ClaimTransferInput, ResponsibilityClaim),

  make(M.orchestratorsList, Empty, Schema.Struct({ orchestrators: Schema.Array(Orchestrator) })),
  makeStream(
    M.orchestratorsSubscribe,
    Empty,
    Schema.Struct({ orchestrators: Schema.Array(Orchestrator) }),
  ),
  make(M.orchestratorsUpsert, OrchestratorUpsertInput, Orchestrator),
  make(M.orchestratorsSetState, OrchestratorSetStateInput, Orchestrator),
  make(M.orchestratorsDelete, Schema.Struct({ orchestratorId: OrchestratorId }), Removed),
  make(M.orchestratorsSend, OrchestratorSendInput, OrchestratorSendResult),
  make(
    M.orchestratorsInbox,
    OrchestratorsInboxInput,
    Schema.Struct({ entries: Schema.Array(InboxEntry) }),
  ),
  make(M.orchestratorsResolveInbox, OrchestratorsResolveInboxInput, InboxEntry),
  make(
    M.orchestratorsCheckpoints,
    Schema.Struct({ orchestratorId: OrchestratorId, limit: Schema.optional(PositiveInt) }),
    Schema.Struct({ checkpoints: Schema.Array(OrchestratorCheckpoint) }),
  ),
  make(M.orchestratorsHandoff, OrchestratorsHandoffInput, OrchestratorHandoff),
  make(
    M.orchestratorsHandoffStatus,
    Schema.Struct({ orchestratorId: OrchestratorId }),
    Schema.Struct({ handoff: Schema.NullOr(OrchestratorHandoff) }),
  ),

  make(
    M.tasksDelegate,
    TaskDelegateInput,
    Schema.Struct({ task: DelegatedTask, created: Schema.Boolean }),
  ),
  make(M.tasksGet, Schema.Struct({ taskId: DelegatedTaskId }), DelegatedTask),
  make(M.tasksList, TaskListInput, Schema.Struct({ tasks: Schema.Array(DelegatedTask) })),
  make(M.tasksUpdate, TaskUpdateInput, DelegatedTask),
  make(
    M.threadTree,
    Schema.Struct({ threadId: ThreadId }),
    Schema.Struct({ nodes: Schema.Array(ThreadTreeNode) }),
  ),

  make(M.nodesList, Empty, Schema.Struct({ nodes: Schema.Array(ExecutionNode) })),
  make(M.nodesUpsert, ExecutionNodeUpsertInput, ExecutionNode),
  make(M.nodesRemove, Schema.Struct({ nodeId: ExecutionNodeId }), Removed),
  make(M.nodesProbe, Schema.Struct({ nodeId: ExecutionNodeId }), ExecutionNode),
  make(M.jobsSubmit, JobSubmitInput, Schema.Struct({ job: Job, created: Schema.Boolean })),
  make(M.jobsGet, Schema.Struct({ jobId: JobId }), Job),
  make(M.jobsList, JobsListInput, Schema.Struct({ jobs: Schema.Array(Job) })),
  make(M.jobsCancel, Schema.Struct({ jobId: JobId }), Job),
  make(M.jobsReconcile, Schema.Struct({ jobId: JobId }), Job),
  make(M.jobsLogs, JobLogsInput, JobLogsResult),
  /** Emits the job on subscribe and on every status change, and ends once it is terminal. */
  makeStream(M.jobsWatch, Schema.Struct({ jobId: JobId }), Job),

  make(M.peersList, Empty, Schema.Struct({ peers: Schema.Array(Peer) })),
  make(M.peersAdd, PeerAddInput, Peer),
  make(M.peersUpdate, PeerUpdateInput, Peer),
  make(M.peersRemove, Schema.Struct({ environmentId: EnvironmentId }), Removed),
  make(M.peersOutbox, PeersOutboxInput, Schema.Struct({ entries: Schema.Array(PeerOutboxEntry) })),
  /** Called by a peer environment, never by a client. */
  make(M.peerHello, PeerHelloInput, PeerHelloResult),
  make(M.peerDeliver, PeerDeliverInput, PeerDeliverResult),

  make(M.diagnostics, Empty, AutomationDiagnostics),
);
