import * as Schema from "effect/Schema";

import {
  CommandId,
  EnvironmentId,
  EventId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { OrchestrationV2ThreadLaunchWorkspaceStrategy } from "./orchestrationV2.ts";
import {
  ProviderApprovalDecision,
  ProviderInteractionMode,
  RuntimeMode,
} from "./providerPolicy.ts";

/**
 * Contracts for durable automation: the event journal, hook subscriptions,
 * persistent orchestrators, delegated tasks, execution nodes and jobs, and
 * peer federation between environments.
 *
 * Four dimensions stay separate throughout: how a thread is organized
 * (settled, snoozed, archived), what its provider is doing (run status), what
 * needs attention (runtime requests), and the state of a delegated task. None
 * of them implies another.
 */

export const AUTOMATION_CONTRACT_VERSION = 1;

const makeId = <Brand extends string>(brand: Brand) =>
  TrimmedNonEmptyString.check(Schema.isMaxLength(200)).pipe(Schema.brand(brand));

export const HookId = makeId("HookId");
export type HookId = typeof HookId.Type;
export const HookDeliveryId = makeId("HookDeliveryId");
export type HookDeliveryId = typeof HookDeliveryId.Type;
export const EventConsumerId = makeId("EventConsumerId");
export type EventConsumerId = typeof EventConsumerId.Type;
export const OrchestratorId = makeId("OrchestratorId");
export type OrchestratorId = typeof OrchestratorId.Type;
export const DelegatedTaskId = makeId("DelegatedTaskId");
export type DelegatedTaskId = typeof DelegatedTaskId.Type;
/** A machine that executes jobs for an environment. Distinct from the run-graph `NodeId`. */
export const ExecutionNodeId = makeId("ExecutionNodeId");
export type ExecutionNodeId = typeof ExecutionNodeId.Type;
export const JobId = makeId("JobId");
export type JobId = typeof JobId.Type;
export const InboxEntryId = makeId("InboxEntryId");
export type InboxEntryId = typeof InboxEntryId.Type;
export const PeerMessageId = makeId("PeerMessageId");
export type PeerMessageId = typeof PeerMessageId.Type;
/** Caller-chosen key. Repeating a mutation with the same key returns the first result. */
export const IdempotencyKey = makeId("IdempotencyKey");
export type IdempotencyKey = typeof IdempotencyKey.Type;

const JsonRecord = Schema.Record(Schema.String, Schema.Json);

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Stable codes. The CLI prints them as `error.code` in `--json` mode. */
export const AutomationErrorCode = Schema.Literals([
  "NOT_FOUND",
  "INVALID_INPUT",
  "CONFLICT",
  "REVISION_MISMATCH",
  "PERMISSION_DENIED",
  "REQUEST_ALREADY_RESOLVED",
  "REQUEST_EXPIRED",
  "NOT_OWNER",
  "ENVIRONMENT_UNAVAILABLE",
  "NODE_UNAVAILABLE",
  "CAPABILITY_UNSUPPORTED",
  "VERSION_INCOMPATIBLE",
  "CURSOR_EXPIRED",
  "BACKPRESSURE",
  "BUDGET_EXCEEDED",
  "PAUSED",
  "RESULT_UNKNOWN",
  "INTERNAL",
]);
export type AutomationErrorCode = typeof AutomationErrorCode.Type;

export class AutomationError extends Schema.TaggedError<AutomationError>()("AutomationError", {
  code: AutomationErrorCode,
  message: Schema.String,
  /** Structured, secret-free context such as ids, the current revision, or the oldest cursor. */
  detail: Schema.optional(JsonRecord),
}) {}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Event types the server produces itself. `privileged` types state facts only
 * the executor can know; `events.emit` can never publish them.
 */
export const AUTOMATION_EVENT_TYPES = [
  "thread.created",
  "thread.organized",
  "thread.deleted",
  "turn.started",
  "turn.completed",
  "turn.failed",
  "turn.interrupted",
  "request.opened",
  "request.resolved",
  "task.delegated",
  "task.accepted",
  "task.progress",
  "task.blocked",
  "task.reported",
  "task.validated",
  "task.failed",
  "task.cancelled",
  "task.unknown",
  "artifact.produced",
  "job.accepted",
  "job.started",
  "job.finished",
  "job.cancelled",
  "job.unknown",
  "node.availability",
  "peer.availability",
  "peer.message.received",
  "orchestrator.changed",
  "orchestrator.message.received",
  "orchestrator.turn.finished",
  "claim.changed",
  "hook.changed",
  "hook.delivery.failed",
  "tool.called",
] as const;
export const AutomationCoreEventType = Schema.Literals(AUTOMATION_EVENT_TYPES);
export type AutomationCoreEventType = typeof AutomationCoreEventType.Type;

export const CUSTOM_EVENT_TYPE_PATTERN = /^custom\.[a-z][a-z0-9-]{0,39}\.[a-z][a-z0-9._-]{0,79}$/;
/** `custom.<namespace>.<name>`: the only shape an authorized process may publish. */
export const AutomationCustomEventType = Schema.String.check(
  Schema.isPattern(CUSTOM_EVENT_TYPE_PATTERN),
);
export const AutomationEventType = Schema.Union([
  AutomationCoreEventType,
  AutomationCustomEventType,
]);
export type AutomationEventType = typeof AutomationEventType.Type;

/**
 * Types that never wake an orchestrator on their own and never match a hook
 * unless it names them: administrative changes and an orchestrator's own turn.
 */
export const AUTOMATION_ADMINISTRATIVE_EVENT_TYPES: ReadonlyArray<AutomationCoreEventType> = [
  "orchestrator.changed",
  "orchestrator.turn.finished",
  "claim.changed",
  "hook.changed",
  "hook.delivery.failed",
  "tool.called",
];

export const AutomationEventOrigin = Schema.Struct({
  /** Environment whose journal first recorded the event. Assigned by the server. */
  environmentId: EnvironmentId,
  kind: Schema.Literals(["service", "provider", "user", "agent", "timer", "peer", "custom"]),
  /** Authenticated session subject, orchestrator id, or peer environment id. */
  actorId: Schema.optional(TrimmedNonEmptyString),
  nodeId: Schema.optional(ExecutionNodeId),
});
export type AutomationEventOrigin = typeof AutomationEventOrigin.Type;

/** Ids an event is about. Hook filters match on these, never on payload contents. */
export const AutomationEventScope = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  threadId: Schema.optional(ThreadId),
  parentThreadId: Schema.optional(ThreadId),
  rootThreadId: Schema.optional(ThreadId),
  orchestratorId: Schema.optional(OrchestratorId),
  taskId: Schema.optional(DelegatedTaskId),
  runId: Schema.optional(RunId),
  requestId: Schema.optional(RuntimeRequestId),
  jobId: Schema.optional(JobId),
  nodeId: Schema.optional(ExecutionNodeId),
});
export type AutomationEventScope = typeof AutomationEventScope.Type;

export const AutomationReference = Schema.Struct({
  kind: Schema.Literals(["thread", "message", "log", "artifact", "commit", "patch", "url", "file"]),
  ref: TrimmedNonEmptyString,
  label: Schema.optional(TrimmedNonEmptyString),
});
export type AutomationReference = typeof AutomationReference.Type;

export const AUTOMATION_EVENT_MAX_PAYLOAD_BYTES = 32 * 1024;
export const AUTOMATION_EVENT_MAX_HOPS = 8;

export const AutomationEvent = Schema.Struct({
  version: Schema.Literal(AUTOMATION_CONTRACT_VERSION),
  eventId: EventId,
  type: AutomationEventType,
  origin: AutomationEventOrigin,
  /** Position in the origin environment's journal. Orders events of one origin only. */
  originCursor: PositiveInt,
  scope: AutomationEventScope,
  aggregate: Schema.Struct({
    kind: Schema.Literals([
      "thread",
      "request",
      "task",
      "job",
      "node",
      "peer",
      "orchestrator",
      "hook",
      "custom",
    ]),
    id: TrimmedNonEmptyString,
    /** Monotonic per aggregate. Use this, not timestamps, to detect a stale view. */
    revision: NonNegativeInt,
  }),
  occurredAt: IsoDateTime,
  recordedAt: IsoDateTime,
  correlationId: TrimmedNonEmptyString,
  causationId: Schema.NullOr(EventId),
  /** Incremented each time an automated reaction to this chain publishes another event. */
  hops: NonNegativeInt,
  payload: JsonRecord,
  refs: Schema.optional(Schema.Array(AutomationReference)),
});
export type AutomationEvent = typeof AutomationEvent.Type;

/** A journal row as a consumer sees it: `cursor` is the local journal position. */
export const AutomationJournalEntry = Schema.Struct({
  cursor: PositiveInt,
  event: AutomationEvent,
});
export type AutomationJournalEntry = typeof AutomationJournalEntry.Type;

export const AutomationEventFilter = Schema.Struct({
  /** Exact types, or a prefix ending in `.*` such as `task.*`. Empty or absent matches every non-administrative type. */
  types: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  originEnvironmentIds: Schema.optional(Schema.Array(EnvironmentId)),
  nodeIds: Schema.optional(Schema.Array(ExecutionNodeId)),
  projectIds: Schema.optional(Schema.Array(ProjectId)),
  threadIds: Schema.optional(Schema.Array(ThreadId)),
  /** Matches events whose thread is a direct child of one of these. */
  parentThreadIds: Schema.optional(Schema.Array(ThreadId)),
  /** Matches events anywhere in the lineage rooted at one of these. */
  rootThreadIds: Schema.optional(Schema.Array(ThreadId)),
  orchestratorIds: Schema.optional(Schema.Array(OrchestratorId)),
  taskIds: Schema.optional(Schema.Array(DelegatedTaskId)),
});
export type AutomationEventFilter = typeof AutomationEventFilter.Type;

export const AutomationEventsReadInput = Schema.Struct({
  /** Exclusive. Omit to start at the oldest retained entry. */
  afterCursor: Schema.optional(NonNegativeInt),
  filter: Schema.optional(AutomationEventFilter),
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(1000))),
});
export type AutomationEventsReadInput = typeof AutomationEventsReadInput.Type;

export const AutomationJournalStatus = Schema.Struct({
  environmentId: EnvironmentId,
  /** Cursor of the newest entry, 0 when the journal is empty. */
  headCursor: NonNegativeInt,
  /** Cursor of the oldest retained entry, or null when empty. A cursor below `oldestCursor - 1` has expired. */
  oldestCursor: Schema.NullOr(PositiveInt),
  retainedEntries: NonNegativeInt,
  observedAt: IsoDateTime,
});
export type AutomationJournalStatus = typeof AutomationJournalStatus.Type;

export const AutomationEventsReadResult = Schema.Struct({
  entries: Schema.Array(AutomationJournalEntry),
  /** Pass as `afterCursor` to continue. Advances past filtered-out entries too. */
  nextCursor: NonNegativeInt,
  status: AutomationJournalStatus,
});
export type AutomationEventsReadResult = typeof AutomationEventsReadResult.Type;

export const AutomationEventsSubscribeInput = Schema.Struct({
  /** Exclusive replay start. Omit to receive only events recorded after subscribing. */
  afterCursor: Schema.optional(NonNegativeInt),
  filter: Schema.optional(AutomationEventFilter),
  /** Named durable consumer: resumes from its stored cursor when `afterCursor` is omitted. */
  consumerId: Schema.optional(EventConsumerId),
});
export type AutomationEventsSubscribeInput = typeof AutomationEventsSubscribeInput.Type;

export const AutomationEventsStreamItem = Schema.Union([
  Schema.Struct({ type: Schema.Literal("entry"), entry: AutomationJournalEntry }),
  /** Replay reached the head; everything after this is live. */
  Schema.Struct({ type: Schema.Literal("live"), cursor: NonNegativeInt }),
]);
export type AutomationEventsStreamItem = typeof AutomationEventsStreamItem.Type;

export const AutomationEventEmitInput = Schema.Struct({
  idempotencyKey: IdempotencyKey,
  type: AutomationCustomEventType,
  scope: Schema.optional(AutomationEventScope),
  nodeId: Schema.optional(ExecutionNodeId),
  correlationId: Schema.optional(TrimmedNonEmptyString),
  causationId: Schema.optional(EventId),
  payload: Schema.optional(JsonRecord),
  refs: Schema.optional(Schema.Array(AutomationReference)),
  /** `global` also forwards the event to peers whose permissions allow it. */
  destination: Schema.optional(Schema.Literals(["local", "global"])),
});
export type AutomationEventEmitInput = typeof AutomationEventEmitInput.Type;

export const AutomationEventEmitResult = Schema.Struct({
  entry: AutomationJournalEntry,
  /** False when the idempotency key matched an event recorded earlier. */
  created: Schema.Boolean,
});
export type AutomationEventEmitResult = typeof AutomationEventEmitResult.Type;

export const EventConsumerAckInput = Schema.Struct({
  consumerId: EventConsumerId,
  cursor: NonNegativeInt,
});
export type EventConsumerAckInput = typeof EventConsumerAckInput.Type;

export const EventConsumer = Schema.Struct({
  consumerId: EventConsumerId,
  cursor: NonNegativeInt,
  updatedAt: IsoDateTime,
});
export type EventConsumer = typeof EventConsumer.Type;

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export const HookRetryPolicy = Schema.Struct({
  maxAttempts: PositiveInt.check(Schema.isLessThanOrEqualTo(20)),
  initialDelayMs: PositiveInt,
  maxDelayMs: PositiveInt,
});
export type HookRetryPolicy = typeof HookRetryPolicy.Type;

export const DEFAULT_HOOK_RETRY_POLICY: HookRetryPolicy = {
  maxAttempts: 6,
  initialDelayMs: 1_000,
  maxDelayMs: 300_000,
};

export const HookTarget = Schema.Union([
  /** Appends to the orchestrator's inbox. The default, always available. */
  Schema.Struct({ type: Schema.Literal("orchestrator_inbox"), orchestratorId: OrchestratorId }),
  /** Advances nothing by itself: a named CLI consumer reads matching events from its cursor. */
  Schema.Struct({ type: Schema.Literal("cli_consumer"), consumerId: EventConsumerId }),
  /** Opt-in. The URL must match the environment's webhook allowlist. */
  Schema.Struct({
    type: Schema.Literal("webhook"),
    url: TrimmedNonEmptyString,
    /** Name of a server secret used to sign the body. The secret never leaves the server. */
    secretRef: TrimmedNonEmptyString,
  }),
  /** Opt-in. Fixed executable and argv; the event arrives as JSON on stdin. */
  Schema.Struct({
    type: Schema.Literal("command"),
    executable: TrimmedNonEmptyString,
    args: Schema.Array(Schema.String),
    cwd: Schema.optional(TrimmedNonEmptyString),
    /** Names of environment variables to pass through. Nothing else is inherited. */
    envAllowlist: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  }),
]);
export type HookTarget = typeof HookTarget.Type;

export const HookTargetType = Schema.Literals([
  "orchestrator_inbox",
  "cli_consumer",
  "webhook",
  "command",
]);
export type HookTargetType = typeof HookTargetType.Type;

export const HookDeliveryMode = Schema.Literals(["each", "batch"]);
export type HookDeliveryMode = typeof HookDeliveryMode.Type;

const HookFields = {
  name: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  filter: AutomationEventFilter,
  target: HookTarget,
  /** `batch` groups events arriving within `batchWindowMs` into one delivery. */
  deliveryMode: HookDeliveryMode,
  batchWindowMs: Schema.optional(PositiveInt),
  retry: HookRetryPolicy,
  timeoutMs: PositiveInt,
  /** Higher delivers first when several deliveries are due. */
  priority: Schema.Int,
  /** Minimum gap between deliveries for the same correlation chain. */
  cooldownMs: Schema.optional(NonNegativeInt),
  /** Deliveries allowed per task before further ones are held as `suppressed`. */
  maxDeliveriesPerTask: Schema.optional(PositiveInt),
} as const;

export const Hook = Schema.Struct({
  id: HookId,
  version: Schema.Literal(AUTOMATION_CONTRACT_VERSION),
  /** Bumped on every edit. Edits must name the revision they replace. */
  revision: PositiveInt,
  ...HookFields,
  /** Journal cursor the hook has matched through. */
  cursor: NonNegativeInt,
  createdBy: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Hook = typeof Hook.Type;

export const HookUpsertInput = Schema.Struct({
  id: Schema.optional(HookId),
  /** Required when editing an existing hook. */
  expectedRevision: Schema.optional(PositiveInt),
  idempotencyKey: Schema.optional(IdempotencyKey),
  ...HookFields,
  /** Where a new hook starts: `head` skips history, a cursor replays from there. Ignored on edit. */
  startAt: Schema.optional(Schema.Union([Schema.Literal("head"), NonNegativeInt])),
});
export type HookUpsertInput = typeof HookUpsertInput.Type;

export const HookDeliveryStatus = Schema.Literals([
  "pending",
  "delivering",
  /** Written durably at the target (inbox row, 2xx, exit 0). Says nothing about the work it triggers. */
  "delivered",
  "retrying",
  /** Attempts exhausted. Stays inspectable until redelivered or dismissed. */
  "failed",
  /** Held back by a loop, cooldown, or per-task limit. Never dropped. */
  "suppressed",
]);
export type HookDeliveryStatus = typeof HookDeliveryStatus.Type;

export const HookDelivery = Schema.Struct({
  id: HookDeliveryId,
  hookId: HookId,
  /** Stable per (hook, events): the target uses it to deduplicate redeliveries. */
  dedupKey: TrimmedNonEmptyString,
  eventIds: Schema.Array(EventId),
  firstCursor: PositiveInt,
  lastCursor: PositiveInt,
  status: HookDeliveryStatus,
  attemptCount: NonNegativeInt,
  nextAttemptAt: Schema.NullOr(IsoDateTime),
  lastError: Schema.NullOr(Schema.String),
  suppressedReason: Schema.NullOr(
    Schema.Literals(["hop_limit", "cooldown", "task_limit", "self_turn", "backpressure"]),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type HookDelivery = typeof HookDelivery.Type;

export const HookTestResult = Schema.Struct({
  /** True when nothing was sent: the default. */
  dryRun: Schema.Boolean,
  matched: Schema.Array(AutomationJournalEntry),
  /** What would be sent to the target, with secrets redacted. */
  preview: Schema.NullOr(JsonRecord),
  delivery: Schema.NullOr(HookDelivery),
});
export type HookTestResult = typeof HookTestResult.Type;

/** Body a webhook or command target receives. */
export const HookDeliveryPayload = Schema.Struct({
  version: Schema.Literal(AUTOMATION_CONTRACT_VERSION),
  deliveryId: HookDeliveryId,
  dedupKey: TrimmedNonEmptyString,
  hookId: HookId,
  attempt: PositiveInt,
  sentAt: IsoDateTime,
  entries: Schema.Array(AutomationJournalEntry),
});
export type HookDeliveryPayload = typeof HookDeliveryPayload.Type;

// ---------------------------------------------------------------------------
// Pending requests and responsibility claims
// ---------------------------------------------------------------------------

export const ResponsibilityOwner = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("user") }),
  Schema.Struct({
    kind: Schema.Literal("orchestrator"),
    orchestratorId: OrchestratorId,
    environmentId: EnvironmentId,
  }),
  Schema.Struct({ kind: Schema.Literal("thread"), threadId: ThreadId }),
]);
export type ResponsibilityOwner = typeof ResponsibilityOwner.Type;

/** Why the runtime picked the owner. Evaluated in the order of `ResponsibilityPolicy.order`. */
export const ResponsibilityRule = Schema.Literals([
  "explicit_owner",
  "managing_parent",
  "local_orchestrator",
  "global_orchestrator",
  "user",
]);
export type ResponsibilityRule = typeof ResponsibilityRule.Type;

export const DEFAULT_RESPONSIBILITY_ORDER: ReadonlyArray<ResponsibilityRule> = [
  "explicit_owner",
  "managing_parent",
  "local_orchestrator",
  "global_orchestrator",
  "user",
];

export const ResponsibilityClaim = Schema.Struct({
  /** What is claimed: a runtime request or a delegated task. */
  subject: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("request"),
      threadId: ThreadId,
      requestId: RuntimeRequestId,
    }),
    Schema.Struct({ kind: Schema.Literal("task"), taskId: DelegatedTaskId }),
  ]),
  owner: ResponsibilityOwner,
  rule: ResponsibilityRule,
  /** Fencing token. Every transfer increments it; a mutation carrying an older one is rejected. */
  generation: PositiveInt,
  /** Null for the user, who never expires. An expired lease does not prove the owner stopped. */
  leaseExpiresAt: Schema.NullOr(IsoDateTime),
  claimedAt: IsoDateTime,
});
export type ResponsibilityClaim = typeof ResponsibilityClaim.Type;

export const PendingRequestSummary = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  threadTitle: Schema.String,
  parentThreadId: Schema.NullOr(ThreadId),
  requestId: RuntimeRequestId,
  kind: Schema.Literals(["approval", "user_input", "other"]),
  /** Approvals guard an action; only the user or a matching pre-authorization may decide them. */
  reservedForUser: Schema.Boolean,
  /** Revision of the request. A response must name it when the caller read the request earlier. */
  revision: NonNegativeInt,
  createdAt: IsoDateTime,
  /** The full request as `thread show` returns it: questions, options, approval scope. */
  request: Schema.Json,
  claim: Schema.NullOr(ResponsibilityClaim),
});
export type PendingRequestSummary = typeof PendingRequestSummary.Type;

export const PendingRequestsListInput = Schema.Struct({
  threadId: Schema.optional(ThreadId),
  rootThreadId: Schema.optional(ThreadId),
  orchestratorId: Schema.optional(OrchestratorId),
});
export type PendingRequestsListInput = typeof PendingRequestsListInput.Type;

export const RequestRespondInput = Schema.Struct({
  idempotencyKey: IdempotencyKey,
  threadId: ThreadId,
  requestId: RuntimeRequestId,
  /** Who is answering. The server checks it against the claim and the session. */
  responder: ResponsibilityOwner,
  /** Fencing token from the claim. Required unless the responder is the user. */
  generation: Schema.optional(PositiveInt),
  expectedRevision: Schema.optional(NonNegativeInt),
  decision: Schema.optional(ProviderApprovalDecision),
  answers: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
  dismiss: Schema.optional(Schema.Boolean),
});
export type RequestRespondInput = typeof RequestRespondInput.Type;

export const RequestRespondResult = Schema.Struct({
  threadId: ThreadId,
  requestId: RuntimeRequestId,
  commandId: CommandId,
  /** `accepted` means the response committed; the provider applies it afterwards. */
  status: Schema.Literals(["accepted", "replayed"]),
});
export type RequestRespondResult = typeof RequestRespondResult.Type;

export const ClaimTransferInput = Schema.Struct({
  idempotencyKey: IdempotencyKey,
  subject: ResponsibilityClaim.fields.subject,
  to: ResponsibilityOwner,
  /** Generation the caller believes is current. */
  expectedGeneration: Schema.optional(PositiveInt),
  reason: Schema.optional(TrimmedNonEmptyString),
});
export type ClaimTransferInput = typeof ClaimTransferInput.Type;

// ---------------------------------------------------------------------------
// Orchestrators
// ---------------------------------------------------------------------------

export const OrchestratorScope = Schema.Literals(["local", "global"]);
export type OrchestratorScope = typeof OrchestratorScope.Type;

/** What the operator asked for. `disabled` also stops inbox intake from hooks. */
export const OrchestratorDesiredState = Schema.Literals(["active", "paused", "disabled"]);
export type OrchestratorDesiredState = typeof OrchestratorDesiredState.Type;

/** What the runtime is doing. Thread settle, snooze, or archive never change it. */
export const OrchestratorEffectiveState = Schema.Literals([
  "idle",
  "queued",
  "running",
  "waiting",
  "paused",
  "disabled",
  "budget_exceeded",
  "handing_off",
  "not_hosted_here",
  "error",
]);
export type OrchestratorEffectiveState = typeof OrchestratorEffectiveState.Type;

export const OrchestratorAction = Schema.Literals([
  "thread.read",
  "thread.create",
  "thread.send",
  "thread.organize",
  "thread.interrupt",
  "request.answer",
  /** Deciding approvals. Off unless a pre-authorization names it. */
  "request.approve",
  "task.delegate",
  "task.cancel",
  "peer.message",
  "peer.delegate",
  "job.run",
  /** Arbitrary shell on a node. Needs the `automation:execute` scope as well. */
  "job.shell",
  "event.emit",
]);
export type OrchestratorAction = typeof OrchestratorAction.Type;

export const OrchestratorPermissions = Schema.Struct({
  actions: Schema.Array(OrchestratorAction),
  /** Absent means every project of the host environment; an empty array means none. */
  projectIds: Schema.optional(Schema.Array(ProjectId)),
  /** Peers this orchestrator may address. Only meaningful for `global` scope. */
  environmentIds: Schema.optional(Schema.Array(EnvironmentId)),
  nodeIds: Schema.optional(Schema.Array(ExecutionNodeId)),
  /** Approval decisions the orchestrator may take without the user, by request kind. */
  preAuthorizedApprovals: Schema.optional(
    Schema.Array(
      Schema.Struct({
        requestKind: TrimmedNonEmptyString,
        decisions: Schema.Array(ProviderApprovalDecision),
        projectIds: Schema.optional(Schema.Array(ProjectId)),
      }),
    ),
  ),
});
export type OrchestratorPermissions = typeof OrchestratorPermissions.Type;

/** Null means no limit. The runtime never raises a limit or switches model on its own. */
export const OrchestratorBudget = Schema.Struct({
  maxTokens: Schema.NullOr(PositiveInt),
  maxTurnsPerTask: Schema.NullOr(PositiveInt),
  maxTurnsPerHour: Schema.NullOr(PositiveInt),
  maxConcurrentChildren: Schema.NullOr(PositiveInt),
  maxChildrenPerTask: Schema.NullOr(PositiveInt),
  maxTaskAttempts: Schema.NullOr(PositiveInt),
  maxTurnDurationMs: Schema.NullOr(PositiveInt),
});
export type OrchestratorBudget = typeof OrchestratorBudget.Type;

export const OrchestratorUsage = Schema.Struct({
  /** Null when the provider does not report usage: unknown, not zero. */
  tokens: Schema.NullOr(NonNegativeInt),
  tokensComplete: Schema.Boolean,
  turns: NonNegativeInt,
  turnsLastHour: NonNegativeInt,
  activeChildren: NonNegativeInt,
  since: IsoDateTime,
});
export type OrchestratorUsage = typeof OrchestratorUsage.Type;

const OrchestratorFields = {
  name: TrimmedNonEmptyString,
  scope: OrchestratorScope,
  projectId: ProjectId,
  modelSelection: ModelSelection,
  /** Agent profile slug applied to every turn. */
  profile: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode,
  /** Appended to the built-in orchestrator instructions. */
  instructions: Schema.String,
  permissions: OrchestratorPermissions,
  budget: OrchestratorBudget,
  responsibilityOrder: Schema.Array(ResponsibilityRule),
  /** Events arriving within this window open one turn instead of one each. */
  batchWindowMs: NonNegativeInt,
} as const;

export const Orchestrator = Schema.Struct({
  id: OrchestratorId,
  version: Schema.Literal(AUTOMATION_CONTRACT_VERSION),
  revision: PositiveInt,
  ...OrchestratorFields,
  /** Environment currently hosting the runtime. Other environments hold a read-only projection. */
  hostEnvironmentId: EnvironmentId,
  /** Fencing token for hosting. A handoff increments it. */
  hostGeneration: PositiveInt,
  /** The conversational thread. Null on environments that only know the orchestrator as a peer projection. */
  threadId: Schema.NullOr(ThreadId),
  desiredState: OrchestratorDesiredState,
  effectiveState: OrchestratorEffectiveState,
  stateReason: Schema.NullOr(Schema.String),
  inboxPending: NonNegativeInt,
  usage: OrchestratorUsage,
  lastTurnAt: Schema.NullOr(IsoDateTime),
  lastCheckpointAt: Schema.NullOr(IsoDateTime),
  /** When this environment last observed the record. Older than `updatedAt` on a stale projection. */
  observedAt: IsoDateTime,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Orchestrator = typeof Orchestrator.Type;

export const OrchestratorUpsertInput = Schema.Struct({
  id: Schema.optional(OrchestratorId),
  expectedRevision: Schema.optional(PositiveInt),
  idempotencyKey: Schema.optional(IdempotencyKey),
  ...OrchestratorFields,
  /** Adopt an existing thread as the main thread instead of creating one. Create only. */
  threadId: Schema.optional(ThreadId),
  desiredState: Schema.optional(OrchestratorDesiredState),
});
export type OrchestratorUpsertInput = typeof OrchestratorUpsertInput.Type;

export const OrchestratorSetStateInput = Schema.Struct({
  orchestratorId: OrchestratorId,
  desiredState: OrchestratorDesiredState,
  /** Separate from pausing: also interrupt the running turn. Children keep running. */
  interruptActiveTurn: Schema.optional(Schema.Boolean),
});
export type OrchestratorSetStateInput = typeof OrchestratorSetStateInput.Type;

export const InboxEntryKind = Schema.Literals(["user_message", "peer_message", "event", "timer"]);
export type InboxEntryKind = typeof InboxEntryKind.Type;

export const InboxEntryStatus = Schema.Literals([
  /** Stored, not yet shown to the model. */
  "pending",
  /** Reserved by the turn that is reading it. */
  "reserved",
  /** The turn that read it finished and its checkpoint is saved. */
  "processed",
  /** Recorded as state without opening a turn. */
  "absorbed",
  /** The turn's outcome is unknown after a crash. Needs reconciliation, never an automatic retry. */
  "unknown",
  "dismissed",
]);
export type InboxEntryStatus = typeof InboxEntryStatus.Type;

export const InboxEntry = Schema.Struct({
  id: InboxEntryId,
  orchestratorId: OrchestratorId,
  kind: InboxEntryKind,
  /** Unique per orchestrator: redelivering the same thing does not add a second entry. */
  dedupKey: TrimmedNonEmptyString,
  status: InboxEntryStatus,
  /** Low entries are absorbed or batched; they never open a turn alone. */
  relevance: Schema.Literals(["actionable", "informational"]),
  entries: Schema.Array(AutomationJournalEntry),
  text: Schema.NullOr(Schema.String),
  from: Schema.NullOr(ResponsibilityOwner),
  reservedByRunId: Schema.NullOr(RunId),
  receivedAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type InboxEntry = typeof InboxEntry.Type;

export const OrchestratorSendInput = Schema.Struct({
  idempotencyKey: IdempotencyKey,
  orchestratorId: OrchestratorId,
  text: TrimmedNonEmptyString,
});
export type OrchestratorSendInput = typeof OrchestratorSendInput.Type;

export const OrchestratorSendResult = Schema.Struct({
  entry: InboxEntry,
  /** `queued_remote`: the host is another environment and has not confirmed receipt yet. */
  delivery: Schema.Literals(["queued_local", "queued_remote", "delivered_remote"]),
  hostEnvironmentId: EnvironmentId,
});
export type OrchestratorSendResult = typeof OrchestratorSendResult.Type;

export const OrchestratorCheckpoint = Schema.Struct({
  orchestratorId: OrchestratorId,
  sequence: PositiveInt,
  hostGeneration: PositiveInt,
  /** Run that produced it, or null for a checkpoint taken while idle. */
  runId: Schema.NullOr(RunId),
  /** Structured operational state, kept apart from the conversation. */
  state: Schema.Struct({
    goals: Schema.Array(Schema.Struct({ id: TrimmedNonEmptyString, text: Schema.String })),
    openTaskIds: Schema.Array(DelegatedTaskId),
    pendingOperations: Schema.Array(
      Schema.Struct({
        idempotencyKey: IdempotencyKey,
        action: OrchestratorAction,
        status: Schema.Literals(["started", "confirmed", "unknown"]),
        ref: Schema.NullOr(TrimmedNonEmptyString),
      }),
    ),
    decisions: Schema.Array(
      Schema.Struct({
        at: IsoDateTime,
        text: Schema.String,
        refs: Schema.Array(AutomationReference),
      }),
    ),
    summary: Schema.String,
  }),
  inboxCursor: NonNegativeInt,
  createdAt: IsoDateTime,
});
export type OrchestratorCheckpoint = typeof OrchestratorCheckpoint.Type;

export const OrchestratorHandoffPhase = Schema.Literals([
  "requested",
  "paused",
  "reconciled",
  "checkpointed",
  "transferred",
  "accepted",
  "committed",
  "resumed",
  "cancelled",
  "failed",
]);
export type OrchestratorHandoffPhase = typeof OrchestratorHandoffPhase.Type;

export const OrchestratorHandoff = Schema.Struct({
  orchestratorId: OrchestratorId,
  sourceEnvironmentId: EnvironmentId,
  destinationEnvironmentId: EnvironmentId,
  /** Generation the destination holds once the handoff commits. */
  nextGeneration: PositiveInt,
  phase: OrchestratorHandoffPhase,
  error: Schema.NullOr(Schema.String),
  startedAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestratorHandoff = typeof OrchestratorHandoff.Type;

// ---------------------------------------------------------------------------
// Delegated tasks
// ---------------------------------------------------------------------------

/**
 * Reported and validated are different facts. A provider's final answer moves a
 * task to `reported`; only checking the acceptance criteria moves it to
 * `validated`.
 */
export const DelegatedTaskStatus = Schema.Literals([
  /** Stored at the origin; the destination has not confirmed receipt. */
  "pending_delivery",
  /** The destination stored it and created (or found) the thread. */
  "accepted",
  "running",
  /** Waiting on a request, a dependency, or a permission. */
  "blocked",
  "reported",
  "validated",
  "failed",
  "cancel_requested",
  "cancelled",
  /** The executor's outcome cannot be established. Reconcile by id; never re-run blindly. */
  "unknown",
  "expired",
]);
export type DelegatedTaskStatus = typeof DelegatedTaskStatus.Type;

export const DELEGATED_TASK_TERMINAL_STATUSES: ReadonlyArray<DelegatedTaskStatus> = [
  "validated",
  "failed",
  "cancelled",
  "expired",
];

export const DelegatedTaskTarget = Schema.Struct({
  /** Absent means the environment that receives the request. */
  environmentId: Schema.optional(EnvironmentId),
  nodeId: Schema.optional(ExecutionNodeId),
  projectId: ProjectId,
  workspaceStrategy: Schema.optional(OrchestrationV2ThreadLaunchWorkspaceStrategy),
  modelSelection: Schema.optional(ModelSelection),
  profile: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
});
export type DelegatedTaskTarget = typeof DelegatedTaskTarget.Type;

export const DelegatedTaskContract = Schema.Struct({
  title: TrimmedNonEmptyString,
  objective: TrimmedNonEmptyString,
  context: Schema.optional(Schema.String),
  deliverables: Schema.Array(TrimmedNonEmptyString),
  acceptanceCriteria: Schema.Array(TrimmedNonEmptyString),
  dependsOn: Schema.optional(Schema.Array(DelegatedTaskId)),
  /** Actions the child may take on the parent's behalf. Never wider than the delegator's own. */
  permissions: Schema.optional(Schema.Array(OrchestratorAction)),
  budget: Schema.optional(
    Schema.Struct({
      maxTokens: Schema.NullOr(PositiveInt),
      maxTurns: Schema.NullOr(PositiveInt),
    }),
  ),
  /** After this the task expires instead of starting; the destination rechecks it before running. */
  deadline: Schema.optional(IsoDateTime),
  refs: Schema.optional(Schema.Array(AutomationReference)),
  /** What stopping the parent does to this task. `detach` leaves it running. */
  onParentCancel: Schema.optional(Schema.Literals(["cancel", "detach"])),
});
export type DelegatedTaskContract = typeof DelegatedTaskContract.Type;

export const DelegatedTask = Schema.Struct({
  id: DelegatedTaskId,
  version: Schema.Literal(AUTOMATION_CONTRACT_VERSION),
  revision: PositiveInt,
  /** Environment that created the task and owns its contract. */
  originEnvironmentId: EnvironmentId,
  /** Environment that executes it and owns its thread and status. */
  executionEnvironmentId: EnvironmentId,
  nodeId: Schema.NullOr(ExecutionNodeId),
  orchestratorId: Schema.NullOr(OrchestratorId),
  parentTaskId: Schema.NullOr(DelegatedTaskId),
  parentThreadId: Schema.NullOr(ThreadId),
  /** Null until the execution environment accepts. Stable across retries of the same task. */
  threadId: Schema.NullOr(ThreadId),
  kind: Schema.Literals(["managed_thread", "native_subagent"]),
  /** What can be done to the child. A native subagent is read-only from T3. */
  capabilities: Schema.Struct({
    send: Schema.Boolean,
    answer: Schema.Boolean,
    cancel: Schema.Boolean,
    read: Schema.Boolean,
  }),
  target: DelegatedTaskTarget,
  contract: DelegatedTaskContract,
  status: DelegatedTaskStatus,
  statusReason: Schema.NullOr(Schema.String),
  attemptCount: NonNegativeInt,
  claim: Schema.NullOr(ResponsibilityClaim),
  result: Schema.NullOr(
    Schema.Struct({
      summary: Schema.String,
      /** Per acceptance criterion, in the contract's order. Null entries were not checked. */
      criteria: Schema.Array(
        Schema.Struct({
          text: Schema.String,
          met: Schema.NullOr(Schema.Boolean),
          evidence: Schema.NullOr(Schema.String),
        }),
      ),
      validatedBy: Schema.NullOr(ResponsibilityOwner),
      refs: Schema.Array(AutomationReference),
    }),
  ),
  usage: Schema.Struct({ tokens: Schema.NullOr(NonNegativeInt), turns: NonNegativeInt }),
  /** When this environment last observed the task. A remote task can be stale. */
  observedAt: IsoDateTime,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type DelegatedTask = typeof DelegatedTask.Type;

export const TaskDelegateInput = Schema.Struct({
  /** Also derives the task id: repeating it returns the same task and thread. */
  idempotencyKey: IdempotencyKey,
  orchestratorId: Schema.optional(OrchestratorId),
  parentThreadId: Schema.optional(ThreadId),
  parentTaskId: Schema.optional(DelegatedTaskId),
  target: DelegatedTaskTarget,
  contract: DelegatedTaskContract,
});
export type TaskDelegateInput = typeof TaskDelegateInput.Type;

export const TaskUpdateInput = Schema.Struct({
  idempotencyKey: IdempotencyKey,
  taskId: DelegatedTaskId,
  expectedRevision: Schema.optional(PositiveInt),
  /** Fencing token of the caller's claim. */
  generation: Schema.optional(PositiveInt),
  action: Schema.Union([
    Schema.Struct({ type: Schema.Literal("cancel"), reason: Schema.optional(Schema.String) }),
    Schema.Struct({
      type: Schema.Literal("validate"),
      criteria: Schema.Array(
        Schema.Struct({ met: Schema.Boolean, evidence: Schema.optional(Schema.String) }),
      ),
      summary: Schema.optional(Schema.String),
    }),
    Schema.Struct({ type: Schema.Literal("reject"), reason: TrimmedNonEmptyString }),
    Schema.Struct({ type: Schema.Literal("send"), text: TrimmedNonEmptyString }),
    /** Re-read the executor's state for a task whose outcome is unknown. */
    Schema.Struct({ type: Schema.Literal("reconcile") }),
  ]),
});
export type TaskUpdateInput = typeof TaskUpdateInput.Type;

export const TaskListInput = Schema.Struct({
  orchestratorId: Schema.optional(OrchestratorId),
  parentThreadId: Schema.optional(ThreadId),
  rootTaskId: Schema.optional(DelegatedTaskId),
  statuses: Schema.optional(Schema.Array(DelegatedTaskStatus)),
  includeTerminal: Schema.optional(Schema.Boolean),
});
export type TaskListInput = typeof TaskListInput.Type;

/** One node of the tree under a thread: managed tasks and native subagents together. */
export const ThreadTreeNode = Schema.Struct({
  threadId: ThreadId,
  parentThreadId: Schema.NullOr(ThreadId),
  title: Schema.String,
  relationship: Schema.NullOr(Schema.Literals(["fork", "subagent", "delegated"])),
  kind: Schema.Literals(["thread", "managed_thread", "native_subagent"]),
  taskId: Schema.NullOr(DelegatedTaskId),
  taskStatus: Schema.NullOr(DelegatedTaskStatus),
  threadStatus: Schema.String,
  pendingRequests: NonNegativeInt,
  depth: NonNegativeInt,
});
export type ThreadTreeNode = typeof ThreadTreeNode.Type;

// ---------------------------------------------------------------------------
// Execution nodes and jobs
// ---------------------------------------------------------------------------

export const ExecutionNodeTransport = Schema.Union([
  /** The machine running the environment's server. */
  Schema.Struct({ type: Schema.Literal("local") }),
  Schema.Struct({
    type: Schema.Literal("ssh"),
    target: TrimmedNonEmptyString,
    port: Schema.optional(PositiveInt),
    identityFile: Schema.optional(TrimmedNonEmptyString),
  }),
]);
export type ExecutionNodeTransport = typeof ExecutionNodeTransport.Type;

export const ExecutionNode = Schema.Struct({
  id: ExecutionNodeId,
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  transport: ExecutionNodeTransport,
  enabled: Schema.Boolean,
  /** Directories jobs may run in. A job's cwd must be inside one of them. */
  workspaceRoots: Schema.Array(TrimmedNonEmptyString),
  allowShell: Schema.Boolean,
  /** Last probe. A snapshot, not a promise that the next job will run. */
  availability: Schema.Struct({
    status: Schema.Literals(["available", "unavailable", "unknown"]),
    os: Schema.NullOr(Schema.String),
    arch: Schema.NullOr(Schema.String),
    tools: Schema.Array(
      Schema.Struct({ name: Schema.String, version: Schema.NullOr(Schema.String) }),
    ),
    error: Schema.NullOr(Schema.String),
    observedAt: Schema.NullOr(IsoDateTime),
  }),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ExecutionNode = typeof ExecutionNode.Type;

export const ExecutionNodeUpsertInput = Schema.Struct({
  id: Schema.optional(ExecutionNodeId),
  label: TrimmedNonEmptyString,
  transport: ExecutionNodeTransport,
  enabled: Schema.Boolean,
  workspaceRoots: Schema.Array(TrimmedNonEmptyString),
  allowShell: Schema.Boolean,
});
export type ExecutionNodeUpsertInput = typeof ExecutionNodeUpsertInput.Type;

export const JobAction = Schema.Union([
  /** Fixed executable and argv, no shell. */
  Schema.Struct({
    type: Schema.Literal("command"),
    executable: TrimmedNonEmptyString,
    args: Schema.Array(Schema.String),
    stdin: Schema.optional(Schema.String),
  }),
  /** A shell line. Needs `allowShell` on the node and the `automation:execute` scope. */
  Schema.Struct({ type: Schema.Literal("shell"), script: TrimmedNonEmptyString }),
]);
export type JobAction = typeof JobAction.Type;

export const JobStatus = Schema.Literals([
  /** Stored; not handed to the executor yet. */
  "accepted",
  "started",
  "succeeded",
  "failed",
  "timed_out",
  "cancel_requested",
  "cancelled",
  /** Handed to the executor and then lost. Never re-run without `reconcile`. */
  "unknown",
]);
export type JobStatus = typeof JobStatus.Type;

export const JOB_TERMINAL_STATUSES: ReadonlyArray<JobStatus> = [
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
];

export const Job = Schema.Struct({
  id: JobId,
  environmentId: EnvironmentId,
  nodeId: ExecutionNodeId,
  requestedBy: ResponsibilityOwner,
  requestedByEnvironmentId: EnvironmentId,
  taskId: Schema.NullOr(DelegatedTaskId),
  threadId: Schema.NullOr(ThreadId),
  cwd: TrimmedNonEmptyString,
  action: JobAction,
  timeoutMs: PositiveInt,
  /** Declared by the requester. Only an idempotent job may be re-run after `unknown`. */
  idempotent: Schema.Boolean,
  status: JobStatus,
  statusReason: Schema.NullOr(Schema.String),
  /** Null until the executor reports it. Quiet output never implies an exit. */
  exitCode: Schema.NullOr(Schema.Int),
  logBytes: NonNegativeInt,
  logTruncated: Schema.Boolean,
  refs: Schema.Array(AutomationReference),
  acceptedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  finishedAt: Schema.NullOr(IsoDateTime),
  updatedAt: IsoDateTime,
});
export type Job = typeof Job.Type;

export const JobSubmitInput = Schema.Struct({
  idempotencyKey: IdempotencyKey,
  nodeId: ExecutionNodeId,
  cwd: TrimmedNonEmptyString,
  action: JobAction,
  timeoutMs: Schema.optional(PositiveInt),
  idempotent: Schema.optional(Schema.Boolean),
  taskId: Schema.optional(DelegatedTaskId),
  threadId: Schema.optional(ThreadId),
  orchestratorId: Schema.optional(OrchestratorId),
});
export type JobSubmitInput = typeof JobSubmitInput.Type;

export const JobLogsInput = Schema.Struct({
  jobId: JobId,
  afterByte: Schema.optional(NonNegativeInt),
  maxBytes: Schema.optional(PositiveInt),
});
export type JobLogsInput = typeof JobLogsInput.Type;

export const JobLogsResult = Schema.Struct({
  jobId: JobId,
  text: Schema.String,
  nextByte: NonNegativeInt,
  /** True only once the job is terminal and everything has been read. */
  complete: Schema.Boolean,
});
export type JobLogsResult = typeof JobLogsResult.Type;

// ---------------------------------------------------------------------------
// Peers
// ---------------------------------------------------------------------------

export const PeerAction = Schema.Literals([
  "message.send",
  "event.forward",
  "task.delegate",
  "task.read",
  "orchestrator.read",
  "orchestrator.send",
  "orchestrator.host",
]);
export type PeerAction = typeof PeerAction.Type;

/** What a peer may ask of this environment. Checked when the action runs, not when it was queued. */
export const PeerPermissions = Schema.Struct({
  inbound: Schema.Array(PeerAction),
  projectIds: Schema.optional(Schema.Array(ProjectId)),
  nodeIds: Schema.optional(Schema.Array(ExecutionNodeId)),
  /** Event types forwarded to the peer. Empty forwards nothing. */
  forwardEventTypes: Schema.Array(TrimmedNonEmptyString),
});
export type PeerPermissions = typeof PeerPermissions.Type;

export const PeerConnectionStatus = Schema.Literals([
  "connected",
  "connecting",
  "offline",
  "incompatible",
  "revoked",
]);
export type PeerConnectionStatus = typeof PeerConnectionStatus.Type;

export const FEDERATION_PROTOCOL_VERSION = 1;

export const PeerCapabilities = Schema.Struct({
  protocolVersions: Schema.Array(PositiveInt),
  eventTypes: Schema.Array(Schema.String),
  hookTargets: Schema.Array(HookTargetType),
  orchestratorHost: Schema.Boolean,
  jobs: Schema.Boolean,
});
export type PeerCapabilities = typeof PeerCapabilities.Type;

export const Peer = Schema.Struct({
  /** Stable identity. Names and URLs can change. */
  environmentId: EnvironmentId,
  name: TrimmedNonEmptyString,
  httpBaseUrl: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  permissions: PeerPermissions,
  status: PeerConnectionStatus,
  statusReason: Schema.NullOr(Schema.String),
  negotiatedProtocolVersion: Schema.NullOr(PositiveInt),
  capabilities: Schema.NullOr(PeerCapabilities),
  /** Peer journal cursor received through. */
  inboundCursor: NonNegativeInt,
  /** Messages stored here and not yet acknowledged by the peer. */
  outboxPending: NonNegativeInt,
  lastConnectedAt: Schema.NullOr(IsoDateTime),
  lastObservedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Peer = typeof Peer.Type;

export const PeerAddInput = Schema.Struct({
  name: TrimmedNonEmptyString,
  /** A pairing link from the peer, or its URL together with `token`. */
  pairingUrl: Schema.optional(TrimmedNonEmptyString),
  httpBaseUrl: Schema.optional(TrimmedNonEmptyString),
  token: Schema.optional(TrimmedNonEmptyString),
  permissions: PeerPermissions,
});
export type PeerAddInput = typeof PeerAddInput.Type;

export const PeerUpdateInput = Schema.Struct({
  environmentId: EnvironmentId,
  name: Schema.optional(TrimmedNonEmptyString),
  enabled: Schema.optional(Schema.Boolean),
  permissions: Schema.optional(PeerPermissions),
  httpBaseUrl: Schema.optional(TrimmedNonEmptyString),
});
export type PeerUpdateInput = typeof PeerUpdateInput.Type;

export const PeerMessageBody = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("text"),
    toOrchestratorId: Schema.optional(OrchestratorId),
    fromOrchestratorId: Schema.optional(OrchestratorId),
    text: TrimmedNonEmptyString,
  }),
  Schema.Struct({ type: Schema.Literal("events"), entries: Schema.Array(AutomationJournalEntry) }),
  Schema.Struct({ type: Schema.Literal("task.delegate"), task: DelegatedTask }),
  Schema.Struct({
    type: Schema.Literal("task.cancel"),
    taskId: DelegatedTaskId,
    reason: Schema.NullOr(Schema.String),
  }),
  /** The execution environment's view of a task, sent back to its origin. */
  Schema.Struct({ type: Schema.Literal("task.status"), task: DelegatedTask }),
  Schema.Struct({
    type: Schema.Literal("orchestrator.send"),
    orchestratorId: OrchestratorId,
    text: TrimmedNonEmptyString,
    from: ResponsibilityOwner,
  }),
  Schema.Struct({ type: Schema.Literal("orchestrator.projection"), orchestrator: Orchestrator }),
  Schema.Struct({
    type: Schema.Literal("orchestrator.handoff"),
    handoff: OrchestratorHandoff,
    orchestrator: Schema.NullOr(Orchestrator),
    checkpoint: Schema.NullOr(OrchestratorCheckpoint),
  }),
]);
export type PeerMessageBody = typeof PeerMessageBody.Type;

export const PeerMessage = Schema.Struct({
  version: Schema.Literal(FEDERATION_PROTOCOL_VERSION),
  /** Stable across retries: the receiver stores it before acknowledging and ignores repeats. */
  messageId: PeerMessageId,
  fromEnvironmentId: EnvironmentId,
  toEnvironmentId: EnvironmentId,
  /** Position in the sender's outbox for this peer. */
  sequence: PositiveInt,
  correlationId: TrimmedNonEmptyString,
  sentAt: IsoDateTime,
  /** After this the receiver rejects the message instead of acting on it. */
  expiresAt: Schema.NullOr(IsoDateTime),
  body: PeerMessageBody,
});
export type PeerMessage = typeof PeerMessage.Type;

export const PeerOutboxStatus = Schema.Literals([
  "pending_delivery",
  /** The peer stored it. Acceptance of the work inside is reported separately. */
  "delivered",
  "rejected",
  "expired",
  "cancelled",
]);
export type PeerOutboxStatus = typeof PeerOutboxStatus.Type;

export const PeerOutboxEntry = Schema.Struct({
  message: PeerMessage,
  status: PeerOutboxStatus,
  attemptCount: NonNegativeInt,
  lastError: Schema.NullOr(Schema.String),
  rejection: Schema.NullOr(AutomationErrorCode),
  updatedAt: IsoDateTime,
});
export type PeerOutboxEntry = typeof PeerOutboxEntry.Type;

export const PeerHelloInput = Schema.Struct({
  fromEnvironmentId: EnvironmentId,
  name: TrimmedNonEmptyString,
  capabilities: PeerCapabilities,
  /** Highest sequence of this peer's messages the caller has stored. */
  receivedThroughSequence: NonNegativeInt,
});
export type PeerHelloInput = typeof PeerHelloInput.Type;

export const PeerHelloResult = Schema.Struct({
  environmentId: EnvironmentId,
  name: TrimmedNonEmptyString,
  capabilities: PeerCapabilities,
  /** Null when no shared version exists; the caller marks the peer `incompatible`. */
  protocolVersion: Schema.NullOr(PositiveInt),
  receivedThroughSequence: NonNegativeInt,
  /** What this environment allows the caller to ask of it. */
  granted: Schema.Array(PeerAction),
});
export type PeerHelloResult = typeof PeerHelloResult.Type;

export const PeerDeliverInput = Schema.Struct({ messages: Schema.Array(PeerMessage) });
export type PeerDeliverInput = typeof PeerDeliverInput.Type;

export const PeerDeliverResult = Schema.Struct({
  /** Stored durably through this sequence. */
  receivedThroughSequence: NonNegativeInt,
  rejected: Schema.Array(
    Schema.Struct({
      messageId: PeerMessageId,
      code: AutomationErrorCode,
      message: Schema.String,
    }),
  ),
});
export type PeerDeliverResult = typeof PeerDeliverResult.Type;

// ---------------------------------------------------------------------------
// Aggregation and diagnostics
// ---------------------------------------------------------------------------

/** Attached to any answer assembled from more than one environment. */
export const AggregationCoverage = Schema.Struct({
  consulted: Schema.Array(Schema.Struct({ environmentId: EnvironmentId, observedAt: IsoDateTime })),
  unavailable: Schema.Array(Schema.Struct({ environmentId: EnvironmentId, reason: Schema.String })),
  /** Answered from a stored projection instead of the environment itself. */
  stale: Schema.Array(Schema.Struct({ environmentId: EnvironmentId, observedAt: IsoDateTime })),
});
export type AggregationCoverage = typeof AggregationCoverage.Type;

/** Automation work that keeps a server from being safe to close. */
export const AutomationPendingWork = Schema.Struct({
  hookDeliveries: Schema.Struct({
    pending: NonNegativeInt,
    retrying: NonNegativeInt,
    failed: NonNegativeInt,
  }),
  orchestrators: Schema.Array(
    Schema.Struct({
      orchestratorId: OrchestratorId,
      name: Schema.String,
      effectiveState: OrchestratorEffectiveState,
      inboxPending: NonNegativeInt,
      activeChildren: NonNegativeInt,
    }),
  ),
  activeTasks: NonNegativeInt,
  unknownTasks: NonNegativeInt,
  activeJobs: Schema.Array(
    Schema.Struct({ jobId: JobId, nodeId: ExecutionNodeId, status: JobStatus }),
  ),
  peerOutboxPending: NonNegativeInt,
});
export type AutomationPendingWork = typeof AutomationPendingWork.Type;

export const AutomationDiagnostics = Schema.Struct({
  environmentId: EnvironmentId,
  journal: AutomationJournalStatus,
  workers: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      running: Schema.Boolean,
      lastTickAt: Schema.NullOr(IsoDateTime),
      lastError: Schema.NullOr(Schema.String),
    }),
  ),
  pendingWork: AutomationPendingWork,
  peers: Schema.Array(Peer),
  observedAt: IsoDateTime,
});
export type AutomationDiagnostics = typeof AutomationDiagnostics.Type;
