import {
  OrchestrationDispatchCommandError,
  type ScheduledMessage,
  ThreadTurnStartCommand,
  type ScheduledMessageUpdate,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import type { OrchestrationDispatchError } from "./Errors.ts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const decodeCommand = Schema.decodeUnknownEffect(Schema.fromJsonString(ThreadTurnStartCommand));
const encodeCommand = Schema.encodeEffect(Schema.fromJsonString(ThreadTurnStartCommand));
const failure = (cause: unknown) =>
  new OrchestrationDispatchCommandError({
    message: "Could not update scheduled messages.",
    cause,
  });

/** Prepared turns belong to the environment, not the socket or view that submitted them. */
export const makeScheduledMessages = Effect.fnUntraced(function* (input: {
  dispatch: (
    command: typeof ThreadTurnStartCommand.Type,
  ) => Effect.Effect<unknown, OrchestrationDispatchError>;
  threadState: (threadId: ThreadId) => "ready" | "busy" | "deleted";
  canDispatch?: (threadId: ThreadId) => Effect.Effect<boolean, OrchestrationDispatchError>;
}) {
  const sql = yield* SqlClient.SqlClient;
  const mutex = yield* Semaphore.make(1);
  const wake = yield* Queue.make<void>({ capacity: 1, strategy: "dropping" });
  const rows = yield* sql<{ command_json: string; send_at: string; error: string | null }>`
    SELECT command_json, send_at, error FROM scheduled_messages ORDER BY send_at, command_id
  `;
  const initial = yield* Effect.forEach(rows, (row) =>
    decodeCommand(row.command_json).pipe(
      Effect.map((command): ScheduledMessage => ({
        command,
        sendAt: row.send_at,
        error: row.error,
      })),
    ),
  );
  const state = yield* SubscriptionRef.make<ReadonlyArray<ScheduledMessage>>(initial);
  const notify = Queue.offer(wake, undefined).pipe(Effect.asVoid);
  const remove = Effect.fnUntraced(function* (entry: ScheduledMessage) {
    yield* sql`DELETE FROM scheduled_messages WHERE command_id = ${entry.command.commandId}`;
    yield* SubscriptionRef.update(state, (entries) =>
      entries.filter((item) => item.command.commandId !== entry.command.commandId),
    );
  });
  const save = Effect.fnUntraced(function* (entry: ScheduledMessage) {
    yield* sql`INSERT INTO scheduled_messages (command_id, thread_id, command_json, send_at, error)
      VALUES (${entry.command.commandId}, ${entry.command.threadId}, ${yield* encodeCommand(entry.command)}, ${entry.sendAt}, ${entry.error})
      ON CONFLICT(command_id) DO UPDATE SET command_json = excluded.command_json, send_at = excluded.send_at, error = excluded.error`;
    yield* SubscriptionRef.update(state, (entries) =>
      [...entries.filter((item) => item.command.commandId !== entry.command.commandId), entry].sort(
        (a, b) => Date.parse(a.sendAt) - Date.parse(b.sendAt),
      ),
    );
  });
  const runDue = mutex
    .withPermits(1)(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        for (const entry of yield* SubscriptionRef.get(state)) {
          const status = input.threadState(entry.command.threadId);
          if (status === "deleted") {
            yield* remove(entry);
            continue;
          }
          if (entry.error || status === "busy" || Date.parse(entry.sendAt) > now) continue;
          if (input.canDispatch && !(yield* input.canDispatch(entry.command.threadId))) continue;
          // Keep the row until the command receipt exists. A crash between dispatch
          // and removal replays the same command id, so the engine deduplicates it.
          const { sendAt: _sendAt, ...command } = entry.command;
          const result = yield* Effect.exit(
            input.dispatch({ ...command, createdAt: DateTime.formatIso(yield* DateTime.now) }),
          );
          if (result._tag === "Success") {
            yield* remove(entry);
          } else {
            if (Cause.hasInterruptsOnly(result.cause)) return yield* Effect.failCause(result.cause);
            yield* save({ ...entry, error: Cause.pretty(result.cause) });
          }
        }
      }),
    )
    .pipe(Effect.mapError(failure));
  const schedule = (command: typeof ThreadTurnStartCommand.Type) =>
    mutex
      .withPermits(1)(
        Effect.gen(function* () {
          if (!command.sendAt || input.threadState(command.threadId) === "deleted") {
            return yield* new OrchestrationDispatchCommandError({
              message: "Cannot schedule a message for a missing or archived thread.",
            });
          }
          const entries = yield* SubscriptionRef.get(state);
          if (entries.some((entry) => entry.command.commandId === command.commandId)) return;
          yield* save({ command, sendAt: command.sendAt, error: null });
          yield* notify;
        }),
      )
      .pipe(
        Effect.uninterruptible,
        Effect.mapError((cause) =>
          Schema.is(OrchestrationDispatchCommandError)(cause) ? cause : failure(cause),
        ),
      );
  const update = (request: ScheduledMessageUpdate) =>
    mutex
      .withPermits(1)(
        Effect.gen(function* () {
          const entry = (yield* SubscriptionRef.get(state)).find(
            (item) =>
              item.command.commandId === request.commandId &&
              item.command.threadId === request.threadId,
          );
          if (!entry) return;
          if (request.action === "cancel") {
            yield* remove(entry);
          } else {
            if (entry.error) {
              return yield* new OrchestrationDispatchCommandError({
                message: "Cancel the failed schedule and submit the message again.",
              });
            }
            const sendAt =
              request.action === "send" ? DateTime.formatIso(yield* DateTime.now) : request.sendAt;
            if (!sendAt)
              return yield* new OrchestrationDispatchCommandError({
                message: "Choose a send time.",
              });
            yield* save({ ...entry, sendAt, command: { ...entry.command, sendAt } });
          }
          yield* notify;
        }),
      )
      .pipe(
        Effect.uninterruptible,
        Effect.mapError((cause) =>
          Schema.is(OrchestrationDispatchCommandError)(cause) ? cause : failure(cause),
        ),
      );

  const cancelThread = (threadId: ThreadId) =>
    mutex
      .withPermits(1)(
        Effect.gen(function* () {
          for (const entry of yield* SubscriptionRef.get(state)) {
            if (entry.command.threadId === threadId) yield* remove(entry);
          }
          yield* notify;
        }),
      )
      .pipe(Effect.uninterruptible, Effect.mapError(failure));

  const worker = Effect.forever(
    Effect.gen(function* () {
      const succeeded = yield* runDue.pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Effect.logError("Scheduled message dispatch failed", cause).pipe(Effect.as(false)),
        ),
      );
      if (!succeeded) {
        yield* Effect.sleep("5 seconds");
        return;
      }
      const now = yield* Clock.currentTimeMillis;
      const next = (yield* SubscriptionRef.get(state))
        .filter((entry) => !entry.error && Date.parse(entry.sendAt) > now)
        .reduce((time, entry) => Math.min(time, Date.parse(entry.sendAt)), Infinity);
      // Busy threads wake on orchestration events. Future deadlines use the
      // server clock; long waits are capped to the platform's timer range.
      if (next === Infinity) yield* Queue.take(wake);
      else
        yield* Queue.take(wake).pipe(
          Effect.timeoutOption(Math.min(2_147_483_647, Math.max(1, next - now))),
        );
    }),
  );
  return {
    start: worker,
    schedule,
    cancelThread,
    update,
    notify,
    runDue,
    stream: (threadId: ThreadId) =>
      SubscriptionRef.changes(state).pipe(
        Stream.map((entries) => entries.filter((entry) => entry.command.threadId === threadId)),
      ),
  };
});
export type ScheduledMessages = Effect.Success<ReturnType<typeof makeScheduledMessages>>;
