import { assert, describe, it } from "@effect/vitest";
import { type AutomationJournalEntry } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as EventJournal from "../EventJournal.ts";
import {
  makeChildThread,
  makeRequest,
  makeRun,
  makeThread,
  PROJECT_ID,
  requestEvent,
  runEvent,
  threadEvent,
} from "./domainEvents.testkit.ts";
import { testClient, testEnvironmentLayer } from "./journal.testkit.ts";
import * as JournalStore from "./JournalStore.ts";

const makeLayer = () =>
  EventSink.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(EventStore.layer, ProjectionStore.layer)),
    Layer.provideMerge(EventJournal.layer),
    Layer.provideMerge(Layer.fresh(SqlitePersistenceMemory)),
    Layer.provide(testEnvironmentLayer),
  );

const journalEntries = Effect.gen(function* () {
  const journal = yield* EventJournal.EventJournal;
  return (yield* journal.read(testClient, { afterCursor: 0 })).entries;
});

const summary = (entries: ReadonlyArray<AutomationJournalEntry>) =>
  entries.map((entry) => `${entry.event.type}@${entry.event.scope.threadId}`);

describe("domain events in the journal", () => {
  it.effect("records one public event per actionable fact, across separate commits", () =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const parent = makeThread("thread-parent");
      const child = makeChildThread("thread-child", parent);

      yield* sink.write({ events: [threadEvent("thread.created", parent)] });
      yield* sink.write({ events: [threadEvent("thread.created", child)] });
      yield* sink.write({ events: [runEvent("run.created", makeRun("run-1", child, "queued"))] });
      yield* sink.write({ events: [runEvent("run.updated", makeRun("run-1", child, "running"))] });
      // The provider restates the run while it streams.
      yield* sink.write({ events: [runEvent("run.updated", makeRun("run-1", child, "running"))] });
      yield* sink.write({
        events: [requestEvent(child, makeRequest("request-1", "pending"), "run-1")],
      });
      yield* sink.write({
        events: [requestEvent(child, makeRequest("request-1", "pending"), "run-1")],
      });
      yield* sink.write({
        events: [
          requestEvent(child, makeRequest("request-1", "resolved", { decision: "accept" })),
          runEvent("run.updated", makeRun("run-1", child, "completed")),
        ],
      });
      yield* sink.write({
        events: [runEvent("run.updated", makeRun("run-1", child, "completed"))],
      });
      yield* sink.write({ events: [threadEvent("thread.settled", child)] });
      yield* sink.write({ events: [threadEvent("thread.visited", child)] });

      const entries = yield* journalEntries;
      assert.deepStrictEqual(summary(entries), [
        "thread.created@thread-parent",
        "thread.created@thread-child",
        "turn.started@thread-child",
        "request.opened@thread-child",
        "request.resolved@thread-child",
        "turn.completed@thread-child",
        "thread.organized@thread-child",
      ]);

      // Scope comes from the stored thread, not from the run event.
      const completed = entries.find((entry) => entry.event.type === "turn.completed");
      assert.deepStrictEqual(completed?.event.scope, {
        threadId: child.id,
        projectId: PROJECT_ID,
        parentThreadId: parent.id,
        rootThreadId: parent.id,
        runId: makeRun("run-1", child, "completed").id,
      });
      // The thread's events share one aggregate, so their revisions count up.
      assert.deepStrictEqual(
        entries
          .filter((entry) => entry.event.aggregate.id === child.id)
          .map((entry) => entry.event.aggregate.revision),
        [1, 2, 3, 4],
      );
      assert.strictEqual(completed?.event.origin.kind, "service");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("commits the journal entry with the domain event, or not at all", () =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const store = yield* JournalStore.JournalStore;
      const sql = yield* SqlClient.SqlClient;
      const heard = yield* Ref.make<ReadonlyArray<string>>([]);
      const subscription = yield* store.live;
      yield* Stream.fromSubscription(subscription).pipe(
        Stream.runForEach((entry) => Ref.update(heard, (all) => [...all, entry.event.type])),
        Effect.forkScoped,
      );
      const counts = Effect.gen(function* () {
        const rows = yield* sql<{ readonly events: number; readonly journal: number }>`
          SELECT
            (SELECT COUNT(*) FROM orchestration_events) AS events,
            (SELECT COUNT(*) FROM automation_journal) AS journal
        `;
        return [rows[0]?.events, rows[0]?.journal];
      });

      const thread = makeThread("thread-atomic");
      const aborted = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sink.write({ events: [threadEvent("thread.created", thread)] });
            assert.deepStrictEqual(yield* counts, [1, 1]);
            return yield* Effect.fail("abort" as const);
          }),
        )
        .pipe(Effect.flip);
      assert.strictEqual(aborted, "abort");
      yield* store.flush;
      assert.deepStrictEqual(yield* counts, [0, 0]);
      assert.deepStrictEqual(yield* Ref.get(heard), []);

      yield* sink.write({ events: [threadEvent("thread.created", thread)] });
      yield* sink.write({ events: [threadEvent("thread.archived", thread)] });
      yield* store.flush;
      assert.deepStrictEqual(yield* counts, [2, 2]);
      assert.deepStrictEqual(yield* Ref.get(heard), ["thread.created", "thread.organized"]);
    }).pipe(Effect.provide(makeLayer()), Effect.scoped),
  );

  it.effect("leaves a sink built without the journal working as before", () =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const sql = yield* SqlClient.SqlClient;
      const stored = yield* sink.write({
        events: [threadEvent("thread.created", makeThread("thread-plain"))],
      });
      assert.strictEqual(stored.length, 1);
      const rows = yield* sql<{ readonly journal: number }>`
        SELECT COUNT(*) AS journal FROM automation_journal
      `;
      assert.strictEqual(rows[0]?.journal, 0);
    }).pipe(
      Effect.provide(
        EventSink.layer.pipe(
          Layer.provideMerge(Layer.mergeAll(EventStore.layer, ProjectionStore.layer)),
          Layer.provideMerge(Layer.fresh(SqlitePersistenceMemory)),
        ),
      ),
    ),
  );
});
