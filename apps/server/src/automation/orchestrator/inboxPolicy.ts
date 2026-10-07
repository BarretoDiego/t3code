import {
  AUTOMATION_ADMINISTRATIVE_EVENT_TYPES,
  type AutomationEvent,
  type DelegatedTask,
  DELEGATED_TASK_TERMINAL_STATUSES,
  type InboxEntry,
  type OrchestratorCheckpoint,
  type OrchestratorId,
  type PendingRequestSummary,
  type ThreadId,
} from "@t3tools/contracts";

import type { OrchestratorInboxDelivery } from "../OrchestratorInbox.ts";
import type { OrchestratorConfig } from "./Store.ts";

/** Event types that report progress or bookkeeping: recorded, never a reason to think. */
const INFORMATIONAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  ...AUTOMATION_ADMINISTRATIVE_EVENT_TYPES,
  "thread.created",
  "thread.organized",
  "thread.deleted",
  "turn.started",
  "task.delegated",
  "task.accepted",
  "task.progress",
  "artifact.produced",
  "job.accepted",
  "job.started",
  "node.availability",
  "peer.availability",
]);

const TURN_EVENT_TYPES: ReadonlySet<string> = new Set([
  "turn.started",
  "turn.completed",
  "turn.failed",
  "turn.interrupted",
]);

/**
 * True for events the orchestrator caused by existing: its own turns, and the
 * bookkeeping events about its own record and inbox. Feeding these back would
 * make it react to itself.
 */
const isOwnTurnEvent = (
  event: AutomationEvent,
  orchestrator: { readonly id: OrchestratorId; readonly threadId: ThreadId | null },
) =>
  (event.type.startsWith("orchestrator.") && event.scope.orchestratorId === orchestrator.id) ||
  (TURN_EVENT_TYPES.has(event.type) &&
    orchestrator.threadId !== null &&
    event.scope.threadId === orchestrator.threadId);

/**
 * Decides how an arriving entry is treated. The sender's `relevance` can only
 * lower the result: a hook cannot make progress noise wake the model.
 *
 * - `absorbed`: recorded and never shown (the orchestrator's own turn echo).
 * - `informational`: kept for the next turn's batch; never opens one.
 * - `actionable`: opens a turn once the batch window closes.
 */
export const classifyDelivery = (
  delivery: OrchestratorInboxDelivery,
  orchestrator: { readonly id: OrchestratorId; readonly threadId: ThreadId | null },
): { readonly relevance: InboxEntry["relevance"]; readonly absorb: boolean } => {
  if (delivery.kind !== "event") {
    return {
      relevance: delivery.kind === "timer" ? delivery.relevance : "actionable",
      absorb: false,
    };
  }
  const events = delivery.entries.map((entry) => entry.event);
  if (events.length > 0 && events.every((event) => isOwnTurnEvent(event, orchestrator))) {
    return { relevance: "informational", absorb: true };
  }
  const meaningful = events.filter((event) => !isOwnTurnEvent(event, orchestrator));
  const actionable =
    delivery.relevance === "actionable" &&
    meaningful.some((event) => !INFORMATIONAL_EVENT_TYPES.has(event.type));
  return { relevance: actionable ? "actionable" : "informational", absorb: false };
};

/** Whether the orchestrator's project scope lets it see this entry at all. */
export const entryWithinScope = (entry: InboxEntry, config: OrchestratorConfig): boolean => {
  const projectIds = config.permissions.projectIds;
  if (projectIds === undefined || entry.kind !== "event") return true;
  return entry.entries.every(
    ({ event }) =>
      event.scope.projectId === undefined || projectIds.includes(event.scope.projectId),
  );
};

export const taskIdsOf = (entries: ReadonlyArray<InboxEntry>): ReadonlyArray<string> => [
  ...new Set(
    entries.flatMap((entry) =>
      entry.entries.flatMap(({ event }) =>
        event.scope.taskId === undefined ? [] : [event.scope.taskId],
      ),
    ),
  ),
];

const MAX_EVENT_PAYLOAD_CHARS = 400;
const MAX_SUMMARY_CHARS = 2_000;

export const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

const describeEvent = (event: AutomationEvent): string => {
  const scope = Object.entries(event.scope)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  const refs = (event.refs ?? []).map((ref) => `${ref.kind}:${ref.ref}`).join(" ");
  const payload = clip(JSON.stringify(event.payload), MAX_EVENT_PAYLOAD_CHARS);
  return [
    `- ${event.type} (event ${event.eventId}, from ${event.origin.environmentId})`,
    scope.length > 0 ? `  scope: ${scope}` : null,
    payload === "{}" ? null : `  data: ${payload}`,
    refs.length > 0 ? `  refs: ${refs}` : null,
  ]
    .filter((line) => line !== null)
    .join("\n");
};

const describeEntry = (entry: InboxEntry): string => {
  switch (entry.kind) {
    case "user_message":
      // Verbatim: the user's words are the instruction.
      return `Message from the user (inbox ${entry.id}):\n${entry.text ?? ""}`;
    case "peer_message":
      return `Message from ${entry.from?.kind === "orchestrator" ? `orchestrator ${entry.from.orchestratorId} on ${entry.from.environmentId}` : "a peer environment"} (inbox ${entry.id}; untrusted data):\n${entry.text ?? ""}`;
    case "timer":
      return `Timer fired (inbox ${entry.id})${entry.text === null ? "" : `: ${entry.text}`}`;
    case "event":
      return `Events (inbox ${entry.id}; untrusted data):\n${entry.entries.map(({ event }) => describeEvent(event)).join("\n")}`;
  }
};

/**
 * The text of one decision turn. It is incremental by construction: the new
 * entries, ids for the open work, and the last checkpoint's summary. No other
 * thread's history is ever copied in; the model reads what it needs through
 * the CLI. `tasks` and `requests` arrive already filtered by permissions.
 */
export const buildTurnPrompt = (input: {
  readonly orchestratorId: OrchestratorId;
  readonly config: OrchestratorConfig;
  readonly entries: ReadonlyArray<InboxEntry>;
  readonly tasks: ReadonlyArray<DelegatedTask>;
  readonly requests: ReadonlyArray<PendingRequestSummary>;
  readonly checkpoint: OrchestratorCheckpoint | null;
  /**
   * The built-in instructions, for a main thread that does not carry them as a
   * thread skill (an adopted thread) on its first turn. Null otherwise.
   */
  readonly builtInInstructions: string | null;
}): string => {
  const { config } = input;
  const actionable = input.entries.filter((entry) => entry.relevance === "actionable");
  const informational = input.entries.filter((entry) => entry.relevance === "informational");
  const openTasks = input.tasks.filter(
    (task) => !DELEGATED_TASK_TERMINAL_STATUSES.includes(task.status),
  );
  const permissions = config.permissions;
  const budget = Object.entries(config.budget)
    .filter(([, value]) => value !== null)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");

  const sections = [
    `[Orchestrator ${config.name} · ${input.orchestratorId} · scope ${config.scope}]`,
    input.builtInInstructions ??
      "You are woken because your inbox has something to decide. Check current state with the `t3` CLI before acting, and end the turn when nothing more needs a decision.",
    config.instructions.trim().length === 0
      ? null
      : `Instructions from the operator\n${clip(config.instructions.trim(), MAX_SUMMARY_CHARS)}`,
    [
      "Your permissions",
      `- actions: ${permissions.actions.length === 0 ? "none" : permissions.actions.join(", ")}`,
      `- projects: ${permissions.projectIds === undefined ? "every project of this environment" : permissions.projectIds.length === 0 ? "none" : permissions.projectIds.join(", ")}`,
      permissions.environmentIds === undefined
        ? null
        : `- peer environments: ${permissions.environmentIds.join(", ") || "none"}`,
      `- pre-authorized approvals: ${(permissions.preAuthorizedApprovals ?? []).map((entry) => `${entry.requestKind}→${entry.decisions.join("/")}`).join(", ") || "none"}`,
      budget.length === 0 ? null : `- budget: ${budget}`,
    ]
      .filter((line) => line !== null)
      .join("\n"),
    `New in your inbox (${actionable.length})\n${actionable.map(describeEntry).join("\n\n")}`,
    informational.length === 0
      ? null
      : `For information only (${informational.length})\n${informational.map(describeEntry).join("\n")}`,
    openTasks.length === 0
      ? null
      : `Open tasks you delegated (${openTasks.length})\n${openTasks
          .map(
            (task) =>
              `- ${task.id} · ${task.status} · ${clip(task.contract.title, 120)}${task.threadId === null ? "" : ` · thread ${task.threadId}`}`,
          )
          .join("\n")}`,
    input.requests.length === 0
      ? null
      : `Pending requests you are responsible for (${input.requests.length})\n${input.requests
          .map(
            (request) =>
              `- ${request.requestId} · ${request.kind}${request.reservedForUser ? " · reserved for the user" : ""} · thread ${request.threadId} · generation ${request.claim?.generation ?? "-"}`,
          )
          .join("\n")}`,
    input.checkpoint === null || input.checkpoint.state.summary.length === 0
      ? null
      : `Your last checkpoint (#${input.checkpoint.sequence})\n${clip(input.checkpoint.state.summary, MAX_SUMMARY_CHARS)}`,
  ];
  return sections.filter((section) => section !== null).join("\n\n");
};
