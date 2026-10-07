import { assert, describe, it } from "@effect/vitest";
import {
  AUTOMATION_EVENT_MAX_PAYLOAD_BYTES,
  type AutomationEventsStreamItem,
  type AutomationJournalEntry,
  EnvironmentId,
  EventConsumerId,
  EventId,
  IdempotencyKey,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { internalCaller } from "./Caller.ts";
import * as EventJournal from "./EventJournal.ts";
import * as JournalStore from "./events/JournalStore.ts";
import {
  makeJournalTestLayer,
  TEST_ENVIRONMENT_ID,
  testClient,
  testEvent,
} from "./events/journal.testkit.ts";

const withJournal = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    EventJournal.EventJournal | JournalStore.JournalStore | SqlClient.SqlClient | Scope.Scope
  >,
) => effect.pipe(Effect.scoped, Effect.provide(makeJournalTestLayer()));

const cursorsOf = (entries: ReadonlyArray<AutomationJournalEntry>) =>
  entries.map((entry) => entry.cursor);

const entriesOf = (items: ReadonlyArray<AutomationEventsStreamItem>) =>
  items.flatMap((item) => (item.type === "entry" ? [item.entry] : []));

const appendMany = (count: number, type: "task.progress" | "turn.completed" = "task.progress") =>
  Effect.gen(function* () {
    const journal = yield* EventJournal.EventJournal;
    for (let index = 0; index < count; index++) {
      yield* journal.append([testEvent(type, { payload: { index } })]);
    }
  });

describe("EventJournal.append", () => {
  it.effect("assigns identity, cursors, origin, revision, hops and correlation", () =>
    withJournal(
      Effect.gen(function* () {
        const journal = yield* EventJournal.EventJournal;
        const [first, second] = yield* journal.append([
          testEvent("task.delegated", { correlationId: "chain-1" }),
          testEvent("task.accepted"),
        ]);
        assert.isDefined(first);
        assert.isDefined(second);
        assert.strictEqual(first.cursor, 1);
        assert.strictEqual(first.event.originCursor, 1);
        assert.strictEqual(second.cursor, 2);
        assert.strictEqual(first.event.origin.environmentId, TEST_ENVIRONMENT_ID);
        assert.strictEqual(first.event.recordedAt, "1970-01-01T00:00:00.000Z");
        assert.strictEqual(first.event.occurredAt, first.event.recordedAt);
        assert.notStrictEqual(first.event.eventId, second.event.eventId);
        // Both are about the same aggregate, so the revision counts up.
        assert.deepStrictEqual(
          [first.event.aggregate.revision, second.event.aggregate.revision],
          [1, 2],
        );
        assert.deepStrictEqual([first.event.hops, first.event.correlationId], [0, "chain-1"]);
        assert.strictEqual(first.event.causationId, null);
        // Without a given correlation the event starts its own chain.
        assert.strictEqual(second.event.correlationId, second.event.eventId);

        const [reaction] = yield* journal.append([
          testEvent("task.reported", { causedBy: first.event, correlationId: "ignored" }),
        ]);
        assert.isDefined(reaction);
        assert.strictEqual(reaction.event.hops, 1);
        assert.strictEqual(reaction.event.correlationId, "chain-1");
        assert.strictEqual(reaction.event.causationId, first.event.eventId);

        const [other] = yield* journal.append([
          testEvent("task.delegated", { aggregate: { kind: "task", id: "task-2" } }),
        ]);
        assert.strictEqual(other?.event.aggregate.revision, 1);
      }),
    ),
  );

  it.effect("returns the first entry when a dedup key repeats", () =>
    withJournal(
      Effect.gen(function* () {
        const journal = yield* EventJournal.EventJournal;
        const [first] = yield* journal.append([
          testEvent("job.finished", { dedupKey: "job-1:finished", payload: { exitCode: 0 } }),
        ]);
        const [repeat] = yield* journal.append([
          testEvent("job.finished", { dedupKey: "job-1:finished", payload: { exitCode: 1 } }),
        ]);
        assert.deepStrictEqual(repeat, first);
        const status = yield* journal.status;
        assert.strictEqual(status.retainedEntries, 1);
      }),
    ),
  );

  it.effect("rejects an oversized payload and stores nothing from that call", () =>
    withJournal(
      Effect.gen(function* () {
        const journal = yield* EventJournal.EventJournal;
        const error = yield* journal
          .append([
            testEvent("task.progress"),
            testEvent("task.progress", {
              payload: { text: "x".repeat(AUTOMATION_EVENT_MAX_PAYLOAD_BYTES) },
            }),
          ])
          .pipe(Effect.flip);
        assert.strictEqual(error.code, "INVALID_INPUT");
        assert.strictEqual((yield* journal.status).headCursor, 0);
        // Exactly at the limit is accepted.
        const fitting = "x".repeat(AUTOMATION_EVENT_MAX_PAYLOAD_BYTES - '{"text":""}'.length);
        yield* journal.append([testEvent("task.progress", { payload: { text: fitting } })]);
        assert.strictEqual((yield* journal.status).headCursor, 1);
      }),
    ),
  );

  it.effect("joins the caller's transaction and notifies only after it commits", () =>
    withJournal(
      Effect.gen(function* () {
        const journal = yield* EventJournal.EventJournal;
        const store = yield* JournalStore.JournalStore;
        const sql = yield* SqlClient.SqlClient;
        const heard = yield* Ref.make<ReadonlyArray<string>>([]);
        const subscription = yield* store.live;
        yield* Stream.fromSubscription(subscription).pipe(
          Stream.runForEach((entry) =>
            Ref.update(heard, (all) => [...all, `${entry.cursor}:${entry.event.type}`]),
          ),
          Effect.forkScoped,
        );

        // An aborted transaction leaves no row and reaches no subscriber.
        const aborted = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* journal.append([testEvent("task.failed")]);
              assert.strictEqual((yield* journal.status).headCursor, 1);
              return yield* Effect.fail("abort" as const);
            }),
          )
          .pipe(Effect.flip);
        assert.strictEqual(aborted, "abort");
        yield* store.flush;
        assert.strictEqual((yield* journal.status).retainedEntries, 0);
        assert.deepStrictEqual(yield* Ref.get(heard), []);

        // A committed one is visible to readers inside it, and to subscribers
        // only once it has committed.
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* journal.append([testEvent("task.reported")]);
            for (let turn = 0; turn < 20; turn++) yield* Effect.yieldNow;
            assert.deepStrictEqual(yield* Ref.get(heard), []);
          }),
        );
        yield* store.flush;
        assert.deepStrictEqual(yield* Ref.get(heard), ["1:task.reported"]);
      }),
    ),
  );
});

describe("EventJournal.read", () => {
  it.effect("filters by type prefix and scope, and hides administrative types by default", () =>
    withJournal(
      Effect.gen(function* () {
        const journal = yield* EventJournal.EventJournal;
        const threadA = ThreadId.make("thread-a");
        const threadB = ThreadId.make("thread-b");
        yield* journal.append([
          testEvent("task.delegated", { scope: { threadId: threadA, rootThreadId: threadA } }),
          testEvent("turn.completed", { scope: { threadId: threadA, rootThreadId: threadA } }),
          testEvent("hook.changed"),
          testEvent("task.reported", {
            scope: { threadId: threadB, parentThreadId: threadA, rootThreadId: threadA },
          }),
          testEvent("turn.completed", { scope: { threadId: threadB, rootThreadId: threadB } }),
        ]);
        const types = (filter: Parameters<typeof journal.read>[1]["filter"]) =>
          Effect.map(journal.read(testClient, { afterCursor: 0, filter }), (result) =>
            result.entries.map((entry) => `${entry.cursor}:${entry.event.type}`),
          );

        assert.deepStrictEqual(yield* types(undefined), [
          "1:task.delegated",
          "2:turn.completed",
          "4:task.reported",
          "5:turn.completed",
        ]);
        assert.deepStrictEqual(yield* types({ types: [] }), yield* types(undefined));
        assert.deepStrictEqual(yield* types({ types: ["task.*"] }), [
          "1:task.delegated",
          "4:task.reported",
        ]);
        assert.deepStrictEqual(yield* types({ types: ["hook.changed", "task.reported"] }), [
          "3:hook.changed",
          "4:task.reported",
        ]);
        assert.deepStrictEqual(yield* types({ threadIds: [threadB] }), [
          "4:task.reported",
          "5:turn.completed",
        ]);
        assert.deepStrictEqual(yield* types({ parentThreadIds: [threadA] }), ["4:task.reported"]);
        assert.deepStrictEqual(
          yield* types({ rootThreadIds: [threadA], types: ["turn.completed"] }),
          ["2:turn.completed"],
        );
        assert.deepStrictEqual(
          yield* types({ originEnvironmentIds: [EnvironmentId.make("env-elsewhere")] }),
          [],
        );

        const invalid = yield* journal
          .read(testClient, { filter: { types: ["Task *"] } })
          .pipe(Effect.flip);
        assert.strictEqual(invalid.code, "INVALID_INPUT");
      }),
    ),
  );

  it.effect("advances nextCursor past entries the filter left out", () =>
    withJournal(
      Effect.gen(function* () {
        const journal = yield* EventJournal.EventJournal;
        yield* journal.append([testEvent("turn.completed")]);
        yield* appendMany(4);
        const filter = { types: ["turn.completed"] };

        const all = yield* journal.read(testClient, { filter });
        assert.deepStrictEqual(cursorsOf(all.entries), [1]);
        assert.strictEqual(all.nextCursor, 5);
        assert.strictEqual(all.status.headCursor, 5);

        const empty = yield* journal.read(testClient, { afterCursor: 5, filter });
        assert.deepStrictEqual([empty.entries.length, empty.nextCursor], [0, 5]);

        // A full page stops at its last entry so the next read continues there.
        const paged = yield* journal.read(testClient, { afterCursor: 0, limit: 2 });
        assert.deepStrictEqual(cursorsOf(paged.entries), [1, 2]);
        assert.strictEqual(paged.nextCursor, 2);
      }),
    ),
  );
});

describe("EventJournal.subscribe", () => {
  it.effect("replays from a cursor, marks the head, then continues live", () =>
    withJournal(
      Effect.gen(function* () {
        const journal = yield* EventJournal.EventJournal;
        yield* appendMany(3);
        const live = yield* Deferred.make<void>();
        const fiber = yield* journal.subscribe(testClient, { afterCursor: 1 }).pipe(
          Stream.tap((item) =>
            item.type === "live" ? Deferred.succeed(live, undefined) : Effect.void,
          ),
          Stream.take(5),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Deferred.await(live);
        yield* appendMany(2);
        const items = yield* Fiber.join(fiber);
        assert.deepStrictEqual(
          items.map((item) => (item.type === "live" ? `live@${item.cursor}` : item.entry.cursor)),
          [2, 3, "live@3", 4, 5],
        );
      }),
    ),
  );

  it.effect("delivers an event that happened before the subscriber arrived", () =>
    withJournal(
      Effect.gen(function* () {
        const journal = yield* EventJournal.EventJournal;
        const threadId = ThreadId.make("thread-finished-early");
        const before = (yield* journal.status).headCursor;
        yield* journal.append([testEvent("turn.completed", { scope: { threadId } })]);
        yield* appendMany(2);

        const items = yield* journal
          .subscribe(testClient, {
            afterCursor: before,
            filter: { types: ["turn.completed"], threadIds: [threadId] },
          })
          .pipe(Stream.take(2), Stream.runCollect);
        assert.deepStrictEqual(cursorsOf(entriesOf(items)), [1]);
        assert.deepStrictEqual(items.at(-1), { type: "live", cursor: 3 });

        // Without a cursor a subscriber only hears what is recorded from now on.
        const onlyNew = yield* journal
          .subscribe(testClient, {})
          .pipe(Stream.take(1), Stream.runCollect);
        assert.deepStrictEqual(onlyNew, [{ type: "live", cursor: 3 }]);
      }),
    ),
  );

  it.effect("loses and repeats nothing when replay overlaps live appends", () =>
    withJournal(
      Effect.gen(function* () {
        const journal = yield* EventJournal.EventJournal;
        const historical = 600;
        const concurrent = 300;
        yield* appendMany(historical);

        const collector = yield* journal.subscribe(testClient, { afterCursor: 0 }).pipe(
          Stream.filter((item) => item.type === "entry"),
          Stream.take(historical + concurrent),
          Stream.runCollect,
          Effect.forkScoped,
        );
        const writer = yield* Effect.gen(function* () {
          for (let index = 0; index < concurrent; index++) {
            yield* journal.append([testEvent("task.progress", { payload: { index } })]);
            yield* Effect.yieldNow;
          }
        }).pipe(Effect.forkScoped);

        yield* Fiber.join(writer);
        const received = cursorsOf(entriesOf(yield* Fiber.join(collector)));
        assert.deepStrictEqual(
          received,
          Array.from({ length: historical + concurrent }, (_, index) => index + 1),
        );
      }),
    ),
  );

  it.effect("fails with CURSOR_EXPIRED rather than skipping pruned history", () =>
    withJournal(
      Effect.gen(function* () {
        const journal = yield* EventJournal.EventJournal;
        const store = yield* JournalStore.JournalStore;
        yield* appendMany(10);
        assert.strictEqual(yield* store.prune({ maxEntries: 4 }), 6);
        const status = yield* journal.status;
        assert.deepStrictEqual(
          [status.oldestCursor, status.headCursor, status.retainedEntries],
          [7, 10, 4],
        );

        const expiredRead = yield* journal.read(testClient, { afterCursor: 3 }).pipe(Effect.flip);
        assert.strictEqual(expiredRead.code, "CURSOR_EXPIRED");
        assert.strictEqual(expiredRead.detail?.oldestCursor, 7);

        const expiredStream = yield* journal
          .subscribe(testClient, { afterCursor: 0 })
          .pipe(Stream.runCollect, Effect.flip);
        assert.strictEqual(expiredStream.code, "CURSOR_EXPIRED");
        assert.strictEqual(expiredStream.detail?.oldestCursor, 7);

        // The cursor just before the oldest entry has lost nothing.
        const boundary = yield* journal.read(testClient, { afterCursor: 6 });
        assert.deepStrictEqual(cursorsOf(boundary.entries), [7, 8, 9, 10]);
        // Reading without a cursor starts at what is retained.
        const oldest = yield* journal.read(testClient, {});
        assert.deepStrictEqual(cursorsOf(oldest.entries), [7, 8, 9, 10]);
      }),
    ),
  );
});

describe("EventJournal consumers", () => {
  it.effect("resumes a named consumer from its acknowledged cursor after reconnecting", () =>
    withJournal(
      Effect.gen(function* () {
        const journal = yield* EventJournal.EventJournal;
        const consumerId = EventConsumerId.make("orchestrator-watch");
        const other = EventConsumerId.make("another-reader");
        yield* appendMany(3);

        const first = yield* journal
          .subscribe(testClient, { consumerId, afterCursor: 0 })
          .pipe(Stream.take(2), Stream.runCollect);
        assert.deepStrictEqual(cursorsOf(entriesOf(first)), [1, 2]);
        yield* journal.ackConsumer(testClient, { consumerId, cursor: 2 });
        yield* journal.ackConsumer(testClient, { consumerId: other, cursor: 1 });

        // The stream above has closed. The consumer and its position remain.
        yield* appendMany(2);
        const resumed = yield* journal
          .subscribe(testClient, { consumerId })
          .pipe(Stream.take(4), Stream.runCollect);
        assert.deepStrictEqual(
          resumed.map((item) => (item.type === "live" ? "live" : item.entry.cursor)),
          [3, 4, 5, "live"],
        );

        // A late or repeated acknowledgement never moves a consumer back.
        const stale = yield* journal.ackConsumer(testClient, { consumerId, cursor: 1 });
        assert.strictEqual(stale.cursor, 2);
        const ahead = yield* journal
          .ackConsumer(testClient, { consumerId, cursor: 99 })
          .pipe(Effect.flip);
        assert.strictEqual(ahead.code, "INVALID_INPUT");

        assert.deepStrictEqual(
          (yield* journal.listConsumers(testClient)).map((consumer) => [
            consumer.consumerId,
            consumer.cursor,
          ]),
          [
            [other, 1],
            [consumerId, 2],
          ],
        );
        assert.isTrue(yield* journal.deleteConsumer(testClient, other));
        assert.isFalse(yield* journal.deleteConsumer(testClient, other));
        assert.strictEqual((yield* journal.listConsumers(testClient)).length, 1);
      }),
    ),
  );

  it.effect("starts a new consumer at the head when no cursor is given", () =>
    withJournal(
      Effect.gen(function* () {
        const journal = yield* EventJournal.EventJournal;
        const consumerId = EventConsumerId.make("fresh");
        yield* appendMany(2);
        const items = yield* journal
          .subscribe(testClient, { consumerId })
          .pipe(Stream.take(1), Stream.runCollect);
        assert.deepStrictEqual(items, [{ type: "live", cursor: 2 }]);
        assert.strictEqual((yield* journal.listConsumers(testClient))[0]?.cursor, 2);
      }),
    ),
  );
});

describe("journal retention", () => {
  it.effect("keeps what a durable consumer or hook has not read, up to the hard cap", () =>
    withJournal(
      Effect.gen(function* () {
        const journal = yield* EventJournal.EventJournal;
        const store = yield* JournalStore.JournalStore;
        const sql = yield* SqlClient.SqlClient;
        yield* appendMany(20);
        yield* journal.ackConsumer(testClient, {
          consumerId: EventConsumerId.make("slow"),
          cursor: 5,
        });
        yield* sql`
          INSERT INTO automation_hooks
            (hook_id, revision, enabled, priority, cursor, hook_json, created_by, created_at, updated_at)
          VALUES
            ('hook-enabled', 1, 1, 0, 8, '{}', 'test', 'now', 'now'),
            ('hook-disabled', 1, 0, 0, 2, '{}', 'test', 'now', 'now')
        `;

        // The consumer at 5 holds entries 6.. back; the disabled hook holds nothing.
        assert.strictEqual(yield* store.prune({ maxEntries: 4 }), 5);
        assert.strictEqual((yield* journal.status).oldestCursor, 6);
        assert.strictEqual(yield* store.prune({ maxEntries: 4 }), 0);

        // With the consumer caught up, the enabled hook at 8 is the limit.
        yield* journal.ackConsumer(testClient, {
          consumerId: EventConsumerId.make("slow"),
          cursor: 20,
        });
        assert.strictEqual(yield* store.prune({ maxEntries: 4 }), 8);

        // Past the hard cap the laggard no longer holds the journal, and finds out.
        assert.strictEqual(yield* store.prune({ maxEntries: 4, hardMaxEntries: 6 }), 14);
        assert.strictEqual((yield* journal.status).oldestCursor, 15);
        const lagging = yield* store.assertRetained(8).pipe(Effect.flip);
        assert.strictEqual(lagging.code, "CURSOR_EXPIRED");
        assert.strictEqual(lagging.detail?.oldestCursor, 15);
      }),
    ),
  );

  it.effect("prunes by age and always keeps the newest entry", () =>
    withJournal(
      Effect.gen(function* () {
        const journal = yield* EventJournal.EventJournal;
        const store = yield* JournalStore.JournalStore;
        yield* appendMany(3);
        yield* TestClock.adjust("2 hours");
        yield* appendMany(2);
        assert.strictEqual(yield* store.prune({ maxAgeMs: 60 * 60 * 1_000 }), 3);
        assert.strictEqual((yield* journal.status).oldestCursor, 4);

        yield* TestClock.adjust("2 hours");
        assert.strictEqual(yield* store.prune({ maxAgeMs: 60 * 60 * 1_000 }), 4);
        const status = yield* journal.status;
        assert.deepStrictEqual([status.oldestCursor, status.headCursor], [5, 5]);
        // New entries continue after the kept head.
        const [next] = yield* journal.append([testEvent("task.progress")]);
        assert.strictEqual(next?.cursor, 6);
      }),
    ),
  );
});

describe("EventJournal.emit", () => {
  const emitInput = {
    idempotencyKey: IdempotencyKey.make("emit-1"),
    type: "custom.ci.build-finished",
    payload: { ok: true },
  };

  it.effect("assigns the origin itself and records the event before returning", () =>
    withJournal(
      Effect.gen(function* () {
        const journal = yield* EventJournal.EventJournal;
        const sql = yield* SqlClient.SqlClient;
        const forged = {
          ...emitInput,
          origin: { kind: "service", environmentId: "env-forged", actorId: "root" },
        };
        const result = yield* journal.emit(testClient, forged);
        assert.isTrue(result.created);
        assert.deepStrictEqual(result.entry.event.origin, {
          kind: "custom",
          actorId: "session-test",
          environmentId: TEST_ENVIRONMENT_ID,
        });
        assert.deepStrictEqual(result.entry.event.aggregate, {
          kind: "custom",
          id: "custom.ci.build-finished",
          revision: 1,
        });
        const rows = yield* sql<{ readonly event_id: string }>`
          SELECT event_id FROM automation_journal WHERE cursor = ${result.entry.cursor}
        `;
        assert.strictEqual(rows[0]?.event_id, result.entry.event.eventId);
      }),
    ),
  );

  it.effect("returns the first event again for a repeated idempotency key", () =>
    withJournal(
      Effect.gen(function* () {
        const journal = yield* EventJournal.EventJournal;
        const first = yield* journal.emit(testClient, emitInput);
        const repeat = yield* journal.emit(testClient, { ...emitInput, payload: { ok: false } });
        assert.isFalse(repeat.created);
        assert.deepStrictEqual(repeat.entry, first.entry);
        assert.strictEqual((yield* journal.status).retainedEntries, 1);
      }),
    ),
  );

  it.effect("refuses server-owned types, malformed types and peers without recording", () =>
    withJournal(
      Effect.gen(function* () {
        const journal = yield* EventJournal.EventJournal;
        const privileged = yield* journal
          .emit(testClient, { ...emitInput, type: "task.validated" })
          .pipe(Effect.flip);
        assert.strictEqual(privileged.code, "PERMISSION_DENIED");
        const malformed = yield* journal
          .emit(testClient, { ...emitInput, type: "custom.CI" })
          .pipe(Effect.flip);
        assert.strictEqual(malformed.code, "INVALID_INPUT");
        const fromPeer = yield* journal
          .emit(
            {
              kind: "peer",
              environmentId: EnvironmentId.make("env-peer"),
              subject: "peer:env-peer",
              scopes: [],
            },
            emitInput,
          )
          .pipe(Effect.flip);
        assert.strictEqual(fromPeer.code, "PERMISSION_DENIED");
        const unknownCause = yield* journal
          .emit(testClient, { ...emitInput, causationId: EventId.make("no-such-event") })
          .pipe(Effect.flip);
        assert.strictEqual(unknownCause.code, "INVALID_INPUT");
        assert.strictEqual((yield* journal.status).retainedEntries, 0);
        // A refused emit did not consume the key.
        assert.isTrue((yield* journal.emit(testClient, emitInput)).created);
      }),
    ),
  );

  it.effect("carries the hop count of the event it reacts to", () =>
    withJournal(
      Effect.gen(function* () {
        const journal = yield* EventJournal.EventJournal;
        const first = yield* journal.emit(internalCaller("worker"), emitInput);
        const reaction = yield* journal.emit(testClient, {
          ...emitInput,
          idempotencyKey: IdempotencyKey.make("emit-2"),
          causationId: first.entry.event.eventId,
        });
        assert.strictEqual(reaction.entry.event.hops, 1);
        assert.strictEqual(reaction.entry.event.correlationId, first.entry.event.correlationId);
        assert.strictEqual(reaction.entry.event.aggregate.revision, 2);
      }),
    ),
  );
});

describe("EventJournal.importPeerEntries", () => {
  it.effect("stores a forwarded entry once, under a local cursor, with its origin intact", () =>
    withJournal(
      Effect.gen(function* () {
        const journal = yield* EventJournal.EventJournal;
        yield* appendMany(2);
        const [local] = yield* journal.append([testEvent("task.reported")]);
        assert.isDefined(local);
        const peerEnvironment = EnvironmentId.make("env-peer");
        const forwarded = (originCursor: number, eventId: string): AutomationJournalEntry => ({
          cursor: originCursor,
          event: {
            ...local.event,
            eventId: EventId.make(eventId),
            origin: { kind: "service", environmentId: peerEnvironment },
            originCursor,
            hops: 3,
          },
        });

        const imported = yield* journal.importPeerEntries([
          forwarded(1, "peer-event-1"),
          forwarded(2, "peer-event-2"),
          // An entry of our own that a peer echoes back is ignored.
          local,
        ]);
        assert.deepStrictEqual(cursorsOf(imported), [4, 5]);
        assert.deepStrictEqual(
          imported.map((entry) => [entry.event.originCursor, entry.event.origin.environmentId]),
          [
            [1, peerEnvironment],
            [2, peerEnvironment],
          ],
        );
        assert.strictEqual(imported[0]?.event.hops, 3);

        const again = yield* journal.importPeerEntries([
          forwarded(2, "peer-event-2"),
          forwarded(3, "peer-event-3"),
        ]);
        assert.deepStrictEqual(cursorsOf(again), [5, 6]);
        assert.strictEqual((yield* journal.status).retainedEntries, 6);

        const fromPeer = yield* journal.read(testClient, {
          afterCursor: 0,
          filter: { originEnvironmentIds: [peerEnvironment] },
        });
        assert.deepStrictEqual(cursorsOf(fromPeer.entries), [4, 5, 6]);
      }),
    ),
  );
});
