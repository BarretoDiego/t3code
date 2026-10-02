import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  type ClientOrchestrationCommand,
  MessageId,
  ModelSelection,
  ORCHESTRATION_WS_METHODS,
  type OrchestrationMessage,
  type OrchestrationProjectShell,
  type OrchestrationShellSnapshot,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  ProviderApprovalDecision,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import { resolveThreadAwarenessPhase } from "@t3tools/shared/agentAwareness";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import { HostProcessWorkingDirectory } from "@t3tools/shared/hostProcess";
import { derivePendingRequests } from "@t3tools/shared/pendingRequests";
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

import { threadHasQueuedTurnStart } from "../orchestration/ThreadSettlementPolicy.ts";
import { DurationFromString } from "./config.ts";
import {
  type EnvironmentRpcClient,
  type EnvironmentTargetFlags,
  environmentTargetFlags,
  withEnvironmentRpc,
} from "./environmentRpc.ts";

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
 * states win over activity, and a sent-but-not-yet-started turn reads as
 * queued rather than as the previous turn's "completed".
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

export function resolveThreadStatus(thread: OrchestrationThreadShell, now: string): ThreadStatus {
  const phase = resolveThreadAwarenessPhase(thread);
  if (phase === "waiting_for_approval" || phase === "waiting_for_input" || phase === "failed") {
    return phase;
  }
  if (phase !== "starting" && phase !== "running" && threadHasQueuedTurnStart(thread, now)) {
    return "queued";
  }
  if (phase === "starting" || phase === "running" || phase === "completed") return phase;
  if (thread.session?.status === "interrupted" || thread.latestTurn?.state === "interrupted") {
    return "interrupted";
  }
  return "idle";
}

const BUSY_STATUSES: ReadonlySet<ThreadStatus> = new Set(["queued", "starting", "running"]);

/**
 * Whether a waiter can return: the agent stopped or needs a human. When
 * `sentAt` is given, the thread must first show a user message at or after it,
 * so a wait issued right after a send never returns on the previous turn.
 */
export function isThreadSettledForWait(
  thread: OrchestrationThreadShell,
  now: string,
  sentAt?: string,
): boolean {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return true;
  if (sentAt !== undefined) {
    const latest = thread.latestUserMessageAt;
    if (latest === null || Date.parse(latest) < Date.parse(sentAt)) return false;
  }
  return !BUSY_STATUSES.has(resolveThreadStatus(thread, now));
}

// ---------------------------------------------------------------------------
// Server reads

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

export const loadShell = (client: EnvironmentRpcClient) =>
  client[ORCHESTRATION_WS_METHODS.subscribeShell]({}).pipe(
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
  client[ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot]({});

const loadThreadDetail = (client: EnvironmentRpcClient, threadId: ThreadId, turnLimit?: number) =>
  client[ORCHESTRATION_WS_METHODS.subscribeThread]({
    threadId,
    ...(turnLimit === undefined ? {} : { turnLimit }),
  }).pipe(
    Stream.filterMap((item) =>
      item.kind === "snapshot" ? Result.succeed(item.snapshot.thread) : Result.fail(item),
    ),
    Stream.runHead,
    Effect.flatMap(
      Option.match({
        onNone: () => fail("thread-not-found", `Thread ${threadId} not found.`),
        onSome: Effect.succeed,
      }),
    ),
  );

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
  shell: OrchestrationShellSnapshot,
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
  shell: OrchestrationShellSnapshot,
  project: OrchestrationProjectShell,
  modelFlag: Option.Option<string>,
) {
  const settings = yield* client[WS_METHODS.serverGetSettings]({});
  const resolved = resolveProjectSettings(settings, project.id, project).settings;
  const recent = shell.threads
    .filter((thread) => thread.projectId === project.id)
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
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
  thread: OrchestrationThreadShell,
  project: OrchestrationProjectShell | undefined,
  now: string,
) {
  return {
    id: thread.id,
    title: thread.title,
    status: resolveThreadStatus(thread, now),
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
    snoozedUntil: thread.snoozedUntil ?? null,
    hasPendingApprovals: thread.hasPendingApprovals,
    hasPendingUserInput: thread.hasPendingUserInput,
    hasActionableProposedPlan: thread.hasActionableProposedPlan,
    planProgress: thread.planProgress ?? null,
    backgroundLiveness: thread.backgroundLiveness ?? null,
    lastError: thread.session?.lastError ?? null,
    pullRequests: thread.pullRequests
      .filter((link) => link.source !== "stack-dismissed")
      .map((link) => link.url),
    latestUserMessageAt: thread.latestUserMessageAt,
    updatedAt: thread.updatedAt,
  };
}

type ThreadSummary = ReturnType<typeof summarizeThread>;

function conversationMessages(thread: OrchestrationThread) {
  return thread.messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({
      id: message.id,
      role: message.role,
      text: message.text,
      streaming: message.streaming,
      createdAt: message.createdAt,
    }));
}

/** Assistant text produced after the latest user message: the agent's reply. */
function latestReply(messages: ReadonlyArray<OrchestrationMessage>): string {
  const lastUserIndex = messages.findLastIndex((message) => message.role === "user");
  return messages
    .slice(lastUserIndex + 1)
    .filter((message) => message.role === "assistant" && message.text.trim().length > 0)
    .map((message) => message.text.trim())
    .join("\n\n");
}

function threadAttention(thread: OrchestrationThread) {
  const pending = derivePendingRequests(thread.activities);
  const plan = thread.proposedPlans
    .filter((entry) => entry.implementedAt === null)
    .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  return {
    pendingApprovals: pending.approvals,
    pendingUserInputs: pending.userInputs,
    proposedPlan: plan ? { id: plan.id, markdown: plan.planMarkdown } : null,
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

export const printJson = (value: unknown) => Console.log(JSON.stringify(value, null, 2));

// ---------------------------------------------------------------------------
// Waiting

/**
 * Follows the shell stream until the thread settles (see
 * `isThreadSettledForWait`). Event-driven: every shell upsert re-evaluates the
 * thread, so there is no polling interval to tune.
 */
const waitForThread = Effect.fn("cli.thread.wait")(function* (
  client: EnvironmentRpcClient,
  threadId: ThreadId,
  options: { readonly sentAt?: string; readonly timeout: Option.Option<Duration.Duration> },
) {
  let current: OrchestrationThreadShell | undefined;
  const settled = client[ORCHESTRATION_WS_METHODS.subscribeShell]({}).pipe(
    Stream.mapEffect((item) =>
      Effect.gen(function* () {
        if (item.kind === "snapshot") {
          current = item.snapshot.threads.find((thread) => thread.id === threadId);
          if (current === undefined) {
            return yield* fail("thread-not-found", `Thread ${threadId} is not active.`);
          }
        } else if (item.kind === "thread-upserted" && item.thread.id === threadId) {
          current = item.thread;
        } else if (item.kind === "thread-removed" && item.threadId === threadId) {
          return yield* fail("thread-not-found", `Thread ${threadId} was removed.`);
        } else {
          return null;
        }
        return current !== undefined &&
          isThreadSettledForWait(current, yield* nowIso, options.sentAt)
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
          `Timed out waiting for thread ${threadId}; it is still ${current ? resolveThreadStatus(current, DateTime.formatIso(DateTime.nowUnsafe())) : "running"}.`,
        ),
    }),
  );
});

/** Waits, then prints the outcome an agent needs: status, reply, and blockers. */
const waitAndReport = Effect.fn("cli.thread.waitAndReport")(function* (
  client: EnvironmentRpcClient,
  threadId: ThreadId,
  options: {
    readonly sentAt?: string;
    readonly timeout: Option.Option<Duration.Duration>;
    readonly json: boolean;
  },
) {
  const settled = yield* waitForThread(client, threadId, options);
  const detail = yield* loadThreadDetail(client, threadId, 1);
  const now = yield* nowIso;
  const shell = yield* loadShell(client);
  const summary = summarizeThread(
    settled,
    shell.projects.find((project) => project.id === settled.projectId),
    now,
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

export const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Print machine-readable JSON."),
  Flag.withDefault(false),
);
const threadArgument = Argument.String("thread").pipe(
  Argument.withDescription("Thread id or unique id prefix."),
);
const waitFlag = Flag.Boolean("wait").pipe(
  Flag.withDescription(
    "Block until the agent finishes or needs approval/input, then print its reply.",
  ),
  Flag.withDefault(false),
);
export const timeoutFlag = Flag.String("timeout").pipe(
  Flag.withSchema(DurationFromString),
  Flag.withDescription("Give up waiting after this long (e.g. 30s, 10m, 2h)."),
  Flag.optional,
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
const messageArgument = Argument.String("message").pipe(
  Argument.withDescription("Message text. Omit or pass - to read it from stdin."),
  Argument.variadic(),
);

/** Runs a handler against the live server's RPC client. */
export const withClient =
  <Flags extends EnvironmentTargetFlags, A, E, R>(
    run: (client: EnvironmentRpcClient, flags: Flags) => Effect.Effect<A, E, R>,
  ) =>
  (flags: Flags) =>
    withEnvironmentRpc(flags, (client) => run(client, flags));

const dispatch = (client: EnvironmentRpcClient, command: ClientOrchestrationCommand) =>
  client[ORCHESTRATION_WS_METHODS.dispatchCommand](command);

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
        const now = yield* nowIso;
        const projects = new Map(shell.projects.map((entry) => [entry.id, entry]));
        const summaries = source.threads
          .filter((thread) => project === undefined || thread.projectId === project.id)
          .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
          .map((thread) => summarizeThread(thread, projects.get(thread.projectId), now))
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
        const detail = yield* loadThreadDetail(client, thread.id, Math.max(1, flags.turns));
        const summary = summarizeThread(thread, project, yield* nowIso);
        const messages = conversationMessages(detail);
        const attention = threadAttention(detail);
        if (flags.json) return yield* printJson({ thread: summary, messages, ...attention });
        const lines = [
          formatSummaryLine(summary),
          `Model ${summary.model} · ${summary.runtimeMode} · ${summary.interactionMode}${summary.branch ? ` · ${summary.branch}` : ""}`,
        ];
        if (summary.lastError) lines.push(`Error: ${summary.lastError}`);
        for (const message of messages) {
          lines.push(
            "",
            `── ${message.role}${message.streaming ? " (streaming)" : ""}`,
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
  title: Flag.String("title").pipe(Flag.optional),
  model: modelFlag,
  runtimeMode: runtimeModeFlag,
  mode: interactionModeFlag,
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
        const runtimeMode = Option.getOrElse(flags.runtimeMode, () => defaults.runtimeMode);
        const interactionMode = Option.getOrElse(flags.mode, () => "default" as const);
        const title = Option.getOrElse(flags.title, () => threadTitleFromPrompt(text));
        const threadId = ThreadId.make(newId());
        const createdAt = yield* nowIso;
        yield* dispatch(client, {
          type: "thread.turn.start",
          commandId: CommandId.make(newId()),
          threadId,
          message: { messageId: MessageId.make(newId()), role: "user", text, attachments: [] },
          modelSelection: defaults.modelSelection,
          titleSeed: title,
          runtimeMode,
          interactionMode,
          bootstrap: {
            createThread: {
              projectId: project.id,
              title,
              modelSelection: defaults.modelSelection,
              runtimeMode,
              interactionMode,
              branch: Option.getOrNull(flags.worktree),
              worktreePath: null,
              createdAt,
            },
            ...(Option.isSome(flags.worktree)
              ? {
                  prepareWorktree: {
                    projectCwd: project.workspaceRoot,
                    baseBranch: flags.worktree.value,
                    branch: buildTemporaryWorktreeBranchName((bytes) =>
                      NodeCrypto.randomBytes(bytes).toString("hex"),
                    ),
                  },
                  runSetupScript: true,
                }
              : {}),
          },
          createdAt,
        });
        if (flags.wait) {
          return yield* waitAndReport(client, threadId, {
            sentAt: createdAt,
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
        const createdAt = yield* nowIso;
        yield* dispatch(client, {
          type: "thread.turn.start",
          commandId: CommandId.make(newId()),
          threadId: thread.id,
          message: { messageId: MessageId.make(newId()), role: "user", text, attachments: [] },
          modelSelection,
          runtimeMode: Option.getOrElse(flags.runtimeMode, () => thread.runtimeMode),
          interactionMode: Option.getOrElse(flags.mode, () => thread.interactionMode),
          createdAt,
        });
        if (flags.wait) {
          return yield* waitAndReport(client, thread.id, {
            sentAt: createdAt,
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
        const detail = yield* loadThreadDetail(client, thread.id, 1);
        const { approvals } = derivePendingRequests(detail.activities);
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
          type: "thread.approval.respond",
          commandId: CommandId.make(newId()),
          threadId: thread.id,
          requestId: approval.requestId,
          decision: flags.decision,
          createdAt: yield* nowIso,
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
        const detail = yield* loadThreadDetail(client, thread.id, 1);
        const { userInputs } = derivePendingRequests(detail.activities);
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
        const createdAt = yield* nowIso;
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
            createdAt,
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
          type: "thread.user-input.respond",
          commandId: CommandId.make(newId()),
          threadId: thread.id,
          requestId: request.requestId,
          answers,
          createdAt,
        });
        yield* Console.log(`Answered ${request.requestId}.`);
      }),
    ),
  ),
);

/** A command that dispatches one thread-scoped orchestration command. */
const simpleThreadCommand = <const Name extends string>(
  name: Name,
  description: string,
  build: (input: {
    readonly thread: OrchestrationThreadShell;
    readonly commandId: CommandId;
    readonly createdAt: string;
  }) => ClientOrchestrationCommand,
  done: string,
) =>
  Command.make(name, { ...environmentTargetFlags, thread: threadArgument }).pipe(
    Command.withDescription(description),
    Command.withHandler(
      withClient(
        Effect.fn(`cli.thread.${name}`)(function* (client, flags) {
          const { thread } = yield* resolveThread(client, flags.thread);
          yield* dispatch(
            client,
            build({ thread, commandId: CommandId.make(newId()), createdAt: yield* nowIso }),
          );
          yield* Console.log(`${done} ${thread.id}.`);
        }),
      ),
    ),
  );

const interruptCommand = simpleThreadCommand(
  "interrupt",
  "Stop the agent's current turn.",
  ({ thread, commandId, createdAt }) => ({
    type: "thread.turn.interrupt",
    commandId,
    threadId: thread.id,
    ...(thread.session?.activeTurnId ? { turnId: thread.session.activeTurnId } : {}),
    createdAt,
  }),
  "Interrupted",
);

const stopCommand = simpleThreadCommand(
  "stop",
  "Stop the thread's provider session.",
  ({ thread, commandId, createdAt }) => ({
    type: "thread.session.stop",
    commandId,
    threadId: thread.id,
    createdAt,
  }),
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
          type: "thread.meta.update",
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
