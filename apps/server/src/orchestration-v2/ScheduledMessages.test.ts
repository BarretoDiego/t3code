import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  MiniSkillId,
  type OrchestrationV2MessageDispatchCommand,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import migration from "../persistence/Migrations/058_ScheduledMessages.ts";
import upgradeMigration from "../persistence/Migrations/062_ScheduledMessagesOrchestrationV2.ts";
import { makeScheduledMessages, threadStateFromShell } from "./ScheduledMessages.ts";

const command = (id = "schedule-1"): OrchestrationV2MessageDispatchCommand => ({
  type: "message.dispatch",
  createdBy: "user",
  creationSource: "web",
  commandId: CommandId.make(id),
  threadId: ThreadId.make("thread-1"),
  messageId: MessageId.make(id),
  text: "Run the checks",
  attachments: [],
  deliveryIntent: "auto",
  dispatchMode: { type: "start_immediately" },
  sendAt: "1970-01-01T00:01:00.000Z",
});
const database = NodeSqliteClient.layer({ filename: ":memory:" });
const ready = () => Effect.succeed("ready" as const);

it.effect("dispatches on the server clock with no view, socket, or subscriber", () =>
  Effect.gen(function* () {
    yield* migration;
    const sent = yield* Deferred.make<void>();
    const received: Array<OrchestrationV2MessageDispatchCommand> = [];
    const scheduler = yield* makeScheduledMessages({
      threadState: ready,
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
    assert.equal(received[0]?.text, "Run the checks");
    const state = yield* Stream.runCollect(Stream.take(scheduler.stream(command().threadId), 1));
    assert.deepEqual(state, [[]]);
  }).pipe(Effect.provide(database)),
);

it.effect("reloads persisted schedules and sends an overdue message after restart", () =>
  Effect.gen(function* () {
    yield* migration;
    const first = yield* makeScheduledMessages({ threadState: ready, dispatch: () => Effect.void });
    const request = command();
    yield* first.schedule(request);
    const [held] = yield* Stream.runHead(first.stream(request.threadId)).pipe(
      Effect.map((entries) => (entries._tag === "Some" ? entries.value : [])),
    );
    assert.equal(held?.sendAt, request.sendAt);
    assert.equal(held?.command.sendAt, undefined);
    yield* TestClock.adjust("2 minutes");
    const received: Array<OrchestrationV2MessageDispatchCommand> = [];
    const restarted = yield* makeScheduledMessages({
      threadState: ready,
      dispatch: (value) =>
        Effect.sync(() => {
          received.push(value);
        }),
    });
    yield* restarted.runDue;
    yield* restarted.runDue;
    assert.equal(received.length, 1);
    assert.equal(received[0]?.text, request.text);
    assert.equal(received[0]?.commandId, request.commandId);
  }).pipe(Effect.provide(database)),
);

it.effect("honors rescheduling and cancellation across clients", () =>
  Effect.gen(function* () {
    yield* migration;
    const received: string[] = [];
    const scheduler = yield* makeScheduledMessages({
      threadState: ready,
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

it.effect("waits for a busy thread and wakes on its orchestration events without a client", () =>
  Effect.gen(function* () {
    yield* migration;
    let busy = true;
    const sent = yield* Deferred.make<void>();
    const events = yield* Queue.unbounded<{ type: string; threadId: ThreadId }>();
    const scheduler = yield* makeScheduledMessages({
      threadState: () => Effect.succeed(busy ? "busy" : "ready"),
      dispatch: () => Deferred.succeed(sent, undefined),
      threadEvents: Stream.fromQueue(events),
    });
    yield* scheduler.schedule(command());
    yield* Effect.forkScoped(scheduler.start);
    yield* TestClock.adjust("1 minute");
    yield* scheduler.runDue;
    assert.isFalse(yield* Deferred.isDone(sent));
    busy = false;
    yield* Queue.offer(events, { type: "run.updated", threadId: command().threadId });
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
      threadState: () => Effect.succeed(deleted ? "deleted" : "ready"),
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
      threadState: ready,
      dispatch: () =>
        Effect.suspend(() => {
          attempts++;
          return Effect.fail(new Error("Provider unavailable"));
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

it.effect("upgrades held V1 turn starts into message dispatches", () =>
  Effect.gen(function* () {
    yield* migration;
    const sql = yield* SqlClient.SqlClient;
    const legacy = {
      type: "thread.turn.start",
      commandId: "legacy-1",
      threadId: "thread-1",
      message: { messageId: "legacy-1", role: "user", text: "Ship it", attachments: [] },
      miniSkillIds: ["skill-1"],
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: "1970-01-01T00:00:00.000Z",
      sendAt: "1970-01-01T00:01:00.000Z",
    };
    yield* sql`INSERT INTO scheduled_messages (command_id, thread_id, command_json, send_at, error)
      VALUES ('legacy-1', 'thread-1', ${JSON.stringify(legacy)}, '1970-01-01T00:01:00.000Z', NULL)`;
    yield* sql`INSERT INTO scheduled_messages (command_id, thread_id, command_json, send_at, error)
      VALUES ('broken', 'thread-1', '{"type":"thread.turn.start"}', '1970-01-01T00:01:00.000Z', NULL)`;
    yield* upgradeMigration;
    const received: Array<OrchestrationV2MessageDispatchCommand> = [];
    const scheduler = yield* makeScheduledMessages({
      threadState: ready,
      dispatch: (value) =>
        Effect.sync(() => {
          received.push(value);
        }),
    });
    yield* TestClock.adjust("1 minute");
    yield* scheduler.runDue;
    assert.equal(received.length, 1);
    assert.equal(received[0]?.type, "message.dispatch");
    assert.equal(received[0]?.text, "Ship it");
    assert.deepEqual(received[0]?.miniSkillIds, [MiniSkillId.make("skill-1")]);
    assert.deepEqual(yield* sql`SELECT command_id FROM scheduled_messages`, []);
  }).pipe(Effect.provide(database)),
);

it("treats active, queued or blocked threads as busy and archived ones as gone", () => {
  const shell = {
    status: "idle",
    activeRunId: null,
    pendingRuntimeRequest: null,
    archivedAt: null,
  };
  assert.equal(threadStateFromShell(shell), "ready");
  assert.equal(threadStateFromShell({ ...shell, status: "queued" }), "busy");
  assert.equal(threadStateFromShell({ ...shell, activeRunId: "run-1" }), "busy");
  assert.equal(threadStateFromShell({ ...shell, pendingRuntimeRequest: {} }), "busy");
  assert.equal(threadStateFromShell({ ...shell, archivedAt: new Date(0) }), "deleted");
  assert.equal(threadStateFromShell(null), "deleted");
});
