import {
  CommandId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import { forkParked } from "../../serverActivation.ts";

/** The thread snapshot an organization event carries, when it carries one. */
function organizedThread(event: OrchestrationV2DomainEvent): OrchestrationV2AppThread | null {
  switch (event.type) {
    case "thread.created":
    case "thread.archived":
    case "thread.unarchived":
    case "thread.settled":
    case "thread.unsettled":
    case "thread.snoozed":
    case "thread.unsnoozed":
    case "thread.pinned":
    case "thread.metadata-updated":
      return event.payload;
    default:
      return null;
  }
}

/**
 * Makes a snooze's end a server fact. A snooze only hides a thread until a
 * time: it does not pause its agent, mute its notifications, or drop anything.
 * When the time passes this wakes the thread with `thread.unsnooze` (reason
 * `expired`), which records `thread.unsnoozed` like any other wake.
 *
 * Deadlines live on the thread projection. This keeps only an index of them,
 * rebuilt from the projection on start, so a snooze that ran out while the
 * server was down is woken as soon as it is back.
 */
export class SnoozeExpiry extends Context.Service<
  SnoozeExpiry,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Wakes every thread whose deadline has passed and returns how many. */
    readonly expireDue: Effect.Effect<number>;
  }
>()("t3/automation/tasks/SnoozeExpiry") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const eventSink = yield* EventSink.EventSinkV2;
  const scheduler = yield* Scheduler.Scheduler;
  // Wake time, in epoch milliseconds, of each snoozed thread that is not archived.
  const deadlines = yield* Ref.make(new Map<ThreadId, number>());

  const track = (thread: {
    readonly id: ThreadId;
    readonly snoozedUntil?: DateTime.Utc | null | undefined;
    readonly archivedAt: DateTime.Utc | null;
    readonly deletedAt?: DateTime.Utc | null | undefined;
  }) =>
    Ref.update(deadlines, (current) => {
      const next = new Map(current);
      if (thread.snoozedUntil == null || thread.archivedAt !== null || thread.deletedAt != null) {
        next.delete(thread.id);
      } else {
        next.set(thread.id, DateTime.toEpochMillis(thread.snoozedUntil));
      }
      return next;
    });

  const expireDue: SnoozeExpiry["Service"]["expireDue"] = Effect.gen(function* () {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const due = [...(yield* Ref.get(deadlines))].filter(([, wakeAt]) => wakeAt <= now);
    yield* Effect.forEach(
      due,
      ([threadId, wakeAt]) =>
        threads
          .dispatch({
            type: "thread.unsnooze",
            // One command per deadline: a retry replays it, and a thread
            // snoozed again gets a new one for its new deadline.
            commandId: CommandId.make(`server:snooze-expired:${threadId}:${wakeAt}`),
            threadId,
            reason: "expired",
          })
          .pipe(
            // Refused means the snooze is no longer due (woken, moved, or the
            // thread is gone). Either way this deadline is finished.
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.interrupt
                : Effect.logDebug("Snooze expiry skipped", { threadId, cause }),
            ),
            Effect.andThen(
              Ref.update(deadlines, (current) => {
                if (current.get(threadId) !== wakeAt) return current;
                const next = new Map(current);
                next.delete(threadId);
                return next;
              }),
            ),
          ),
      { discard: true },
    );
    return due.length;
  });

  const start: SnoozeExpiry["Service"]["start"] = Effect.fn("SnoozeExpiry.start")(function* () {
    // Events after this mark are replayed over the snapshot read below, so a
    // snooze set in between is never lost and never overwritten by older state.
    const mark = yield* eventSink.latestSequence().pipe(Effect.orElseSucceed(() => 0));
    const snapshot = yield* threads
      .getShellSnapshot({ location: "active" })
      .pipe(Effect.orElseSucceed(() => ({ threads: [] })));
    yield* Effect.forEach(snapshot.threads, track, { discard: true });
    yield* forkParked(
      threads.streamStoredEventsFrom({ afterSequence: mark }).pipe(
        Stream.runForEach(({ event }) => {
          if (event.type === "thread.deleted") {
            return Ref.update(deadlines, (current) => {
              const next = new Map(current);
              next.delete(event.threadId);
              return next;
            });
          }
          const thread = organizedThread(event);
          return thread === null ? Effect.void : track(thread);
        }),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("Snooze expiry event stream failed", { cause }),
        ),
      ),
    );
    // Runs once now, which wakes whatever ran out while the server was down,
    // then on the scheduler's clock.
    yield* scheduler.register("thread-snooze-expiry", expireDue);
  });

  return SnoozeExpiry.of({ start, expireDue });
});

export const layer = Layer.effect(SnoozeExpiry, make);

/** Starts snooze expiry with the server. Add it where the other reactors start. */
export const workerLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const expiry = yield* SnoozeExpiry;
    yield* expiry.start();
  }),
).pipe(Layer.provide(layer));
