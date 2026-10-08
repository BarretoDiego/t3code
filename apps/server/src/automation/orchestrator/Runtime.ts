import {
  AUTOMATION_CONTRACT_VERSION,
  type AutomationError,
  CommandId,
  DELEGATED_TASK_TERMINAL_STATUSES,
  type DelegatedTask,
  type EnvironmentId,
  IdempotencyKey,
  type InboxEntry,
  MessageId,
  type Orchestrator,
  type OrchestratorBudget,
  type OrchestratorCheckpoint,
  type OrchestratorId,
  type OrchestratorUsage,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type PendingRequestSummary,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as CommandReceiptStore from "../../orchestration-v2/CommandReceiptStore.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import { randomUuidV4 } from "../../orchestration-v2/RandomUuid.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import { forkParked } from "../../serverActivation.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { automationError, internalCaller } from "../Caller.ts";
import * as EventJournal from "../EventJournal.ts";
import * as ResponsibilityService from "../ResponsibilityService.ts";
import { makeAgentCredentials } from "./AgentCredentials.ts";
import { buildTurnPrompt, clip, entryWithinScope, taskIdsOf } from "./inboxPolicy.ts";
import { ORCHESTRATOR_INSTRUCTIONS, ORCHESTRATOR_MINI_SKILL_ID } from "./instructions.ts";
import {
  makeStore,
  type OrchestratorStore,
  type StoredInboxEntry,
  type StoredOrchestrator,
  type StoredTurn,
} from "./Store.ts";
import { agentShellRefusal, resolveTurnLibrary, type TurnLibrary } from "./TurnPreparation.ts";

const HOUR_MS = 60 * 60 * 1_000;
/** Informational entries shown alongside the actionable ones of a turn. */
const MAX_BATCHED_INFORMATIONAL = 20;
const MAX_CHECKPOINT_GOALS = 20;
const MAX_CHECKPOINT_DECISIONS = 20;
const MAX_SUMMARY_CHARS = 4_000;
const MAX_DECISION_CHARS = 600;
/** How long a turn's agent credential lasts when the budget sets no turn duration. */
const DEFAULT_CREDENTIAL_TTL_MS = 12 * HOUR_MS;
const CREDENTIAL_TTL_MARGIN_MS = 5 * 60 * 1_000;
/** Marks a `stateReason` that says no turn can start until the operator changes something. */
const TURN_REFUSED_PREFIX = "Cannot start a turn: ";

type ThreadView = Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "providerTurns">;

const turnRefused = (row: StoredOrchestrator) =>
  row.stateReason !== null && row.stateReason.startsWith(TURN_REFUSED_PREFIX);

const isActiveTurn = (turn: StoredTurn) =>
  turn.status === "reserved" || turn.status === "dispatched";

const isTerminalRun = (status: OrchestrationV2Run["status"]) =>
  ThreadManagementService.isTerminalRunStatus(status);

/**
 * Tokens the orchestrator's lineage has used: its main thread's provider turns
 * plus what its delegated tasks report. A turn or task without a report makes
 * the total incomplete; when nothing at all was reported it is unknown (null),
 * which is never read as zero and never as over budget.
 */
const tokenUsage = (
  view: ThreadView | null,
  tasks: ReadonlyArray<DelegatedTask>,
): Pick<OrchestratorUsage, "tokens" | "tokensComplete"> => {
  let total = 0;
  let reported = 0;
  let missing = 0;
  for (const turn of view?.providerTurns ?? []) {
    const usage = turn.turnTokenUsage;
    if (usage === undefined || usage.usageStatus === "unavailable") {
      missing += 1;
      continue;
    }
    if (usage.usageStatus === "partial") missing += 1;
    if (usage.inputTokens !== undefined || usage.outputTokens !== undefined) reported += 1;
    total += (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  }
  for (const task of tasks) {
    if (task.usage.turns === 0) continue;
    if (task.usage.tokens === null) {
      missing += 1;
      continue;
    }
    reported += 1;
    total += task.usage.tokens;
  }
  if (reported === 0) {
    return missing === 0
      ? { tokens: 0, tokensComplete: true }
      : { tokens: null, tokensComplete: false };
  }
  return { tokens: total, tokensComplete: missing === 0 };
};

const usageOf = (input: {
  readonly row: StoredOrchestrator;
  readonly turns: ReadonlyArray<StoredTurn>;
  readonly tasks: ReadonlyArray<DelegatedTask>;
  readonly view: ThreadView | null;
  readonly nowMs: number;
}): OrchestratorUsage => ({
  ...tokenUsage(input.view, input.tasks),
  turns: input.turns.length,
  turnsLastHour: input.turns.filter((turn) => Date.parse(turn.reservedAt) > input.nowMs - HOUR_MS)
    .length,
  activeChildren: input.tasks.filter(
    (task) => !DELEGATED_TASK_TERMINAL_STATUSES.includes(task.status),
  ).length,
  since: input.row.usageSince,
});

/** Why no new turn may start, or null. `retryAtMs` is set when waiting fixes it. */
const budgetBlock = (
  budget: OrchestratorBudget,
  usage: OrchestratorUsage,
  turns: ReadonlyArray<StoredTurn>,
  nowMs: number,
): { readonly reason: string; readonly retryAtMs: number | null } | null => {
  if (budget.maxTokens !== null && usage.tokens !== null && usage.tokens >= budget.maxTokens) {
    return {
      reason: `Token budget reached: ${usage.tokens} of ${budget.maxTokens} tokens used.`,
      retryAtMs: null,
    };
  }
  if (budget.maxTurnsPerHour !== null && usage.turnsLastHour >= budget.maxTurnsPerHour) {
    const inWindow = turns
      .map((turn) => Date.parse(turn.reservedAt))
      .filter((reservedAt) => reservedAt > nowMs - HOUR_MS)
      .toSorted((left, right) => left - right);
    const freesAt = inWindow[inWindow.length - budget.maxTurnsPerHour];
    return {
      reason: `Turn budget reached: ${usage.turnsLastHour} of ${budget.maxTurnsPerHour} turns in the last hour.`,
      retryAtMs: freesAt === undefined ? null : freesAt + HOUR_MS,
    };
  }
  return null;
};

/** Entries allowed to open a turn, and the task that held any back. */
const withinTaskTurnBudget = (
  entries: ReadonlyArray<StoredInboxEntry>,
  turns: ReadonlyArray<StoredTurn>,
  maxTurnsPerTask: number | null,
) => {
  if (maxTurnsPerTask === null) return { eligible: entries, heldTaskId: null as string | null };
  const turnsByTask = new Map<string, number>();
  for (const turn of turns) {
    for (const taskId of turn.taskIds) turnsByTask.set(taskId, (turnsByTask.get(taskId) ?? 0) + 1);
  }
  let heldTaskId: string | null = null;
  const eligible = entries.filter(({ entry }) => {
    const over = taskIdsOf([entry]).find(
      (taskId) => (turnsByTask.get(taskId) ?? 0) >= maxTurnsPerTask,
    );
    if (over !== undefined) heldTaskId = over;
    return over === undefined;
  });
  return { eligible, heldTaskId };
};

interface TurnGate {
  /** Entries a turn would read now, or empty. */
  readonly batch: ReadonlyArray<StoredInboxEntry>;
  readonly blockedReason: string | null;
  /** Actionable entries exist but their batch window is still open. */
  readonly waitingUntilMs: number | null;
  readonly retryAtMs: number | null;
  readonly actionablePending: number;
}

/**
 * The one place that decides whether an orchestrator may take a turn. Both the
 * loop and the reported `effectiveState` come from it, so what is shown is what
 * the runtime will do.
 */
const turnGate = (input: {
  readonly row: StoredOrchestrator;
  readonly pending: ReadonlyArray<StoredInboxEntry>;
  readonly turns: ReadonlyArray<StoredTurn>;
  readonly usage: OrchestratorUsage;
  readonly nowMs: number;
}): TurnGate => {
  const visible = input.pending.filter(({ entry }) => entryWithinScope(entry, input.row.config));
  const actionable = visible.filter(({ entry }) => entry.relevance === "actionable");
  const none = { batch: [], waitingUntilMs: null, retryAtMs: null } as const;
  if (actionable.length === 0) {
    return { ...none, blockedReason: null, actionablePending: 0 };
  }
  const budget = input.row.config.budget;
  const block = budgetBlock(budget, input.usage, input.turns, input.nowMs);
  if (block !== null) {
    return {
      ...none,
      blockedReason: block.reason,
      retryAtMs: block.retryAtMs,
      actionablePending: actionable.length,
    };
  }
  const { eligible, heldTaskId } = withinTaskTurnBudget(
    actionable,
    input.turns,
    budget.maxTurnsPerTask,
  );
  if (eligible.length === 0) {
    return {
      ...none,
      blockedReason: `Turn budget reached for task ${heldTaskId}: ${budget.maxTurnsPerTask} turns per task.`,
      actionablePending: actionable.length,
    };
  }
  const dueAtMs =
    Math.min(...eligible.map(({ entry }) => Date.parse(entry.receivedAt))) +
    input.row.config.batchWindowMs;
  if (input.nowMs < dueAtMs) {
    return {
      ...none,
      blockedReason: null,
      waitingUntilMs: dueAtMs,
      actionablePending: actionable.length,
    };
  }
  const informational = visible
    .filter(({ entry }) => entry.relevance === "informational")
    .slice(-MAX_BATCHED_INFORMATIONAL);
  return {
    batch: [...eligible, ...informational].toSorted(
      (left, right) => left.sequence - right.sequence,
    ),
    blockedReason: null,
    waitingUntilMs: null,
    retryAtMs: null,
    actionablePending: actionable.length,
  };
};

/**
 * The turn loop of every orchestrator hosted by this environment. It is woken
 * by inbox writes, by the main thread's run ending, and by the scheduler sweep;
 * it never calls a model unless an actionable entry is pending.
 */
export class OrchestratorRuntime extends Context.Service<
  OrchestratorRuntime,
  {
    readonly store: OrchestratorStore;
    readonly environmentId: EnvironmentId;
    /** Reconciles turns left open by a previous process, then starts reacting. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Asks the loop to look at one orchestrator. Safe to call from anywhere, any number of times. */
    readonly wake: (orchestratorId: OrchestratorId) => Effect.Effect<void>;
    /** Resolves once every queued wake has been handled. Turns in flight at a provider are not awaited. */
    readonly drain: Effect.Effect<void>;
    /** The record a client sees: stored fields plus what the runtime is doing right now. */
    readonly describe: (row: StoredOrchestrator) => Effect.Effect<Orchestrator, AutomationError>;
    readonly interruptActiveTurn: (
      orchestratorId: OrchestratorId,
      reason: string,
    ) => Effect.Effect<boolean, AutomationError>;
    /** Writes a checkpoint outside a turn, for example before a successor session starts. */
    readonly checkpointIdle: (
      orchestratorId: OrchestratorId,
      summary: string,
    ) => Effect.Effect<OrchestratorCheckpoint, AutomationError>;
    /** Published whenever a record a client lists may have changed. */
    readonly changes: PubSub.PubSub<void>;
    readonly notifyChanged: Effect.Effect<void>;
  }
>()("t3/automation/orchestrator/Runtime/OrchestratorRuntime") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
  const journal = yield* EventJournal.EventJournal;
  const responsibility = yield* ResponsibilityService.ResponsibilityService;
  const scheduler = yield* Scheduler.Scheduler;
  const settings = yield* ServerSettings.ServerSettingsService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const credentials = yield* makeAgentCredentials;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  const scope = yield* Effect.scope;
  const store = makeStore(sql);
  const changed = yield* PubSub.sliding<void>(1);
  const started = yield* Deferred.make<void>();
  const wakeTimers = new Map<OrchestratorId, number>();

  const isoNow = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const notifyChanged = PubSub.publish(changed, undefined).pipe(Effect.asVoid);

  const readThread = (threadId: ThreadId): Effect.Effect<ThreadView | null> =>
    threads
      .getThreadRecords(threadId, ["runs", "providerTurns"])
      .pipe(Effect.catch(() => Effect.succeed(null)));

  const describe: OrchestratorRuntime["Service"]["describe"] = Effect.fn(
    "OrchestratorRuntime.describe",
  )(function* (row) {
    const now = yield* isoNow;
    const nowMs = yield* Clock.currentTimeMillis;
    const turns = yield* store.listTurns(row.id);
    const tasks = yield* store.listTasks(row.id);
    const hosted = row.hostEnvironmentId === environmentId;
    const view = hosted && row.threadId !== null ? yield* readThread(row.threadId) : null;
    const usage = usageOf({ row, turns, tasks, view, nowMs });
    const pending = yield* store.listInbox({ orchestratorId: row.id, statuses: ["pending"] });
    const unknown = yield* store.countInbox(row.id, "unknown");
    const checkpoints = yield* store.listCheckpoints(row.id, 1);
    const activeTurn = turns.find(isActiveTurn);
    const gate = turnGate({ row, pending, turns, usage, nowMs });
    const activeRun =
      activeTurn === undefined || view === null
        ? undefined
        : view.runs.find((run) => run.userMessageId === activeTurn.messageId);

    let effectiveState: Orchestrator["effectiveState"] = "idle";
    let stateReason: string | null = null;
    if (!hosted) {
      effectiveState = "not_hosted_here";
      stateReason = `Hosted by environment ${row.hostEnvironmentId}.`;
    } else if (row.desiredState === "disabled") {
      effectiveState = "disabled";
      stateReason = "Disabled: no turns, and hooks cannot deliver to the inbox.";
    } else if (activeTurn !== undefined) {
      effectiveState =
        activeRun !== undefined && activeRun.status !== "queued" && activeRun.status !== "preparing"
          ? "running"
          : "queued";
      stateReason =
        row.desiredState === "paused"
          ? "Paused: the current turn is finishing and no new turn will start."
          : row.stateReason;
    } else if (row.desiredState === "paused") {
      effectiveState = "paused";
      stateReason = "Paused: the inbox keeps filling and no turn will start.";
    } else if (view === null) {
      effectiveState = "error";
      stateReason = "The main thread could not be read.";
    } else if (gate.blockedReason !== null) {
      effectiveState = "budget_exceeded";
      stateReason = gate.blockedReason;
    } else if (gate.actionablePending > 0 && turnRefused(row)) {
      effectiveState = "error";
      stateReason = row.stateReason;
    } else if (gate.actionablePending > 0) {
      effectiveState = "queued";
      stateReason =
        gate.waitingUntilMs === null ? null : "Collecting inbox entries before the next turn.";
    } else if (row.stateReason !== null || unknown > 0) {
      effectiveState = "error";
      stateReason =
        row.stateReason ??
        `${unknown} inbox ${unknown === 1 ? "entry has" : "entries have"} an unknown outcome and need review.`;
    } else if (usage.activeChildren > 0) {
      effectiveState = "waiting";
      stateReason = `${usage.activeChildren} delegated ${usage.activeChildren === 1 ? "task is" : "tasks are"} in progress.`;
    }

    return {
      id: row.id,
      version: AUTOMATION_CONTRACT_VERSION,
      revision: row.revision,
      ...row.config,
      hostEnvironmentId: row.hostEnvironmentId,
      hostGeneration: row.hostGeneration,
      threadId: row.threadId,
      desiredState: row.desiredState,
      effectiveState,
      stateReason,
      inboxPending: pending.length,
      usage,
      lastTurnAt: row.lastTurnAt,
      lastCheckpointAt: checkpoints[0]?.createdAt ?? null,
      observedAt: now,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    } satisfies Orchestrator;
  });

  const scopeOf = (row: StoredOrchestrator) => ({
    orchestratorId: row.id,
    projectId: row.config.projectId,
    ...(row.threadId === null ? {} : { threadId: row.threadId }),
  });

  /** Entries move to `unknown` and are surfaced; nothing is dispatched again on its own. */
  const markTurnUnknown = Effect.fn("OrchestratorRuntime.markTurnUnknown")(function* (
    row: StoredOrchestrator,
    turn: StoredTurn,
    reason: string,
  ) {
    const now = yield* isoNow;
    yield* credentials.revoke(row.id);
    const entryIds = yield* store.turnEntryIds(row.id, turn.sequence);
    yield* store.transact(
      Effect.gen(function* () {
        for (const entryId of entryIds) {
          yield* store.transitionInboxEntry({
            orchestratorId: row.id,
            entryId,
            from: ["reserved"],
            to: "unknown",
            runId: turn.runId,
            now,
          });
        }
        yield* store.updateTurn(turn, { status: "unknown", outcome: reason, finishedAt: now });
        yield* store.setStateReason(
          row.id,
          `${reason} ${entryIds.length} inbox ${entryIds.length === 1 ? "entry needs" : "entries need"} review: requeue or dismiss.`,
          now,
        );
        yield* journal.append([
          {
            type: "orchestrator.turn.finished",
            origin: { kind: "service", actorId: row.id },
            scope: { ...scopeOf(row), ...(turn.runId === null ? {} : { runId: turn.runId }) },
            aggregate: { kind: "orchestrator", id: row.id },
            payload: { outcome: "unknown", reason, turn: turn.sequence, entryIds },
            dedupKey: `orchestrator-turn:${turn.commandId}`,
          },
        ]);
      }),
    );
    yield* notifyChanged;
  });

  const buildCheckpoint = Effect.fn("OrchestratorRuntime.buildCheckpoint")(function* (input: {
    readonly row: StoredOrchestrator;
    readonly runId: RunId | null;
    readonly summary: string;
    readonly newGoals: ReadonlyArray<InboxEntry>;
    readonly decision: { readonly text: string; readonly messageId: MessageId | null } | null;
    readonly inboxCursor: number | null;
    readonly now: string;
  }) {
    const previous = (yield* store.listCheckpoints(input.row.id, 1))[0] ?? null;
    const tasks = yield* store.listTasks(input.row.id);
    const open = tasks.filter((task) => !DELEGATED_TASK_TERMINAL_STATUSES.includes(task.status));
    const goals = [
      ...(previous?.state.goals ?? []),
      ...input.newGoals.map((entry) => ({ id: entry.id, text: clip(entry.text ?? "", 500) })),
    ].slice(-MAX_CHECKPOINT_GOALS);
    const decisions = [
      ...(previous?.state.decisions ?? []),
      ...(input.decision === null
        ? []
        : [
            {
              at: input.now,
              text: clip(input.decision.text, MAX_DECISION_CHARS),
              refs: [
                ...(input.row.threadId === null
                  ? []
                  : [{ kind: "thread" as const, ref: input.row.threadId }]),
                ...(input.decision.messageId === null
                  ? []
                  : [{ kind: "message" as const, ref: input.decision.messageId }]),
              ],
            },
          ]),
    ].slice(-MAX_CHECKPOINT_DECISIONS);
    return {
      orchestratorId: input.row.id,
      sequence: (previous?.sequence ?? 0) + 1,
      hostGeneration: input.row.hostGeneration,
      runId: input.runId,
      state: {
        goals,
        openTaskIds: open.map((task) => task.id),
        // Delegations whose delivery or outcome is not confirmed yet. The task id
        // is derived from the delegation's idempotency key, so it names the retry.
        pendingOperations: open
          .filter((task) => task.status === "pending_delivery" || task.status === "unknown")
          .map((task) => ({
            idempotencyKey: IdempotencyKey.make(task.id),
            action: "task.delegate" as const,
            status: task.status === "unknown" ? ("unknown" as const) : ("started" as const),
            ref: task.id,
          })),
        decisions,
        summary: clip(input.summary, MAX_SUMMARY_CHARS),
      },
      inboxCursor: input.inboxCursor ?? previous?.inboxCursor ?? 0,
      createdAt: input.now,
    } satisfies OrchestratorCheckpoint;
  });

  /**
   * Closes a turn whose run reached a terminal status. The checkpoint, the
   * entries' final status, the usage timestamp and the journal event commit
   * together; entries are never `processed` without the checkpoint beside them.
   */
  const finishTurn = Effect.fn("OrchestratorRuntime.finishTurn")(function* (
    row: StoredOrchestrator,
    turn: StoredTurn,
    run: OrchestrationV2Run,
  ) {
    const now = yield* isoNow;
    // The run is over, so nothing may act as this orchestrator's agent any more.
    yield* credentials.revoke(row.id);
    const completed = run.status === "completed";
    const entryIds = yield* store.turnEntryIds(row.id, turn.sequence);
    const inbox = yield* store.listInbox({ orchestratorId: row.id, statuses: ["reserved"] });
    const read = inbox.filter(({ entry }) => entryIds.includes(entry.id));
    // The model's last reply in this run is the decision record and the summary
    // the next turn starts from.
    const answer = yield* threads.getThreadRecords(turn.threadId, ["turnItems"]).pipe(
      Effect.map((records) =>
        records.turnItems.findLast(
          (item) => item.type === "assistant_message" && item.runId === run.id,
        ),
      ),
      Effect.map((item) =>
        item?.type === "assistant_message" ? { text: item.text, id: item.messageId } : undefined,
      ),
      Effect.catch(() => Effect.succeed(undefined)),
    );
    const interruptedForDuration = turn.interruptRequestedAt !== null;
    const outcome = interruptedForDuration ? "interrupted_max_duration" : run.status;
    const checkpoint = yield* buildCheckpoint({
      row,
      runId: run.id,
      summary:
        answer?.text ??
        (completed ? "The turn completed without a reply." : `The turn ended ${run.status}.`),
      newGoals: completed
        ? read.flatMap(({ entry }) => (entry.kind === "user_message" ? [entry] : []))
        : [],
      decision: answer === undefined ? null : { text: answer.text, messageId: answer.id },
      inboxCursor: completed ? Math.max(0, ...read.map(({ sequence }) => sequence)) || null : null,
      now,
    });
    yield* store.transact(
      Effect.gen(function* () {
        yield* store.insertCheckpoint(checkpoint);
        for (const entryId of entryIds) {
          yield* store.transitionInboxEntry({
            orchestratorId: row.id,
            entryId,
            from: ["reserved"],
            // A turn that did not complete may or may not have acted on what it
            // read, so its entries are surfaced instead of being fed back in.
            to: completed ? "processed" : "unknown",
            runId: run.id,
            now,
          });
        }
        yield* store.updateTurn(turn, {
          status: "finished",
          runId: run.id,
          outcome,
          finishedAt: now,
        });
        yield* store.touchLastTurn(row.id, now);
        yield* store.setStateReason(
          row.id,
          completed
            ? null
            : interruptedForDuration
              ? `The last turn was interrupted after exceeding maxTurnDurationMs; ${entryIds.length} inbox entries need review.`
              : `The last turn ended ${run.status}; ${entryIds.length} inbox entries need review.`,
          now,
        );
        yield* journal.append([
          {
            type: "orchestrator.turn.finished",
            origin: { kind: "service", actorId: row.id },
            scope: { ...scopeOf(row), runId: run.id },
            aggregate: { kind: "orchestrator", id: row.id },
            payload: {
              outcome,
              turn: turn.sequence,
              checkpoint: checkpoint.sequence,
              entryIds,
            },
            dedupKey: `orchestrator-turn:${turn.commandId}`,
          },
        ]);
      }),
    );
    yield* notifyChanged;
  });

  const wake: OrchestratorRuntime["Service"]["wake"] = (orchestratorId) =>
    Effect.suspend(() => worker.enqueue(orchestratorId));

  /** One timer per orchestrator, at the earliest instant something becomes due. */
  const wakeAt = (orchestratorId: OrchestratorId, atMs: number) =>
    Effect.gen(function* () {
      const existing = wakeTimers.get(orchestratorId);
      if (existing !== undefined && existing <= atMs) return;
      wakeTimers.set(orchestratorId, atMs);
      const nowMs = yield* Clock.currentTimeMillis;
      yield* Effect.sleep(Duration.millis(Math.max(0, atMs - nowMs))).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            if (wakeTimers.get(orchestratorId) !== atMs) return Effect.void;
            wakeTimers.delete(orchestratorId);
            return wake(orchestratorId);
          }),
        ),
        Effect.forkIn(scope),
      );
    });

  const findRun = (view: ThreadView, turn: StoredTurn) =>
    view.runs.find((run) => run.userMessageId === turn.messageId);

  /**
   * What a turn needs before it may run: a provider whose agent can be given
   * the orchestrator's own credential, and the configured agent profile
   * resolved against that provider. Fails with the reason the operator sees.
   */
  const prepareTurn = Effect.fn("OrchestratorRuntime.prepareTurn")(function* (
    row: StoredOrchestrator,
    view: ThreadView | null,
  ) {
    if (view === null) {
      return yield* automationError("INTERNAL", "The main thread could not be read.");
    }
    const selection = view.thread.modelSelection;
    const provider = (yield* providers.getProviders).find(
      (candidate) => candidate.instanceId === selection.instanceId,
    );
    const refusal = agentShellRefusal(provider, selection.instanceId);
    if (refusal !== null) return yield* refusal;
    const current = yield* settings.getSettings.pipe(
      Effect.mapError(() =>
        automationError("INTERNAL", "Server settings could not be read to apply the profile."),
      ),
    );
    return yield* resolveTurnLibrary({
      profile: row.config.profile,
      modelSelection: selection,
      settings: current,
      provider,
    });
  });

  /** Records why no turn can start. The inbox is left as it is. */
  const refuseTurn = Effect.fn("OrchestratorRuntime.refuseTurn")(function* (
    row: StoredOrchestrator,
    error: AutomationError,
  ) {
    const reason = `${TURN_REFUSED_PREFIX}${error.code}: ${error.message}`;
    // The sweep asks again on every pass; an unchanged refusal is not news.
    if (row.stateReason === reason) return;
    yield* store.setStateReason(row.id, reason, yield* isoNow);
    yield* notifyChanged;
  });

  /**
   * Hands the turn's message to the main thread. `queue_after_active` lets the
   * thread's own queue hold it behind whatever is running, so a second
   * concurrent decision turn cannot exist. The command id was fixed when the
   * turn was reserved: repeating this after a failure returns the first receipt.
   */
  const dispatchPrepared = Effect.fn("OrchestratorRuntime.dispatchPrepared")(function* (
    row: StoredOrchestrator,
    turn: StoredTurn,
    library: TurnLibrary,
  ) {
    const issued = yield* credentials
      .issue({
        orchestratorId: row.id,
        hostGeneration: row.hostGeneration,
        threadId: turn.threadId,
        ttl: Duration.millis(
          (row.config.budget.maxTurnDurationMs ?? DEFAULT_CREDENTIAL_TTL_MS) +
            CREDENTIAL_TTL_MARGIN_MS,
        ),
      })
      .pipe(Effect.result);
    if (issued._tag === "Failure") return yield* refuseTurn(row, issued.failure);
    const dispatched = yield* threads
      .dispatch({
        type: "message.dispatch",
        createdBy: "system",
        creationSource: "server",
        commandId: turn.commandId,
        threadId: turn.threadId,
        messageId: turn.messageId,
        text: turn.prompt,
        attachments: [],
        // The profile adapts the turn to the thread's provider; without one the
        // thread keeps the model it has.
        ...(library.agentProfile === null
          ? {}
          : {
              modelSelection: library.modelSelection,
              agentProfile: library.agentProfile,
              ...(library.miniSkillIds.length === 0
                ? {}
                : { miniSkillIds: [...library.miniSkillIds] }),
            }),
        dispatchMode: { type: "queue_after_active" },
      })
      .pipe(Effect.result);
    const now = yield* isoNow;
    if (dispatched._tag === "Failure") {
      const receipt = yield* receipts.getByCommandId(turn.commandId).pipe(Effect.result);
      if (receipt._tag === "Failure") {
        return yield* markTurnUnknown(
          row,
          turn,
          "The turn's dispatch failed and its receipt could not be read.",
        );
      }
      if (Option.isNone(receipt.success)) {
        // Nothing committed, so the provider never saw it. The reserved turn
        // stays and the same command is tried again on the next wake, with a
        // credential of its own.
        yield* credentials.revoke(row.id);
        yield* store.setStateReason(
          row.id,
          `The main thread did not accept the turn: ${dispatched.failure.message}`,
          now,
        );
        return yield* notifyChanged;
      }
      if (receipt.success.value.status === "rejected") {
        return yield* markTurnUnknown(
          row,
          turn,
          `The main thread rejected the turn: ${receipt.success.value.error ?? dispatched.failure.message}`,
        );
      }
    }
    const view = yield* readThread(turn.threadId);
    const run = view === null ? undefined : findRun(view, turn);
    if (run === undefined) {
      return yield* markTurnUnknown(
        row,
        turn,
        "The turn was accepted but its run cannot be found.",
      );
    }
    const entryIds = yield* store.turnEntryIds(row.id, turn.sequence);
    yield* store.transact(
      Effect.gen(function* () {
        yield* store.updateTurn(turn, { status: "dispatched", runId: run.id, dispatchedAt: now });
        for (const entryId of entryIds) {
          yield* store.transitionInboxEntry({
            orchestratorId: row.id,
            entryId,
            from: ["reserved"],
            to: "reserved",
            runId: run.id,
            now,
          });
        }
        yield* store.setStateReason(row.id, null, now);
      }),
    );
    yield* notifyChanged;
    yield* followTurn(row, { ...turn, status: "dispatched", runId: run.id, dispatchedAt: now });
  });

  /**
   * Brings a turn that is not finished one step closer, from durable facts
   * only. This is also the whole of crash recovery: a reserved turn whose
   * command has no receipt was never sent and is sent now for the first time;
   * one with a receipt is matched to its run and followed; one whose facts
   * cannot be read becomes `unknown`.
   */
  const followTurn: (
    row: StoredOrchestrator,
    turn: StoredTurn,
  ) => Effect.Effect<void, AutomationError> = Effect.fn("OrchestratorRuntime.followTurn")(
    function* (row, turn) {
      if (turn.status === "reserved") {
        const receipt = yield* receipts.getByCommandId(turn.commandId).pipe(Effect.result);
        if (receipt._tag === "Failure") {
          return yield* markTurnUnknown(
            row,
            turn,
            "The turn's dispatch receipt could not be read.",
          );
        }
        // No receipt, or an accepted one: dispatching is the first send or an
        // idempotent replay that returns the stored receipt. Neither starts a
        // second provider turn.
        if (Option.isSome(receipt.success) && receipt.success.value.status === "rejected") {
          return yield* markTurnUnknown(
            row,
            turn,
            `The main thread rejected the turn: ${receipt.success.value.error ?? "no reason recorded"}`,
          );
        }
        // Prepared again rather than remembered: the provider, the profile and
        // the credential are facts of now, not of when the turn was reserved.
        const library = yield* prepareTurn(row, yield* readThread(turn.threadId)).pipe(
          Effect.result,
        );
        if (library._tag === "Failure") return yield* refuseTurn(row, library.failure);
        return yield* dispatchPrepared(row, turn, library.success);
      }
      const view = yield* readThread(turn.threadId);
      const run = view === null ? undefined : findRun(view, turn);
      if (view === null || run === undefined) {
        return yield* markTurnUnknown(row, turn, "The turn's run can no longer be read.");
      }
      if (isTerminalRun(run.status)) {
        return yield* finishTurn(row, turn, run);
      }
      const maxDurationMs = row.config.budget.maxTurnDurationMs;
      if (maxDurationMs === null || run.startedAt === null || turn.interruptRequestedAt !== null) {
        return;
      }
      const deadlineMs = DateTime.toEpochMillis(run.startedAt) + maxDurationMs;
      const nowMs = yield* Clock.currentTimeMillis;
      if (nowMs < deadlineMs) {
        return yield* wakeAt(row.id, deadlineMs);
      }
      const now = yield* isoNow;
      yield* store.updateTurn(turn, { interruptRequestedAt: now });
      yield* threads
        .dispatch({
          type: "run.interrupt",
          commandId: CommandId.make(`${turn.commandId}:max-duration`),
          threadId: turn.threadId,
          runId: run.id,
          reason: `Orchestrator turn exceeded maxTurnDurationMs (${maxDurationMs} ms).`,
        })
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not interrupt an over-long orchestrator turn", {
              orchestratorId: row.id,
              cause,
            }),
          ),
        );
      yield* notifyChanged;
    },
  );

  /** Everything the turn may see, read only after the permission check that allows it. */
  const contextFor = Effect.fn("OrchestratorRuntime.contextFor")(function* (
    row: StoredOrchestrator,
  ) {
    const actions = row.config.permissions.actions;
    const projectIds = row.config.permissions.projectIds;
    const tasks = actions.includes("thread.read")
      ? (yield* store.listTasks(row.id)).filter(
          (task) => projectIds === undefined || projectIds.includes(task.target.projectId),
        )
      : [];
    const requests: ReadonlyArray<PendingRequestSummary> =
      actions.includes("thread.read") && actions.includes("request.answer")
        ? yield* responsibility
            .listRequests(internalCaller(`orchestrator:${row.id}`), { orchestratorId: row.id })
            .pipe(Effect.catch(() => Effect.succeed([])))
        : [];
    const checkpoint = (yield* store.listCheckpoints(row.id, 1))[0] ?? null;
    return { tasks, requests, checkpoint };
  });

  const openTurn = Effect.fn("OrchestratorRuntime.openTurn")(function* (
    row: StoredOrchestrator & { readonly threadId: ThreadId },
    turns: ReadonlyArray<StoredTurn>,
  ) {
    if (row.desiredState !== "active") return;
    const now = yield* isoNow;
    const nowMs = yield* Clock.currentTimeMillis;
    const pending = yield* store.listInbox({ orchestratorId: row.id, statuses: ["pending"] });
    // Entries about projects outside the orchestrator's scope are never shown.
    for (const { entry } of pending) {
      if (entryWithinScope(entry, row.config)) continue;
      yield* store.transitionInboxEntry({
        orchestratorId: row.id,
        entryId: entry.id,
        from: ["pending"],
        to: "dismissed",
        now,
      });
    }
    if (!pending.some(({ entry }) => entry.relevance === "actionable")) return;
    const tasks = yield* store.listTasks(row.id);
    const view = yield* readThread(row.threadId);
    const usage = usageOf({ row, turns, tasks, view, nowMs });
    const gate = turnGate({ row, pending, turns, usage, nowMs });
    if (gate.retryAtMs !== null) yield* wakeAt(row.id, gate.retryAtMs);
    if (gate.waitingUntilMs !== null) yield* wakeAt(row.id, gate.waitingUntilMs);
    if (gate.batch.length === 0) return yield* notifyChanged;

    // Decided before anything is reserved, so a refusal leaves the inbox pending.
    const library = yield* prepareTurn(row, view).pipe(Effect.result);
    if (library._tag === "Failure") return yield* refuseTurn(row, library.failure);
    const entries = gate.batch.map(({ entry }) => entry);
    const context = yield* contextFor(row);
    const turnId = yield* randomUuidV4;
    const turn: StoredTurn = {
      orchestratorId: row.id,
      sequence: Math.max(0, ...turns.map((existing) => existing.sequence)) + 1,
      commandId: CommandId.make(`automation:orchestrator-turn:${turnId}`),
      messageId: MessageId.make(`message:orchestrator-turn:${turnId}`),
      threadId: row.threadId,
      runId: null,
      status: "reserved",
      outcome: null,
      prompt: buildTurnPrompt({
        orchestratorId: row.id,
        config: row.config,
        entries,
        ...context,
        builtInInstructions:
          turns.length === 0 &&
          !(view?.thread.miniSkills ?? []).some(
            (skill) => skill.skillId === ORCHESTRATOR_MINI_SKILL_ID,
          )
            ? ORCHESTRATOR_INSTRUCTIONS
            : null,
      }),
      taskIds: taskIdsOf(entries),
      interruptRequestedAt: null,
      reservedAt: now,
      dispatchedAt: null,
      finishedAt: null,
    };
    // Reserve first: the entries and the intended command commit together, so a
    // crash from here on always finds the turn and its fixed command id.
    yield* store.transact(
      Effect.gen(function* () {
        yield* store.insertTurn(
          turn,
          entries.map((entry) => entry.id),
        );
        for (const entry of entries) {
          const reserved = yield* store.transitionInboxEntry({
            orchestratorId: row.id,
            entryId: entry.id,
            from: ["pending"],
            to: "reserved",
            now,
          });
          if (!reserved) {
            return yield* automationError(
              "CONFLICT",
              `Inbox entry ${entry.id} changed while reserving.`,
            );
          }
        }
      }),
    );
    yield* notifyChanged;
    yield* dispatchPrepared(row, turn, library.success);
  });

  const process = Effect.fn("OrchestratorRuntime.process")(function* (
    orchestratorId: OrchestratorId,
  ) {
    yield* Deferred.await(started);
    const row = yield* store.getOrchestrator(orchestratorId);
    // Deleted, handed off, paused or disabled: its agent's credential ends now,
    // whatever its turn is still doing.
    if (
      row === null ||
      row.hostEnvironmentId !== environmentId ||
      row.threadId === null ||
      row.desiredState !== "active"
    ) {
      yield* credentials.revoke(orchestratorId);
    }
    if (row === null || row.hostEnvironmentId !== environmentId || row.threadId === null) return;
    const hosted = { ...row, threadId: row.threadId };
    const active = (yield* store.listTurns(orchestratorId)).find(isActiveTurn);
    if (active !== undefined) yield* followTurn(row, active);
    const turns = yield* store.listTurns(orchestratorId);
    // One decision turn at a time: entries that arrived meanwhile stay pending.
    if (turns.some(isActiveTurn)) return;
    yield* openTurn(hosted, turns);
  });

  const worker = yield* makeDrainableWorker((orchestratorId: OrchestratorId) =>
    process(orchestratorId).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Orchestrator turn loop step failed", { orchestratorId, cause }),
      ),
    ),
  );

  const wakeAllWithWork = Effect.gen(function* () {
    const rows = yield* sql<{ readonly orchestrator_id: string }>`
      SELECT orchestrator_id FROM automation_orchestrator_turns
      WHERE status IN ('reserved', 'dispatched')
      UNION
      SELECT orchestrator_id FROM automation_inbox
      WHERE status = 'pending' AND relevance = 'actionable'
    `;
    yield* Effect.forEach(rows, (row) => wake(row.orchestrator_id as OrchestratorId), {
      discard: true,
    });
  });

  const start: OrchestratorRuntime["Service"]["start"] = Effect.fn("OrchestratorRuntime.start")(
    function* () {
      // Subscribed before recovery reads anything, so a run that ends while
      // recovery is working is still seen.
      yield* forkParked(
        Stream.runForEach(threads.streamStoredEvents, ({ event }) =>
          event.type === "run.updated"
            ? store.getOrchestratorByThread(event.threadId).pipe(
                Effect.flatMap((row) =>
                  row === null
                    ? Effect.void
                    : isTerminalRun(event.payload.status)
                      ? wake(row.id)
                      : notifyChanged,
                ),
                Effect.catch(() => Effect.void),
              )
            : Effect.void,
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Orchestrator runtime lost the thread event stream", { cause }),
          ),
        ),
      );
      // Parked until the server is active, so the engine has reconciled its own
      // runs before a turn left open by the last process is looked at. Recovery
      // is then the ordinary loop over what that process left behind, and no
      // other wake is handled before it has been queued.
      yield* forkParked(
        Effect.gen(function* () {
          yield* credentials.revokeLeftovers;
          yield* wakeAllWithWork.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not list orchestrators to recover", { cause }),
            ),
          );
          yield* Deferred.succeed(started, undefined);
          yield* scheduler.register("automation-orchestrators", wakeAllWithWork);
        }),
      );
    },
  );

  const interruptActiveTurn: OrchestratorRuntime["Service"]["interruptActiveTurn"] = Effect.fn(
    "OrchestratorRuntime.interruptActiveTurn",
  )(function* (orchestratorId, reason) {
    const turn = (yield* store.listTurns(orchestratorId)).find(isActiveTurn);
    if (turn === undefined) return false;
    const view = yield* readThread(turn.threadId);
    const run = view === null ? undefined : findRun(view, turn);
    if (run === undefined || isTerminalRun(run.status)) return false;
    const now = yield* isoNow;
    yield* threads
      .dispatch({
        type: "run.interrupt",
        commandId: CommandId.make(`${turn.commandId}:interrupt:${now}`),
        threadId: turn.threadId,
        runId: run.id,
        reason,
      })
      .pipe(
        Effect.mapError((cause) =>
          automationError("CONFLICT", `The active turn could not be interrupted: ${cause.message}`),
        ),
      );
    return true;
  });

  const checkpointIdle: OrchestratorRuntime["Service"]["checkpointIdle"] = Effect.fn(
    "OrchestratorRuntime.checkpointIdle",
  )(function* (orchestratorId, summary) {
    const row = yield* store.requireOrchestrator(orchestratorId);
    const now = yield* isoNow;
    const previous = (yield* store.listCheckpoints(orchestratorId, 1))[0] ?? null;
    const checkpoint = yield* buildCheckpoint({
      row,
      runId: null,
      summary: previous === null ? summary : `${summary}\n\n${previous.state.summary}`,
      newGoals: [],
      decision: null,
      inboxCursor: null,
      now,
    });
    yield* store.insertCheckpoint(checkpoint);
    return checkpoint;
  });

  return OrchestratorRuntime.of({
    store,
    environmentId,
    start,
    wake,
    drain: Deferred.await(started).pipe(Effect.andThen(worker.drain)),
    describe,
    interruptActiveTurn,
    checkpointIdle,
    changes: changed,
    notifyChanged,
  });
});

/** The runtime alone: the caller provides its dependencies and calls `start`. */
export const layerCore = Layer.effect(OrchestratorRuntime, make);

/** The runtime as the server runs it: started, with the automation services it uses. */
export const layer = Layer.effect(
  OrchestratorRuntime,
  make.pipe(Effect.tap((runtime) => runtime.start())),
).pipe(
  Layer.provide(ResponsibilityService.layer),
  Layer.provide(EventJournal.layer),
  Layer.provide(CommandReceiptStore.layer),
  Layer.provide(Scheduler.layer),
);
