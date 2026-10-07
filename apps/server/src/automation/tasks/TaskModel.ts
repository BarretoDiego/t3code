// @effect-diagnostics nodeBuiltinImport:off -- Ids are derived with a plain hash so a repeat reaches the same task.
import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  DELEGATED_TASK_TERMINAL_STATUSES,
  DelegatedTaskId,
  MessageId,
  ThreadId,
  type DelegatedTask,
  type DelegatedTaskContract,
  type DelegatedTaskStatus,
  type EnvironmentId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";

const digest = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");

const uuidShaped = (hex: string) =>
  `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;

/**
 * The task id for an idempotency key. It is scoped to the environment that
 * created the task, so two environments using the same key never collide.
 */
export const taskIdFor = (originEnvironmentId: EnvironmentId, idempotencyKey: string) =>
  DelegatedTaskId.make(`task-${digest(`${originEnvironmentId}\n${idempotencyKey}`).slice(0, 32)}`);

/**
 * Ids of what a task creates. They follow from the task id, so starting the
 * same task twice addresses the same thread, message and commands instead of
 * creating a second set.
 */
export const taskThreadId = (taskId: DelegatedTaskId) =>
  ThreadId.make(uuidShaped(digest(`thread\n${taskId}`)));
export const taskMessageId = (taskId: DelegatedTaskId, part: string) =>
  MessageId.make(uuidShaped(digest(`message\n${taskId}\n${part}`)));
export const taskCommandId = (taskId: DelegatedTaskId, part: string) =>
  CommandId.make(`task:${taskId}:${part}`);

/** What can be done to a thread T3 launched itself. */
export const MANAGED_THREAD_CAPABILITIES: DelegatedTask["capabilities"] = {
  send: true,
  answer: true,
  cancel: true,
  read: true,
};

/** A subagent the provider runs on its own can only be watched. */
export const NATIVE_SUBAGENT_CAPABILITIES: DelegatedTask["capabilities"] = {
  send: false,
  answer: false,
  cancel: false,
  read: true,
};

export const isTerminalTaskStatus = (status: DelegatedTaskStatus) =>
  DELEGATED_TASK_TERMINAL_STATUSES.includes(status);

const bullets = (items: ReadonlyArray<string>) => items.map((item) => `- ${item}`).join("\n");

/** The first message of a managed thread: the whole contract, and how to report back. */
export function renderTaskPrompt(input: {
  readonly taskId: DelegatedTaskId;
  readonly contract: DelegatedTaskContract;
}): string {
  const { contract } = input;
  const sections = [
    `# Delegated task: ${contract.title}`,
    `Task id: ${input.taskId}`,
    `## Objective\n${contract.objective}`,
    ...(contract.context === undefined || contract.context.trim().length === 0
      ? []
      : [`## Context\n${contract.context.trim()}`]),
    ...(contract.deliverables.length === 0
      ? []
      : [`## Deliverables\n${bullets(contract.deliverables)}`]),
    ...(contract.acceptanceCriteria.length === 0
      ? []
      : [`## Acceptance criteria\n${bullets(contract.acceptanceCriteria)}`]),
    ...(contract.refs === undefined || contract.refs.length === 0
      ? []
      : [
          `## References\n${bullets(
            contract.refs.map((ref) => `${ref.label ?? ref.kind}: ${ref.ref}`),
          )}`,
        ]),
    ...(contract.deadline === undefined ? [] : [`## Deadline\n${contract.deadline}`]),
    [
      "## How to report",
      "Finish with one final message that states what you delivered and, for each",
      "acceptance criterion, whether it is met and the evidence. That message is",
      "recorded as your report. It is checked against the criteria by whoever",
      "delegated the task; reporting does not by itself mark the task as accepted.",
      "If you are blocked, ask a question instead of guessing.",
    ].join("\n"),
  ];
  return sections.join("\n\n");
}

/** What a thread's own records say, reduced to what a task's status depends on. */
export interface TaskThreadFacts {
  readonly exists: boolean;
  /** Status of the newest run, or null when the thread has none. */
  readonly latestRunStatus: OrchestrationV2ThreadProjection["runs"][number]["status"] | null;
  readonly runCount: number;
  readonly pendingRequests: number;
  /** A provider session that could still be producing the newest run's outcome. */
  readonly liveSession: boolean;
  /** Assistant text after the newest user message. */
  readonly reply: string;
  readonly lastError: string | null;
}

export function taskThreadFacts(
  projection: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "runs" | "runtimeRequests" | "messages" | "providerSessions"
  >,
): TaskThreadFacts {
  const latestRun = projection.runs.toSorted((left, right) => right.ordinal - left.ordinal)[0];
  const lastUserIndex = projection.messages.findLastIndex((message) => message.role === "user");
  return {
    exists: projection.thread.deletedAt === null,
    latestRunStatus: latestRun?.status ?? null,
    runCount: projection.runs.length,
    pendingRequests: projection.runtimeRequests.filter(
      (request) => request.status === "pending" && request.kind !== "auth_refresh",
    ).length,
    liveSession: projection.providerSessions.some(
      (session) => session.status !== "stopped" && session.status !== "error",
    ),
    reply: projection.messages
      .slice(lastUserIndex + 1)
      .filter((message) => message.role === "assistant" && message.text.trim().length > 0)
      .map((message) => message.text.trim())
      .join("\n\n"),
    lastError: latestRun?.status === "failed" ? "The child run failed." : null,
  };
}

export interface TaskStateChange {
  readonly status: DelegatedTaskStatus;
  readonly statusReason: string | null;
  /** The child's final answer, when the change is a report. */
  readonly summary?: string;
}

/**
 * The status a locally executed task has, given its thread's facts. Returns
 * null when nothing changes.
 *
 * `reconcile` is a deliberate re-read (startup, or the `reconcile` action). It
 * is the only mode that can conclude `unknown`: a run marked active with no
 * provider session behind it has an outcome nobody can establish. A live event
 * never concludes that on its own, because the session attaches a moment after
 * the run starts.
 */
export function deriveTaskState(
  task: Pick<DelegatedTask, "status" | "statusReason" | "result">,
  facts: TaskThreadFacts,
  mode: "live" | "reconcile",
): TaskStateChange | null {
  // Only an explicit action leaves a terminal status, and only validation
  // (never a later run) may follow a validated task.
  if (isTerminalTaskStatus(task.status)) return null;
  const change = ((): TaskStateChange => {
    if (!facts.exists) {
      return task.status === "cancel_requested"
        ? { status: "cancelled", statusReason: "The task's thread was deleted." }
        : { status: "failed", statusReason: "The task's thread was deleted." };
    }
    const run = facts.latestRunStatus;
    if (run === null) return { status: "accepted", statusReason: null };
    const active =
      run === "queued" ||
      run === "preparing" ||
      run === "starting" ||
      run === "running" ||
      run === "waiting";
    if (task.status === "cancel_requested") {
      // Cancellation is confirmed by the run stopping, not by asking for it.
      return active
        ? { status: "cancel_requested", statusReason: task.statusReason }
        : { status: "cancelled", statusReason: task.statusReason };
    }
    if (facts.pendingRequests > 0) {
      return {
        status: "blocked",
        statusReason: `Waiting on ${facts.pendingRequests} pending request${facts.pendingRequests === 1 ? "" : "s"}.`,
      };
    }
    switch (run) {
      case "queued":
      case "preparing":
        // Before the first run starts the task is only accepted; a later run
        // (a follow-up message, a rejection) keeps it running.
        return task.status === "accepted" || task.status === "pending_delivery"
          ? { status: "accepted", statusReason: null }
          : { status: "running", statusReason: null };
      case "starting":
      case "running":
      case "waiting":
        return !facts.liveSession && (mode === "reconcile" || task.status === "unknown")
          ? {
              status: "unknown",
              statusReason:
                "The run is marked active but no provider session is attached, so its outcome cannot be established.",
            }
          : { status: "running", statusReason: null };
      case "completed":
        return { status: "reported", statusReason: null, summary: facts.reply };
      case "failed":
        return { status: "failed", statusReason: facts.lastError ?? "The child run failed." };
      case "interrupted":
      case "cancelled":
      case "rolled_back":
        return {
          status: "blocked",
          statusReason: `The child run was ${run === "rolled_back" ? "rolled back" : run} and nothing is running.`,
        };
    }
  })();
  const sameSummary =
    change.summary === undefined ||
    (task.result !== null && task.result.summary === change.summary);
  return change.status === task.status && change.statusReason === task.statusReason && sameSummary
    ? null
    : change;
}

/** The journal event that reports a status. */
export function taskEventType(status: DelegatedTaskStatus) {
  switch (status) {
    case "pending_delivery":
      return "task.delegated" as const;
    case "accepted":
      return "task.accepted" as const;
    case "running":
    case "cancel_requested":
      return "task.progress" as const;
    case "blocked":
      return "task.blocked" as const;
    case "reported":
      return "task.reported" as const;
    case "validated":
      return "task.validated" as const;
    case "failed":
    case "expired":
      return "task.failed" as const;
    case "cancelled":
      return "task.cancelled" as const;
    case "unknown":
      return "task.unknown" as const;
  }
}
