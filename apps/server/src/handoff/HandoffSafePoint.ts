import {
  CommandId,
  ThreadHandoffError,
  type ThreadHandoffRecord,
  type ThreadId,
  type OrchestrationThreadShell,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { CheckpointReactor } from "../orchestration/Services/CheckpointReactor.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProviderCommandReactor } from "../orchestration/Services/ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionService } from "../orchestration/Services/ProviderRuntimeIngestion.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { makeHandoffJournal } from "./HandoffJournal.ts";

type ThreadState = Pick<OrchestrationThreadShell, "id" | "session">;
export interface HandoffSafePointPorts<Thread extends ThreadState> {
  readonly readHandoff: (
    threadId: ThreadId,
  ) => Effect.Effect<ThreadHandoffRecord | null, ThreadHandoffError>;
  readonly readThread: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<Thread>, ThreadHandoffError>;
  readonly subscribe: Effect.Effect<Stream.Stream<OrchestrationEvent>, never, Scope.Scope>;
  readonly dispatchStop: (
    record: ThreadHandoffRecord,
  ) => Effect.Effect<{ sequence: number }, ThreadHandoffError>;
  readonly interrupt: (threadId: ThreadId) => Effect.Effect<void, ThreadHandoffError>;
  readonly stop: (threadId: ThreadId) => Effect.Effect<void, ThreadHandoffError>;
  readonly hasSession: (threadId: ThreadId) => Effect.Effect<boolean, ThreadHandoffError>;
  readonly flushDomainEvents: Effect.Effect<void, ThreadHandoffError>;
  readonly flushProviderEvents: Effect.Effect<void, ThreadHandoffError>;
  readonly drainCommands: Effect.Effect<void>;
  readonly drainIngestion: Effect.Effect<void>;
  readonly drainCheckpoints: Effect.Effect<void>;
  readonly latestSequence: Effect.Effect<number>;
}
const running = (thread: ThreadState) =>
  thread.session?.activeTurnId != null ||
  thread.session?.status === "running" ||
  thread.session?.status === "starting";
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
  const waitForCurrentTurn = Effect.fn("HandoffSafePoint.waitForCurrentTurn")(function* (input: {
    readonly threadId: ThreadId;
  }) {
    yield* requireFence(input.threadId, "preflighting");
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const events = yield* ports.subscribe;
        const thread = yield* readThread(input.threadId);
        if (!running(thread)) return thread;
        const completed = yield* events.pipe(
          Stream.filter(
            (event) => event.aggregateKind === "thread" && event.aggregateId === input.threadId,
          ),
          Stream.mapEffect(() =>
            Effect.gen(function* () {
              yield* requireFence(input.threadId, "preflighting");
              return yield* readThread(input.threadId);
            }),
          ),
          Stream.filter((current) => !running(current)),
          Stream.runHead,
        );
        if (Option.isNone(completed))
          return yield* new ThreadHandoffError({
            code: "transferFailed",
            message: "Thread event stream ended before the turn completed.",
          });
        return completed.value;
      }),
    );
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
    if (running(initialThread)) yield* ports.interrupt(input.threadId);
    yield* ports.dispatchStop(record);
    yield* ports.flushDomainEvents;
    yield* ports.drainCommands;
    // A deduplicated stop intent need not emit another session-set event.
    // Causal stream barriers plus idempotent native shutdown also cover retries.
    yield* ports.stop(input.threadId);
    yield* ports.flushProviderEvents;
    yield* ports.drainIngestion;
    yield* ports.drainCheckpoints;
    yield* ports.flushDomainEvents;
    yield* ports.drainIngestion;
    yield* ports.drainCheckpoints;
    yield* ports.drainCommands;
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
    return { thread, sequence: yield* ports.latestSequence };
  }, Effect.mapError(normalizeFailure));
  return { waitForCurrentTurn, freeze };
}

export const makeHandoffSafePoint = Effect.gen(function* () {
  const journal = yield* makeHandoffJournal;
  const engine = yield* OrchestrationEngineService;
  const query = yield* ProjectionSnapshotQuery;
  const commands = yield* ProviderCommandReactor;
  const ingestion = yield* ProviderRuntimeIngestionService;
  const checkpoints = yield* CheckpointReactor;
  const provider = yield* ProviderService;
  return createHandoffSafePoint({
    readHandoff: (threadId) => journal.head(threadId).pipe(Effect.mapError(normalizeFailure)),
    readThread: (threadId) =>
      query.getThreadShellById(threadId).pipe(Effect.mapError(normalizeFailure)),
    subscribe: engine.subscribeDomainEvents,
    dispatchStop: Effect.fn("HandoffSafePoint.dispatchStop")(function* (
      record: ThreadHandoffRecord,
    ) {
      return yield* engine.dispatch({
        type: "thread.session.stop",
        threadId: record.owner.threadId,
        commandId: CommandId.make(`${record.handoffId}-stop`),
        createdAt: DateTime.formatIso(yield* DateTime.now),
      });
    }, Effect.mapError(normalizeFailure)),
    interrupt: (threadId) =>
      provider.interruptTurn({ threadId }).pipe(Effect.mapError(normalizeFailure)),
    stop: (threadId) => provider.stopSession({ threadId }).pipe(Effect.mapError(normalizeFailure)),
    hasSession: (threadId) =>
      provider
        .listSessions()
        .pipe(Effect.map((sessions) => sessions.some((session) => session.threadId === threadId))),
    flushDomainEvents:
      engine.flushEvents ??
      Effect.fail(
        new ThreadHandoffError({
          code: "unsupported",
          message: "Domain event delivery barriers are unavailable.",
        }),
      ),
    flushProviderEvents:
      provider.flushEvents ??
      Effect.fail(
        new ThreadHandoffError({
          code: "unsupported",
          message: "Provider event delivery barriers are unavailable.",
        }),
      ),
    drainCommands: commands.drain,
    drainIngestion: ingestion.drain,
    drainCheckpoints: checkpoints.drain,
    latestSequence: engine.latestSequence,
  });
});
