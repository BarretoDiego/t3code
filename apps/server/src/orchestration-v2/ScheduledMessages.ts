import {
  OrchestrationDispatchCommandError,
  OrchestrationV2MessageDispatchCommand,
  type ScheduledMessage,
  type ScheduledMessageUpdate,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ThreadManagement from "./ThreadManagementService.ts";

const decodeCommand = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2MessageDispatchCommand),
);
const encodeCommand = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2MessageDispatchCommand),
);
const failure = (cause: unknown) =>
  new OrchestrationDispatchCommandError({
    message: "Could not update scheduled messages.",
    cause,
  });
const isDispatchError = Schema.is(OrchestrationDispatchCommandError);

/** Whether a held message may be released now, must wait, or can never be delivered. */
export type ScheduledThreadState = "ready" | "busy" | "deleted";

/**
 * Prepared turns belong to the environment, not the socket or view that
 * submitted them: they persist in SQLite, are released on the server clock
 * with no client connected, and resume (overdue first) after a restart.
 */
export const makeScheduledMessages = Effect.fnUntraced(function* <
  DispatchError,
  ThreadStateError,
  ThreadEventsError = never,
>(input: {
  /** Sends a due command. It never carries `sendAt`. */
  readonly dispatch: (
    command: OrchestrationV2MessageDispatchCommand,
  ) => Effect.Effect<unknown, DispatchError>;
  /**
   * `busy` waits for the thread's active, queued or blocked work, so the
   * message starts its own turn rather than steering someone else's.
   */
  readonly threadState: (
    threadId: ThreadId,
  ) => Effect.Effect<ScheduledThreadState, ThreadStateError>;
  /**
   * Orchestration events that may end a thread's busy state. `start` wakes the
   * worker for those touching a thread that holds a message.
   */
  readonly threadEvents?: Stream.Stream<
    { readonly type: string; readonly threadId: ThreadId },
    ThreadEventsError
  >;
}) {
  const sql = yield* SqlClient.SqlClient;
  const mutex = yield* Semaphore.make(1);
  const wake = yield* Queue.make<void>({ capacity: 1, strategy: "dropping" });
  const rows = yield* sql<{
    command_id: string;
    command_json: string;
    send_at: string;
    error: string | null;
  }>`
    SELECT command_id, command_json, send_at, error FROM scheduled_messages ORDER BY send_at, command_id
  `;
  const initial: Array<ScheduledMessage> = [];
  for (const row of rows) {
    const decoded = yield* Effect.result(decodeCommand(row.command_json));
    if (decoded._tag === "Success") {
      initial.push({ command: decoded.success, sendAt: row.send_at, error: row.error });
      continue;
    }
    // No client can render or cancel a command this build cannot read.
    yield* Effect.logWarning("Dropping unreadable scheduled message", {
      commandId: row.command_id,
      cause: decoded.failure.message,
    });
    yield* sql`DELETE FROM scheduled_messages WHERE command_id = ${row.command_id}`;
  }
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
          if (entry.error || Date.parse(entry.sendAt) > now) continue;
          const status = yield* input.threadState(entry.command.threadId);
          if (status === "deleted") {
            yield* remove(entry);
            continue;
          }
          if (status === "busy") continue;
          // Keep the row until the command receipt exists. A crash between dispatch
          // and removal replays the same command id, so the orchestrator deduplicates it.
          const { sendAt: _sendAt, ...command } = entry.command;
          const result = yield* Effect.exit(input.dispatch(command));
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
  const schedule = (command: OrchestrationV2MessageDispatchCommand) =>
    mutex
      .withPermits(1)(
        Effect.gen(function* () {
          if (!command.sendAt || (yield* input.threadState(command.threadId)) === "deleted") {
            return yield* new OrchestrationDispatchCommandError({
              message: "Cannot schedule a message for a missing or archived thread.",
            });
          }
          const entries = yield* SubscriptionRef.get(state);
          if (entries.some((entry) => entry.command.commandId === command.commandId)) return;
          const { sendAt, ...stored } = command;
          yield* save({ command: stored, sendAt, error: null });
          yield* notify;
        }),
      )
      .pipe(
        Effect.uninterruptible,
        Effect.mapError((cause) => (isDispatchError(cause) ? cause : failure(cause))),
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
            yield* save({ ...entry, sendAt });
          }
          yield* notify;
        }),
      )
      .pipe(
        Effect.uninterruptible,
        Effect.mapError((cause) => (isDispatchError(cause) ? cause : failure(cause))),
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

  const hasThread = (threadId: ThreadId) =>
    SubscriptionRef.get(state).pipe(
      Effect.map((entries) => entries.some((entry) => entry.command.threadId === threadId)),
    );

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
  // Streaming deltas never change whether a thread is busy; run, request and
  // thread lifecycle changes do.
  const observeThreads =
    input.threadEvents === undefined
      ? Effect.never
      : input.threadEvents.pipe(
          Stream.filter(
            (event) =>
              event.type.startsWith("run.") ||
              event.type.startsWith("runtime-request.") ||
              event.type.startsWith("thread."),
          ),
          Stream.runForEach((event) =>
            hasThread(event.threadId).pipe(Effect.flatMap((held) => (held ? notify : Effect.void))),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("Scheduled messages stopped observing thread events", {
              cause: Cause.pretty(cause),
            }),
          ),
          Effect.andThen(Effect.never),
        );
  const start = Effect.all([worker, observeThreads], { concurrency: 2, discard: true });
  return {
    start,
    schedule,
    cancelThread,
    update,
    notify,
    runDue,
    hasThread,
    stream: (threadId: ThreadId) =>
      SubscriptionRef.changes(state).pipe(
        Stream.map((entries) => entries.filter((entry) => entry.command.threadId === threadId)),
      ),
  };
});
export type ScheduledMessagesShape = Effect.Success<ReturnType<typeof makeScheduledMessages>>;

export class ScheduledMessages extends Context.Service<ScheduledMessages, ScheduledMessagesShape>()(
  "t3/orchestration-v2/ScheduledMessages",
) {}

const BUSY_RUN_STATUSES = new Set(["queued", "preparing", "starting", "running", "waiting"]);

/** Thread state from the V2 shell: archived or deleted threads never receive the message. */
export const threadStateFromShell = (
  shell: {
    readonly status: string;
    readonly activeRunId: unknown;
    readonly pendingRuntimeRequest: unknown;
    readonly archivedAt: unknown;
    readonly deletedAt?: unknown;
  } | null,
): ScheduledThreadState => {
  if (shell === null || shell.archivedAt !== null || (shell.deletedAt ?? null) !== null) {
    return "deleted";
  }
  return shell.activeRunId !== null ||
    shell.pendingRuntimeRequest !== null ||
    BUSY_RUN_STATUSES.has(shell.status)
    ? "busy"
    : "ready";
};

/**
 * Releases due messages through thread management, the same path a client's
 * `message.dispatch` takes after its attachments were claimed. Attachments
 * are claimed when the message is scheduled, so the stored command is final.
 * Nothing runs until `start` is forked, once the server accepts commands.
 */
export const layer: Layer.Layer<
  ScheduledMessages,
  never,
  SqlClient.SqlClient | ThreadManagement.ThreadManagementService
> = Layer.effect(
  ScheduledMessages,
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const scheduled = yield* makeScheduledMessages({
      dispatch: (command) => threads.dispatch(command),
      threadState: (threadId) =>
        threads.getThreadShell(threadId).pipe(Effect.map(threadStateFromShell)),
      threadEvents: threads.streamDomainEvents,
    }).pipe(Effect.orDie);
    return ScheduledMessages.of(scheduled);
  }),
);
