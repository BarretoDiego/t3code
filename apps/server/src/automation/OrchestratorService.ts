import {
  type AutomationError,
  CommandId,
  type DelegatedTaskId,
  DELEGATED_TASK_TERMINAL_STATUSES,
  type InboxEntry,
  type ModelSelection,
  type Orchestrator,
  type OrchestratorAction,
  type OrchestratorCheckpoint,
  type OrchestratorHandoff,
  OrchestratorId,
  type OrchestratorSendInput,
  type OrchestratorSendResult,
  type OrchestratorSetStateInput,
  type OrchestratorUpsertInput,
  type OrchestratorsHandoffInput,
  type OrchestratorsInboxInput,
  type OrchestratorsResolveInboxInput,
  type ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import { randomUuidV4 } from "../orchestration-v2/RandomUuid.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import { type AutomationCaller, automationError } from "./Caller.ts";
import * as EventJournal from "./EventJournal.ts";
import * as OrchestratorInbox from "./OrchestratorInbox.ts";
import { orchestratorMiniSkill } from "./orchestrator/instructions.ts";
import * as OrchestratorRuntime from "./orchestrator/Runtime.ts";
import { configOf, type StoredOrchestrator, toJson } from "./orchestrator/Store.ts";

/** Persistent orchestrators: identity, inbox, turns, checkpoints, and hosting. */
export class OrchestratorService extends Context.Service<
  OrchestratorService,
  {
    readonly list: (
      caller: AutomationCaller,
    ) => Effect.Effect<ReadonlyArray<Orchestrator>, AutomationError>;
    readonly subscribe: (
      caller: AutomationCaller,
    ) => Stream.Stream<ReadonlyArray<Orchestrator>, AutomationError>;
    readonly upsert: (
      caller: AutomationCaller,
      input: OrchestratorUpsertInput,
    ) => Effect.Effect<Orchestrator, AutomationError>;
    readonly setState: (
      caller: AutomationCaller,
      input: OrchestratorSetStateInput,
    ) => Effect.Effect<Orchestrator, AutomationError>;
    readonly delete: (
      caller: AutomationCaller,
      input: OrchestratorId,
    ) => Effect.Effect<boolean, AutomationError>;
    readonly send: (
      caller: AutomationCaller,
      input: OrchestratorSendInput,
    ) => Effect.Effect<OrchestratorSendResult, AutomationError>;
    readonly inbox: (
      caller: AutomationCaller,
      input: OrchestratorsInboxInput,
    ) => Effect.Effect<ReadonlyArray<InboxEntry>, AutomationError>;
    readonly resolveInbox: (
      caller: AutomationCaller,
      input: OrchestratorsResolveInboxInput,
    ) => Effect.Effect<InboxEntry, AutomationError>;
    readonly checkpoints: (
      caller: AutomationCaller,
      input: { readonly orchestratorId: OrchestratorId; readonly limit?: number | undefined },
    ) => Effect.Effect<ReadonlyArray<OrchestratorCheckpoint>, AutomationError>;
    readonly handoff: (
      caller: AutomationCaller,
      input: OrchestratorsHandoffInput,
    ) => Effect.Effect<OrchestratorHandoff, AutomationError>;
    readonly handoffStatus: (
      caller: AutomationCaller,
      input: OrchestratorId,
    ) => Effect.Effect<OrchestratorHandoff | null, AutomationError>;
    /**
     * The gate a delegation on an orchestrator's behalf must pass before the
     * task is created: the orchestrator is active, holds the action for that
     * project, and has room in its child and attempt budgets. Fails with
     * `PAUSED`, `PERMISSION_DENIED` or `BUDGET_EXCEEDED`; never adjusts a limit.
     */
    readonly authorizeDelegation: (input: {
      readonly orchestratorId: OrchestratorId;
      readonly action: Extract<OrchestratorAction, "task.delegate" | "peer.delegate">;
      readonly projectId: ProjectId;
      readonly parentTaskId?: DelegatedTaskId | undefined;
      /** The task being attempted again, when this is a retry. */
      readonly retryOfTaskId?: DelegatedTaskId | undefined;
    }) => Effect.Effect<void, AutomationError>;
  }
>()("t3/automation/OrchestratorService") {}

const UPSERT_SCOPE = "orchestrators.upsert";
const sendScope = (orchestratorId: OrchestratorId) => `orchestrators.send:${orchestratorId}`;

const sameSelection = (left: ModelSelection, right: ModelSelection) =>
  toJson(left) === toJson(right);

const make = Effect.gen(function* () {
  const runtime = yield* OrchestratorRuntime.OrchestratorRuntime;
  const inboxWriter = yield* OrchestratorInbox.OrchestratorInbox;
  const journal = yield* EventJournal.EventJournal;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const { store, environmentId } = runtime;

  const isoNow = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const rejectPeer = (caller: AutomationCaller, operation: string) =>
    caller.kind === "peer"
      ? Effect.fail(
          automationError("PERMISSION_DENIED", `A peer environment may not ${operation}.`),
        )
      : Effect.void;

  const requireHosted = (row: StoredOrchestrator) =>
    row.hostEnvironmentId === environmentId
      ? Effect.succeed(row)
      : Effect.fail(
          automationError(
            "ENVIRONMENT_UNAVAILABLE",
            `Orchestrator ${row.id} is hosted by environment ${row.hostEnvironmentId}; run this there.`,
            { hostEnvironmentId: row.hostEnvironmentId },
          ),
        );

  const changedEvent = (row: StoredOrchestrator, change: string) =>
    journal.append([
      {
        type: "orchestrator.changed",
        origin: { kind: "service", actorId: row.id },
        scope: {
          orchestratorId: row.id,
          projectId: row.config.projectId,
          ...(row.threadId === null ? {} : { threadId: row.threadId }),
        },
        aggregate: { kind: "orchestrator", id: row.id },
        payload: {
          change,
          name: row.config.name,
          scope: row.config.scope,
          desiredState: row.desiredState,
          revision: row.revision,
          hostEnvironmentId: row.hostEnvironmentId,
        },
      },
    ]);

  /** A model the provider cannot serve fails here; nothing is substituted for it. */
  const requireModelAvailable = Effect.fn("OrchestratorService.requireModelAvailable")(function* (
    selection: ModelSelection,
  ) {
    const provider = (yield* providers.getProviders).find(
      (candidate) => candidate.instanceId === selection.instanceId,
    );
    if (provider === undefined || !provider.enabled || !provider.installed) {
      return yield* automationError(
        "CAPABILITY_UNSUPPORTED",
        `Provider ${selection.instanceId} is not available on this environment.`,
        { instanceId: selection.instanceId },
      );
    }
    if (!provider.models.some((model) => model.slug === selection.model)) {
      return yield* automationError(
        "CAPABILITY_UNSUPPORTED",
        `Model ${selection.model} is not available from provider ${selection.instanceId}.`,
        { instanceId: selection.instanceId, model: selection.model },
      );
    }
  });

  const list: OrchestratorService["Service"]["list"] = () =>
    store.listOrchestrators.pipe(Effect.flatMap((rows) => Effect.forEach(rows, runtime.describe)));

  const subscribe: OrchestratorService["Service"]["subscribe"] = (caller) =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribed before the snapshot, so a change between the two is not lost.
        const subscription = yield* PubSub.subscribe(runtime.changes);
        return Stream.concat(
          Stream.fromEffect(list(caller)),
          Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => list(caller))),
        );
      }),
    );

  const create = Effect.fn("OrchestratorService.create")(function* (
    input: OrchestratorUpsertInput,
    now: string,
  ) {
    const config = configOf(input);
    yield* requireModelAvailable(config.modelSelection);
    const id = input.id ?? OrchestratorId.make(`orchestrator:${yield* randomUuidV4}`);
    let threadId: ThreadId;
    if (input.threadId !== undefined) {
      // Adopting: the thread keeps its history and simply gains an owner.
      const adopted = yield* threads
        .getThreadRecords(input.threadId, [])
        .pipe(
          Effect.mapError(() =>
            automationError("NOT_FOUND", `Thread ${input.threadId} does not exist.`),
          ),
        );
      if (adopted.thread.projectId !== config.projectId) {
        return yield* automationError(
          "INVALID_INPUT",
          `Thread ${input.threadId} belongs to project ${adopted.thread.projectId}, not ${config.projectId}.`,
        );
      }
      if (adopted.thread.deletedAt !== null || adopted.thread.lineage.parentThreadId !== null) {
        return yield* automationError(
          "INVALID_INPUT",
          "Only an existing top-level thread can become an orchestrator's main thread.",
        );
      }
      if ((yield* store.getOrchestratorByThread(input.threadId)) !== null) {
        return yield* automationError(
          "CONFLICT",
          `Thread ${input.threadId} is already an orchestrator's main thread.`,
        );
      }
      threadId = input.threadId;
    } else {
      const launched = yield* threadLaunch
        .launch({
          // Derived from the orchestrator id, so repeating a create that failed
          // half way finds the thread it already launched.
          commandId: CommandId.make(`automation:orchestrator:${id}:launch`),
          threadId: ThreadId.make(`thread:orchestrator:${yield* randomUuidV4}`),
          projectId: config.projectId,
          title: `Orchestrator: ${config.name}`,
          generateTitle: false,
          modelSelection: config.modelSelection,
          runtimeMode: config.runtimeMode,
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          miniSkills: [orchestratorMiniSkill(config.name, now)],
          createdBy: "system",
          creationSource: "server",
        })
        .pipe(
          Effect.mapError((cause) =>
            automationError(
              cause.operation === "resolve-project" ? "INVALID_INPUT" : "INTERNAL",
              `The orchestrator's main thread could not be created: ${cause.message}`,
              { operation: cause.operation },
            ),
          ),
        );
      threadId = launched.threadId;
    }
    const row: StoredOrchestrator = {
      id,
      revision: 1,
      config,
      hostEnvironmentId: environmentId,
      hostGeneration: 1,
      threadId,
      desiredState: input.desiredState ?? "active",
      stateReason: null,
      usageSince: now,
      lastTurnAt: null,
      createdAt: now,
      updatedAt: now,
    };
    yield* store.transact(
      Effect.gen(function* () {
        yield* store.insertOrchestrator(row);
        yield* changedEvent(row, "created");
        if (input.idempotencyKey !== undefined) {
          yield* store.putIdempotent(UPSERT_SCOPE, input.idempotencyKey, { id }, now);
        }
      }),
    );
    return row;
  });

  /**
   * Carries a model change to the main thread. Within one provider instance the
   * thread's selection changes and the session continues. Across instances the
   * session cannot be carried: a checkpoint is written and the existing
   * provider-switch handoff starts a successor session from the transcript.
   */
  const applyModelChange = Effect.fn("OrchestratorService.applyModelChange")(function* (
    row: StoredOrchestrator,
    next: ModelSelection,
  ) {
    if (row.threadId === null) return;
    yield* requireModelAvailable(next);
    const sameInstance = row.config.modelSelection.instanceId === next.instanceId;
    if (!sameInstance) {
      yield* runtime.checkpointIdle(
        row.id,
        `Provider changed from ${row.config.modelSelection.instanceId} to ${next.instanceId}; a successor session continues from this checkpoint.`,
      );
    }
    const commandId = CommandId.make(`automation:orchestrator:${row.id}:model:${row.revision + 1}`);
    yield* threads
      .dispatch(
        sameInstance
          ? {
              type: "thread.model-selection.set",
              commandId,
              threadId: row.threadId,
              modelSelection: next,
            }
          : { type: "provider.switch", commandId, threadId: row.threadId, modelSelection: next },
      )
      .pipe(
        Effect.mapError((cause) =>
          automationError(
            "CONFLICT",
            `The main thread did not accept the model change: ${cause.message}`,
          ),
        ),
      );
  });

  const edit = Effect.fn("OrchestratorService.edit")(function* (
    existing: StoredOrchestrator,
    input: OrchestratorUpsertInput,
    now: string,
  ) {
    yield* requireHosted(existing);
    if (input.expectedRevision === undefined) {
      return yield* automationError(
        "INVALID_INPUT",
        "Editing an orchestrator needs expectedRevision, the revision you read.",
        { currentRevision: existing.revision },
      );
    }
    if (input.expectedRevision !== existing.revision) {
      return yield* automationError(
        "REVISION_MISMATCH",
        `Orchestrator ${existing.id} is at revision ${existing.revision}, not ${input.expectedRevision}.`,
        { currentRevision: existing.revision },
      );
    }
    if (input.threadId !== undefined && input.threadId !== existing.threadId) {
      return yield* automationError(
        "INVALID_INPUT",
        "An orchestrator's main thread cannot be replaced by an edit.",
      );
    }
    const config = configOf(input);
    if (config.projectId !== existing.config.projectId) {
      return yield* automationError(
        "INVALID_INPUT",
        "An orchestrator cannot move to another project.",
      );
    }
    if (!sameSelection(existing.config.modelSelection, config.modelSelection)) {
      yield* applyModelChange(existing, config.modelSelection);
    }
    if (existing.threadId !== null && existing.config.runtimeMode !== config.runtimeMode) {
      yield* threads
        .dispatch({
          type: "thread.runtime-mode.set",
          commandId: CommandId.make(
            `automation:orchestrator:${existing.id}:runtime-mode:${existing.revision + 1}`,
          ),
          threadId: existing.threadId,
          runtimeMode: config.runtimeMode,
        })
        .pipe(
          Effect.mapError((cause) =>
            automationError(
              "CONFLICT",
              `The main thread did not accept the runtime mode: ${cause.message}`,
            ),
          ),
        );
    }
    const desiredState = input.desiredState ?? existing.desiredState;
    const next: StoredOrchestrator = {
      ...existing,
      config,
      desiredState,
      revision: existing.revision + 1,
      updatedAt: now,
    };
    yield* store.transact(
      Effect.gen(function* () {
        const updated = yield* store.updateOrchestratorConfig({
          id: existing.id,
          expectedRevision: existing.revision,
          config,
          desiredState,
          now,
        });
        if (!updated) {
          return yield* automationError(
            "REVISION_MISMATCH",
            `Orchestrator ${existing.id} changed while it was being edited.`,
          );
        }
        yield* changedEvent(next, "edited");
        if (input.idempotencyKey !== undefined) {
          yield* store.putIdempotent(UPSERT_SCOPE, input.idempotencyKey, { id: existing.id }, now);
        }
      }),
    );
    return next;
  });

  const upsert: OrchestratorService["Service"]["upsert"] = Effect.fn("OrchestratorService.upsert")(
    function* (caller, input) {
      yield* rejectPeer(caller, "create or edit an orchestrator");
      if (input.idempotencyKey !== undefined) {
        const replay = (yield* store.getIdempotent(UPSERT_SCOPE, input.idempotencyKey)) as {
          readonly id: OrchestratorId;
        } | null;
        if (replay !== null) {
          return yield* runtime.describe(yield* store.requireOrchestrator(replay.id));
        }
      }
      if (new Set(input.responsibilityOrder).size !== input.responsibilityOrder.length) {
        return yield* automationError("INVALID_INPUT", "responsibilityOrder lists a rule twice.");
      }
      const now = yield* isoNow;
      const existing = input.id === undefined ? null : yield* store.getOrchestrator(input.id);
      const row = existing === null ? yield* create(input, now) : yield* edit(existing, input, now);
      yield* runtime.notifyChanged;
      yield* runtime.wake(row.id);
      return yield* runtime.describe(row);
    },
  );

  const setState: OrchestratorService["Service"]["setState"] = Effect.fn(
    "OrchestratorService.setState",
  )(function* (caller, input) {
    yield* rejectPeer(caller, "change an orchestrator's state");
    const existing = yield* requireHosted(yield* store.requireOrchestrator(input.orchestratorId));
    const now = yield* isoNow;
    if (existing.desiredState !== input.desiredState) {
      // Only the desired state changes: the inbox and delegated tasks stay as they are.
      yield* store.transact(
        Effect.gen(function* () {
          yield* store.setDesiredState(existing.id, input.desiredState, now);
          yield* changedEvent(
            {
              ...existing,
              desiredState: input.desiredState,
              revision: existing.revision + 1,
            },
            input.desiredState,
          );
        }),
      );
    }
    if (input.interruptActiveTurn === true) {
      yield* runtime.interruptActiveTurn(
        existing.id,
        `Interrupted by ${caller.subject} through the orchestrator.`,
      );
    }
    yield* runtime.notifyChanged;
    yield* runtime.wake(existing.id);
    return yield* runtime.describe(yield* store.requireOrchestrator(existing.id));
  });

  const remove: OrchestratorService["Service"]["delete"] = Effect.fn("OrchestratorService.delete")(
    function* (caller, orchestratorId) {
      yield* rejectPeer(caller, "delete an orchestrator");
      const existing = yield* store.getOrchestrator(orchestratorId);
      if (existing === null) return false;
      // The main thread is left alone: it is an ordinary thread again.
      const removed = yield* store.transact(
        Effect.gen(function* () {
          const deleted = yield* store.deleteOrchestrator(orchestratorId);
          if (deleted) yield* changedEvent(existing, "deleted");
          return deleted;
        }),
      );
      yield* runtime.notifyChanged;
      return removed;
    },
  );

  const send: OrchestratorService["Service"]["send"] = Effect.fn("OrchestratorService.send")(
    function* (caller, input) {
      const orchestrator = yield* store.requireOrchestrator(input.orchestratorId);
      // Forwarding to a remote host is the federation step; until then the
      // caller is told exactly where the orchestrator lives.
      yield* requireHosted(orchestrator);
      const { entry } = yield* inboxWriter.deliver({
        orchestratorId: input.orchestratorId,
        kind: caller.kind === "peer" ? "peer_message" : "user_message",
        dedupKey: `${sendScope(input.orchestratorId)}:${input.idempotencyKey}`,
        relevance: "actionable",
        entries: [],
        text: input.text,
        from: caller.kind === "peer" ? null : { kind: "user" },
      });
      return {
        entry,
        delivery: "queued_local" as const,
        hostEnvironmentId: orchestrator.hostEnvironmentId,
      };
    },
  );

  const inbox: OrchestratorService["Service"]["inbox"] = Effect.fn("OrchestratorService.inbox")(
    function* (_caller, input) {
      yield* store.requireOrchestrator(input.orchestratorId);
      // The newest entries, oldest first.
      const entries = yield* store.listInbox({
        orchestratorId: input.orchestratorId,
        statuses: input.statuses,
        limit: input.limit ?? 200,
        order: "desc",
      });
      return entries.map(({ entry }) => entry).toReversed();
    },
  );

  const resolveInbox: OrchestratorService["Service"]["resolveInbox"] = Effect.fn(
    "OrchestratorService.resolveInbox",
  )(function* (caller, input) {
    yield* rejectPeer(caller, "settle an inbox entry");
    const orchestrator = yield* requireHosted(
      yield* store.requireOrchestrator(input.orchestratorId),
    );
    const stored = yield* store.getInboxEntry(input.orchestratorId, input.entryId);
    if (stored === null) {
      return yield* automationError("NOT_FOUND", `Inbox entry ${input.entryId} does not exist.`);
    }
    const now = yield* isoNow;
    const requeue = input.resolution === "requeue";
    // Requeue is the operator's decision to show an entry to the model again,
    // so it applies only to entries whose turn has an unknown outcome.
    const moved = yield* store.transitionInboxEntry({
      orchestratorId: input.orchestratorId,
      entryId: input.entryId,
      from: requeue ? ["unknown"] : ["pending", "unknown"],
      to: requeue ? "pending" : "dismissed",
      now,
    });
    if (!moved) {
      return yield* automationError(
        "CONFLICT",
        requeue
          ? `Only an entry with an unknown outcome can be requeued; ${input.entryId} is ${stored.entry.status}.`
          : `Inbox entry ${input.entryId} is ${stored.entry.status} and cannot be dismissed.`,
        { status: stored.entry.status },
      );
    }
    if ((yield* store.countInbox(input.orchestratorId, "unknown")) === 0) {
      yield* store.setStateReason(orchestrator.id, null, now);
    }
    yield* runtime.notifyChanged;
    yield* runtime.wake(input.orchestratorId);
    const updated = yield* store.getInboxEntry(input.orchestratorId, input.entryId);
    return updated === null ? stored.entry : updated.entry;
  });

  const checkpoints: OrchestratorService["Service"]["checkpoints"] = Effect.fn(
    "OrchestratorService.checkpoints",
  )(function* (_caller, input) {
    yield* store.requireOrchestrator(input.orchestratorId);
    return yield* store.listCheckpoints(input.orchestratorId, input.limit ?? 20);
  });

  const handoffUnsupported = automationError(
    "CAPABILITY_UNSUPPORTED",
    "Moving an orchestrator's hosting to another environment is not available on this server yet. The orchestrator keeps running where it is.",
  );

  const authorizeDelegation: OrchestratorService["Service"]["authorizeDelegation"] = Effect.fn(
    "OrchestratorService.authorizeDelegation",
  )(function* (input) {
    const orchestrator = yield* requireHosted(
      yield* store.requireOrchestrator(input.orchestratorId),
    );
    if (orchestrator.desiredState !== "active") {
      return yield* automationError(
        "PAUSED",
        `Orchestrator ${orchestrator.id} is ${orchestrator.desiredState} and cannot delegate.`,
      );
    }
    const { permissions, budget } = orchestrator.config;
    if (!permissions.actions.includes(input.action)) {
      return yield* automationError(
        "PERMISSION_DENIED",
        `Orchestrator ${orchestrator.id} does not hold ${input.action}.`,
      );
    }
    if (permissions.projectIds !== undefined && !permissions.projectIds.includes(input.projectId)) {
      return yield* automationError(
        "PERMISSION_DENIED",
        `Project ${input.projectId} is outside orchestrator ${orchestrator.id}'s scope.`,
      );
    }
    const tasks = yield* store.listTasks(orchestrator.id);
    const open = tasks.filter(
      (task) =>
        !DELEGATED_TASK_TERMINAL_STATUSES.includes(task.status) && task.id !== input.retryOfTaskId,
    );
    const exceeded = (limit: string, used: number, max: number) =>
      automationError("BUDGET_EXCEEDED", `${limit} reached: ${used} of ${max}.`, {
        limit,
        used,
        max,
      });
    if (budget.maxConcurrentChildren !== null && open.length >= budget.maxConcurrentChildren) {
      return yield* exceeded("maxConcurrentChildren", open.length, budget.maxConcurrentChildren);
    }
    if (budget.maxChildrenPerTask !== null && input.parentTaskId !== undefined) {
      const children = tasks.filter(
        (task) => task.parentTaskId === input.parentTaskId && task.id !== input.retryOfTaskId,
      ).length;
      if (children >= budget.maxChildrenPerTask) {
        return yield* exceeded("maxChildrenPerTask", children, budget.maxChildrenPerTask);
      }
    }
    if (budget.maxTaskAttempts !== null && input.retryOfTaskId !== undefined) {
      const attempts = (yield* store.getTask(input.retryOfTaskId))?.attemptCount ?? 0;
      if (attempts >= budget.maxTaskAttempts) {
        return yield* exceeded("maxTaskAttempts", attempts, budget.maxTaskAttempts);
      }
    }
  });

  return OrchestratorService.of({
    list,
    subscribe,
    upsert,
    setState,
    delete: remove,
    send,
    inbox,
    resolveInbox,
    checkpoints,
    handoff: () => Effect.fail(handoffUnsupported),
    handoffStatus: () => Effect.fail(handoffUnsupported),
    authorizeDelegation,
  });
});

/** The service alone: the caller provides every dependency, including the runtime. */
export const layerCore = Layer.effect(OrchestratorService, make);

export const layer = layerCore.pipe(
  Layer.provide(OrchestratorInbox.layer),
  Layer.provide(OrchestratorRuntime.layer),
  Layer.provide(EventJournal.layer),
);
