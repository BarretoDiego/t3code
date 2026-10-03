import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  MessageId,
  ModelSelection,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationProjectShell,
  type OrchestrationV2Command,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  ProviderApprovalDecision,
  ProviderInteractionMode,
  type RunId,
  RuntimeMode,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import { resolveThreadAwarenessPhaseV2 } from "@t3tools/shared/agentAwareness";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import { HostProcessWorkingDirectory } from "@t3tools/shared/hostProcess";
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

import { jsonFlag, printJson, timeoutFlag, withClient } from "./common.ts";
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

/**
 * The single status word a script branches on. Mirrors the sidebar: attention
 * states win over activity, and a message queued behind (or ahead of) a run
 * reads as queued rather than as the previous turn's "completed".
 */
export type ThreadStatus =
  | "queued"
  | "starting"
  | "running"
  | "waiting_for_approval"
  | "waiting_for_input"
  | "completed"
  | "failed"
  | "interrupted"
  | "idle";

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

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const formatTime = (value: DateTime.Utc | null | undefined) =>
  value === null || value === undefined ? null : DateTime.formatIso(value);

export const loadShell = (client: EnvironmentRpcClient) =>
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

/** Resolves a thread by full id or unique id prefix, active threads first. */
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
const resolveProject = Effect.fn("cli.thread.resolveProject")(function* (
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

const parseModelSelection = Effect.fn("cli.thread.parseModel")(function* (
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
const resolveNewThreadDefaults = Effect.fn("cli.thread.newDefaults")(function* (
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

function formatModel(selection: { readonly instanceId: string; readonly model: string }) {
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
    archived: thread.archivedAt !== null,
    settled: thread.settledAt !== null,
    pinned: (thread.pinnedAt ?? null) !== null,
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

/**
 * Pending runtime requests, oldest first, with the detail their turn items
 * carry: approvals (anything but a question or an auth refresh) and questions.
 */
function pendingRequests(projection: OrchestrationV2ThreadProjection) {
  const pending = projection.runtimeRequests
    .filter((request) => request.status === "pending" && request.kind !== "auth_refresh")
    .toSorted(
      (left, right) =>
        DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt),
    );
  const approvals = pending
    .filter((request) => request.kind !== "user_input")
    .map((request) => {
      const item = projection.turnItems.find(
        (candidate) => candidate.type === "approval_request" && candidate.requestId === request.id,
      );
      const prompt = item?.type === "approval_request" ? item.prompt : undefined;
      return {
        requestId: request.id,
        requestKind: request.kind,
        detail: prompt === undefined || prompt.trim().length === 0 ? null : prompt.trim(),
      };
    });
  const userInputs = pending
    .filter((request) => request.kind === "user_input")
    .map((request) => {
      const item = projection.turnItems.find(
        (candidate) =>
          candidate.type === "user_input_request" && candidate.requestId === request.id,
      );
      return {
        requestId: request.id,
        // Only questions the server can close with a message reply may be dismissed.
        dismissible: request.responseCapability.type === "message",
        questions: (item?.type === "user_input_request" ? item.questions : []).map((question) => ({
          id: question.id,
          question: question.question,
          options: question.options.map((option) => ({ label: option.label })),
          multiSelect: question.multiSelect ?? false,
        })),
      };
    });
  return { approvals, userInputs };
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
    );
  }
  for (const input of attention.pendingUserInputs) {
    lines.push(`Question request ${input.requestId}:`);
    for (const question of input.questions) {
      const options = question.options.map((option) => option.label).join(" | ");
      lines.push(`  [${question.id}] ${question.question}${options ? ` (${options})` : ""}`);
    }
  }
  if (attention.proposedPlan) {
    lines.push(`Proposed plan ${attention.proposedPlan.id}:`, attention.proposedPlan.markdown);
  }
  return lines;
}

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
      orElse: () =>
        fail(
          "timeout",
          `Timed out waiting for thread ${threadId}; it is still ${current ? resolveThreadStatus(current) : "running"}.`,
        ),
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

const readMessage = Effect.fn("cli.thread.readMessage")(function* (parts: ReadonlyArray<string>) {
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
const modelFlag = Flag.String("model").pipe(
  Flag.withDescription(
    "Model as <provider-instance>/<model>, or just <model> on the same provider.",
  ),
  Flag.optional,
);
const runtimeModeFlag = Flag.Literals("runtime-mode", RuntimeMode.literals).pipe(
  Flag.withDescription("Permission mode for the agent."),
  Flag.optional,
);
const interactionModeFlag = Flag.Literals("mode", ProviderInteractionMode.literals).pipe(
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
const CLI_PROVENANCE = { createdBy: "user", creationSource: "server" } as const;

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
  },
) {
  if (Option.isSome(modes.runtimeMode) && modes.runtimeMode.value !== thread.runtimeMode) {
    yield* dispatch(client, {
      type: "thread.runtime-mode.set",
      commandId: CommandId.make(newId()),
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
      commandId: CommandId.make(newId()),
      threadId: thread.id,
      interactionMode: modes.interactionMode.value,
    });
  }
});

// ---------------------------------------------------------------------------
// Commands

const listCommand = Command.make("list", {
  ...environmentTargetFlags,
  project: Flag.String("project").pipe(
    Flag.withDescription("Only threads in this project (id, path, or title)."),
    Flag.optional,
  ),
  status: Flag.String("status").pipe(
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
        const launched = yield* client[ORCHESTRATION_V2_WS_METHODS.launchThread]({
          commandId: CommandId.make(newId()),
          creationSource: CLI_PROVENANCE.creationSource,
          threadId: ThreadId.make(newId()),
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
            messageId: MessageId.make(newId()),
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
          return yield* printJson({ threadId, projectId: project.id, status: "queued" });
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
  wait: waitFlag,
  timeout: timeoutFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Send a message to a thread. If the agent is busy, it is queued as the next turn.",
  ),
  Command.withHandler(
    withClient(
      Effect.fn("cli.thread.send")(function* (client, flags) {
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
        });
        // Server time of the newest user message before this one, for --wait.
        const sentAfter = thread.latestUserMessageAt;
        // Starts a run when the agent is idle; otherwise queues it as the next turn.
        yield* dispatch(client, {
          type: "message.dispatch",
          ...CLI_PROVENANCE,
          commandId: CommandId.make(newId()),
          threadId: thread.id,
          messageId: MessageId.make(newId()),
          text,
          attachments: [],
          modelSelection: library.modelSelection,
          ...libraryTurnFields(library),
          dispatchMode: { type: "start_immediately" },
        });
        if (flags.wait) {
          return yield* waitAndReport(client, thread.id, {
            sentAfter,
            timeout: flags.timeout,
            json: flags.json,
          });
        }
        if (flags.json) return yield* printJson({ threadId: thread.id, status: "queued" });
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
    "Block until the thread's agent finishes or needs approval/input, then print its reply.",
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
  ...environmentTargetFlags,
  thread: threadArgument,
  request: Flag.String("request").pipe(
    Flag.withDescription("Approval request id. Default: the oldest pending approval."),
    Flag.optional,
  ),
  decision: Flag.Literals("decision", ProviderApprovalDecision.literals).pipe(
    Flag.withDescription("accept, acceptForSession, acceptAlways, decline, or cancel."),
    Flag.withDefault("accept" as const),
  ),
}).pipe(
  Command.withDescription("Answer a pending approval request (default: accept the oldest)."),
  Command.withHandler(
    withClient(
      Effect.fn("cli.thread.approve")(function* (client, flags) {
        const { thread } = yield* resolveThread(client, flags.thread);
        const detail = yield* loadThreadDetail(client, thread.id);
        const { approvals } = pendingRequests(detail);
        const requestId = Option.getOrUndefined(flags.request);
        const approval =
          requestId === undefined
            ? approvals[0]
            : approvals.find((entry) => entry.requestId === requestId);
        if (approval === undefined) {
          return yield* fail(
            "no-pending-request",
            `Thread ${thread.id} has no matching pending approval.`,
          );
        }
        yield* dispatch(client, {
          type: "runtime-request.respond",
          commandId: CommandId.make(newId()),
          threadId: thread.id,
          requestId: approval.requestId,
          decision: flags.decision,
        });
        yield* Console.log(`Responded ${flags.decision} to ${approval.requestId}.`);
      }),
    ),
  ),
);

const answerCommand = Command.make("answer", {
  ...environmentTargetFlags,
  thread: threadArgument,
  answers: Argument.String("answer").pipe(
    Argument.withDescription(
      "<question-id>=<answer>, repeatable (repeat an id for multi-select). A bare answer fills a single-question request.",
    ),
    Argument.variadic(),
  ),
  request: Flag.String("request").pipe(
    Flag.withDescription("Question request id. Default: the oldest pending question."),
    Flag.optional,
  ),
  dismiss: Flag.Boolean("dismiss").pipe(
    Flag.withDescription("Close an async question without answering it."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("Answer (or dismiss) a question the agent asked."),
  Command.withHandler(
    withClient(
      Effect.fn("cli.thread.answer")(function* (client, flags) {
        const { thread } = yield* resolveThread(client, flags.thread);
        const detail = yield* loadThreadDetail(client, thread.id);
        const { userInputs } = pendingRequests(detail);
        const requestId = Option.getOrUndefined(flags.request);
        const request =
          requestId === undefined
            ? userInputs[0]
            : userInputs.find((entry) => entry.requestId === requestId);
        if (request === undefined) {
          return yield* fail(
            "no-pending-request",
            `Thread ${thread.id} has no matching pending question.`,
          );
        }
        if (flags.dismiss) {
          if (!request.dismissible) {
            return yield* fail(
              "invalid-input",
              "This question must be answered; it cannot be dismissed.",
            );
          }
          yield* dispatch(client, {
            type: "thread.user-input.dismiss",
            commandId: CommandId.make(newId()),
            threadId: thread.id,
            requestId: request.requestId,
          });
          return yield* Console.log(`Dismissed ${request.requestId}.`);
        }
        const collected = new Map<string, string[]>();
        for (const raw of flags.answers) {
          const separator = raw.indexOf("=");
          const questionId =
            separator > 0
              ? raw.slice(0, separator)
              : request.questions.length === 1
                ? request.questions[0]!.id
                : undefined;
          if (questionId === undefined) {
            return yield* fail(
              "invalid-input",
              `This request has ${request.questions.length} questions; use <question-id>=<answer>.`,
            );
          }
          const value = separator > 0 ? raw.slice(separator + 1) : raw;
          collected.set(questionId, [...(collected.get(questionId) ?? []), value]);
        }
        if (collected.size === 0) {
          return yield* fail("invalid-input", "Pass at least one answer, or --dismiss.");
        }
        const answers: Record<string, string | ReadonlyArray<string>> = {};
        for (const question of request.questions) {
          const values = collected.get(question.id);
          if (values === undefined) continue;
          answers[question.id] = question.multiSelect ? values : values.join(" ");
        }
        yield* dispatch(client, {
          type: "runtime-request.respond",
          commandId: CommandId.make(newId()),
          threadId: thread.id,
          requestId: request.requestId,
          answers,
        });
        yield* Console.log(`Answered ${request.requestId}.`);
      }),
    ),
  ),
);

/** A command that dispatches thread-scoped orchestration commands. */
const simpleThreadCommand = <const Name extends string, E = never>(
  name: Name,
  description: string,
  build: (input: {
    readonly client: EnvironmentRpcClient;
    readonly thread: OrchestrationV2ThreadShell;
    readonly commandId: CommandId;
  }) =>
    | OrchestrationV2Command
    | ReadonlyArray<OrchestrationV2Command>
    | Effect.Effect<ReadonlyArray<OrchestrationV2Command>, E>,
  done: string,
) =>
  Command.make(name, { ...environmentTargetFlags, thread: threadArgument }).pipe(
    Command.withDescription(description),
    Command.withHandler(
      withClient(
        Effect.fn(`cli.thread.${name}`)(function* (client, flags) {
          const { thread } = yield* resolveThread(client, flags.thread);
          const built = build({ client, thread, commandId: CommandId.make(newId()) });
          const commands = Effect.isEffect(built)
            ? yield* built
            : Array.isArray(built)
              ? built
              : [built as OrchestrationV2Command];
          for (const command of commands) yield* dispatch(client, command);
          yield* Console.log(`${done} ${thread.id}.`);
        }),
      ),
    ),
  );

const interruptCommand = simpleThreadCommand(
  "interrupt",
  "Stop the agent's current turn.",
  ({ thread, commandId }) => {
    // Background work still running after the latest run settled is stopped
    // through that run, as the composer's Stop button does.
    const runId: RunId | null =
      thread.activeRunId ??
      ((thread.pendingBackgroundTasks ?? []).length > 0 ? thread.latestRunId : null);
    if (runId === null) {
      return Effect.fail(
        new ThreadCliError({
          reason: "invalid-input",
          detail: `Thread ${thread.id} has no running turn to interrupt.`,
        }),
      );
    }
    return Effect.succeed([
      { type: "run.interrupt", commandId, threadId: thread.id, runId, holdQueue: true } as const,
    ]);
  },
  "Interrupted",
);

const stopCommand = simpleThreadCommand(
  "stop",
  "Stop the thread's provider session.",
  ({ client, thread, commandId }) =>
    loadThreadDetail(client, thread.id).pipe(
      Effect.map((projection) =>
        projection.providerSessions.map((session): OrchestrationV2Command => ({
          type: "provider-session.detach",
          commandId: CommandId.make(`${commandId}:detach:${session.id}`),
          threadId: thread.id,
          providerSessionId: session.id,
          reason: "client-requested",
        })),
      ),
    ),
  "Stopped",
);

const lifecycleCommands = [
  simpleThreadCommand(
    "archive",
    "Archive a thread.",
    ({ thread, commandId }) => ({ type: "thread.archive", commandId, threadId: thread.id }),
    "Archived",
  ),
  simpleThreadCommand(
    "unarchive",
    "Restore an archived thread.",
    ({ thread, commandId }) => ({ type: "thread.unarchive", commandId, threadId: thread.id }),
    "Unarchived",
  ),
  simpleThreadCommand(
    "settle",
    "Mark a thread as done.",
    ({ thread, commandId }) => ({ type: "thread.settle", commandId, threadId: thread.id }),
    "Settled",
  ),
  simpleThreadCommand(
    "unsettle",
    "Move a settled thread back to active.",
    ({ thread, commandId }) => ({
      type: "thread.unsettle",
      commandId,
      threadId: thread.id,
      reason: "user",
    }),
    "Unsettled",
  ),
  simpleThreadCommand(
    "pin",
    "Pin a thread.",
    ({ thread, commandId }) => ({ type: "thread.pin", commandId, threadId: thread.id }),
    "Pinned",
  ),
  simpleThreadCommand(
    "unpin",
    "Unpin a thread.",
    ({ thread, commandId }) => ({ type: "thread.unpin", commandId, threadId: thread.id }),
    "Unpinned",
  ),
  simpleThreadCommand(
    "unsnooze",
    "Wake a snoozed thread.",
    ({ thread, commandId }) => ({
      type: "thread.unsnooze",
      commandId,
      threadId: thread.id,
      reason: "user",
    }),
    "Unsnoozed",
  ),
  simpleThreadCommand(
    "delete",
    "Delete a thread permanently.",
    ({ thread, commandId }) => ({ type: "thread.delete", commandId, threadId: thread.id }),
    "Deleted",
  ),
];

const snoozeCommand = Command.make("snooze", {
  ...environmentTargetFlags,
  thread: threadArgument,
  duration: Argument.String("duration").pipe(
    Argument.withSchema(DurationFromString),
    Argument.withDescription("How long to snooze, e.g. 30m, 2h, 1d."),
  ),
}).pipe(
  Command.withDescription("Hide a thread from the inbox for a while."),
  Command.withHandler(
    withClient(
      Effect.fn("cli.thread.snooze")(function* (client, flags) {
        const { thread } = yield* resolveThread(client, flags.thread);
        const until = DateTime.formatIso(DateTime.addDuration(yield* DateTime.now, flags.duration));
        yield* dispatch(client, {
          type: "thread.snooze",
          commandId: CommandId.make(newId()),
          threadId: thread.id,
          snoozedUntil: until,
        });
        yield* Console.log(`Snoozed ${thread.id} until ${until}.`);
      }),
    ),
  ),
);

const renameCommand = Command.make("rename", {
  ...environmentTargetFlags,
  thread: threadArgument,
  title: Argument.String("title"),
}).pipe(
  Command.withDescription("Rename a thread."),
  Command.withHandler(
    withClient(
      Effect.fn("cli.thread.rename")(function* (client, flags) {
        const { thread } = yield* resolveThread(client, flags.thread);
        const title = flags.title.trim();
        if (title.length === 0) return yield* fail("invalid-input", "Title cannot be empty.");
        yield* dispatch(client, {
          type: "thread.metadata.update",
          commandId: CommandId.make(newId()),
          threadId: thread.id,
          title,
        });
        yield* Console.log(`Renamed ${thread.id} to ${title}.`);
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
