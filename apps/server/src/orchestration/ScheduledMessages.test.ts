import { assert, it } from "@effect/vitest";
import { CommandId, MessageId, ThreadId, type ThreadTurnStartCommand } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import migration from "../persistence/Migrations/058_ScheduledMessages.ts";
import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { makeScheduledMessages } from "./ScheduledMessages.ts";

const command = (id = "schedule-1"): typeof ThreadTurnStartCommand.Type => ({
  type: "thread.turn.start",
  commandId: CommandId.make(id),
  threadId: ThreadId.make("thread-1"),
  message: { messageId: MessageId.make(id), role: "user", text: "Run the checks", attachments: [] },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdAt: "1970-01-01T00:00:00.000Z",
  sendAt: "1970-01-01T00:01:00.000Z",
});
const database = NodeSqliteClient.layer({ filename: ":memory:" });

it.effect("dispatches on the server clock with no view, socket, or subscriber", () =>
  Effect.gen(function* () {
    yield* migration;
    const sent = yield* Deferred.make<void>();
    const received: Array<typeof ThreadTurnStartCommand.Type> = [];
    const scheduler = yield* makeScheduledMessages({
      threadState: () => "ready",
      dispatch: (request) =>
        Effect.sync(() => received.push(request)).pipe(
          Effect.andThen(Deferred.succeed(sent, undefined)),
        ),
    });
    yield* scheduler.schedule(command());
    yield* scheduler.schedule(command());
    yield* Effect.forkScoped(scheduler.start);
    yield* TestClock.adjust("59 seconds");
    assert.equal(received.length, 0);
    yield* TestClock.adjust("1 second");
    yield* Deferred.await(sent);
    yield* scheduler.runDue;
    assert.equal(received.length, 1);
    assert.equal(received[0]?.sendAt, undefined);
    assert.equal(received[0]?.createdAt, "1970-01-01T00:01:00.000Z");
    const state = yield* Stream.runCollect(Stream.take(scheduler.stream(command().threadId), 1));
    assert.deepEqual(state, [[]]);
  }).pipe(Effect.provide(database)),
);

it.effect("reloads persisted schedules and sends an overdue message after restart", () =>
  Effect.gen(function* () {
    yield* migration;
    const first = yield* makeScheduledMessages({
      threadState: () => "ready",
      dispatch: () => Effect.void,
    });
    const request = command();
    yield* first.schedule(request);
    yield* TestClock.adjust("2 minutes");
    const received: Array<typeof ThreadTurnStartCommand.Type> = [];
    const restarted = yield* makeScheduledMessages({
      threadState: () => "ready",
      dispatch: (value) =>
        Effect.sync(() => {
          received.push(value);
        }),
    });
    yield* restarted.runDue;
    yield* restarted.runDue;
    assert.equal(received.length, 1);
    assert.equal(received[0]?.message.text, request.message.text);
    assert.equal(received[0]?.commandId, request.commandId);
  }).pipe(Effect.provide(database)),
);

it.effect("honors rescheduling and cancellation across clients", () =>
  Effect.gen(function* () {
    yield* migration;
    const received: string[] = [];
    const scheduler = yield* makeScheduledMessages({
      threadState: () => "ready",
      dispatch: (value) =>
        Effect.sync(() => {
          received.push(value.commandId);
        }),
    });
    const first = command();
    const second = command("schedule-2");
    yield* scheduler.schedule(first);
    yield* scheduler.schedule(second);
    yield* scheduler.update({ ...first, action: "reschedule", sendAt: "1970-01-01T00:02:00.000Z" });
    yield* scheduler.update({ ...second, action: "cancel" });
    yield* TestClock.adjust("1 minute");
    yield* scheduler.runDue;
    assert.deepEqual(received, []);
    yield* TestClock.adjust("1 minute");
    yield* scheduler.runDue;
    assert.deepEqual(received, [first.commandId]);
  }).pipe(Effect.provide(database)),
);

it.effect("waits for a busy thread and wakes on its completion without a client", () =>
  Effect.gen(function* () {
    yield* migration;
    let busy = true;
    const sent = yield* Deferred.make<void>();
    const scheduler = yield* makeScheduledMessages({
      threadState: () => (busy ? "busy" : "ready"),
      dispatch: () => Deferred.succeed(sent, undefined),
    });
    yield* scheduler.schedule(command());
    yield* Effect.forkScoped(scheduler.start);
    yield* TestClock.adjust("1 minute");
    yield* scheduler.runDue;
    assert.isFalse(yield* Deferred.isDone(sent));
    busy = false;
    yield* scheduler.notify;
    yield* Deferred.await(sent);
    yield* scheduler.runDue;
  }).pipe(Effect.provide(database)),
);

it.effect("send now advances the deadline and deleted threads never dispatch", () =>
  Effect.gen(function* () {
    yield* migration;
    let deleted = false;
    const received: string[] = [];
    const scheduler = yield* makeScheduledMessages({
      threadState: () => (deleted ? "deleted" : "ready"),
      dispatch: (value) =>
        Effect.sync(() => {
          received.push(value.commandId);
        }),
    });
    yield* scheduler.schedule(command());
    yield* scheduler.update({ ...command(), action: "send" });
    yield* scheduler.runDue;
    yield* scheduler.schedule(command("second"));
    deleted = true;
    yield* TestClock.adjust("1 minute");
    yield* scheduler.runDue;
    assert.deepEqual(received, [command().commandId]);
    assert.deepEqual(
      yield* Stream.runCollect(Stream.take(scheduler.stream(command().threadId), 1)),
      [[]],
    );
  }).pipe(Effect.provide(database)),
);

it.effect("retains dispatch failures for inspection instead of repeatedly resending", () =>
  Effect.gen(function* () {
    yield* migration;
    let attempts = 0;
    const scheduler = yield* makeScheduledMessages({
      threadState: () => "ready",
      dispatch: () =>
        Effect.suspend(() => {
          attempts++;
          return Effect.fail(
            new OrchestrationCommandInvariantError({
              commandType: "thread.turn.start",
              detail: "Provider unavailable",
            }),
          );
        }),
    });
    yield* scheduler.schedule(command());
    yield* TestClock.adjust("1 minute");
    yield* scheduler.runDue;
    yield* scheduler.runDue;
    assert.equal(attempts, 1);
    const snapshots = yield* Stream.runCollect(
      Stream.take(scheduler.stream(command().threadId), 1),
    );
    assert.include(snapshots[0]?.[0]?.error, "Provider unavailable");
  }).pipe(Effect.provide(database)),
);
