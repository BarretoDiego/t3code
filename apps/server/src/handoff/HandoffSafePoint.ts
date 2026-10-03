import {
  CommandId,
  ThreadHandoffError,
  type OrchestrationV2ThreadShell,
  type ProviderSessionId,
  type ThreadHandoffRecord,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import { makeHandoffJournal } from "./HandoffJournal.ts";

type ThreadState = Pick<OrchestrationV2ThreadShell, "id" | "activeRunId" | "activityRunStatus">;
export interface HandoffSafePointPorts<Thread extends ThreadState> {
  readonly readHandoff: (
    threadId: ThreadId,
  ) => Effect.Effect<ThreadHandoffRecord | null, ThreadHandoffError>;
  readonly readThread: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<Thread>, ThreadHandoffError>;
  /** Every later change to the thread, without a gap after subscribing. */
  readonly subscribe: (
    threadId: ThreadId,
  ) => Effect.Effect<Stream.Stream<unknown, ThreadHandoffError>, ThreadHandoffError, Scope.Scope>;
  /** Asks the active run to stop; completion arrives as thread changes. */
  readonly interrupt: (
    record: ThreadHandoffRecord,
    thread: Thread,
  ) => Effect.Effect<void, ThreadHandoffError>;
  /** Records the provider session detach in the thread's history. */
  readonly dispatchStop: (record: ThreadHandoffRecord) => Effect.Effect<void, ThreadHandoffError>;
  /** Shuts the thread's native provider processes down and waits for them. */
  readonly stop: (threadId: ThreadId) => Effect.Effect<void, ThreadHandoffError>;
  readonly hasSession: (threadId: ThreadId) => Effect.Effect<boolean, ThreadHandoffError>;
  readonly latestSequence: (threadId: ThreadId) => Effect.Effect<number, ThreadHandoffError>;
}
const ACTIVE_RUN_STATUSES: ReadonlySet<string> = new Set([
  "preparing",
  "starting",
  "running",
  "waiting",
]);
const running = (thread: ThreadState) =>
  thread.activeRunId !== null ||
  (thread.activityRunStatus != null && ACTIVE_RUN_STATUSES.has(thread.activityRunStatus));
const isHandoffError = Schema.is(ThreadHandoffError);
const normalizeFailure = (cause: unknown) =>
  isHandoffError(cause)
    ? cause
    : new ThreadHandoffError({
        code: "transferFailed",
        message:
          cause instanceof Error ? cause.message : "Failed to establish a provider safe point.",
      });

/** Waiting leaves the journal in preflighting, so approvals and user replies
 * remain usable. Only an idle/interrupt freeze runs under the pausing fence. */
export function createHandoffSafePoint<Thread extends ThreadState>(
  ports: HandoffSafePointPorts<Thread>,
) {
  const readThread = Effect.fn("HandoffSafePoint.readThread")(function* (threadId: ThreadId) {
    const thread = Option.getOrUndefined(yield* ports.readThread(threadId));
    if (!thread)
      return yield* new ThreadHandoffError({
        code: "conflict",
        message: "Thread no longer exists.",
      });
    return thread;
  });
  const requireFence = Effect.fn("HandoffSafePoint.requireFence")(function* (
    threadId: ThreadId,
    phase: "preflighting" | "pausing",
  ) {
    const record = yield* ports.readHandoff(threadId);
    if (
      !record ||
      record.phase !== phase ||
      (record.localEnvironmentId ?? record.owner.environmentId) !== record.owner.environmentId
    )
      return yield* new ThreadHandoffError({
        code: "notOwner",
        message: `A source ${phase} fence is required.`,
      });
    return record;
  });
  /** Subscribes before reading, so a run settling in between is still seen. */
  const untilSettled = (
    threadId: ThreadId,
    phase: "preflighting" | "pausing",
    onRunning: (thread: Thread) => Effect.Effect<void, ThreadHandoffError> = () => Effect.void,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const changes = yield* ports.subscribe(threadId);
        const thread = yield* readThread(threadId);
        if (!running(thread)) return thread;
        yield* onRunning(thread);
        const settled = yield* changes.pipe(
          Stream.mapEffect(() =>
            Effect.gen(function* () {
              yield* requireFence(threadId, phase);
              return yield* readThread(threadId);
            }),
          ),
          Stream.filter((current) => !running(current)),
          Stream.runHead,
        );
        if (Option.isNone(settled))
          return yield* new ThreadHandoffError({
            code: "transferFailed",
            message: "Thread event stream ended before the turn completed.",
          });
        return settled.value;
      }),
    );
  const waitForCurrentTurn = Effect.fn("HandoffSafePoint.waitForCurrentTurn")(function* (input: {
    readonly threadId: ThreadId;
  }) {
    yield* requireFence(input.threadId, "preflighting");
    return yield* untilSettled(input.threadId, "preflighting");
  }, Effect.mapError(normalizeFailure));

  const freeze = Effect.fn("HandoffSafePoint.freeze")(function* (input: {
    readonly threadId: ThreadId;
    readonly mode: "idle" | "interrupt";
  }) {
    const record = yield* requireFence(input.threadId, "pausing");
    const initialThread = yield* readThread(input.threadId);
    if (running(initialThread) && input.mode === "idle")
      return yield* new ThreadHandoffError({
        code: "busy",
        message: "The agent is running. Finish the turn or choose stop and transfer.",
      });
    if (running(initialThread))
      yield* untilSettled(input.threadId, "pausing", (thread) => ports.interrupt(record, thread));
    // A deduplicated stop intent need not emit another event; native shutdown
    // is idempotent, so retries converge on the same stopped state.
    yield* ports.dispatchStop(record);
    yield* ports.stop(input.threadId);
    if (yield* ports.hasSession(input.threadId))
      return yield* new ThreadHandoffError({
        code: "busy",
        message: "Provider session did not stop; source remains fenced.",
      });
    const thread = yield* readThread(input.threadId);
    if (running(thread))
      return yield* new ThreadHandoffError({
        code: "busy",
        message: "Thread work has not settled; source remains fenced.",
      });
    yield* requireFence(input.threadId, "pausing");
    return { thread, sequence: yield* ports.latestSequence(input.threadId) };
  }, Effect.mapError(normalizeFailure));
  return { waitForCurrentTurn, freeze };
}

/** Provider sessions recorded on the thread; detached ones are skipped by the manager. */
const threadSessionIds = (
  projections: ProjectionStore.ProjectionStoreV2["Service"],
  threadId: ThreadId,
) =>
  projections
    .getThreadRecords(threadId, ["providerSessions"])
    .pipe(
      Effect.map((records) =>
        records.providerSessions.map((session): ProviderSessionId => session.id),
      ),
    );

export const makeHandoffSafePoint = Effect.gen(function* () {
  const journal = yield* makeHandoffJournal;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  return createHandoffSafePoint({
    readHandoff: (threadId) => journal.head(threadId).pipe(Effect.mapError(normalizeFailure)),
    readThread: (threadId) =>
      projections
        .getThreadShell(threadId)
        .pipe(Effect.map(Option.fromNullishOr), Effect.mapError(normalizeFailure)),
    subscribe: (threadId) =>
      eventSink.latestSequence({ threadId }).pipe(
        Effect.map((afterSequence) =>
          eventSink.stream({ threadId, afterSequence }).pipe(Stream.mapError(normalizeFailure)),
        ),
        Effect.mapError(normalizeFailure),
      ),
    interrupt: Effect.fn("HandoffSafePoint.interrupt")(function* (record, thread) {
      const runId = thread.activeRunId ?? thread.latestRunId;
      if (runId === null) return;
      yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make(`${record.handoffId}:interrupt:${runId}`),
        threadId: record.owner.threadId,
        runId,
        reason: "Thread is transferring to another environment.",
        holdQueue: true,
      });
    }, Effect.mapError(normalizeFailure)),
    dispatchStop: Effect.fn("HandoffSafePoint.dispatchStop")(function* (
      record: ThreadHandoffRecord,
    ) {
      for (const providerSessionId of yield* threadSessionIds(projections, record.owner.threadId)) {
        yield* orchestrator.dispatch({
          type: "provider-session.detach",
          commandId: CommandId.make(`${record.handoffId}:detach:${providerSessionId}`),
          threadId: record.owner.threadId,
          providerSessionId,
          reason: "Thread is transferring to another environment.",
        });
      }
    }, Effect.mapError(normalizeFailure)),
    stop: Effect.fn("HandoffSafePoint.stop")(function* (threadId: ThreadId) {
      for (const providerSessionId of yield* threadSessionIds(projections, threadId))
        yield* sessions.detach({
          providerSessionId,
          threadId,
          detail: "Thread is transferring to another environment.",
        });
    }, Effect.mapError(normalizeFailure)),
    hasSession: Effect.fn("HandoffSafePoint.hasSession")(function* (threadId: ThreadId) {
      for (const providerSessionId of yield* threadSessionIds(projections, threadId)) {
        const runtime = Option.getOrUndefined(yield* sessions.get(providerSessionId));
        // A shared runtime keeps serving other threads after this one detaches.
        if (
          runtime &&
          !runtime.providerSession.capabilities.sessions.supportsMultipleProviderThreadsPerSession
        )
          return true;
      }
      return false;
    }, Effect.mapError(normalizeFailure)),
    latestSequence: (threadId) =>
      orchestrator.getThreadEventSequence(threadId).pipe(Effect.mapError(normalizeFailure)),
  });
});
