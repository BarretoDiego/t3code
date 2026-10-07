import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  DelegatedTaskId,
  IdempotencyKey,
  type InboxEntry,
  type Orchestrator,
  type OrchestratorId,
  type OrchestratorUpsertInput,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { TestClock } from "effect/testing";

import * as CommandReceiptStore from "../../orchestration-v2/CommandReceiptStore.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { internalCaller } from "../Caller.ts";
import * as OrchestratorInbox from "../OrchestratorInbox.ts";
import * as OrchestratorService from "../OrchestratorService.ts";
import {
  awaitThreadEvent,
  journalEntry,
  makeAutomationLayer,
  makeAutomationLayerWith,
  orchestratorInput,
  otherProjectId,
  projectId,
  type ProviderProbe,
  withEngine,
} from "./Orchestrator.testkit.ts";
import * as OrchestratorRuntime from "./Runtime.ts";

const user = internalCaller("test-user");
const TIMEOUT = 60_000;

/** One life of the runtime: started, with the services a test drives. */
const life = Effect.gen(function* () {
  const service = yield* OrchestratorService.OrchestratorService;
  const inbox = yield* OrchestratorInbox.OrchestratorInbox;
  const runtime = yield* OrchestratorRuntime.OrchestratorRuntime;
  yield* runtime.start();
  yield* runtime.drain;
  let sends = 0;
  const send = (orchestratorId: OrchestratorId, text: string) =>
    service.send(user, {
      idempotencyKey: IdempotencyKey.make(`send:${orchestratorId}:${(sends += 1)}:${text}`),
      orchestratorId,
      text,
    });
  const create = (overrides: Partial<OrchestratorUpsertInput> = {}) =>
    service.upsert(user, orchestratorInput(overrides));
  const get = (orchestratorId: OrchestratorId) =>
    service
      .list(user)
      .pipe(
        Effect.map(
          (all) => all.find((orchestrator) => orchestrator.id === orchestratorId) as Orchestrator,
        ),
      );
  const statuses = (orchestratorId: OrchestratorId) =>
    service
      .inbox(user, { orchestratorId })
      .pipe(Effect.map((entries) => entries.map((entry) => entry.status)));
  const deliverEvent = (
    orchestratorId: OrchestratorId,
    dedupKey: string,
    entries: InboxEntry["entries"],
    relevance: InboxEntry["relevance"] = "actionable",
  ) =>
    inbox.deliver({
      orchestratorId,
      kind: "event",
      dedupKey,
      relevance,
      entries,
      text: null,
      from: null,
    });
  return { service, inbox, runtime, send, create, get, statuses, deliverEvent };
});

const turnCount = (provider: ProviderProbe) =>
  Ref.get(provider.turns).pipe(Effect.map((turns) => turns.length));

const holdNextTurn = (provider: ProviderProbe) =>
  Effect.gen(function* () {
    const hold = yield* Deferred.make<void>();
    yield* Ref.set(provider.holdNextTurn, hold);
    return hold;
  });

const statusIs =
  (type: "run.updated" | "provider-turn.updated", status: string) =>
  (event: { readonly type: string; readonly payload: unknown }) =>
    event.type === type && (event.payload as { readonly status: string }).status === status;
const runIs = (status: string) => statusIs("run.updated", status);
/** The provider has the turn: from here on it counts as a turn the provider accepted. */
const providerTurnRunning = statusIs("provider-turn.updated", "running");

/** A thread service that dies on the orchestrator's turn dispatch, as a crash at that line would. */
const crashingDispatch = (when: "before" | "after") =>
  Layer.effect(
    ThreadManagement.ThreadManagementService,
    Effect.gen(function* () {
      const real = yield* ThreadManagement.ThreadManagementService;
      return ThreadManagement.ThreadManagementService.of({
        ...real,
        dispatch: (command) =>
          command.type === "message.dispatch" &&
          command.commandId.startsWith("automation:orchestrator-turn:")
            ? (when === "before" ? Effect.void : real.dispatch(command)).pipe(
                Effect.andThen(Effect.die("simulated crash")),
              )
            : real.dispatch(command),
      });
    }),
  );

describe("orchestrator turn loop", () => {
  it.effect(
    "takes one turn for a user message and checkpoints with the entry it processed",
    () =>
      withEngine("orchestrator-basic", ({ provider, journal }) =>
        Effect.gen(function* () {
          const { service, send, create, get, statuses } = yield* life;
          const created = yield* create();
          assert.strictEqual(created.effectiveState, "idle");
          assert.strictEqual(created.hostGeneration, 1);

          const sent = yield* send(created.id, "Ship the release notes.");
          assert.strictEqual(sent.delivery, "queued_local");
          yield* journal.untilTurnsFinished(1);

          const turns = yield* Ref.get(provider.turns);
          assert.strictEqual(turns.length, 1);
          // The user's words reach the model verbatim; the turn names its permissions.
          assert.include(turns[0]!.text, "Ship the release notes.");
          assert.include(turns[0]!.text, "Your permissions");
          assert.deepStrictEqual(yield* statuses(created.id), ["processed"]);
          const inbox = yield* service.inbox(user, { orchestratorId: created.id });
          const checkpoints = yield* service.checkpoints(user, { orchestratorId: created.id });
          assert.strictEqual(checkpoints.length, 1);
          assert.strictEqual(checkpoints[0]!.runId, inbox[0]!.reservedByRunId);
          assert.deepStrictEqual(
            checkpoints[0]!.state.goals.map((goal) => goal.text),
            ["Ship the release notes."],
          );
          assert.strictEqual(checkpoints[0]!.state.decisions.length, 1);
          const after = yield* get(created.id);
          assert.strictEqual(after.effectiveState, "idle");
          assert.strictEqual(after.usage.turns, 1);
          assert.isNotNull(after.lastCheckpointAt);
          const types = (yield* SubscriptionRef.get(journal.events)).map((event) => event.type);
          assert.deepStrictEqual(types, [
            "orchestrator.changed",
            "orchestrator.message.received",
            "orchestrator.turn.finished",
          ]);
        }).pipe(Effect.provide(makeAutomationLayer())),
      ),
    TIMEOUT,
  );

  it.effect(
    "an idle orchestrator calls no model across scheduler ticks and informational events",
    () =>
      withEngine("orchestrator-idle", ({ provider, journal }) =>
        Effect.gen(function* () {
          const { runtime, send, create, get, statuses, deliverEvent } = yield* life;
          const created = yield* create();
          yield* TestClock.adjust("2 minutes");
          yield* runtime.drain;
          assert.strictEqual(yield* turnCount(provider), 0);

          // Progress noise stays informational even when the hook calls it actionable.
          const progress = yield* deliverEvent(created.id, "hook:progress", [
            journalEntry("task.progress", { orchestratorId: created.id }, { percent: 40 }),
          ]);
          assert.strictEqual(progress.entry.relevance, "informational");
          yield* deliverEvent(
            created.id,
            "hook:accepted",
            [journalEntry("task.accepted", { orchestratorId: created.id })],
            "informational",
          );
          yield* TestClock.adjust("2 minutes");
          yield* runtime.drain;
          assert.strictEqual(yield* turnCount(provider), 0);
          assert.deepStrictEqual(yield* statuses(created.id), ["pending", "pending"]);
          assert.strictEqual((yield* get(created.id)).effectiveState, "idle");

          // The next real turn carries them along, clearly marked.
          yield* send(created.id, "What changed?");
          yield* journal.untilTurnsFinished(1);
          const turns = yield* Ref.get(provider.turns);
          assert.strictEqual(turns.length, 1);
          assert.include(turns[0]!.text, "For information only (2)");
          assert.include(turns[0]!.text, "task.progress");
          assert.deepStrictEqual(yield* statuses(created.id), [
            "processed",
            "processed",
            "processed",
          ]);
        }).pipe(Effect.provide(makeAutomationLayer())),
      ),
    TIMEOUT,
  );

  it.effect(
    "a message arriving during a turn is stored and read by the next turn, one turn at a time",
    () =>
      withEngine("orchestrator-busy", ({ provider, journal }) =>
        Effect.gen(function* () {
          const { runtime, send, create, get, statuses } = yield* life;
          const created = yield* create();
          const hold = yield* holdNextTurn(provider);
          yield* send(created.id, "First question.");
          yield* awaitThreadEvent(created.threadId!, providerTurnRunning);

          const second = yield* send(created.id, "Second question.");
          assert.strictEqual(second.entry.status, "pending");
          yield* runtime.drain;
          yield* TestClock.adjust("30 seconds");
          yield* runtime.drain;
          assert.strictEqual(yield* turnCount(provider), 1);
          assert.deepStrictEqual(yield* statuses(created.id), ["reserved", "pending"]);
          const busy = yield* get(created.id);
          assert.strictEqual(busy.effectiveState, "running");
          assert.strictEqual(busy.inboxPending, 1);

          yield* Deferred.succeed(hold, undefined);
          yield* journal.untilTurnsFinished(2);
          const turns = yield* Ref.get(provider.turns);
          assert.strictEqual(turns.length, 2);
          assert.include(turns[1]!.text, "Second question.");
          assert.notInclude(turns[1]!.text, "First question.");
          assert.deepStrictEqual(yield* statuses(created.id), ["processed", "processed"]);
        }).pipe(Effect.provide(makeAutomationLayer())),
      ),
    TIMEOUT,
  );

  it.effect(
    "actionable entries inside the batch window open one turn",
    () =>
      withEngine("orchestrator-batch", ({ provider, journal }) =>
        Effect.gen(function* () {
          const { runtime, send, create, get } = yield* life;
          const created = yield* create({ batchWindowMs: 10_000 });
          yield* send(created.id, "One.");
          yield* TestClock.adjust("2 seconds");
          yield* send(created.id, "Two.");
          yield* TestClock.adjust("2 seconds");
          yield* send(created.id, "Three.");
          yield* runtime.drain;
          assert.strictEqual(yield* turnCount(provider), 0);
          assert.strictEqual((yield* get(created.id)).effectiveState, "queued");

          yield* TestClock.adjust("10 seconds");
          yield* journal.untilTurnsFinished(1);
          yield* TestClock.adjust("1 minute");
          yield* runtime.drain;
          const turns = yield* Ref.get(provider.turns);
          assert.strictEqual(turns.length, 1);
          for (const text of ["One.", "Two.", "Three."]) assert.include(turns[0]!.text, text);
        }).pipe(Effect.provide(makeAutomationLayer())),
      ),
    TIMEOUT,
  );

  it.effect(
    "pausing keeps the inbox and stops turns; disabling also refuses hook deliveries",
    () =>
      withEngine("orchestrator-pause", ({ provider, journal }) =>
        Effect.gen(function* () {
          const { service, runtime, send, create, get, statuses, deliverEvent } = yield* life;
          const created = yield* create();
          const paused = yield* service.setState(user, {
            orchestratorId: created.id,
            desiredState: "paused",
          });
          assert.strictEqual(paused.effectiveState, "paused");
          yield* send(created.id, "While paused.");
          yield* deliverEvent(created.id, "hook:reported", [
            journalEntry("task.reported", { orchestratorId: created.id }),
          ]);
          yield* TestClock.adjust("1 minute");
          yield* runtime.drain;
          assert.strictEqual(yield* turnCount(provider), 0);
          assert.deepStrictEqual(yield* statuses(created.id), ["pending", "pending"]);
          assert.strictEqual((yield* get(created.id)).inboxPending, 2);

          yield* service.setState(user, { orchestratorId: created.id, desiredState: "disabled" });
          const refused = yield* deliverEvent(created.id, "hook:blocked", [
            journalEntry("task.blocked", { orchestratorId: created.id }),
          ]).pipe(Effect.flip);
          assert.strictEqual(refused.code, "PAUSED");
          // What the user sends directly is still kept.
          yield* send(created.id, "While disabled.");
          yield* runtime.drain;
          assert.strictEqual(yield* turnCount(provider), 0);
          assert.strictEqual((yield* get(created.id)).effectiveState, "disabled");
          assert.deepStrictEqual(yield* statuses(created.id), ["pending", "pending", "pending"]);

          yield* service.setState(user, { orchestratorId: created.id, desiredState: "active" });
          yield* journal.untilTurnsFinished(1);
          assert.strictEqual(yield* turnCount(provider), 1);
          assert.deepStrictEqual(yield* statuses(created.id), [
            "processed",
            "processed",
            "processed",
          ]);
        }).pipe(Effect.provide(makeAutomationLayer())),
      ),
    TIMEOUT,
  );

  it.effect(
    "an exhausted hourly turn budget holds the backlog and resumes when the window moves",
    () =>
      withEngine("orchestrator-budget-turns", ({ provider, journal }) =>
        Effect.gen(function* () {
          const { runtime, send, create, get, statuses } = yield* life;
          const created = yield* create({
            budget: { ...orchestratorInput().budget, maxTurnsPerHour: 1 },
          });
          yield* send(created.id, "First.");
          yield* journal.untilTurnsFinished(1);
          yield* send(created.id, "Second.");
          yield* TestClock.adjust("10 minutes");
          yield* runtime.drain;
          assert.strictEqual(yield* turnCount(provider), 1);
          const held = yield* get(created.id);
          assert.strictEqual(held.effectiveState, "budget_exceeded");
          assert.include(held.stateReason ?? "", "1 of 1 turns");
          assert.deepStrictEqual(yield* statuses(created.id), ["processed", "pending"]);
          // The limit itself was not touched.
          assert.strictEqual(held.budget.maxTurnsPerHour, 1);

          yield* TestClock.adjust("51 minutes");
          yield* journal.untilTurnsFinished(2);
          assert.strictEqual(yield* turnCount(provider), 2);
          assert.deepStrictEqual(yield* statuses(created.id), ["processed", "processed"]);
        }).pipe(Effect.provide(makeAutomationLayer())),
      ),
    TIMEOUT,
  );

  it.effect(
    "a spent token budget stops turns; unreported usage is unknown, not zero and not exceeded",
    () =>
      withEngine("orchestrator-budget-tokens", ({ provider, journal }) =>
        Effect.gen(function* () {
          const { service, runtime, send, create, get, statuses } = yield* life;
          const budget = { ...orchestratorInput().budget, maxTokens: 100 };

          // A provider that reports nothing: usage is unknown and never blocks.
          const silent = yield* create({ name: "Silent provider", budget });
          yield* send(silent.id, "One.");
          yield* journal.untilTurnsFinished(1);
          const unknown = yield* get(silent.id);
          assert.isNull(unknown.usage.tokens);
          assert.isFalse(unknown.usage.tokensComplete);
          yield* send(silent.id, "Two.");
          yield* journal.untilTurnsFinished(2);
          assert.strictEqual(yield* turnCount(provider), 2);

          // A provider that reports: the budget is enforced at the next turn.
          yield* Ref.set(provider.usage, { input: 70, output: 50 });
          const metered = yield* create({ name: "Metered provider", budget });
          yield* send(metered.id, "One.");
          yield* journal.untilTurnsFinished(3);
          yield* send(metered.id, "Two.");
          yield* TestClock.adjust("2 hours");
          yield* runtime.drain;
          assert.strictEqual(yield* turnCount(provider), 3);
          const spent = yield* get(metered.id);
          assert.strictEqual(spent.usage.tokens, 120);
          assert.isTrue(spent.usage.tokensComplete);
          assert.strictEqual(spent.effectiveState, "budget_exceeded");
          assert.deepStrictEqual(yield* statuses(metered.id), ["processed", "pending"]);

          // Only the operator raises a limit; the backlog then drains.
          yield* service.upsert(
            user,
            orchestratorInput({
              id: metered.id,
              expectedRevision: spent.revision,
              name: "Metered provider",
              budget: { ...budget, maxTokens: 1_000 },
            }),
          );
          yield* journal.untilTurnsFinished(4);
          assert.deepStrictEqual(yield* statuses(metered.id), ["processed", "processed"]);
        }).pipe(Effect.provide(makeAutomationLayer())),
      ),
    TIMEOUT,
  );

  it.effect(
    "a turn that outlives maxTurnDurationMs is interrupted and its entries surfaced",
    () =>
      withEngine("orchestrator-duration", ({ provider, journal }) =>
        Effect.gen(function* () {
          const { send, create, get, statuses } = yield* life;
          const created = yield* create({
            budget: { ...orchestratorInput().budget, maxTurnDurationMs: 5_000 },
          });
          yield* holdNextTurn(provider);
          yield* send(created.id, "Think for a long time.");
          yield* awaitThreadEvent(created.threadId!, providerTurnRunning);
          yield* TestClock.adjust("15 seconds");
          const events = yield* journal.untilTurnsFinished(1);
          assert.strictEqual(events.at(-1)!.payload.outcome, "interrupted_max_duration");
          assert.strictEqual(yield* turnCount(provider), 1);
          assert.deepStrictEqual(yield* statuses(created.id), ["unknown"]);
          const after = yield* get(created.id);
          assert.strictEqual(after.effectiveState, "error");
          assert.include(after.stateReason ?? "", "maxTurnDurationMs");
        }).pipe(Effect.provide(makeAutomationLayer())),
      ),
    TIMEOUT,
  );

  it.effect(
    "a crash after reserving and before dispatch sends the turn once on restart",
    () =>
      withEngine("orchestrator-crash-reserved", ({ provider, journal }) =>
        Effect.gen(function* () {
          const orchestratorId = yield* Effect.gen(function* () {
            const { runtime, send, create, statuses } = yield* life;
            const created = yield* create();
            yield* send(created.id, "Survive the crash.");
            yield* runtime.drain;
            assert.strictEqual(yield* turnCount(provider), 0);
            assert.deepStrictEqual(yield* statuses(created.id), ["reserved"]);
            return created.id;
          }).pipe(Effect.provide(makeAutomationLayerWith(crashingDispatch("before"))));

          yield* Effect.gen(function* () {
            const { service, runtime, statuses } = yield* life;
            yield* journal.untilTurnsFinished(1);
            yield* TestClock.adjust("1 minute");
            yield* runtime.drain;
            assert.strictEqual(yield* turnCount(provider), 1);
            assert.deepStrictEqual(yield* statuses(orchestratorId), ["processed"]);
            const checkpoints = yield* service.checkpoints(user, { orchestratorId });
            assert.strictEqual(checkpoints.length, 1);
          }).pipe(Effect.provide(makeAutomationLayer()));
        }),
      ),
    TIMEOUT,
  );

  it.effect(
    "a crash after the dispatch was accepted follows that run instead of sending again",
    () =>
      withEngine("orchestrator-crash-dispatched", ({ provider, journal }) =>
        Effect.gen(function* () {
          const hold = yield* holdNextTurn(provider);
          const { orchestratorId, threadId } = yield* Effect.gen(function* () {
            const { runtime, send, create, statuses } = yield* life;
            const created = yield* create();
            yield* send(created.id, "Already at the provider.");
            yield* runtime.drain;
            yield* awaitThreadEvent(created.threadId!, providerTurnRunning);
            assert.strictEqual(yield* turnCount(provider), 1);
            // The process died before it could record that the run exists.
            assert.deepStrictEqual(yield* statuses(created.id), ["reserved"]);
            return { orchestratorId: created.id, threadId: created.threadId! };
          }).pipe(Effect.provide(makeAutomationLayerWith(crashingDispatch("after"))));

          yield* Effect.gen(function* () {
            const { service, runtime, get, statuses } = yield* life;
            yield* TestClock.adjust("1 minute");
            yield* runtime.drain;
            assert.strictEqual(yield* turnCount(provider), 1);
            assert.strictEqual((yield* get(orchestratorId)).effectiveState, "running");
            assert.deepStrictEqual(yield* statuses(orchestratorId), ["reserved"]);

            yield* Deferred.succeed(hold, undefined);
            yield* journal.untilTurnsFinished(1);
            yield* TestClock.adjust("1 minute");
            yield* runtime.drain;
            assert.strictEqual(yield* turnCount(provider), 1);
            assert.deepStrictEqual(yield* statuses(orchestratorId), ["processed"]);
            const checkpoints = yield* service.checkpoints(user, { orchestratorId });
            assert.strictEqual(checkpoints.length, 1);
            const inbox = yield* service.inbox(user, { orchestratorId });
            assert.strictEqual(checkpoints[0]!.runId, inbox[0]!.reservedByRunId);
          }).pipe(Effect.provide(makeAutomationLayer()));
          // The run that finished while nobody watched is still the only one.
          yield* awaitThreadEvent(threadId, runIs("completed"));
        }),
      ),
    TIMEOUT,
  );

  it.effect(
    "when the dispatch outcome cannot be read the entries become unknown until the operator decides",
    () =>
      withEngine("orchestrator-crash-unknown", ({ provider, journal }) =>
        Effect.gen(function* () {
          const { orchestratorId, threadId } = yield* Effect.gen(function* () {
            const { runtime, send, create } = yield* life;
            const created = yield* create();
            yield* send(created.id, "Did this run?");
            yield* runtime.drain;
            return { orchestratorId: created.id, threadId: created.threadId! };
          }).pipe(Effect.provide(makeAutomationLayerWith(crashingDispatch("after"))));
          yield* awaitThreadEvent(threadId, runIs("completed"));
          assert.strictEqual(yield* turnCount(provider), 1);

          // Restart with a receipt store that cannot be read.
          yield* Effect.gen(function* () {
            const { service, runtime, get, statuses } = yield* life;
            const events = yield* journal.untilTurnsFinished(1);
            assert.strictEqual(events.at(-1)!.payload.outcome, "unknown");
            yield* TestClock.adjust("5 minutes");
            yield* runtime.drain;
            assert.strictEqual(yield* turnCount(provider), 1);
            assert.deepStrictEqual(yield* statuses(orchestratorId), ["unknown"]);
            assert.strictEqual((yield* get(orchestratorId)).effectiveState, "error");
            assert.strictEqual((yield* service.checkpoints(user, { orchestratorId })).length, 0);
          }).pipe(
            Effect.provide(
              makeAutomationLayerWith(
                Layer.mock(CommandReceiptStore.CommandReceiptStoreV2)({
                  getByCommandId: (commandId) =>
                    Effect.fail(
                      new CommandReceiptStore.CommandReceiptStoreReadError({
                        commandId,
                        cause: "disk unavailable",
                      }),
                    ),
                }),
              ),
            ),
          );

          yield* Effect.gen(function* () {
            const { service, runtime, get, statuses } = yield* life;
            yield* TestClock.adjust("5 minutes");
            yield* runtime.drain;
            // Still nothing happens on its own.
            assert.strictEqual(yield* turnCount(provider), 1);
            const [entry] = yield* service.inbox(user, { orchestratorId });
            const requeued = yield* service.resolveInbox(user, {
              orchestratorId,
              entryId: entry!.id,
              resolution: "requeue",
            });
            assert.strictEqual(requeued.status, "pending");
            yield* journal.untilTurnsFinished(2);
            assert.strictEqual(yield* turnCount(provider), 2);
            assert.deepStrictEqual(yield* statuses(orchestratorId), ["processed"]);
            assert.strictEqual((yield* get(orchestratorId)).effectiveState, "idle");
            // A processed entry cannot be put back in the queue.
            const refused = yield* service
              .resolveInbox(user, { orchestratorId, entryId: entry!.id, resolution: "requeue" })
              .pipe(Effect.flip);
            assert.strictEqual(refused.code, "CONFLICT");
          }).pipe(Effect.provide(makeAutomationLayer()));
        }),
      ),
    TIMEOUT,
  );

  it.effect(
    "delivering the same thing twice stores one entry and opens one turn",
    () =>
      withEngine("orchestrator-dedup", ({ provider, journal }) =>
        Effect.gen(function* () {
          const { service, runtime, create, deliverEvent, statuses } = yield* life;
          const created = yield* create();
          const entries = [journalEntry("task.reported", { orchestratorId: created.id })];
          const results = yield* Effect.all(
            [
              deliverEvent(created.id, "hook:delivery-1", entries),
              deliverEvent(created.id, "hook:delivery-1", entries),
            ],
            { concurrency: 2 },
          );
          assert.deepStrictEqual(results.map((result) => result.created).toSorted(), [false, true]);
          assert.strictEqual(results[0]!.entry.id, results[1]!.entry.id);
          yield* journal.untilTurnsFinished(1);
          const again = yield* deliverEvent(created.id, "hook:delivery-1", entries);
          assert.isFalse(again.created);
          yield* TestClock.adjust("1 minute");
          yield* runtime.drain;
          assert.strictEqual(yield* turnCount(provider), 1);
          assert.deepStrictEqual(yield* statuses(created.id), ["processed"]);

          const key = IdempotencyKey.make("same-send");
          const first = yield* service.send(user, {
            idempotencyKey: key,
            orchestratorId: created.id,
            text: "Once.",
          });
          const repeat = yield* service.send(user, {
            idempotencyKey: key,
            orchestratorId: created.id,
            text: "Once.",
          });
          assert.strictEqual(first.entry.id, repeat.entry.id);
          yield* journal.untilTurnsFinished(2);
          yield* runtime.drain;
          assert.strictEqual(yield* turnCount(provider), 2);
        }).pipe(Effect.provide(makeAutomationLayer())),
      ),
    TIMEOUT,
  );

  it.effect(
    "its own turn events never wake it; a delegated task's result does",
    () =>
      withEngine("orchestrator-self-wake", ({ provider, journal }) =>
        Effect.gen(function* () {
          const { runtime, send, create, deliverEvent, statuses } = yield* life;
          const created = yield* create();
          yield* send(created.id, "Start.");
          yield* journal.untilTurnsFinished(1);

          const scope = { orchestratorId: created.id, threadId: created.threadId! };
          const own = yield* deliverEvent(created.id, "hook:own-turn", [
            journalEntry("orchestrator.turn.finished", scope),
            journalEntry("turn.completed", { threadId: created.threadId! }),
            journalEntry("orchestrator.message.received", scope),
          ]);
          assert.strictEqual(own.entry.status, "absorbed");
          yield* TestClock.adjust("5 minutes");
          yield* runtime.drain;
          assert.strictEqual(yield* turnCount(provider), 1);

          yield* deliverEvent(created.id, "hook:child-result", [
            journalEntry(
              "task.reported",
              { orchestratorId: created.id, taskId: DelegatedTaskId.make("task:child") },
              { summary: "done" },
            ),
          ]);
          yield* journal.untilTurnsFinished(2);
          const turns = yield* Ref.get(provider.turns);
          assert.strictEqual(turns.length, 2);
          assert.include(turns[1]!.text, "task.reported");
          assert.include(turns[1]!.text, "task:child");
          assert.deepStrictEqual(yield* statuses(created.id), [
            "processed",
            "absorbed",
            "processed",
          ]);
        }).pipe(Effect.provide(makeAutomationLayer())),
      ),
    TIMEOUT,
  );

  it.effect(
    "events outside the orchestrator's projects are never shown to it",
    () =>
      withEngine("orchestrator-scope", ({ provider, journal }) =>
        Effect.gen(function* () {
          const { runtime, create, deliverEvent, statuses } = yield* life;
          const created = yield* create({
            permissions: { actions: ["thread.read"], projectIds: [projectId] },
          });
          yield* deliverEvent(created.id, "hook:foreign", [
            journalEntry("task.reported", { projectId: otherProjectId }, { secret: "elsewhere" }),
          ]);
          yield* runtime.drain;
          assert.strictEqual(yield* turnCount(provider), 0);
          assert.deepStrictEqual(yield* statuses(created.id), ["dismissed"]);

          yield* deliverEvent(created.id, "hook:in-scope", [
            journalEntry("task.reported", { projectId }),
          ]);
          yield* journal.untilTurnsFinished(1);
          const turns = yield* Ref.get(provider.turns);
          assert.notInclude(turns[0]!.text, "elsewhere");
        }).pipe(Effect.provide(makeAutomationLayer())),
      ),
    TIMEOUT,
  );

  it.effect(
    "settling, snoozing or archiving the main thread does not change the desired state",
    () =>
      withEngine("orchestrator-organize", ({ provider, journal }) =>
        Effect.gen(function* () {
          const { send, create, get } = yield* life;
          const threads = yield* ThreadManagement.ThreadManagementService;
          const created = yield* create();
          const threadId = created.threadId!;
          yield* threads.dispatch({
            type: "thread.settle",
            commandId: CommandId.make("command:settle"),
            threadId,
          });
          yield* threads.dispatch({
            type: "thread.snooze",
            commandId: CommandId.make("command:snooze"),
            threadId,
            snoozedUntil: "2099-01-01T00:00:00.000Z",
          });
          const organized = yield* get(created.id);
          assert.strictEqual(organized.desiredState, "active");
          assert.strictEqual(organized.effectiveState, "idle");

          // It still works: an actionable entry opens a turn as before.
          yield* send(created.id, "Still there?");
          yield* journal.untilTurnsFinished(1);
          assert.strictEqual(yield* turnCount(provider), 1);

          yield* threads.dispatch({
            type: "thread.archive",
            commandId: CommandId.make("command:archive"),
            threadId,
          });
          const archived = yield* get(created.id);
          assert.strictEqual(archived.desiredState, "active");
          assert.strictEqual(archived.revision, created.revision);
          assert.isTrue(Option.isSome(Option.fromNullishOr(archived.threadId)));
        }).pipe(Effect.provide(makeAutomationLayer())),
      ),
    TIMEOUT,
  );
});
