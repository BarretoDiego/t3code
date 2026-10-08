import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CommandId, ThreadId, type OrchestrationV2StoredEvent } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  attachSession,
  awaitRunPrepared,
  HARNESS_MODEL,
  HARNESS_MODEL_FLAG,
  HARNESS_PROJECT_ID,
  makeCliHarness,
  runCli,
  setLatestRunStatus,
} from "../../cli/testkit/CliHarness.ts";
import { threadCommand } from "../../cli/thread.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as SnoozeExpiry from "./SnoozeExpiry.ts";

const thread = (...args: ReadonlyArray<string>) => runCli(threadCommand, args);

const createThread = Effect.fn("test.createThread")(function* (id: string) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const threadId = ThreadId.make(id);
  yield* threads.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create:${id}`),
    threadId,
    projectId: HARNESS_PROJECT_ID,
    title: id,
    modelSelection: HARNESS_MODEL,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  return threadId;
});

const shellOf = (threadId: ThreadId) =>
  ThreadManagement.ThreadManagementService.use((threads) => threads.getThreadShell(threadId));

/** Resolves with the thread's next `thread.unsnoozed` event after `afterSequence`. */
const nextUnsnoozed = (threadId: ThreadId, afterSequence: number) =>
  ThreadManagement.ThreadManagementService.use((threads) =>
    threads.streamStoredEventsFrom({ threadId, afterSequence }).pipe(
      Stream.filter((stored) => stored.event.type === "thread.unsnoozed"),
      Stream.runHead,
    ),
  ).pipe(Effect.map((found) => (found as { value: OrchestrationV2StoredEvent }).value));

const sequenceOf = (threadId: ThreadId) =>
  ThreadManagement.ThreadManagementService.use((threads) =>
    threads.getThreadEventSequence(threadId),
  );

const start = SnoozeExpiry.SnoozeExpiry.use((expiry) => expiry.start());
const expireDue = SnoozeExpiry.SnoozeExpiry.use((expiry) => expiry.expireDue);

it.effect("wakes a thread when its snooze runs out, and not before", () =>
  Effect.gen(function* () {
    yield* start;
    const threadId = yield* createThread("snooze-live");
    yield* thread("snooze", threadId, "1h");
    const snoozedAt = yield* sequenceOf(threadId);

    yield* TestClock.adjust("59 minutes");
    assert.equal(yield* expireDue, 0);
    assert.isNotNull((yield* shellOf(threadId))?.snoozedUntil ?? null);

    yield* TestClock.adjust("1 minute");
    const woken = yield* nextUnsnoozed(threadId, snoozedAt);
    assert.isNull((yield* shellOf(threadId))?.snoozedUntil ?? null);
    // The wake is the server's own command for that deadline, recorded once.
    assert.match(woken.commandId ?? "", /^server:snooze-expired:snooze-live:\d+$/);
    yield* TestClock.adjust("1 hour");
    assert.equal(yield* expireDue, 0);
    assert.equal(yield* sequenceOf(threadId), woken.sequence);
  }).pipe(Effect.scoped, Effect.provide(makeCliHarness())),
);

it.effect("an overdue snooze is woken when the server comes back", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-snooze-restart-" });
    const database = SqlitePersistence.layerFromPath(path.join(directory, "state.sqlite")).pipe(
      Layer.provide(NodeServices.layer),
    );

    const { threadId, until, sequence } = yield* Effect.gen(function* () {
      yield* start;
      const id = yield* createThread("snooze-restart");
      yield* thread("snooze", id, "30m");
      return {
        threadId: id,
        until: (yield* shellOf(id))!.snoozedUntil!,
        sequence: yield* sequenceOf(id),
      };
    }).pipe(Effect.scoped, Effect.provide(makeCliHarness({ database })));

    // The server is down while the deadline passes.
    yield* TestClock.adjust("2 hours");

    yield* Effect.gen(function* () {
      // The deadline survived the restart, and nothing woke the thread yet.
      const persisted = (yield* shellOf(threadId))?.snoozedUntil;
      assert.equal(DateTime.toEpochMillis(persisted!), DateTime.toEpochMillis(until));
      assert.equal(yield* sequenceOf(threadId), sequence);
      yield* start;
      const woken = yield* nextUnsnoozed(threadId, sequence);
      assert.isNull((yield* shellOf(threadId))?.snoozedUntil ?? null);
      assert.equal(
        woken.commandId,
        `server:snooze-expired:${threadId}:${DateTime.toEpochMillis(until)}`,
      );
    }).pipe(Effect.scoped, Effect.provide(makeCliHarness({ database })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a snooze moved later is not woken at its old deadline", () =>
  Effect.gen(function* () {
    yield* start;
    const threadId = yield* createThread("snooze-moved");
    yield* thread("snooze", threadId, "1h");
    yield* TestClock.adjust("30 minutes");
    yield* thread("snooze", threadId, "2h");
    const moved = yield* sequenceOf(threadId);

    yield* TestClock.adjust("1 hour");
    assert.equal(yield* expireDue, 0);
    assert.isNotNull((yield* shellOf(threadId))?.snoozedUntil ?? null);
    assert.equal(yield* sequenceOf(threadId), moved);

    yield* TestClock.adjust("1 hour");
    yield* nextUnsnoozed(threadId, moved);
    assert.isNull((yield* shellOf(threadId))?.snoozedUntil ?? null);
  }).pipe(Effect.scoped, Effect.provide(makeCliHarness())),
);

it.effect("waking by hand, pinning or archiving leaves nothing for the timer", () =>
  Effect.gen(function* () {
    yield* start;
    const byHand = yield* createThread("snooze-by-hand");
    const pinned = yield* createThread("snooze-pinned");
    const archived = yield* createThread("snooze-archived");
    for (const id of [byHand, pinned, archived]) yield* thread("snooze", id, "1h");
    yield* thread("unsnooze", byHand);
    yield* thread("pin", pinned);
    yield* thread("archive", archived);
    const sequences = [
      yield* sequenceOf(byHand),
      yield* sequenceOf(pinned),
      yield* sequenceOf(archived),
    ];

    yield* TestClock.adjust("2 hours");
    assert.equal(yield* expireDue, 0);
    assert.deepEqual(
      [yield* sequenceOf(byHand), yield* sequenceOf(pinned), yield* sequenceOf(archived)],
      sequences,
    );
  }).pipe(Effect.scoped, Effect.provide(makeCliHarness())),
);

it.effect("expiry wakes a thread without touching its running agent", () =>
  Effect.gen(function* () {
    yield* start;
    const created = yield* thread(
      "new",
      "Long job",
      "--project",
      HARNESS_PROJECT_ID,
      "--model",
      HARNESS_MODEL_FLAG,
      "--json",
    );
    const threadId = ThreadId.make(created.json().threadId);
    yield* awaitRunPrepared(threadId);
    yield* attachSession(threadId);
    const run = yield* setLatestRunStatus(threadId, "running");
    yield* thread("snooze", threadId, "10m");
    const snoozed = yield* sequenceOf(threadId);
    yield* TestClock.adjust("10 minutes");
    yield* nextUnsnoozed(threadId, snoozed);

    const threads = yield* ThreadManagement.ThreadManagementService;
    const { runs, providerSessions } = yield* threads.getThreadRecords(threadId, [
      "runs",
      "providerSessions",
    ]);
    assert.equal(runs.find((entry) => entry.id === run.id)?.status, "running");
    assert.isTrue(providerSessions.every((session) => session.status === "ready"));
  }).pipe(Effect.scoped, Effect.provide(makeCliHarness())),
);

it.effect("the server refuses an expiry for a snooze that is not due", () =>
  Effect.gen(function* () {
    const threadId = yield* createThread("snooze-early");
    yield* thread("snooze", threadId, "1h");
    const threads = yield* ThreadManagement.ThreadManagementService;
    const refused = yield* threads
      .dispatch({
        type: "thread.unsnooze",
        commandId: CommandId.make("early-expiry"),
        threadId,
        reason: "expired",
      })
      .pipe(Effect.flip);
    assert.deepInclude(refused.cause as object, { code: "CONFLICT" });
    assert.isNotNull((yield* shellOf(threadId))?.snoozedUntil ?? null);
  }).pipe(Effect.scoped, Effect.provide(makeCliHarness())),
);
