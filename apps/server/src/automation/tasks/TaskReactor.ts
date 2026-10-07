import type { OrchestrationV2DomainEvent, ThreadId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../../serverActivation.ts";
import * as TaskEngine from "./TaskEngine.ts";

type Job =
  | { readonly type: "reconcile" }
  | { readonly type: "sync"; readonly threadId: ThreadId }
  | { readonly type: "parent-stopped"; readonly threadId: ThreadId };

/** The work a thread event asks of the task engine, if any. */
function jobsFor(event: OrchestrationV2DomainEvent): ReadonlyArray<Job> {
  switch (event.type) {
    case "run.updated":
      // Stopping a thread's turn is the user stopping that thread: its child
      // tasks follow their own policy. The thread's own task follows its run.
      return event.payload.status === "interrupted"
        ? [
            { type: "sync", threadId: event.threadId },
            { type: "parent-stopped", threadId: event.threadId },
          ]
        : [{ type: "sync", threadId: event.threadId }];
    case "runtime-request.updated":
    case "provider-session.attached":
    case "provider-session.updated":
    case "provider-session.detached":
      return [{ type: "sync", threadId: event.threadId }];
    case "thread.archived":
    case "thread.deleted":
      return [
        { type: "sync", threadId: event.threadId },
        { type: "parent-stopped", threadId: event.threadId },
      ];
    default:
      return [];
  }
}

/**
 * Keeps delegated tasks in step with the threads that carry them out. It
 * follows the orchestration event stream from the point it started, and on
 * start re-reads every unfinished task, so a child that finished while the
 * server was down is still recorded.
 */
export class DelegatedTaskReactor extends Context.Service<
  DelegatedTaskReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Resolves once every event received so far has been applied. For tests. */
    readonly drain: Effect.Effect<void>;
  }
>()("t3/automation/tasks/TaskReactor/DelegatedTaskReactor") {}

const make = Effect.gen(function* () {
  const engine = yield* TaskEngine.DelegatedTaskEngine;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const eventSink = yield* EventSink.EventSinkV2;

  const run = (job: Job) => {
    switch (job.type) {
      case "reconcile":
        return engine.reconcileAll;
      case "sync":
        return engine.syncThread(job.threadId, "live");
      case "parent-stopped":
        return engine.parentStopped(job.threadId);
    }
  };
  const worker = yield* makeDrainableWorker((job: Job) =>
    run(job).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("Delegated task reconciliation failed", { job, cause }),
      ),
    ),
  );

  const start: DelegatedTaskReactor["Service"]["start"] = Effect.fn("DelegatedTaskReactor.start")(
    function* () {
      // The stream replays from this mark, so nothing committed while the
      // reconcile below reads thread facts can fall between the two.
      const mark = yield* eventSink.latestSequence().pipe(Effect.orElseSucceed(() => 0));
      yield* worker.enqueue({ type: "reconcile" });
      yield* forkParked(
        threads.streamStoredEventsFrom({ afterSequence: mark }).pipe(
          Stream.runForEach((stored) =>
            Effect.forEach(jobsFor(stored.event), worker.enqueue, { discard: true }),
          ),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("Delegated task event stream failed", { cause }),
          ),
        ),
      );
    },
  );

  return DelegatedTaskReactor.of({ start, drain: worker.drain });
});

export const layer = Layer.effect(DelegatedTaskReactor, make);

/** Starts the reactor with the server. Add it where the other reactors start. */
export const workerLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const reactor = yield* DelegatedTaskReactor;
    yield* reactor.start();
  }),
).pipe(Layer.provide(layer));
