// @effect-diagnostics nodeBuiltinImport:off - Tests verify signatures and spawned processes with Node.
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AUTOMATION_EVENT_MAX_HOPS,
  DelegatedTaskId,
  EventConsumerId,
  EventId,
  HookDeliveryPayload,
  HookId,
  IdempotencyKey,
  OrchestratorId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Layers/Sqlite.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as EventJournal from "./EventJournal.ts";
import { testClient, testEnvironmentLayer, testEvent } from "./events/journal.testkit.ts";
import * as HookService from "./HookService.ts";
import * as HookRuntime from "./hooks/HookRuntime.ts";
import {
  hookInput,
  type HookTestOptions,
  makeHookTestLayer,
  makeHookTestLayerOn,
  makeInboxState,
  makeWebhookState,
  ORCHESTRATOR_ID,
} from "./hooks/hooks.testkit.ts";
import { webhookSecretName } from "./hooks/webhook.ts";

const services = Effect.gen(function* () {
  return {
    hooks: yield* HookService.HookService,
    runtime: yield* HookRuntime.HookRuntime,
    journal: yield* EventJournal.EventJournal,
    sql: yield* SqlClient.SqlClient,
  };
});

type HookTestServices = Layer.Success<ReturnType<typeof makeHookTestLayer>>;

const withHooks =
  (options: HookTestOptions = {}) =>
  <A, E>(effect: Effect.Effect<A, E, HookTestServices>) =>
    effect.pipe(Effect.provide(makeHookTestLayer(options)));

const decodePayload = Schema.decodeUnknownSync(Schema.fromJsonString(HookDeliveryPayload));
const decodeSeen = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      argv: Schema.Array(Schema.String),
      env: Schema.Record(Schema.String, Schema.String),
      stdin: Schema.String,
    }),
  ),
);

describe("hook management", () => {
  it.effect("starts a new hook at the head, or replays from a cursor when asked", () =>
    Effect.gen(function* () {
      const { hooks, runtime, journal } = yield* services;
      yield* journal.append([
        testEvent("task.reported"),
        testEvent("task.reported"),
        testEvent("task.reported"),
      ]);
      const atHead = yield* hooks.upsert(testClient, hookInput({ name: "from head" }));
      assert.deepStrictEqual(
        [atHead.cursor, atHead.revision, atHead.createdBy],
        [3, 1, "session-test"],
      );
      const replaying = yield* hooks.upsert(testClient, hookInput({ name: "replay", startAt: 1 }));
      assert.strictEqual(replaying.cursor, 1);
      yield* runtime.drain;

      const delivered = yield* hooks.deliveries(testClient, {});
      assert.deepStrictEqual(
        delivered.map((delivery) => [delivery.hookId, delivery.firstCursor, delivery.status]),
        [
          [replaying.id, 3, "delivered"],
          [replaying.id, 2, "delivered"],
        ],
      );

      const beyond = yield* hooks.upsert(testClient, hookInput({ startAt: 99 })).pipe(Effect.flip);
      assert.strictEqual(beyond.code, "INVALID_INPUT");
    }).pipe(withHooks()),
  );

  it.effect("rejects a stale edit and leaves the hook unchanged", () =>
    Effect.gen(function* () {
      const { hooks } = yield* services;
      const created = yield* hooks.upsert(testClient, hookInput({ name: "original" }));
      const edited = yield* hooks.upsert(
        testClient,
        hookInput({ id: created.id, expectedRevision: 1, name: "edited", priority: 5 }),
      );
      assert.deepStrictEqual([edited.revision, edited.name, edited.priority], [2, "edited", 5]);
      assert.strictEqual(edited.cursor, created.cursor);

      const stale = yield* hooks
        .upsert(testClient, hookInput({ id: created.id, expectedRevision: 1, name: "stale" }))
        .pipe(Effect.flip);
      assert.strictEqual(stale.code, "REVISION_MISMATCH");
      assert.strictEqual(stale.detail?.currentRevision, 2);

      const unnamed = yield* hooks
        .upsert(testClient, hookInput({ id: created.id, name: "no revision" }))
        .pipe(Effect.flip);
      assert.strictEqual(unnamed.code, "INVALID_INPUT");

      const missing = yield* hooks
        .upsert(testClient, hookInput({ id: HookId.make("hook-missing"), expectedRevision: 1 }))
        .pipe(Effect.flip);
      assert.strictEqual(missing.code, "NOT_FOUND");

      const [stored] = yield* hooks.list(testClient);
      assert.deepStrictEqual([stored?.revision, stored?.name], [2, "edited"]);
      assert.strictEqual((yield* hooks.list(testClient)).length, 1);
    }).pipe(withHooks()),
  );

  it.effect("validates filters and retry policies, and repeats an idempotent create", () =>
    Effect.gen(function* () {
      const { hooks } = yield* services;
      const badFilter = yield* hooks
        .upsert(testClient, hookInput({ filter: { types: ["not a type"] } }))
        .pipe(Effect.flip);
      assert.strictEqual(badFilter.code, "INVALID_INPUT");
      const badRetry = yield* hooks
        .upsert(
          testClient,
          hookInput({ retry: { maxAttempts: 2, initialDelayMs: 5_000, maxDelayMs: 1_000 } }),
        )
        .pipe(Effect.flip);
      assert.strictEqual(badRetry.code, "INVALID_INPUT");
      assert.strictEqual((yield* hooks.list(testClient)).length, 0);

      const idempotencyKey = IdempotencyKey.make("create-hook-1");
      const first = yield* hooks.upsert(testClient, hookInput({ idempotencyKey }));
      const repeat = yield* hooks.upsert(testClient, hookInput({ idempotencyKey, name: "other" }));
      assert.deepStrictEqual(repeat, first);
      assert.strictEqual((yield* hooks.list(testClient)).length, 1);
    }).pipe(withHooks()),
  );

  it.effect("holds events while disabled, catches up when enabled, and records each change", () => {
    const inbox = makeInboxState();
    return Effect.gen(function* () {
      const { hooks, runtime, journal } = yield* services;
      const hook = yield* hooks.upsert(testClient, hookInput());
      const disabled = yield* hooks.setEnabled(testClient, { hookId: hook.id, enabled: false });
      assert.deepStrictEqual([disabled.enabled, disabled.revision], [false, 2]);
      // Asking for the state it already has changes nothing.
      const again = yield* hooks.setEnabled(testClient, { hookId: hook.id, enabled: false });
      assert.strictEqual(again.revision, 2);

      yield* journal.append([testEvent("task.reported")]);
      yield* runtime.drain;
      assert.strictEqual(inbox.calls.length, 0);

      yield* hooks.setEnabled(testClient, { hookId: hook.id, enabled: true });
      yield* runtime.drain;
      assert.strictEqual(inbox.entries.size, 1);

      assert.isTrue(yield* hooks.delete(testClient, hook.id));
      assert.isFalse(yield* hooks.delete(testClient, hook.id));
      assert.deepStrictEqual(yield* hooks.list(testClient), []);
      assert.deepStrictEqual(yield* hooks.deliveries(testClient, {}), []);

      const changes = yield* journal.read(testClient, {
        afterCursor: 0,
        filter: { types: ["hook.changed"] },
      });
      assert.deepStrictEqual(
        changes.entries.map((entry) => entry.event.payload.change),
        ["created", "disabled", "enabled", "deleted"],
      );
      assert.strictEqual(changes.entries[0]?.event.origin.actorId, "session-test");
    }).pipe(withHooks({ inbox }));
  });

  it.effect("keeps a named CLI consumer for a cli_consumer hook and pushes nothing", () => {
    const inbox = makeInboxState();
    return Effect.gen(function* () {
      const { hooks, runtime, journal } = yield* services;
      const consumerId = EventConsumerId.make("ci-watch");
      yield* journal.append([testEvent("task.progress")]);
      const hook = yield* hooks.upsert(
        testClient,
        hookInput({ target: { type: "cli_consumer", consumerId } }),
      );
      assert.deepStrictEqual(
        (yield* journal.listConsumers(testClient)).map((consumer) => [
          consumer.consumerId,
          consumer.cursor,
        ]),
        [[consumerId, 1]],
      );
      yield* journal.append([testEvent("task.reported")]);
      yield* runtime.drain;
      const [delivery] = yield* hooks.deliveries(testClient, { hookId: hook.id });
      assert.deepStrictEqual([delivery?.status, delivery?.attemptCount], ["delivered", 0]);
      assert.strictEqual(inbox.calls.length, 0);

      // Deleting the hook leaves the consumer and its position alone.
      yield* hooks.delete(testClient, hook.id);
      assert.strictEqual((yield* journal.listConsumers(testClient)).length, 1);
    }).pipe(withHooks({ inbox }));
  });

  it.effect("tests a hook as a dry run unless asked to deliver", () => {
    const inbox = makeInboxState();
    return Effect.gen(function* () {
      const { hooks, runtime, journal } = yield* services;
      yield* journal.append([testEvent("task.reported"), testEvent("task.progress")]);
      const hook = yield* hooks.upsert(
        testClient,
        hookInput({ filter: { types: ["task.reported"] } }),
      );

      const dry = yield* hooks.test(testClient, { hookId: hook.id });
      assert.isTrue(dry.dryRun);
      assert.deepStrictEqual(
        dry.matched.map((entry) => entry.cursor),
        [1],
      );
      assert.deepStrictEqual(dry.preview?.target, {
        type: "orchestrator_inbox",
        orchestratorId: ORCHESTRATOR_ID,
      });
      assert.strictEqual(dry.delivery, null);
      yield* runtime.drain;
      assert.strictEqual(inbox.calls.length, 0);
      assert.deepStrictEqual(yield* hooks.deliveries(testClient, {}), []);

      const real = yield* hooks.test(testClient, { hookId: hook.id, deliver: true });
      assert.isFalse(real.dryRun);
      assert.strictEqual(real.delivery?.status, "delivered");
      assert.strictEqual(inbox.entries.size, 1);

      const nothing = yield* hooks.test(testClient, { hookId: hook.id, afterCursor: 2 });
      assert.deepStrictEqual([nothing.matched.length, nothing.preview], [0, null]);
      const unknown = yield* hooks
        .test(testClient, { hookId: HookId.make("hook-missing") })
        .pipe(Effect.flip);
      assert.strictEqual(unknown.code, "NOT_FOUND");
    }).pipe(withHooks({ inbox }));
  });
});

describe("hook delivery", () => {
  it.effect("delivers higher-priority hooks first and batches within a window", () => {
    const inbox = makeInboxState();
    return Effect.gen(function* () {
      const { hooks, runtime, journal } = yield* services;
      const low = yield* hooks.upsert(testClient, hookInput({ name: "low", priority: 0 }));
      const high = yield* hooks.upsert(testClient, hookInput({ name: "high", priority: 10 }));
      const batch = yield* hooks.upsert(
        testClient,
        hookInput({
          name: "batch",
          priority: -5,
          deliveryMode: "batch",
          batchWindowMs: 10_000,
          target: { type: "orchestrator_inbox", orchestratorId: OrchestratorId.make("batcher") },
        }),
      );
      yield* journal.append([testEvent("task.reported")]);
      yield* TestClock.adjust("3 seconds");
      yield* journal.append([testEvent("task.reported"), testEvent("task.reported")]);
      yield* runtime.drain;

      assert.deepStrictEqual(
        inbox.calls.slice(0, 2).map((key) => key.split(":")[0]),
        [high.id, low.id],
      );
      // The batch window opened with the first event and is still open.
      assert.deepStrictEqual(yield* hooks.deliveries(testClient, { hookId: batch.id }), []);

      yield* TestClock.adjust("7 seconds");
      yield* runtime.wake;
      yield* runtime.drain;
      const [batched] = yield* hooks.deliveries(testClient, { hookId: batch.id });
      assert.deepStrictEqual(
        [batched?.eventIds.length, batched?.firstCursor, batched?.lastCursor, batched?.status],
        [3, 4, 6, "delivered"],
      );
      assert.strictEqual(inbox.entries.get(`batcher:${batched?.dedupKey}`)?.entries.length, 3);
      const stored = (yield* hooks.list(testClient)).find((hook) => hook.id === batch.id);
      assert.strictEqual(stored?.cursor, 6);
    }).pipe(withHooks({ inbox }));
  });

  it.effect("retries with backoff, fails when attempts run out, and redelivers on request", () => {
    const inbox = makeInboxState();
    inbox.script.push("fail", "fail", "fail");
    return Effect.gen(function* () {
      const { hooks, runtime, journal } = yield* services;
      const hook = yield* hooks.upsert(testClient, hookInput());
      yield* journal.append([testEvent("task.reported", { correlationId: "chain-retry" })]);
      yield* runtime.drain;

      const first = (yield* hooks.deliveries(testClient, {}))[0];
      assert.deepStrictEqual([first?.status, first?.attemptCount], ["retrying", 1]);
      assert.include(first?.lastError, "unavailable");
      const firstDelay = Date.parse(first?.nextAttemptAt ?? "");
      assert.isAtLeast(firstDelay, 500);
      assert.isAtMost(firstDelay, 1_000);

      // Nothing is retried before its time.
      yield* runtime.wake;
      yield* runtime.drain;
      assert.strictEqual(inbox.calls.length, 1);

      yield* TestClock.adjust("1 second");
      yield* runtime.wake;
      yield* runtime.drain;
      const second = (yield* hooks.deliveries(testClient, {}))[0];
      assert.deepStrictEqual([second?.status, second?.attemptCount], ["retrying", 2]);
      const secondDelay = Date.parse(second?.nextAttemptAt ?? "") - 1_000;
      assert.isAtLeast(secondDelay, 1_000);
      assert.isAtMost(secondDelay, 2_000);

      yield* TestClock.adjust("2 seconds");
      yield* runtime.wake;
      yield* runtime.drain;
      const failed = (yield* hooks.deliveries(testClient, { statuses: ["failed"] }))[0];
      assert.deepStrictEqual(
        [failed?.status, failed?.attemptCount, failed?.nextAttemptAt],
        ["failed", 3, null],
      );
      assert.strictEqual(inbox.calls.length, 3);
      assert.strictEqual(inbox.entries.size, 0);

      const announced = yield* journal.read(testClient, {
        afterCursor: 0,
        filter: { types: ["hook.delivery.failed"] },
      });
      assert.strictEqual(announced.entries.length, 1);
      const failure = announced.entries[0]?.event;
      assert.deepStrictEqual(failure?.aggregate, { kind: "hook", id: hook.id, revision: 2 });
      assert.strictEqual(failure?.payload.deliveryId, failed?.id);
      assert.strictEqual(failure?.payload.attemptCount, 3);
      // The failure belongs to the chain of the event that could not be delivered.
      assert.deepStrictEqual([failure?.correlationId, failure?.hops], ["chain-retry", 1]);

      // Time alone never retries a failed delivery.
      yield* TestClock.adjust("1 hour");
      yield* runtime.wake;
      yield* runtime.drain;
      assert.strictEqual(inbox.calls.length, 3);

      assert.isDefined(failed);
      const queued = yield* hooks.redeliver(testClient, failed.id);
      assert.deepStrictEqual(
        [queued.status, queued.attemptCount, queued.dedupKey, queued.lastError],
        ["pending", 0, failed.dedupKey, null],
      );
      yield* runtime.drain;
      const delivered = (yield* hooks.deliveries(testClient, {}))[0];
      assert.deepStrictEqual(
        [delivered?.id, delivered?.status, delivered?.attemptCount],
        [failed.id, "delivered", 1],
      );
      assert.deepStrictEqual([...inbox.entries.keys()], [`${ORCHESTRATOR_ID}:${failed.dedupKey}`]);
    }).pipe(withHooks({ inbox }));
  });

  it.effect("gives the target one logical delivery however often it is sent", () => {
    const inbox = makeInboxState();
    // The first write lands but its acknowledgement is lost.
    inbox.script.push("store-then-fail");
    return Effect.gen(function* () {
      const { hooks, runtime, journal } = yield* services;
      yield* hooks.upsert(testClient, hookInput());
      yield* journal.append([testEvent("task.reported")]);
      yield* runtime.drain;
      assert.strictEqual((yield* hooks.deliveries(testClient, {}))[0]?.status, "retrying");

      yield* TestClock.adjust("1 second");
      yield* runtime.wake;
      yield* runtime.drain;
      const delivered = (yield* hooks.deliveries(testClient, {}))[0];
      assert.isDefined(delivered);
      assert.strictEqual(delivered.status, "delivered");

      yield* hooks.redeliver(testClient, delivered.id);
      yield* runtime.drain;

      assert.strictEqual(inbox.calls.length, 3);
      assert.deepStrictEqual(new Set(inbox.calls).size, 1);
      assert.strictEqual(inbox.entries.size, 1);
      assert.strictEqual((yield* hooks.deliveries(testClient, {})).length, 1);
    }).pipe(withHooks({ inbox }));
  });

  it.effect("fails an attempt that outlives the hook's timeout", () => {
    const inbox = makeInboxState();
    inbox.script.push("hang");
    return Effect.gen(function* () {
      const { hooks, runtime, journal } = yield* services;
      const started = yield* Deferred.make<void>();
      inbox.onCall = () => Deferred.succeed(started, undefined);
      yield* hooks.upsert(testClient, hookInput({ timeoutMs: 2_000 }));
      yield* journal.append([testEvent("task.reported")]);
      yield* Deferred.await(started);
      // An attempt in flight cannot be queued a second time.
      const inFlight = (yield* hooks.deliveries(testClient, {}))[0];
      assert.isDefined(inFlight);
      assert.strictEqual(inFlight.status, "delivering");
      const conflict = yield* hooks.redeliver(testClient, inFlight.id).pipe(Effect.flip);
      assert.strictEqual(conflict.code, "CONFLICT");

      yield* TestClock.adjust("2 seconds");
      yield* runtime.drain;
      const [delivery] = yield* hooks.deliveries(testClient, {});
      assert.strictEqual(delivery?.status, "retrying");
      assert.include(delivery?.lastError, "2000 ms");
    }).pipe(withHooks({ inbox }));
  });

  it.effect("dismisses a failed or suppressed delivery, and nothing else", () => {
    const inbox = makeInboxState();
    return Effect.gen(function* () {
      const { hooks, runtime, journal } = yield* services;
      yield* hooks.upsert(testClient, hookInput());
      const hopLimit = { eventId: EventId.make("cause"), correlationId: "c", hops: 99 };
      yield* journal.append([
        testEvent("task.progress"),
        testEvent("task.progress", { causedBy: hopLimit }),
      ]);
      yield* runtime.drain;
      const all = yield* hooks.deliveries(testClient, {});
      const delivered = all.find((delivery) => delivery.status === "delivered");
      const suppressed = all.find((delivery) => delivery.status === "suppressed");
      assert.isDefined(delivered);
      assert.isDefined(suppressed);

      const refused = yield* hooks.dismissDelivery(testClient, delivered.id).pipe(Effect.flip);
      assert.strictEqual(refused.code, "CONFLICT");
      const dismissed = yield* hooks.dismissDelivery(testClient, suppressed.id);
      assert.strictEqual(dismissed.suppressedReason, "hop_limit");
      assert.deepStrictEqual(
        (yield* hooks.deliveries(testClient, {})).map((delivery) => delivery.id),
        [delivered.id],
      );
      const gone = yield* hooks.dismissDelivery(testClient, suppressed.id).pipe(Effect.flip);
      assert.strictEqual(gone.code, "NOT_FOUND");
    }).pipe(withHooks({ inbox }));
  });
});

describe("hook loop protection", () => {
  it.effect("stops a hook that keeps reacting to its own deliveries at the hop limit", () => {
    const inbox = makeInboxState();
    return Effect.gen(function* () {
      const { hooks, runtime, journal } = yield* services;
      // Every delivery makes the receiver publish another event caused by it.
      let reactions = 0;
      inbox.onDelivered = (entry) =>
        journal
          .emit(testClient, {
            idempotencyKey: IdempotencyKey.make(`reaction-${++reactions}`),
            type: "custom.loop.reaction",
            ...(entry.entries[0] === undefined
              ? {}
              : { causationId: entry.entries[0].event.eventId }),
          })
          .pipe(Effect.asVoid, Effect.orDie);
      yield* hooks.upsert(testClient, hookInput({ filter: { types: ["custom.loop.*"] } }));
      yield* journal.emit(testClient, {
        idempotencyKey: IdempotencyKey.make("seed"),
        type: "custom.loop.reaction",
      });
      yield* runtime.drain;

      const deliveries = yield* hooks.deliveries(testClient, {});
      assert.strictEqual(inbox.entries.size, AUTOMATION_EVENT_MAX_HOPS);
      assert.deepStrictEqual(
        deliveries
          .filter((delivery) => delivery.status === "suppressed")
          .map((delivery) => delivery.suppressedReason),
        ["hop_limit"],
      );
      // The suppressed event is still in the journal and its delivery can be inspected.
      const chain = yield* journal.read(testClient, {
        afterCursor: 0,
        filter: { types: ["custom.*"] },
      });
      assert.deepStrictEqual(
        chain.entries.map((entry) => entry.event.hops),
        Array.from({ length: AUTOMATION_EVENT_MAX_HOPS + 1 }, (_, hops) => hops),
      );
      assert.strictEqual(deliveries.length, AUTOMATION_EVENT_MAX_HOPS + 1);
    }).pipe(withHooks({ inbox }));
  });

  it.effect("cools down a chatty chain but still delivers the child's result", () => {
    const inbox = makeInboxState();
    return Effect.gen(function* () {
      const { hooks, runtime, journal } = yield* services;
      const taskId = DelegatedTaskId.make("task-child");
      const chain = { correlationId: "chain-task", scope: { taskId } };
      yield* hooks.upsert(testClient, hookInput({ cooldownMs: 60_000 }));

      yield* journal.append([testEvent("task.progress", chain)]);
      yield* runtime.drain;
      yield* journal.append([
        testEvent("task.progress", chain),
        testEvent("task.progress", chain),
        // Another chain is not affected by this one's cooldown.
        testEvent("task.progress", { correlationId: "chain-other" }),
        testEvent("task.reported", chain),
      ]);
      yield* runtime.drain;

      const summary = (yield* hooks.deliveries(testClient, {}))
        .toSorted((left, right) => left.firstCursor - right.firstCursor)
        .map((delivery) => [delivery.firstCursor, delivery.status, delivery.suppressedReason]);
      assert.deepStrictEqual(summary, [
        [2, "delivered", null],
        [3, "suppressed", "cooldown"],
        [4, "suppressed", "cooldown"],
        [5, "delivered", null],
        [6, "delivered", null],
      ]);

      yield* TestClock.adjust("61 seconds");
      yield* journal.append([testEvent("task.progress", chain)]);
      yield* runtime.drain;
      const latest = (yield* hooks.deliveries(testClient, {})).find(
        (delivery) => delivery.firstCursor === 7,
      );
      assert.strictEqual(latest?.status, "delivered");
    }).pipe(withHooks({ inbox }));
  });

  it.effect("limits deliveries per task without holding back how the task ended", () => {
    const inbox = makeInboxState();
    return Effect.gen(function* () {
      const { hooks, runtime, journal } = yield* services;
      const scope = { taskId: DelegatedTaskId.make("task-noisy") };
      yield* hooks.upsert(testClient, hookInput({ maxDeliveriesPerTask: 2 }));
      yield* journal.append([
        testEvent("task.progress", { scope }),
        testEvent("task.progress", { scope }),
        testEvent("task.progress", { scope }),
        testEvent("task.progress", { scope: { taskId: DelegatedTaskId.make("task-quiet") } }),
      ]);
      yield* runtime.drain;
      yield* journal.append([
        testEvent("task.progress", { scope }),
        testEvent("task.failed", { scope }),
      ]);
      yield* runtime.drain;

      const summary = (yield* hooks.deliveries(testClient, {}))
        .toSorted((left, right) => left.firstCursor - right.firstCursor)
        .map((delivery) => [delivery.firstCursor, delivery.suppressedReason]);
      assert.deepStrictEqual(summary, [
        [2, null],
        [3, null],
        [4, "task_limit"],
        [5, null],
        [6, "task_limit"],
        [7, null],
      ]);
    }).pipe(withHooks({ inbox }));
  });

  it.effect("never delivers an orchestrator's own finished turn back to its inbox", () => {
    const inbox = makeInboxState();
    return Effect.gen(function* () {
      const { hooks, runtime, journal } = yield* services;
      yield* hooks.upsert(
        testClient,
        hookInput({ filter: { types: ["orchestrator.turn.finished"] } }),
      );
      yield* journal.append([
        testEvent("orchestrator.turn.finished", { scope: { orchestratorId: ORCHESTRATOR_ID } }),
        testEvent("orchestrator.turn.finished", {
          scope: { orchestratorId: OrchestratorId.make("orchestrator-other") },
        }),
      ]);
      yield* runtime.drain;
      assert.deepStrictEqual(
        (yield* hooks.deliveries(testClient, {}))
          .toSorted((left, right) => left.firstCursor - right.firstCursor)
          .map((delivery) => [delivery.status, delivery.suppressedReason]),
        [
          ["suppressed", "self_turn"],
          ["delivered", null],
        ],
      );
      assert.strictEqual(inbox.entries.size, 1);
    }).pipe(withHooks({ inbox }));
  });

  it.effect("holds the cursor under backpressure and delivers everything once it clears", () => {
    const inbox = makeInboxState();
    const total = HookRuntime.HOOK_MAX_PENDING_DELIVERIES + 40;
    return Effect.gen(function* () {
      const { hooks, runtime, journal } = yield* services;
      const hook = yield* hooks.upsert(
        testClient,
        hookInput({
          filter: { types: ["task.progress"] },
          retry: { maxAttempts: 5, initialDelayMs: 1_000, maxDelayMs: 1_000 },
        }),
      );
      const firstEventCursor = (yield* journal.status).headCursor + 1;
      // The inbox is down, so deliveries pile up instead of completing.
      for (let index = 0; index < total; index++) inbox.script.push("fail");
      for (let index = 0; index < total; index++) {
        yield* journal.append([testEvent("task.progress", { payload: { index } })]);
      }
      yield* runtime.drain;

      const held = (yield* hooks.list(testClient))[0];
      const waiting = yield* hooks.deliveries(testClient, { limit: 1_000 });
      assert.strictEqual(waiting.length, HookRuntime.HOOK_MAX_PENDING_DELIVERIES);
      assert.isTrue(waiting.every((delivery) => delivery.status === "retrying"));
      // The hook stopped where the cap was reached; the rest stays in the journal.
      assert.isBelow(hook.cursor, firstEventCursor);
      assert.strictEqual(
        held?.cursor,
        firstEventCursor + HookRuntime.HOOK_MAX_PENDING_DELIVERIES - 1,
      );
      const reasons = () =>
        Effect.map(
          journal.read(testClient, {
            afterCursor: 0,
            filter: { types: ["hook.changed"] },
            limit: 1_000,
          }),
          (result) => result.entries.map((entry) => entry.event.payload.change),
        );
      assert.deepStrictEqual(yield* reasons(), ["created", "backpressure"]);

      inbox.script.length = 0;
      yield* TestClock.adjust("1 second");
      yield* runtime.wake;
      yield* runtime.drain;

      const done = yield* hooks.deliveries(testClient, { limit: 1_000 });
      assert.strictEqual(done.length, total);
      assert.isTrue(done.every((delivery) => delivery.status === "delivered"));
      assert.strictEqual(inbox.entries.size, total);
      assert.deepStrictEqual(yield* reasons(), ["created", "backpressure", "backpressure_cleared"]);
      const caughtUp = (yield* hooks.list(testClient))[0];
      assert.strictEqual(caughtUp?.cursor, (yield* journal.status).headCursor);
    }).pipe(withHooks({ inbox }));
  });
});

describe("hook delivery across a restart", () => {
  const temporaryDatabasePath = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-hooks-restart-" });
    return path.join(directory, "state.sqlite");
  });

  /** Builds every layer anew over the same database file, and tears it down afterwards. */
  const restartOn =
    (databasePath: string, options: HookTestOptions) =>
    <A, E>(effect: Effect.Effect<A, E, HookTestServices>) =>
      effect.pipe(
        Effect.provide(
          HookRuntime.workerLive.pipe(
            Layer.provide(Scheduler.layer),
            Layer.provideMerge(
              makeHookTestLayerOn(
                SqlitePersistence.makeSqlitePersistenceLive(databasePath),
                options,
              ),
            ),
          ),
        ),
      );

  it.effect("delivers an event that committed just before the process died", () =>
    Effect.gen(function* () {
      const inbox = makeInboxState();
      const databasePath = yield* temporaryDatabasePath;
      const restart = restartOn(databasePath, { inbox });
      yield* Effect.gen(function* () {
        const { hooks, runtime } = yield* services;
        yield* hooks.upsert(testClient, hookInput());
        yield* runtime.drain;
      }).pipe(restart);

      // Only the journal runs here: the event commits and nothing reacts to it.
      yield* Effect.gen(function* () {
        const journal = yield* EventJournal.EventJournal;
        yield* journal.append([testEvent("task.reported")]);
      }).pipe(
        Effect.provide(
          EventJournal.layer.pipe(
            Layer.provideMerge(SqlitePersistence.makeSqlitePersistenceLive(databasePath)),
            Layer.provide(testEnvironmentLayer),
          ),
        ),
      );
      assert.strictEqual(inbox.calls.length, 0);

      yield* Effect.gen(function* () {
        const { hooks, runtime, sql } = yield* services;
        const before = yield* sql<{ readonly rows: number }>`
              SELECT COUNT(*) AS rows FROM automation_journal WHERE type = 'task.reported'
            `;
        assert.strictEqual(before[0]?.rows, 1);
        yield* runtime.drain;
        const [delivery] = yield* hooks.deliveries(testClient, {});
        assert.deepStrictEqual([delivery?.status, delivery?.attemptCount], ["delivered", 1]);
      }).pipe(restart);
      assert.strictEqual(inbox.entries.size, 1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("finishes a delivery the process died in the middle of, without a duplicate", () =>
    Effect.gen(function* () {
      const inbox = makeInboxState();
      const restart = restartOn(yield* temporaryDatabasePath, { inbox });
      // The write reaches the inbox, and the process dies before recording that.
      inbox.script.push("hang");
      yield* Effect.gen(function* () {
        const { hooks, journal } = yield* services;
        const reached = yield* Deferred.make<void>();
        inbox.onCall = () => Deferred.succeed(reached, undefined);
        yield* hooks.upsert(testClient, hookInput());
        yield* journal.append([testEvent("task.reported")]);
        yield* Deferred.await(reached);
        const [delivery] = yield* hooks.deliveries(testClient, {});
        assert.strictEqual(delivery?.status, "delivering");
      }).pipe(restart);

      inbox.onCall = () => Effect.void;
      yield* Effect.gen(function* () {
        const { hooks, runtime } = yield* services;
        yield* runtime.drain;
        const [delivery] = yield* hooks.deliveries(testClient, {});
        assert.deepStrictEqual([delivery?.status, delivery?.attemptCount], ["delivered", 2]);
        assert.strictEqual(inbox.calls[0], delivery?.dedupKey);
      }).pipe(restart);
      assert.strictEqual(inbox.calls.length, 2);
      assert.strictEqual(new Set(inbox.calls).size, 1);
      assert.strictEqual(inbox.entries.size, 1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("webhook hooks", () => {
  const origin = "https://hooks.example.com";
  const webhookTarget = {
    type: "webhook",
    url: `${origin}/t3?token=ignored`,
    secretRef: "ci",
  } as const;

  it.effect("refuses a webhook the server has not allowed", () => {
    const webhook = makeWebhookState();
    return Effect.gen(function* () {
      const { hooks } = yield* services;
      for (const url of [
        "https://elsewhere.example.net/hook",
        "http://hooks.example.com/hook",
        "https://user:password@hooks.example.com/hook",
        "ftp://hooks.example.com/hook",
        "not a url",
      ]) {
        const error = yield* hooks
          .upsert(testClient, hookInput({ target: { ...webhookTarget, url } }))
          .pipe(Effect.flip);
        assert.strictEqual(error.code, "PERMISSION_DENIED", url);
      }
      const badSecret = yield* hooks
        .upsert(testClient, hookInput({ target: { ...webhookTarget, secretRef: "../session" } }))
        .pipe(Effect.flip);
      assert.strictEqual(badSecret.code, "INVALID_INPUT");
      assert.deepStrictEqual(yield* hooks.list(testClient), []);
      assert.strictEqual(webhook.requests.length, 0);
    }).pipe(withHooks({ webhook, policy: { webhookOrigins: [origin] } }));
  });

  it.effect("signs the body so a receiver can verify it and recognise a repeat", () => {
    const webhook = makeWebhookState();
    const secrets = new Map<string, Uint8Array>();
    webhook.response = { status: 503, location: null };
    return Effect.gen(function* () {
      const { hooks, runtime, journal } = yield* services;
      const hook = yield* hooks.upsert(testClient, hookInput({ target: webhookTarget }));
      const secret = secrets.get(webhookSecretName("ci"));
      assert.isDefined(secret);

      yield* TestClock.adjust("90 seconds");
      yield* journal.append([testEvent("task.reported", { payload: { summary: "done" } })]);
      yield* runtime.drain;
      webhook.response = { status: 204, location: null };
      yield* TestClock.adjust("1 second");
      yield* runtime.wake;
      yield* runtime.drain;

      assert.strictEqual(webhook.requests.length, 2);
      const [first, second] = webhook.requests;
      assert.isDefined(first);
      assert.isDefined(second);
      assert.strictEqual(first.url, webhookTarget.url);
      assert.deepStrictEqual(webhook.resolved, ["hooks.example.com", "hooks.example.com"]);

      for (const request of [first, second]) {
        const timestamp = request.headers["x-t3-timestamp"];
        const deliveryId = request.headers["x-t3-delivery-id"];
        const expected = NodeCrypto.createHmac("sha256", secret)
          .update(`${timestamp}.${deliveryId}.${request.body}`)
          .digest("hex");
        assert.strictEqual(request.headers["x-t3-signature"], `v1=${expected}`);
        assert.strictEqual(request.headers["x-t3-hook-id"], hook.id);
      }
      assert.deepStrictEqual(
        [first.headers["x-t3-timestamp"], second.headers["x-t3-timestamp"]],
        ["90", "91"],
      );
      // A retry carries the same delivery id and dedup key: a receiver that
      // stored them sees the repeat for what it is.
      assert.strictEqual(first.headers["x-t3-delivery-id"], second.headers["x-t3-delivery-id"]);
      assert.strictEqual(first.headers["x-t3-dedup-key"], second.headers["x-t3-dedup-key"]);

      const payload = decodePayload(second.body);
      assert.deepStrictEqual(
        [payload.attempt, payload.hookId, payload.deliveryId, payload.dedupKey],
        [2, hook.id, second.headers["x-t3-delivery-id"], second.headers["x-t3-dedup-key"]],
      );
      assert.deepStrictEqual(payload.entries[0]?.event.payload, { summary: "done" });
      assert.strictEqual((yield* hooks.deliveries(testClient, {}))[0]?.status, "delivered");

      // The test preview never shows the secret reference or the query string.
      const dry = yield* hooks.test(testClient, { hookId: hook.id });
      assert.deepStrictEqual(dry.preview?.target, {
        type: "webhook",
        url: `${origin}/t3`,
        secretRef: "[redacted]",
      });
    }).pipe(withHooks({ webhook, secrets, policy: { webhookOrigins: [origin] } }));
  });

  it.effect("refuses a host that resolves to a private address, without sending", () => {
    const webhook = makeWebhookState();
    webhook.addresses = ["93.184.216.34", "10.0.0.8"];
    return Effect.gen(function* () {
      const { hooks, runtime, journal } = yield* services;
      yield* hooks.upsert(testClient, hookInput({ target: webhookTarget }));
      yield* hooks.upsert(
        testClient,
        hookInput({ target: { ...webhookTarget, url: "https://169.254.169.254/latest" } }),
      );
      yield* journal.append([testEvent("task.reported")]);
      yield* runtime.drain;

      const deliveries = yield* hooks.deliveries(testClient, {});
      assert.deepStrictEqual(
        deliveries.map((delivery) => [delivery.status, delivery.attemptCount]),
        [
          ["failed", 1],
          ["failed", 1],
        ],
      );
      assert.isTrue(deliveries.every((delivery) => delivery.lastError?.includes("private")));
      assert.strictEqual(webhook.requests.length, 0);
      // A literal address is judged as it stands and never looked up.
      assert.deepStrictEqual(webhook.resolved, ["hooks.example.com"]);
    }).pipe(
      withHooks({
        webhook,
        policy: { webhookOrigins: [origin, "https://169.254.169.254"] },
      }),
    );
  });

  it.effect("sends to a private origin only when the operator listed it as private", () => {
    const webhook = makeWebhookState();
    const local = "http://127.0.0.1:8787";
    return Effect.gen(function* () {
      const { hooks, runtime, journal } = yield* services;
      yield* hooks.upsert(
        testClient,
        hookInput({ target: { ...webhookTarget, url: `${local}/hook` } }),
      );
      yield* journal.append([testEvent("task.reported")]);
      yield* runtime.drain;
      assert.strictEqual((yield* hooks.deliveries(testClient, {}))[0]?.status, "delivered");
      assert.deepStrictEqual(
        webhook.requests.map((request) => request.url),
        [`${local}/hook`],
      );
      assert.deepStrictEqual(webhook.resolved, []);
    }).pipe(withHooks({ webhook, policy: { privateWebhookOrigins: [local] } }));
  });

  it.effect("does not follow a redirect to another origin", () => {
    const webhook = makeWebhookState();
    webhook.response = { status: 302, location: "https://elsewhere.example.net/collect" };
    return Effect.gen(function* () {
      const { hooks, runtime, journal } = yield* services;
      yield* hooks.upsert(testClient, hookInput({ target: webhookTarget }));
      yield* journal.append([testEvent("task.reported")]);
      yield* runtime.drain;
      yield* TestClock.adjust("1 hour");
      yield* runtime.wake;
      yield* runtime.drain;

      const [delivery] = yield* hooks.deliveries(testClient, {});
      assert.deepStrictEqual([delivery?.status, delivery?.attemptCount], ["failed", 1]);
      assert.include(delivery?.lastError, "redirect");
      assert.deepStrictEqual(
        webhook.requests.map((request) => request.url),
        [webhookTarget.url],
      );
    }).pipe(withHooks({ webhook, policy: { webhookOrigins: [origin] } }));
  });
});

describe("command hooks", () => {
  it.effect("refuses an executable the server has not allowed", () =>
    Effect.gen(function* () {
      const { hooks } = yield* services;
      const error = yield* hooks
        .upsert(
          testClient,
          hookInput({ target: { type: "command", executable: "/bin/sh", args: ["-c", "id"] } }),
        )
        .pipe(Effect.flip);
      assert.strictEqual(error.code, "PERMISSION_DENIED");
    }).pipe(withHooks({ policy: { commandExecutables: [process.execPath] } })),
  );

  it.effect("runs the fixed argv without a shell and with only the allowed environment", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-hook-command-" });
      const output = path.join(directory, "seen.json");
      const marker = path.join(directory, "injected");
      const script = [
        "const fs = require('node:fs');",
        "fs.writeFileSync(process.argv[1], JSON.stringify({",
        "  argv: process.argv.slice(2), env: process.env, stdin: fs.readFileSync(0, 'utf8')",
        "}));",
      ].join("\n");
      const hostile = [`$(touch ${marker})`, `; touch ${marker}`, "a b", "*"];

      const { hooks, runtime, journal } = yield* services;
      yield* hooks.upsert(
        testClient,
        hookInput({
          target: {
            type: "command",
            executable: process.execPath,
            args: ["-e", script, output, ...hostile],
            envAllowlist: ["HOOK_VISIBLE", "HOOK_ABSENT"],
          },
        }),
      );
      yield* journal.append([testEvent("task.reported", { payload: { summary: "ok" } })]);
      yield* runtime.drain;

      const [delivery] = yield* hooks.deliveries(testClient, {});
      assert.deepStrictEqual([delivery?.status, delivery?.lastError], ["delivered", null]);
      const seen = decodeSeen(yield* fs.readFileString(output));
      // Each argument arrived as written; nothing was expanded or executed.
      assert.deepStrictEqual(seen.argv, hostile);
      assert.isFalse(yield* fs.exists(marker));
      assert.strictEqual(seen.env.HOOK_VISIBLE, "shown");
      assert.isUndefined(seen.env.HOOK_SECRET);
      assert.isUndefined(seen.env.PATH);
      assert.isUndefined(seen.env.HOME);
      const payload = decodePayload(seen.stdin);
      assert.deepStrictEqual(payload.entries[0]?.event.payload, { summary: "ok" });
      assert.strictEqual(payload.deliveryId, delivery?.id);
    }).pipe(
      Effect.scoped,
      withHooks({
        policy: { commandExecutables: [process.execPath] },
        environment: {
          HOOK_VISIBLE: "shown",
          HOOK_SECRET: "hidden",
          PATH: process.env.PATH,
          HOME: process.env.HOME,
        },
      }),
    ),
  );

  it.effect("treats a non-zero exit as a failed attempt", () =>
    Effect.gen(function* () {
      const { hooks, runtime, journal } = yield* services;
      yield* hooks.upsert(
        testClient,
        hookInput({
          target: {
            type: "command",
            executable: process.execPath,
            args: ["-e", "process.stderr.write('no route'); process.exit(3)"],
          },
        }),
      );
      yield* journal.append([testEvent("task.reported")]);
      yield* runtime.drain;
      const [delivery] = yield* hooks.deliveries(testClient, {});
      assert.strictEqual(delivery?.status, "retrying");
      assert.include(delivery?.lastError, "code 3");
      assert.include(delivery?.lastError, "no route");
    }).pipe(withHooks({ policy: { commandExecutables: [process.execPath] } })),
  );
});
