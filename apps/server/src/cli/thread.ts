import * as NodeCrypto from "node:crypto";

import {
  AUTOMATION_WS_METHODS,
  CommandId,
  MessageId,
  ModelSelection,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationProjectShell,
  type OrchestrationV2Command,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  ProviderApprovalDecision,
  ProviderInteractionMode,
  type ProjectId,
  type RunId,
  RuntimeMode,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import { resolveThreadAwarenessPhaseV2 } from "@t3tools/shared/agentAwareness";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import { HostProcessWorkingDirectory } from "@t3tools/shared/hostProcess";
import { topOfPinnedOrderKey } from "@t3tools/shared/pinOrderKey";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { Argument, Command, Flag } from "effect/unstable/cli";

import {
  type CliFailure,
  cliFailure,
  commandIdFor,
  failCli,
  idempotencyKeyFlag,
  jsonFlag,
  printJson,
  timeoutFlag,
  withClient,
} from "./common.ts";
import { DurationFromString } from "./config.ts";
import { resolveTurnLibrary, type TurnLibraryExtras } from "./library.ts";
import { type EnvironmentRpcClient, environmentTargetFlags } from "./environmentRpc.ts";

export class ThreadCliError extends Schema.TaggedError<ThreadCliError>()("ThreadCliError", {
  reason: Schema.Literals([
    "project-not-found",
    "thread-not-found",
    "ambiguous",
    "no-pending-request",
    "invalid-input",
    "model-unresolved",
    "timeout",
    "unavailable",
  ]),
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

const fail = (reason: ThreadCliError["reason"], detail: string) =>
  Effect.fail(new ThreadCliError({ reason, detail }));

// ---------------------------------------------------------------------------
// Status

/** Every value `thread.status` can take, in the order `--status` lists them. */
export const THREAD_STATUSES = [
  "queued",
  "starting",
  "running",
  "waiting_for_approval",
  "waiting_for_input",
  "completed",
  "failed",
  "interrupted",
  "idle",
] as const;

/**
 * The single status word a script branches on. Mirrors the sidebar: attention
 * states win over activity, and a message queued behind (or ahead of) a run
 * reads as queued rather than as the previous turn's "completed".
 */
export type ThreadStatus = (typeof THREAD_STATUSES)[number];

/** The shell fields the status and wait rules read. */
export type ThreadStatusInput = Pick<
  OrchestrationV2ThreadShell,
  | "activityRunStatus"
  | "id"
  | "lineage"
  | "modelSelection"
  | "pendingBackgroundTasks"
  | "pendingRuntimeRequest"
  | "status"
  | "title"
  | "updatedAt"
  | "latestUserMessageAt"
>;

export function resolveThreadStatus(thread: ThreadStatusInput): ThreadStatus {
  const phase = resolveThreadAwarenessPhaseV2(thread);
  if (phase === "waiting_for_approval" || phase === "waiting_for_input" || phase === "failed") {
    return phase;
  }
  if (phase === "starting" || phase === "running") return phase;
  // The latest run waits behind a held queue or a run that is still settling.
  if (thread.status === "queued") return "queued";
  if (phase === "completed") return phase;
  if (thread.status === "interrupted" || thread.status === "cancelled") return "interrupted";
  return "idle";
}

const BUSY_STATUSES: ReadonlySet<ThreadStatus> = new Set(["queued", "starting", "running"]);

/**
 * Whether a waiter can return: the agent stopped or needs a human. When
 * `sentAfter` is given, the thread must first show a user message newer than
 * it (the server's `latestUserMessageAt` read before sending; null when the
 * thread had none), so a wait issued right after a send never returns on the
 * previous turn. Both sides are server timestamps, so client clock skew does
 * not matter.
 */
export function isThreadSettledForWait(
  thread: ThreadStatusInput,
  sentAfter?: DateTime.Utc | null,
): boolean {
  const status = resolveThreadStatus(thread);
  if (status === "waiting_for_approval" || status === "waiting_for_input") return true;
  if (sentAfter !== undefined) {
    const latest = thread.latestUserMessageAt;
    if (latest === null) return false;
    if (sentAfter !== null && DateTime.toEpochMillis(latest) <= DateTime.toEpochMillis(sentAfter)) {
      return false;
    }
  }
  return !BUSY_STATUSES.has(status);
}

// ---------------------------------------------------------------------------
// Server reads

const formatTime = (value: DateTime.Utc | null | undefined) =>
  value === null || value === undefined ? null : DateTime.formatIso(value);

export const loadShell = <E>(client: {
  readonly [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: (input: {}) => Stream.Stream<
    OrchestrationV2ShellStreamItem,
    E
  >;
}) =>
  client[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({}).pipe(
    Stream.filterMap((item) =>
      item.kind === "snapshot" ? Result.succeed(item.snapshot) : Result.fail(item),
    ),
    Stream.runHead,
    Effect.flatMap(
      Option.match({
        onNone: () => fail("unavailable", "The server closed the shell stream."),
        onSome: Effect.succeed,
      }),
    ),
  );

const loadArchivedShell = (client: EnvironmentRpcClient) =>
  client[ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot]({});

const loadThreadDetail = (client: EnvironmentRpcClient, threadId: ThreadId) =>
  client[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({ threadId });

// ---------------------------------------------------------------------------
// Resolution

function matchByIdOrPrefix<T extends { readonly id: string }>(
  items: ReadonlyArray<T>,
  identifier: string,
): ReadonlyArray<T> {
  const exact = items.find((item) => item.id === identifier);
  if (exact) return [exact];
  return items.filter((item) => item.id.startsWith(identifier));
}

/**
 * Resolves a thread by full id or unique id prefix, active threads first. An
 * ambiguous prefix is refused rather than resolved to any one thread, so a
 * mutation never lands on a thread the caller did not name.
 */
export const resolveThread = Effect.fn("cli.thread.resolve")(function* (
  client: EnvironmentRpcClient,
  identifier: string,
) {
  const trimmed = identifier.trim();
  if (trimmed.length === 0) return yield* fail("invalid-input", "Thread id cannot be empty.");
  const shell = yield* loadShell(client);
  let matches = matchByIdOrPrefix(shell.threads, trimmed);
  if (matches.length === 0) {
    const archivedShell = yield* loadArchivedShell(client);
    matches = matchByIdOrPrefix(archivedShell.threads, trimmed);
  }
  if (matches.length === 0) {
    return yield* fail("thread-not-found", `No thread matches '${trimmed}'.`);
  }
  if (matches.length > 1) {
    return yield* fail(
      "ambiguous",
      `'${trimmed}' matches ${matches.length} threads: ${matches
        .slice(0, 5)
        .map((thread) => thread.id)
        .join(", ")}. Use a longer prefix.`,
    );
  }
  const thread = matches[0]!;
  const project = shell.projects.find((entry) => entry.id === thread.projectId);
  return { shell, thread, project } as const;
});

/** Resolves a project by id, id prefix, workspace path, or exact title. */
export const resolveProject = Effect.fn("cli.thread.resolveProject")(function* (
  shell: OrchestrationV2ShellSnapshot,
  identifier: string,
) {
  const path = yield* Path.Path;
  const trimmed = identifier.trim();
  const byId = matchByIdOrPrefix(shell.projects, trimmed);
  if (byId.length === 1) return byId[0]!;
  const resolvedPath = path.resolve(trimmed);
  const byPath = shell.projects.find(
    (project) => project.workspaceRoot === resolvedPath || project.workspaceRoot === trimmed,
  );
  if (byPath) return byPath;
  const byTitle = shell.projects.filter(
    (project) => project.title.toLowerCase() === trimmed.toLowerCase(),
  );
  if (byTitle.length === 1) return byTitle[0]!;
  // A path inside a project's workspace (e.g. the cwd of a subdirectory).
  const containing = shell.projects
    .filter((project) => resolvedPath.startsWith(`${project.workspaceRoot}${path.sep}`))
    .toSorted((left, right) => right.workspaceRoot.length - left.workspaceRoot.length);
  if (containing.length > 0) return containing[0]!;
  return yield* fail(
    "project-not-found",
    `No project matches '${trimmed}'. Run \`t3 project list\` to see projects, or \`t3 project add <path>\` to add one.`,
  );
});

const decodeModelSelection = Schema.decodeEffect(ModelSelection);

export const parseModelSelection = Effect.fn("cli.thread.parseModel")(function* (
  value: string,
  fallbackInstanceId: string | undefined,
) {
  const separator = value.indexOf("/");
  const instanceId = separator > 0 ? value.slice(0, separator) : fallbackInstanceId;
  const model = separator > 0 ? value.slice(separator + 1) : value;
  if (instanceId === undefined || model.trim().length === 0) {
    return yield* fail(
      "invalid-input",
      `Use --model <provider-instance>/<model>, for example --model codex/gpt-5.`,
    );
  }
  return yield* decodeModelSelection({ instanceId, model }).pipe(
    Effect.mapError(
      () => new ThreadCliError({ reason: "invalid-input", detail: "Invalid model." }),
    ),
  );
});

/**
 * The model a new thread starts on, in the order the composer uses: an
 * explicit flag, the project's (or environment's) default, then the model of
 * the most recent thread in the project.
 */
export const resolveNewThreadDefaults = Effect.fn("cli.thread.newDefaults")(function* (
  client: EnvironmentRpcClient,
  shell: OrchestrationV2ShellSnapshot,
  project: OrchestrationProjectShell,
  modelFlag: Option.Option<string>,
) {
  const settings = yield* client[WS_METHODS.serverGetSettings]({});
  const resolved = resolveProjectSettings(settings, project.id, project).settings;
  const recent = shell.threads
    .filter((thread) => thread.projectId === project.id)
    .toSorted(
      (left, right) =>
        DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
    )[0];
  const fallback = resolved.defaultModelSelection ?? recent?.modelSelection ?? null;
  const modelSelection = Option.isSome(modelFlag)
    ? yield* parseModelSelection(modelFlag.value, fallback?.instanceId)
    : fallback;
  if (modelSelection === null) {
    return yield* fail(
      "model-unresolved",
      "No default model is configured for this project. Pass --model <provider-instance>/<model>.",
    );
  }
  return { modelSelection, runtimeMode: resolved.defaultRuntimeMode };
});

// ---------------------------------------------------------------------------
// Presentation

export function formatModel(selection: { readonly instanceId: string; readonly model: string }) {
  return `${selection.instanceId}/${selection.model}`;
}

function summarizeThread(
  thread: OrchestrationV2ThreadShell,
  project: OrchestrationProjectShell | undefined,
) {
  return {
    id: thread.id,
    title: thread.title,
    status: resolveThreadStatus(thread),
    projectId: thread.projectId,
    projectTitle: project?.title ?? null,
    model: formatModel(thread.modelSelection),
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    // How the thread is organized. None of these says what its agent is doing.
    archived: thread.archivedAt !== null,
    settled: thread.settledAt !== null,
    pinned: (thread.pinnedAt ?? null) !== null,
    pinOrderKey: thread.pinOrderKey ?? null,
    snoozedUntil: formatTime(thread.snoozedUntil),
    hasPendingApprovals:
      thread.pendingRuntimeRequest !== null &&
      thread.pendingRuntimeRequest.kind !== "user_input" &&
      thread.pendingRuntimeRequest.kind !== "auth_refresh",
    hasPendingUserInput: thread.pendingRuntimeRequest?.kind === "user_input",
    hasActionableProposedPlan: thread.hasActionableProposedPlan,
    pendingBackgroundTasks: (thread.pendingBackgroundTasks ?? []).map(
      (task) => task.description ?? task.kind,
    ),
    lastError: thread.lastError ?? null,
    pullRequests: (thread.pullRequests ?? [])
      .filter((link) => link.source !== "stack-dismissed")
      .map((link) => link.url),
    latestUserMessageAt: formatTime(thread.latestUserMessageAt),
    updatedAt: DateTime.formatIso(thread.updatedAt),
  };
}

type ThreadSummary = ReturnType<typeof summarizeThread>;

/** User and assistant messages from the `turns` most recent user messages on. */
function conversationMessages(projection: OrchestrationV2ThreadProjection, turns: number) {
  const visible = projection.messages.filter(
    (message) => message.role === "user" || message.role === "assistant",
  );
  const userIndexes = visible.flatMap((message, index) => (message.role === "user" ? [index] : []));
  const start = userIndexes.length > turns ? (userIndexes[userIndexes.length - turns] ?? 0) : 0;
  const promptContexts = new Map(
    projection.turnItems.flatMap((item) =>
      item.type === "user_message" && item.promptContext !== undefined
        ? [[item.messageId, item.promptContext] as const]
        : [],
    ),
  );
  return visible.slice(start).map((message) => {
    const promptContext = promptContexts.get(message.id);
    return {
      id: message.id,
      role: message.role,
      text: message.text,
      streaming: message.streaming,
      createdAt: DateTime.formatIso(message.createdAt),
      appliedSkills: promptContext
        ? [...promptContext.threadSkills, ...promptContext.requestSkills]
        : [],
      appliedProfile: promptContext?.profileName ?? null,
    };
  });
}

/** Assistant text produced after the latest user message: the agent's reply. */
function latestReply(messages: ReadonlyArray<OrchestrationV2ConversationMessage>): string {
  const lastUserIndex = messages.findLastIndex((message) => message.role === "user");
  return messages
    .slice(lastUserIndex + 1)
    .filter((message) => message.role === "assistant" && message.text.trim().length > 0)
    .map((message) => message.text.trim())
    .join("\n\n");
}

type RuntimeRequest = OrchestrationV2ThreadProjection["runtimeRequests"][number];

const isApprovalRequest = (request: RuntimeRequest) =>
  request.kind !== "user_input" && request.kind !== "auth_refresh";

/** An approval as the app shows it: what is asked, and the decisions the provider offers. */
function describeApproval(projection: OrchestrationV2ThreadProjection, request: RuntimeRequest) {
  const item = projection.turnItems.find(
    (candidate) => candidate.type === "approval_request" && candidate.requestId === request.id,
  );
  const approval = item?.type === "approval_request" ? item : undefined;
  const prompt = approval?.prompt;
  const options = approval?.options ?? null;
  return {
    requestId: request.id,
    requestKind: request.kind,
    status: request.status,
    createdAt: DateTime.formatIso(request.createdAt),
    detail: prompt === undefined || prompt.trim().length === 0 ? null : prompt.trim(),
    appName: approval?.appName ?? null,
    /** Null when the provider advertised no choices; every decision is then accepted. */
    options,
    decisions:
      options === null
        ? [...ProviderApprovalDecision.literals]
        : options.map((option) => option.decision),
  };
}

/** A question request as the app shows it: every option's value and each question's rules. */
function describeUserInput(projection: OrchestrationV2ThreadProjection, request: RuntimeRequest) {
  const item = projection.turnItems.find(
    (candidate) => candidate.type === "user_input_request" && candidate.requestId === request.id,
  );
  const input = item?.type === "user_input_request" ? item : undefined;
  return {
    requestId: request.id,
    status: request.status,
    createdAt: DateTime.formatIso(request.createdAt),
    // Only questions the server can close with a message reply may be dismissed.
    dismissible: request.responseCapability.type === "message",
    questions: (input?.questions ?? []).map((question) => ({
      id: question.id,
      header: question.header,
      question: question.question,
      options: question.options.map((option) => ({
        label: option.label,
        description: option.description,
        /** What to pass as the answer to pick this option. */
        value: option.value ?? option.label,
      })),
      multiSelect: question.multiSelect ?? false,
      allowCustomAnswer: question.allowCustomAnswer !== false,
      required: question.required !== false,
    })),
  };
}

type DescribedQuestion = ReturnType<typeof describeUserInput>["questions"][number];

const oldestFirst = (left: RuntimeRequest, right: RuntimeRequest) =>
  DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt);

/**
 * Pending runtime requests, oldest first, with the detail their turn items
 * carry: approvals (anything but a question or an auth refresh) and questions.
 */
function pendingRequests(projection: OrchestrationV2ThreadProjection) {
  const pending = projection.runtimeRequests
    .filter((request) => request.status === "pending" && request.kind !== "auth_refresh")
    .toSorted(oldestFirst);
  return {
    approvals: pending
      .filter(isApprovalRequest)
      .map((request) => describeApproval(projection, request)),
    userInputs: pending
      .filter((request) => request.kind === "user_input")
      .map((request) => describeUserInput(projection, request)),
  };
}

function threadAttention(projection: OrchestrationV2ThreadProjection) {
  const pending = pendingRequests(projection);
  const plan = projection.plans.findLast(
    (entry) =>
      entry.kind === "proposed_plan" && (entry.status === "draft" || entry.status === "active"),
  );
  const planItem =
    plan === undefined
      ? undefined
      : projection.turnItems.findLast(
          (item) => item.type === "proposed_plan" && item.planId === plan.id,
        );
  const markdown =
    planItem?.type === "proposed_plan"
      ? planItem.markdown
      : plan?.kind === "proposed_plan"
        ? plan.markdown
        : "";
  return {
    pendingApprovals: pending.approvals,
    pendingUserInputs: pending.userInputs,
    proposedPlan: plan ? { id: plan.id, markdown } : null,
  };
}

function formatSummaryLine(summary: ThreadSummary): string {
  const flags = [
    summary.archived ? "archived" : null,
    summary.settled ? "settled" : null,
    summary.pinned ? "pinned" : null,
    summary.snoozedUntil ? `snoozed until ${summary.snoozedUntil}` : null,
  ].filter((flag) => flag !== null);
  return [
    summary.id,
    summary.status.padEnd(20),
    `${summary.projectTitle ?? summary.projectId} · ${summary.title}`,
    flags.length > 0 ? `[${flags.join(", ")}]` : "",
  ]
    .join("  ")
    .trimEnd();
}

function formatAttention(attention: ReturnType<typeof threadAttention>): ReadonlyArray<string> {
  const lines: string[] = [];
  for (const approval of attention.pendingApprovals) {
    lines.push(
      `Approval needed (${approval.requestKind}) request ${approval.requestId}${approval.detail ? `: ${approval.detail}` : ""}`,
      `  decisions: ${approval.decisions.join(" | ")}`,
    );
  }
  for (const input of attention.pendingUserInputs) {
    lines.push(`Question request ${input.requestId}:`);
    for (const question of input.questions) {
      const options = question.options.map((option) => option.value).join(" | ");
      const rules = [
        question.multiSelect ? "multi-select" : null,
        question.options.length > 0 && !question.allowCustomAnswer ? "options only" : null,
        question.required ? null : "optional",
      ].filter((rule) => rule !== null);
      lines.push(
        `  [${question.id}] ${question.question}${options ? ` (${options})` : ""}${rules.length > 0 ? ` [${rules.join(", ")}]` : ""}`,
      );
    }
  }
  if (attention.proposedPlan) {
    lines.push(`Proposed plan ${attention.proposedPlan.id}:`, attention.proposedPlan.markdown);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Requests

/**
 * The request a response is for. An explicit id (or unique prefix) may name a
 * request in any state: the server decides whether it can still be answered,
 * so a retry with the same idempotency key reaches its stored result. Without
 * an id there must be exactly one pending request of the kind; more than one
 * is refused instead of answering the oldest.
 */
const selectRequest = Effect.fn("cli.thread.selectRequest")(function* (
  projection: OrchestrationV2ThreadProjection,
  kind: "approval" | "question",
  requested: Option.Option<string>,
) {
  const ofKind = (request: RuntimeRequest) =>
    kind === "approval" ? isApprovalRequest(request) : request.kind === "user_input";
  const threadId = projection.thread.id;
  if (Option.isSome(requested)) {
    const identifier = requested.value.trim();
    const matches = matchByIdOrPrefix(projection.runtimeRequests, identifier);
    if (matches.length === 0) {
      return yield* failCli("NOT_FOUND", `Thread ${threadId} has no request '${identifier}'.`, {
        threadId,
      });
    }
    if (matches.length > 1) {
      return yield* failCli(
        "CONFLICT",
        `'${identifier}' matches ${matches.length} requests: ${matches
          .slice(0, 5)
          .map((request) => request.id)
          .join(", ")}. Use the full request id.`,
        { threadId },
      );
    }
    const request = matches[0]!;
    if (!ofKind(request)) {
      return yield* failCli(
        "INVALID_INPUT",
        kind === "approval"
          ? `Request ${request.id} is not an approval. Use \`t3 thread answer\`: a decision does not answer a question.`
          : `Request ${request.id} is not a question. Use \`t3 thread approve\`: an answer does not approve an action.`,
        { threadId, requestId: request.id, kind: request.kind },
      );
    }
    return request;
  }
  const pending = projection.runtimeRequests
    .filter((request) => request.status === "pending" && ofKind(request))
    .toSorted(oldestFirst);
  if (pending.length === 0) {
    return yield* failCli(
      "NOT_FOUND",
      `Thread ${threadId} has no pending ${kind}. To repeat an earlier response, pass --request <id> with its --idempotency-key.`,
      { threadId },
    );
  }
  if (pending.length > 1) {
    return yield* failCli(
      "CONFLICT",
      `Thread ${threadId} has ${pending.length} pending ${kind}s: ${pending
        .map((request) => request.id)
        .join(", ")}. Pass --request <id>.`,
      { threadId, pending: pending.length },
    );
  }
  return pending[0]!;
});

/**
 * Turns the values given for one question into the answer the app would send:
 * an option's value, an array of them for multi-select, or free text where the
 * question allows it.
 */
const resolveAnswer = Effect.fn("cli.thread.resolveAnswer")(function* (
  question: DescribedQuestion,
  values: ReadonlyArray<string>,
) {
  const invalid = (message: string) =>
    failCli("INVALID_INPUT", `Question '${question.id}': ${message}`, { questionId: question.id });
  const optionValue = (value: string) =>
    question.options.find((option) => option.value === value)?.value ??
    question.options.find((option) => option.label === value)?.value;
  const selected = values.map(optionValue);
  const custom = values.filter((_, index) => selected[index] === undefined);
  if (custom.some((value) => value.trim().length === 0)) {
    return yield* invalid("an answer cannot be empty.");
  }
  if (custom.length > 0) {
    if (!question.allowCustomAnswer) {
      return yield* invalid(
        `'${custom[0]}' is not one of its options (${question.options
          .map((option) => option.value)
          .join(" | ")}), and it takes no free text.`,
      );
    }
    if (values.length > 1) {
      return yield* invalid(
        question.multiSelect
          ? "give option values or one free-text answer, not both."
          : `it takes a single answer; got ${values.length}.`,
      );
    }
    return custom[0]!;
  }
  if (!question.multiSelect) {
    if (values.length > 1) {
      return yield* invalid(`it takes a single answer; got ${values.length}.`);
    }
    return selected[0]!;
  }
  return [...new Set(selected.filter((value) => value !== undefined))];
});

// ---------------------------------------------------------------------------
// Waiting

/**
 * Follows the shell stream until the thread settles (see
 * `isThreadSettledForWait`). Event-driven: every shell update re-evaluates the
 * thread, so there is no polling interval to tune.
 */
const waitForThread = Effect.fn("cli.thread.wait")(function* (
  client: EnvironmentRpcClient,
  threadId: ThreadId,
  options: {
    readonly sentAfter?: DateTime.Utc | null;
    readonly timeout: Option.Option<Duration.Duration>;
  },
) {
  let current: OrchestrationV2ThreadShell | undefined;
  const settled = client[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({}).pipe(
    Stream.mapEffect((item) =>
      Effect.gen(function* () {
        if (item.kind === "snapshot") {
          current = item.snapshot.threads.find((thread) => thread.id === threadId);
          if (current === undefined) {
            return yield* fail("thread-not-found", `Thread ${threadId} is not active.`);
          }
        } else if (item.kind === "thread.updated" && item.thread.id === threadId) {
          current = item.thread;
        } else if (
          item.kind === "thread.removed" &&
          item.threadId === threadId &&
          item.location === "active"
        ) {
          return yield* fail("thread-not-found", `Thread ${threadId} was removed.`);
        } else {
          return null;
        }
        return current !== undefined && isThreadSettledForWait(current, options.sentAfter)
          ? current
          : null;
      }),
    ),
    Stream.filterMap((value) => (value === null ? Result.fail(value) : Result.succeed(value))),
    Stream.runHead,
    Effect.flatMap(
      Option.match({
        onNone: () => fail("unavailable", "The server closed the shell stream."),
        onSome: Effect.succeed,
      }),
    ),
  );
  if (Option.isNone(options.timeout)) return yield* settled;
  return yield* settled.pipe(
    Effect.timeoutOrElse({
      duration: options.timeout.value,
      // Giving up on the wait changes nothing on the server: the turn keeps running.
      orElse: () => {
        const status = current ? resolveThreadStatus(current) : "running";
        return Effect.fail(
          cliFailure(
            "WAIT_TIMEOUT",
            `Timed out waiting for thread ${threadId}. Nothing was cancelled: it is still ${status}.`,
            { threadId, status, cancelled: false },
          ),
        );
      },
    }),
  );
});

/** Waits, then prints the outcome an agent needs: status, reply, and blockers. */
const waitAndReport = Effect.fn("cli.thread.waitAndReport")(function* (
  client: EnvironmentRpcClient,
  threadId: ThreadId,
  options: {
    readonly sentAfter?: DateTime.Utc | null;
    readonly timeout: Option.Option<Duration.Duration>;
    readonly json: boolean;
  },
) {
  const settled = yield* waitForThread(client, threadId, options);
  const detail = yield* loadThreadDetail(client, threadId);
  const shell = yield* loadShell(client);
  const summary = summarizeThread(
    settled,
    shell.projects.find((project) => project.id === settled.projectId),
  );
  const reply = latestReply(detail.messages);
  const attention = threadAttention(detail);
  if (options.json) {
    return yield* printJson({ thread: summary, reply, ...attention });
  }
  yield* Console.log(formatSummaryLine(summary));
  if (summary.lastError) yield* Console.log(`Error: ${summary.lastError}`);
  if (reply) yield* Console.log(`\n${reply}`);
  const blockers = formatAttention(attention);
  if (blockers.length > 0) yield* Console.log(`\n${blockers.join("\n")}`);
});

// ---------------------------------------------------------------------------
// Input

export const readMessage = Effect.fn("cli.thread.readMessage")(function* (
  parts: ReadonlyArray<string>,
) {
  const joined = parts.join(" ");
  if (joined.trim().length > 0 && joined !== "-") return joined;
  const stdio = yield* Stdio.Stdio;
  if (joined !== "-" && (yield* stdio.stdinIsTerminal)) {
    return yield* fail("invalid-input", "Pass a message, or pipe one on stdin.");
  }
  const text = yield* stdio.stdin.pipe(Stream.decodeText(), Stream.mkString);
  if (text.trim().length === 0) return yield* fail("invalid-input", "The message is empty.");
  return text;
});

function threadTitleFromPrompt(text: string): string {
  const compact = text.trim().replace(/\s+/g, " ");
  if (compact.length === 0) return "New thread";
  return compact.length <= 72 ? compact : `${compact.slice(0, 69).trimEnd()}...`;
}

const newId = () => NodeCrypto.randomUUID();

/**
 * An id for something a keyed command creates (a thread, a message): the same
 * key always yields the same id, so a repeat addresses what the first attempt
 * created. Random without a key.
 */
const entityIdFor = (key: Option.Option<string>, part: string) =>
  Option.match(key, {
    onNone: newId,
    onSome: (value) => {
      const hex = NodeCrypto.createHash("sha256").update(`${part}\n${value.trim()}`).digest("hex");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
    },
  });

// ---------------------------------------------------------------------------
// Flags

const threadArgument = Argument.String("thread").pipe(
  Argument.withDescription("Thread id or unique id prefix."),
);
const waitFlag = Flag.Boolean("wait").pipe(
  Flag.withDescription(
    "Block until the agent finishes or needs approval/input, then print its reply.",
  ),
  Flag.withDefault(false),
);
export const modelFlag = Flag.String("model").pipe(
  Flag.withDescription(
    "Model as <provider-instance>/<model>, or just <model> on the same provider.",
  ),
  Flag.optional,
);
export const runtimeModeFlag = Flag.Literals("runtime-mode", RuntimeMode.literals).pipe(
  Flag.withDescription("Permission mode for the agent."),
  Flag.optional,
);
export const interactionModeFlag = Flag.Literals("mode", ProviderInteractionMode.literals).pipe(
  Flag.withDescription("`plan` asks the agent for a plan instead of making changes."),
  Flag.optional,
);
const skillFlag = Flag.String("skill").pipe(
  Flag.withDescription("Mini skill (id or name) for this message only; repeatable."),
  Flag.atLeast(0),
);
const profileFlag = Flag.String("profile").pipe(
  Flag.withDescription("Agent profile (slug, id, or name) for this message."),
  Flag.optional,
);

/** Fields `--skill`/`--profile` add to a turn-start command. */
function libraryTurnFields(library: TurnLibraryExtras) {
  return {
    ...(library.miniSkillIds.length > 0 ? { miniSkillIds: [...library.miniSkillIds] } : {}),
    ...(library.agentProfile !== null ? { agentProfile: library.agentProfile } : {}),
  };
}

const messageArgument = Argument.String("message").pipe(
  Argument.withDescription("Message text. Omit or pass - to read it from stdin."),
  Argument.variadic(),
);

/** Dispatches one orchestration command on the live server. */
const dispatch = (client: EnvironmentRpcClient, command: OrchestrationV2Command) =>
  client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](command);

/** Provenance of messages the CLI sends: a user, acting through this host. */
export const CLI_PROVENANCE = { createdBy: "user", creationSource: "server" } as const;

/**
 * Applies the runtime and interaction modes a turn asks for. V2 keeps them on
 * the thread rather than on each message, so a changed mode is set first.
 */
const applyThreadModes = Effect.fn("cli.thread.applyModes")(function* (
  client: EnvironmentRpcClient,
  thread: Pick<OrchestrationV2ThreadShell, "id" | "runtimeMode" | "interactionMode">,
  modes: {
    readonly runtimeMode: Option.Option<RuntimeMode>;
    readonly interactionMode: Option.Option<ProviderInteractionMode>;
    readonly idempotencyKey: Option.Option<string>;
  },
) {
  if (Option.isSome(modes.runtimeMode) && modes.runtimeMode.value !== thread.runtimeMode) {
    yield* dispatch(client, {
      type: "thread.runtime-mode.set",
      commandId: yield* commandIdFor(modes.idempotencyKey, "runtime-mode"),
      threadId: thread.id,
      runtimeMode: modes.runtimeMode.value,
    });
  }
  if (
    Option.isSome(modes.interactionMode) &&
    modes.interactionMode.value !== thread.interactionMode
  ) {
    yield* dispatch(client, {
      type: "thread.interaction-mode.set",
      commandId: yield* commandIdFor(modes.idempotencyKey, "interaction-mode"),
      threadId: thread.id,
      interactionMode: modes.interactionMode.value,
    });
  }
});

// ---------------------------------------------------------------------------
// Mutations

/** Flags every command that changes a thread takes. */
const mutationFlags = {
  ...environmentTargetFlags,
  thread: threadArgument,
  json: jsonFlag,
  idempotencyKey: idempotencyKeyFlag,
} as const;

/** The thread as it is now, wherever it lives; null once it is deleted. */
const readThreadState = Effect.fn("cli.thread.readState")(function* (
  client: EnvironmentRpcClient,
  threadId: ThreadId,
) {
  const shell = yield* loadShell(client);
  const thread =
    shell.threads.find((entry) => entry.id === threadId) ??
    (yield* loadArchivedShell(client)).threads.find((entry) => entry.id === threadId);
  if (thread === undefined) {
    return { thread: null, pendingApprovals: [], pendingUserInputs: [] };
  }
  const pending = yield* loadThreadDetail(client, threadId).pipe(
    Effect.map(pendingRequests),
    Effect.orElseSucceed(() => ({ approvals: [], userInputs: [] })),
  );
  return {
    thread: summarizeThread(
      thread,
      shell.projects.find((project) => project.id === thread.projectId),
    ),
    pendingApprovals: pending.approvals,
    pendingUserInputs: pending.userInputs,
  };
});

/**
 * Dispatches a mutation's commands and prints its outcome. In JSON mode that
 * is the ids, whether the server answered from a stored receipt, the
 * operation's own result, and the thread's state afterwards.
 */
const runMutation = Effect.fn("cli.thread.runMutation")(function* (
  client: EnvironmentRpcClient,
  input: {
    readonly operation: string;
    readonly threadId: ThreadId;
    /** Sequence of the shell snapshot read before dispatching. */
    readonly snapshotSequence: number;
    readonly commands: ReadonlyArray<OrchestrationV2Command>;
    readonly result?: Record<string, unknown>;
    readonly json: boolean;
    readonly text: string;
  },
) {
  let sequence = 0;
  for (const command of input.commands) sequence = (yield* dispatch(client, command)).sequence;
  if (!input.json) return yield* Console.log(input.text);
  yield* printJson({
    ok: true,
    operation: input.operation,
    threadId: input.threadId,
    commandIds: input.commands.map((command) => command.commandId),
    sequence,
    // A sequence the snapshot already covered was committed by an earlier attempt.
    replayed: input.commands.length > 0 && sequence <= input.snapshotSequence,
    result: input.result ?? {},
    ...(yield* readThreadState(client, input.threadId)),
  });
});

// ---------------------------------------------------------------------------
// Commands

const listCommand = Command.make("list", {
  ...environmentTargetFlags,
  project: Flag.String("project").pipe(
    Flag.withDescription("Only threads in this project (id, path, or title)."),
    Flag.optional,
  ),
  status: Flag.Literals("status", THREAD_STATUSES).pipe(
    Flag.withDescription("Only threads with this status (e.g. running, waiting_for_approval)."),
    Flag.optional,
  ),
  archived: Flag.Boolean("archived").pipe(
    Flag.withDescription("List archived threads instead of active ones."),
    Flag.withDefault(false),
  ),
  limit: Flag.Int("limit").pipe(Flag.withDefault(50)),
  json: jsonFlag,
}).pipe(
  Command.withDescription("List threads with their status, most recently updated first."),
  Command.withHandler(
    withClient(
      Effect.fn("cli.thread.list")(function* (client, flags) {
        const shell = yield* loadShell(client);
        const source = flags.archived ? yield* loadArchivedShell(client) : shell;
        const project = Option.isSome(flags.project)
          ? yield* resolveProject(shell, flags.project.value)
          : undefined;
        const projects = new Map(shell.projects.map((entry) => [entry.id, entry]));
        const summaries = source.threads
          .filter((thread) => project === undefined || thread.projectId === project.id)
          .toSorted(
            (left, right) =>
              DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
          )
          .map((thread) => summarizeThread(thread, projects.get(thread.projectId)))
          .filter((summary) => Option.isNone(flags.status) || summary.status === flags.status.value)
          .slice(0, Math.max(0, flags.limit));
        if (flags.json) return yield* printJson(summaries);
        if (summaries.length === 0) return yield* Console.log("No threads.");
        yield* Console.log(summaries.map(formatSummaryLine).join("\n"));
      }),
    ),
  ),
);

const showCommand = Command.make("show", {
  ...environmentTargetFlags,
  thread: threadArgument,
  turns: Flag.Int("turns").pipe(
    Flag.withDescription("How many recent turns of conversation to include."),
    Flag.withDefault(5),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Show a thread's status, recent conversation, and anything it is waiting on.",
  ),
  Command.withHandler(
    withClient(
      Effect.fn("cli.thread.show")(function* (client, flags) {
        const { thread, project } = yield* resolveThread(client, flags.thread);
        const detail = yield* loadThreadDetail(client, thread.id);
        const summary = summarizeThread(thread, project);
        const messages = conversationMessages(detail, Math.max(1, flags.turns));
        const attention = threadAttention(detail);
        if (flags.json) return yield* printJson({ thread: summary, messages, ...attention });
        const lines = [
          formatSummaryLine(summary),
          `Model ${summary.model} · ${summary.runtimeMode} · ${summary.interactionMode}${summary.branch ? ` · ${summary.branch}` : ""}`,
        ];
        if (summary.lastError) lines.push(`Error: ${summary.lastError}`);
        for (const message of messages) {
          const applied = [
            ...(message.appliedProfile ? [`profile: ${message.appliedProfile}`] : []),
            ...message.appliedSkills,
          ];
          lines.push(
            "",
            `── ${message.role}${message.streaming ? " (streaming)" : ""}${applied.length > 0 ? `  [${applied.join(", ")}]` : ""}`,
            message.text,
          );
        }
        const blockers = formatAttention(attention);
        if (blockers.length > 0) lines.push("", ...blockers);
        yield* Console.log(lines.join("\n"));
      }),
    ),
  ),
);

/**
 * Starts a thread with one message and waits for the agent to stop, for
 * commands that hand a step to an agent and need its answer. A wait that
 * times out interrupts the run, so the agent does not keep working on a
 * result nobody is waiting for.
 */
export const launchThreadAndWait = Effect.fn("cli.thread.launchAndWait")(function* (
  client: EnvironmentRpcClient,
  input: {
    readonly projectId: ProjectId;
    readonly title: string;
    readonly text: string;
    readonly modelSelection: ModelSelection;
    readonly runtimeMode: RuntimeMode;
    readonly workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy;
    readonly timeout: Duration.Duration;
    /** Archive the thread once it settles, for one-off questions not worth keeping in the sidebar. */
    readonly archiveWhenDone: boolean;
  },
) {
  const { threadId } = yield* client[ORCHESTRATION_V2_WS_METHODS.launchThread]({
    commandId: CommandId.make(newId()),
    creationSource: CLI_PROVENANCE.creationSource,
    threadId: ThreadId.make(newId()),
    projectId: input.projectId,
    title: input.title,
    generateTitle: false,
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode,
    interactionMode: "default",
    workspaceStrategy: input.workspaceStrategy,
    initialMessage: { messageId: MessageId.make(newId()), text: input.text, attachments: [] },
  });
  const settled = yield* waitForThread(client, threadId, {
    sentAfter: null,
    timeout: Option.some(input.timeout),
  }).pipe(Effect.result);
  if (settled._tag === "Failure") {
    const shell = yield* loadShell(client);
    const runId = shell.threads.find((thread) => thread.id === threadId)?.activeRunId ?? null;
    if (runId !== null) {
      yield* dispatch(client, {
        type: "run.interrupt",
        commandId: CommandId.make(newId()),
        threadId,
        runId,
        holdQueue: true,
      });
    }
    return { threadId, status: "timeout" as const, reply: "", lastError: settled.failure.message };
  }
  const detail = yield* loadThreadDetail(client, threadId);
  if (input.archiveWhenDone) {
    yield* dispatch(client, {
      type: "thread.archive",
      commandId: CommandId.make(newId()),
      threadId,
    });
  }
  return {
    threadId,
    status: resolveThreadStatus(settled.success),
    reply: latestReply(detail.messages),
    lastError: settled.success.lastError ?? null,
  };
});

const newCommand = Command.make("new", {
  ...environmentTargetFlags,
  message: messageArgument,
  project: Flag.String("project").pipe(
    Flag.withDescription("Project id, path, or title. Default: the project containing the cwd."),
    Flag.optional,
  ),
  title: Flag.String("title").pipe(
    Flag.withDescription(
      "Thread title. Default: derived from the message, then refined by the server.",
    ),
    Flag.optional,
  ),
  model: modelFlag,
  runtimeMode: runtimeModeFlag,
  mode: interactionModeFlag,
  skill: skillFlag,
  profile: profileFlag,
  worktree: Flag.String("worktree").pipe(
    Flag.withDescription("Run in a new git worktree branched from this base branch."),
    Flag.optional,
  ),
  wait: waitFlag,
  timeout: timeoutFlag,
  json: jsonFlag,
  idempotencyKey: idempotencyKeyFlag,
}).pipe(
  Command.withDescription("Start a new thread in a project with a first message."),
  Command.withHandler(
    withClient(
      Effect.fn("cli.thread.new")(function* (client, flags) {
        const text = yield* readMessage(flags.message);
        const shell = yield* loadShell(client);
        const project = yield* resolveProject(
          shell,
          Option.isSome(flags.project) ? flags.project.value : yield* HostProcessWorkingDirectory,
        );
        const defaults = yield* resolveNewThreadDefaults(client, shell, project, flags.model);
        const library = yield* resolveTurnLibrary(client, {
          modelSelection: defaults.modelSelection,
          skills: flags.skill,
          profile: flags.profile,
        });
        const runtimeMode = Option.getOrElse(flags.runtimeMode, () => defaults.runtimeMode);
        const interactionMode = Option.getOrElse(flags.mode, () => "default" as const);
        const title = Option.getOrElse(flags.title, () => threadTitleFromPrompt(text));
        const commandId = yield* commandIdFor(flags.idempotencyKey, "thread.new");
        const launched = yield* client[ORCHESTRATION_V2_WS_METHODS.launchThread]({
          commandId,
          creationSource: CLI_PROVENANCE.creationSource,
          threadId: ThreadId.make(entityIdFor(flags.idempotencyKey, "thread")),
          projectId: project.id,
          title,
          // Without an explicit title the server refines the prompt-derived one.
          generateTitle: Option.isNone(flags.title),
          modelSelection: library.modelSelection,
          runtimeMode,
          interactionMode,
          workspaceStrategy: Option.isSome(flags.worktree)
            ? {
                type: "worktree",
                baseRef: flags.worktree.value,
                branch: buildTemporaryWorktreeBranchName((bytes) =>
                  NodeCrypto.randomBytes(bytes).toString("hex"),
                ),
              }
            : { type: "root" },
          initialMessage: {
            messageId: MessageId.make(entityIdFor(flags.idempotencyKey, "message")),
            text,
            attachments: [],
            ...libraryTurnFields(library),
          },
        });
        const threadId = launched.threadId;
        if (flags.wait) {
          return yield* waitAndReport(client, threadId, {
            sentAfter: null,
            timeout: flags.timeout,
            json: flags.json,
          });
        }
        if (flags.json) {
          return yield* printJson({ threadId, projectId: project.id, status: "queued", commandId });
        }
        yield* Console.log(threadId);
      }),
    ),
  ),
);

const sendCommand = Command.make("send", {
  ...environmentTargetFlags,
  thread: threadArgument,
  message: messageArgument,
  model: modelFlag,
  runtimeMode: runtimeModeFlag,
  mode: interactionModeFlag,
  skill: skillFlag,
  profile: profileFlag,
  queue: Flag.Boolean("queue").pipe(
    Flag.withDescription("Queue the message as the next turn, never touching the running one."),
    Flag.withDefault(false),
  ),
  steer: Flag.Boolean("steer").pipe(
    Flag.withDescription(
      "Deliver into the running turn where the provider supports it; otherwise the server queues it.",
    ),
    Flag.withDefault(false),
  ),
  wait: waitFlag,
  timeout: timeoutFlag,
  json: jsonFlag,
  idempotencyKey: idempotencyKeyFlag,
}).pipe(
  Command.withDescription(
    "Send a message to a thread. If the agent is busy, it is queued as the next turn.",
  ),
  Command.withHandler(
    withClient(
      Effect.fn("cli.thread.send")(function* (client, flags) {
        if (flags.queue && flags.steer) {
          return yield* failCli("INVALID_INPUT", "Pass --queue or --steer, not both.");
        }
        const text = yield* readMessage(flags.message);
        const { thread } = yield* resolveThread(client, flags.thread);
        if (thread.archivedAt !== null) {
          return yield* fail(
            "invalid-input",
            `Thread ${thread.id} is archived. Run \`t3 thread unarchive ${thread.id}\` first.`,
          );
        }
        const modelSelection = Option.isSome(flags.model)
          ? yield* parseModelSelection(flags.model.value, thread.modelSelection.instanceId)
          : thread.modelSelection;
        const library = yield* resolveTurnLibrary(client, {
          modelSelection,
          skills: flags.skill,
          profile: flags.profile,
        });
        yield* applyThreadModes(client, thread, {
          runtimeMode: flags.runtimeMode,
          interactionMode: flags.mode,
          idempotencyKey: flags.idempotencyKey,
        });
        // Server time of the newest user message before this one, for --wait.
        const sentAfter = thread.latestUserMessageAt;
        const commandId = yield* commandIdFor(flags.idempotencyKey, "thread.send");
        const messageId = MessageId.make(entityIdFor(flags.idempotencyKey, "message"));
        // The composer's three intents. The server resolves each against the
        // thread's state at the moment it serializes the command.
        yield* dispatch(client, {
          type: "message.dispatch",
          ...CLI_PROVENANCE,
          commandId,
          threadId: thread.id,
          messageId,
          text,
          attachments: [],
          modelSelection: library.modelSelection,
          ...libraryTurnFields(library),
          ...(flags.steer ? { deliveryIntent: "steer" as const } : {}),
          dispatchMode: flags.queue
            ? { type: "queue_after_active" }
            : { type: "start_immediately" },
        });
        if (flags.wait) {
          return yield* waitAndReport(client, thread.id, {
            sentAfter,
            timeout: flags.timeout,
            json: flags.json,
          });
        }
        if (flags.json) {
          return yield* printJson({
            threadId: thread.id,
            status: "queued",
            commandId,
            messageId,
            delivery: flags.queue ? "queue" : flags.steer ? "steer" : "default",
          });
        }
        yield* Console.log(`Sent to ${thread.id}.`);
      }),
    ),
  ),
);

const waitCommand = Command.make("wait", {
  ...environmentTargetFlags,
  thread: threadArgument,
  timeout: timeoutFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Block until the thread's agent finishes or needs approval/input, then print its reply. A timeout exits 8 and cancels nothing.",
  ),
  Command.withHandler(
    withClient(
      Effect.fn("cli.thread.waitCommand")(function* (client, flags) {
        const { thread } = yield* resolveThread(client, flags.thread);
        yield* waitAndReport(client, thread.id, { timeout: flags.timeout, json: flags.json });
      }),
    ),
  ),
);

const approveCommand = Command.make("approve", {
  ...mutationFlags,
  request: Flag.String("request").pipe(
    Flag.withDescription("Approval request id. Required when more than one approval is pending."),
    Flag.optional,
  ),
  decision: Flag.Literals("decision", ProviderApprovalDecision.literals).pipe(
    Flag.withDescription("One of the decisions the request offers (see `show`). Default: accept."),
    Flag.withDefault("accept" as const),
  ),
}).pipe(
  Command.withDescription(
    "Decide a pending approval request. It never answers a question: use `answer` for those.",
  ),
  Command.withHandler(
    withClient(
      Effect.fn("cli.thread.approve")(function* (client, flags) {
        const { thread, shell } = yield* resolveThread(client, flags.thread);
        const detail = yield* loadThreadDetail(client, thread.id);
        const request = yield* selectRequest(detail, "approval", flags.request);
        const approval = describeApproval(detail, request);
        if (!approval.decisions.includes(flags.decision)) {
          return yield* failCli(
            "INVALID_INPUT",
            `Request ${request.id} does not offer '${flags.decision}'. It offers: ${approval.decisions.join(", ")}.`,
            { threadId: thread.id, requestId: request.id },
          );
        }
        yield* runMutation(client, {
          operation: "thread.approve",
          threadId: thread.id,
          snapshotSequence: shell.snapshotSequence,
          commands: [
            {
              type: "runtime-request.respond",
              commandId: yield* commandIdFor(flags.idempotencyKey, `approve:${request.id}`),
              threadId: thread.id,
              requestId: request.id,
              decision: flags.decision,
            },
          ],
          result: { requestId: request.id, decision: flags.decision },
          json: flags.json,
          text: `Responded ${flags.decision} to ${request.id}.`,
        });
      }),
    ),
  ),
);

const answerCommand = Command.make("answer", {
  ...mutationFlags,
  answers: Argument.String("answer").pipe(
    Argument.withDescription(
      "<question-id>=<answer>, repeatable (repeat an id for multi-select). A bare answer fills a single-question request. An answer is an option's value, or free text where the question allows it.",
    ),
    Argument.variadic(),
  ),
  request: Flag.String("request").pipe(
    Flag.withDescription("Question request id. Required when more than one question is pending."),
    Flag.optional,
  ),
  dismiss: Flag.Boolean("dismiss").pipe(
    Flag.withDescription("Close an async question without answering it."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Answer (or dismiss) a question the agent asked. It never approves an action: use `approve` for those.",
  ),
  Command.withHandler(
    withClient(
      Effect.fn("cli.thread.answer")(function* (client, flags) {
        const { thread, shell } = yield* resolveThread(client, flags.thread);
        const detail = yield* loadThreadDetail(client, thread.id);
        const request = yield* selectRequest(detail, "question", flags.request);
        const described = describeUserInput(detail, request);
        if (flags.dismiss) {
          if (!described.dismissible) {
            return yield* failCli(
              "INVALID_INPUT",
              "This question must be answered; it cannot be dismissed.",
              { threadId: thread.id, requestId: request.id },
            );
          }
          return yield* runMutation(client, {
            operation: "thread.answer.dismiss",
            threadId: thread.id,
            snapshotSequence: shell.snapshotSequence,
            commands: [
              {
                type: "thread.user-input.dismiss",
                commandId: yield* commandIdFor(flags.idempotencyKey, `dismiss:${request.id}`),
                threadId: thread.id,
                requestId: request.id,
              },
            ],
            result: { requestId: request.id, dismissed: true },
            json: flags.json,
            text: `Dismissed ${request.id}.`,
          });
        }
        const collected = new Map<string, string[]>();
        for (const raw of flags.answers) {
          const separator = raw.indexOf("=");
          const questionId =
            separator > 0
              ? raw.slice(0, separator)
              : described.questions.length === 1
                ? described.questions[0]!.id
                : undefined;
          if (questionId === undefined) {
            return yield* failCli(
              "INVALID_INPUT",
              `This request has ${described.questions.length} questions; use <question-id>=<answer>.`,
              { threadId: thread.id, requestId: request.id },
            );
          }
          if (!described.questions.some((question) => question.id === questionId)) {
            return yield* failCli(
              "INVALID_INPUT",
              `Request ${request.id} has no question '${questionId}'. Its questions: ${described.questions
                .map((question) => question.id)
                .join(", ")}.`,
              { threadId: thread.id, requestId: request.id, questionId },
            );
          }
          const value = separator > 0 ? raw.slice(separator + 1) : raw;
          collected.set(questionId, [...(collected.get(questionId) ?? []), value]);
        }
        if (collected.size === 0) {
          return yield* failCli("INVALID_INPUT", "Pass at least one answer, or --dismiss.");
        }
        const answers: Record<string, string | ReadonlyArray<string>> = {};
        for (const question of described.questions) {
          const values = collected.get(question.id);
          if (values === undefined) {
            if (!question.required) continue;
            return yield* failCli(
              "INVALID_INPUT",
              `Question '${question.id}' needs an answer: ${question.question}`,
              { threadId: thread.id, requestId: request.id, questionId: question.id },
            );
          }
          answers[question.id] = yield* resolveAnswer(question, values);
        }
        yield* runMutation(client, {
          operation: "thread.answer",
          threadId: thread.id,
          snapshotSequence: shell.snapshotSequence,
          commands: [
            {
              type: "runtime-request.respond",
              commandId: yield* commandIdFor(flags.idempotencyKey, `answer:${request.id}`),
              threadId: thread.id,
              requestId: request.id,
              answers,
            },
          ],
          result: { requestId: request.id, answers },
          json: flags.json,
          text: `Answered ${request.id}.`,
        });
      }),
    ),
  ),
);

/** What a thread mutation needs to build its commands. */
interface MutationContext {
  readonly client: EnvironmentRpcClient;
  readonly thread: OrchestrationV2ThreadShell;
  readonly shell: OrchestrationV2ShellSnapshot;
  /** The command id for this mutation; `part` distinguishes several commands of one mutation. */
  readonly commandId: (part?: string) => Effect.Effect<CommandId, CliFailure>;
}

interface MutationPlan {
  readonly commands: ReadonlyArray<OrchestrationV2Command>;
  readonly result?: Record<string, unknown>;
  /** Overrides the default "<done> <thread>." line. */
  readonly text?: string;
}

/** A command that dispatches thread-scoped orchestration commands. */
const simpleThreadCommand = <const Name extends string, E = never, R = never>(
  name: Name,
  description: string,
  build: (context: MutationContext) => Effect.Effect<MutationPlan, E, R>,
  done: string,
) =>
  Command.make(name, mutationFlags).pipe(
    Command.withDescription(description),
    Command.withHandler(
      withClient(
        Effect.fn(`cli.thread.${name}`)(function* (client, flags) {
          const { thread, shell } = yield* resolveThread(client, flags.thread);
          const plan = yield* build({
            client,
            thread,
            shell,
            commandId: (part) =>
              commandIdFor(flags.idempotencyKey, part === undefined ? name : `${name}:${part}`),
          });
          yield* runMutation(client, {
            operation: `thread.${name}`,
            threadId: thread.id,
            snapshotSequence: shell.snapshotSequence,
            commands: plan.commands,
            ...(plan.result === undefined ? {} : { result: plan.result }),
            json: flags.json,
            text: plan.text ?? `${done} ${thread.id}.`,
          });
        }),
      ),
    ),
  );

/** One `thread.<type>` command with nothing but the thread's id. */
const single = (
  context: MutationContext,
  build: (commandId: CommandId) => OrchestrationV2Command,
): Effect.Effect<MutationPlan, CliFailure> =>
  context.commandId().pipe(Effect.map((commandId) => ({ commands: [build(commandId)] })));

/** Detaches every provider session of a thread, as the app's stop does. */
const detachSessions = Effect.fn("cli.thread.detachSessions")(function* (context: MutationContext) {
  const projection = yield* loadThreadDetail(context.client, context.thread.id);
  return yield* Effect.forEach(projection.providerSessions, (session) =>
    context.commandId(`detach:${session.id}`).pipe(
      Effect.map((commandId): OrchestrationV2Command => ({
        type: "provider-session.detach",
        commandId,
        threadId: context.thread.id,
        providerSessionId: session.id,
        reason: "client-requested",
      })),
    ),
  );
});

const interruptCommand = simpleThreadCommand(
  "interrupt",
  "Stop the agent's current turn.",
  (context) =>
    Effect.gen(function* () {
      const { thread } = context;
      // Background work still running after the latest run settled is stopped
      // through that run, as the composer's Stop button does.
      const runId: RunId | null =
        thread.activeRunId ??
        ((thread.pendingBackgroundTasks ?? []).length > 0 ? thread.latestRunId : null);
      if (runId === null) {
        return yield* fail(
          "invalid-input",
          `Thread ${thread.id} has no running turn to interrupt.`,
        );
      }
      return {
        commands: [
          {
            type: "run.interrupt",
            commandId: yield* context.commandId(),
            threadId: thread.id,
            runId,
            holdQueue: true,
          } as const,
        ],
        result: { runId },
      };
    }),
  "Interrupted",
);

const stopCommand = simpleThreadCommand(
  "stop",
  "Stop the thread's provider session.",
  (context) =>
    detachSessions(context).pipe(
      Effect.map((commands) => ({
        commands,
        result: { stoppedSessions: commands.length },
        ...(commands.length === 0
          ? { text: `Thread ${context.thread.id} has no provider session to stop.` }
          : {}),
      })),
    ),
  "Stopped",
);

const lifecycleCommands = [
  simpleThreadCommand(
    "archive",
    "Archive a thread. Refused while its agent is working: interrupt it first.",
    (context) =>
      single(context, (commandId) => ({
        type: "thread.archive",
        commandId,
        threadId: context.thread.id,
      })),
    "Archived",
  ),
  simpleThreadCommand(
    "unarchive",
    "Restore an archived thread.",
    (context) =>
      single(context, (commandId) => ({
        type: "thread.unarchive",
        commandId,
        threadId: context.thread.id,
      })),
    "Unarchived",
  ),
  simpleThreadCommand(
    "settle",
    "Mark a thread as done. Clears its pin and stops its idle provider session.",
    (context) =>
      single(context, (commandId) => ({
        type: "thread.settle",
        commandId,
        threadId: context.thread.id,
      })),
    "Settled",
  ),
  simpleThreadCommand(
    "unsettle",
    "Move a settled thread back to active.",
    (context) =>
      single(context, (commandId) => ({
        type: "thread.unsettle",
        commandId,
        threadId: context.thread.id,
        reason: "user",
      })),
    "Unsettled",
  ),
  simpleThreadCommand(
    "pin",
    "Pin a thread to the top of the pinned list.",
    (context) => {
      // A fresh pin lands at the top of the arranged run, as in the apps.
      const orderKey = topOfPinnedOrderKey(context.shell.threads);
      return single(context, (commandId) => ({
        type: "thread.pin",
        commandId,
        threadId: context.thread.id,
        ...(orderKey === undefined ? {} : { orderKey }),
      }));
    },
    "Pinned",
  ),
  simpleThreadCommand(
    "unpin",
    "Unpin a thread.",
    (context) =>
      single(context, (commandId) => ({
        type: "thread.unpin",
        commandId,
        threadId: context.thread.id,
      })),
    "Unpinned",
  ),
  simpleThreadCommand(
    "unsnooze",
    "Wake a snoozed thread.",
    (context) =>
      single(context, (commandId) => ({
        type: "thread.unsnooze",
        commandId,
        threadId: context.thread.id,
        reason: "user",
      })),
    "Unsnoozed",
  ),
];

/**
 * Deleting stops the thread's provider sessions and closes its terminals
 * (dropping their history) before the thread goes, as the app does.
 */
const deleteCommand = Command.make("delete", mutationFlags).pipe(
  Command.withDescription(
    "Delete a thread permanently, after stopping its provider session and closing its terminals.",
  ),
  Command.withHandler(
    withClient(
      Effect.fn("cli.thread.delete")(function* (client, flags) {
        const commandId = (part?: string) =>
          commandIdFor(flags.idempotencyKey, part === undefined ? "delete" : `delete:${part}`);
        const resolved = yield* resolveThread(client, flags.thread).pipe(Effect.result);
        if (resolved._tag === "Failure") {
          // A repeat of a delete that already happened: the thread is gone, so
          // only its full id and key can reach the stored result.
          if (Option.isNone(flags.idempotencyKey)) return yield* Effect.fail(resolved.failure);
          const threadId = ThreadId.make(flags.thread.trim());
          return yield* runMutation(client, {
            operation: "thread.delete",
            threadId,
            snapshotSequence: Number.MAX_SAFE_INTEGER,
            commands: [{ type: "thread.delete", commandId: yield* commandId(), threadId }],
            json: flags.json,
            text: `Deleted ${threadId}.`,
          });
        }
        const { thread, shell } = resolved.success;
        const detaches = yield* detachSessions({ client, thread, shell, commandId });
        for (const command of detaches) yield* dispatch(client, command);
        // Terminal cleanup is best effort, as in the app: a thread with no
        // terminal, or one already closed, must still be deletable.
        yield* client[WS_METHODS.terminalClose]({ threadId: thread.id, deleteHistory: true }).pipe(
          Effect.ignore,
        );
        yield* runMutation(client, {
          operation: "thread.delete",
          threadId: thread.id,
          snapshotSequence: shell.snapshotSequence,
          commands: [{ type: "thread.delete", commandId: yield* commandId(), threadId: thread.id }],
          result: { stoppedSessions: detaches.length },
          json: flags.json,
          text: `Deleted ${thread.id}.`,
        });
      }),
    ),
  ),
);

const decodeDuration = Schema.decodeUnknownEffect(DurationFromString);
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

/**
 * A snooze deadline: a duration (`30m`) counted from the server's clock, or an
 * absolute ISO date-time with a zone. `fallbackUntil` covers a server that
 * predates relative snoozes.
 */
const parseSnooze = Effect.fn("cli.thread.parseSnooze")(function* (value: string) {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}/.test(trimmed)) {
    const parsed = ISO_WITH_ZONE.test(trimmed) ? DateTime.make(trimmed) : Option.none();
    if (Option.isNone(parsed)) {
      return yield* failCli(
        "INVALID_INPUT",
        `'${trimmed}' is not an ISO date-time with a time zone, e.g. 2026-11-03T09:00:00Z.`,
      );
    }
    return { type: "until" as const, snoozedUntil: DateTime.formatIso(parsed.value) };
  }
  const duration = yield* decodeDuration(trimmed).pipe(
    Effect.mapError(() =>
      cliFailure(
        "INVALID_INPUT",
        `'${trimmed}' is neither a duration (30m, 2h, 1d) nor an ISO date-time.`,
      ),
    ),
  );
  const snoozeForMs = Math.round(Duration.toMillis(duration));
  if (snoozeForMs < 1) {
    return yield* failCli("INVALID_INPUT", "A snooze must last longer than zero.");
  }
  return {
    type: "for" as const,
    snoozeForMs,
    snoozedUntil: DateTime.formatIso(DateTime.addDuration(yield* DateTime.now, duration)),
  };
});

const snoozeCommand = Command.make("snooze", {
  ...mutationFlags,
  duration: Argument.String("duration").pipe(
    Argument.withDescription(
      "How long to snooze (30m, 2h, 1d), counted from the server's clock, or an absolute ISO date-time with a zone (2026-11-03T09:00:00Z).",
    ),
  ),
}).pipe(
  Command.withDescription(
    "Hide a thread from the inbox until a time. It never stops the agent or drops queued work; the server wakes the thread when the time passes.",
  ),
  Command.withHandler(
    withClient(
      Effect.fn("cli.thread.snooze")(function* (client, flags) {
        const snooze = yield* parseSnooze(flags.duration);
        const { thread, shell } = yield* resolveThread(client, flags.thread);
        const commandId = yield* commandIdFor(flags.idempotencyKey, "snooze");
        let sequence = 0;
        sequence = (yield* dispatch(client, {
          type: "thread.snooze",
          commandId,
          threadId: thread.id,
          snoozedUntil: snooze.snoozedUntil,
          ...(snooze.type === "for" ? { snoozeForMs: snooze.snoozeForMs } : {}),
        })).sequence;
        // The deadline the server stored, which is the only one that counts.
        const state = yield* readThreadState(client, thread.id);
        const until = state.thread?.snoozedUntil ?? snooze.snoozedUntil;
        if (!flags.json) return yield* Console.log(`Snoozed ${thread.id} until ${until}.`);
        yield* printJson({
          ok: true,
          operation: "thread.snooze",
          threadId: thread.id,
          commandIds: [commandId],
          sequence,
          replayed: sequence <= shell.snapshotSequence,
          result: {
            snoozedUntil: until,
            deadline: snooze.type === "for" ? "relative" : "absolute",
          },
          ...state,
        });
      }),
    ),
  ),
);

const renameCommand = Command.make("rename", {
  ...mutationFlags,
  title: Argument.String("title"),
}).pipe(
  Command.withDescription("Rename a thread."),
  Command.withHandler(
    withClient(
      Effect.fn("cli.thread.rename")(function* (client, flags) {
        const { thread, shell } = yield* resolveThread(client, flags.thread);
        const title = flags.title.trim();
        if (title.length === 0) return yield* fail("invalid-input", "Title cannot be empty.");
        yield* runMutation(client, {
          operation: "thread.rename",
          threadId: thread.id,
          snapshotSequence: shell.snapshotSequence,
          commands: [
            {
              type: "thread.metadata.update",
              commandId: yield* commandIdFor(flags.idempotencyKey, "rename"),
              threadId: thread.id,
              title,
            },
          ],
          result: { title },
          json: flags.json,
          text: `Renamed ${thread.id} to ${title}.`,
        });
      }),
    ),
  ),
);

const treeCommand = Command.make("tree", {
  ...environmentTargetFlags,
  thread: threadArgument,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Show everything running under a thread: delegated tasks and provider subagents, with status and pending requests.",
  ),
  Command.withHandler(
    withClient(
      Effect.fn("cli.thread.tree")(function* (client, flags) {
        const { thread } = yield* resolveThread(client, flags.thread);
        const { nodes } = yield* client[AUTOMATION_WS_METHODS.threadTree]({ threadId: thread.id });
        if (flags.json) return yield* printJson({ threadId: thread.id, nodes });
        yield* Console.log(formatThreadTree(nodes));
      }),
    ),
  ),
);

/** One line per node, indented by depth: id, kind, state, title, pending requests. */
export function formatThreadTree(
  nodes: ReadonlyArray<{
    readonly threadId: string;
    readonly kind: string;
    readonly title: string;
    readonly taskId: string | null;
    readonly taskStatus: string | null;
    readonly threadStatus: string;
    readonly pendingRequests: number;
    readonly depth: number;
  }>,
): string {
  return nodes
    .map((node) =>
      [
        `${"  ".repeat(node.depth)}${node.threadId}`,
        node.kind,
        node.taskStatus === null ? node.threadStatus : `${node.taskStatus} (${node.threadStatus})`,
        node.title,
        ...(node.taskId === null ? [] : [`task ${node.taskId}`]),
        ...(node.pendingRequests > 0 ? [`[${node.pendingRequests} pending]`] : []),
      ].join("  "),
    )
    .join("\n");
}

const requestsCommand = Command.make("requests", {
  ...environmentTargetFlags,
  thread: Flag.String("thread").pipe(
    Flag.withDescription("Only requests of this thread (id or unique prefix)."),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "List pending approvals and questions across threads, with who is responsible for each.",
  ),
  Command.withHandler(
    withClient(
      Effect.fn("cli.thread.requests")(function* (client, flags) {
        const threadId = Option.isSome(flags.thread)
          ? (yield* resolveThread(client, flags.thread.value)).thread.id
          : undefined;
        const { requests } = yield* client[AUTOMATION_WS_METHODS.requestsList](
          threadId === undefined ? {} : { threadId },
        );
        if (flags.json) return yield* printJson({ requests });
        if (requests.length === 0) return yield* Console.log("No pending requests.");
        yield* Console.log(
          requests
            .map((request) =>
              [
                request.requestId,
                request.kind.padEnd(10),
                request.threadId,
                request.threadTitle,
                request.reservedForUser ? "[user only]" : "",
              ]
                .join("  ")
                .trimEnd(),
            )
            .join("\n"),
        );
      }),
    ),
  ),
);

export const threadCommand = Command.make("thread").pipe(
  Command.withDescription(
    "Drive threads on the running server: list, read, start, message, wait, and answer agents.",
  ),
  Command.withSubcommands([
    listCommand,
    showCommand,
    treeCommand,
    requestsCommand,
    newCommand,
    sendCommand,
    waitCommand,
    approveCommand,
    answerCommand,
    interruptCommand,
    stopCommand,
    renameCommand,
    snoozeCommand,
    ...lifecycleCommands,
    deleteCommand,
  ]),
);

/** `t3 project list`: projects as the running server sees them. */
export const projectListCommand = Command.make("list", {
  ...environmentTargetFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("List projects on the running server."),
  Command.withHandler(
    withClient(
      Effect.fn("cli.project.list")(function* (client, flags) {
        const shell = yield* loadShell(client);
        const projects = shell.projects.map((project) => ({
          id: project.id,
          title: project.title,
          workspaceRoot: project.workspaceRoot,
          activeThreads: shell.threads.filter((thread) => thread.projectId === project.id).length,
        }));
        if (flags.json) return yield* printJson(projects);
        if (projects.length === 0) return yield* Console.log("No projects.");
        yield* Console.log(
          projects
            .map((project) => `${project.id}  ${project.title}  ${project.workspaceRoot}`)
            .join("\n"),
        );
      }),
    ),
  ),
);
