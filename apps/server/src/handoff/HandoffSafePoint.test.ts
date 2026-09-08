import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  ThreadHandoffError,
  ThreadHandoffId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationSession,
  type ThreadHandoffRecord,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { createHandoffSafePoint, type HandoffSafePointPorts } from "./HandoffSafePoint.ts";

const threadId = ThreadId.make("safe-point-thread");
const now = "2026-09-08T12:00:00.000Z";
const stopped: OrchestrationSession = {
  threadId,
  status: "stopped",
  providerName: "claudeAgent",
  runtimeMode: "full-access",
  activeTurnId: null,
  lastError: null,
  updatedAt: now,
};
type Thread = { readonly id: ThreadId; readonly session: OrchestrationSession };
const fixture = Effect.gen(function* () {
  const events = yield* PubSub.unbounded<OrchestrationEvent>();
  const calls: string[] = [];
  const state: { record: ThreadHandoffRecord; thread: Thread; nativeAlive: boolean } = {
    record: {
      handoffId: ThreadHandoffId.make("safe-point"),
      owner: { threadId, environmentId: EnvironmentId.make("source"), generation: 0 },
      destinationEnvironmentId: EnvironmentId.make("target"),
      phase: "pausing",
      revision: 1,
      createdAt: now,
      updatedAt: now,
      failure: null,
    },
    thread: { id: threadId, session: stopped },
    nativeAlive: true,
  };
  const publishStopped = PubSub.publish(events, {
    type: "thread.session-set",
    sequence: 12,
    eventId: EventId.make("stopped"),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: now,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: { threadId, session: stopped },
  });
  const ports: HandoffSafePointPorts<Thread> = {
    readHandoff: () => Effect.sync(() => state.record),
    readThread: () => Effect.sync(() => Option.some(state.thread)),
    subscribe: Effect.gen(function* () {
      calls.push("subscribe");
      return Stream.fromSubscription(yield* PubSub.subscribe(events));
    }),
    dispatchStop: () =>
      Effect.gen(function* () {
        calls.push("stop-intent");
        state.thread = { id: threadId, session: stopped };
        yield* publishStopped;
        return { sequence: 11 };
      }),
    interrupt: () =>
      Effect.sync(() => {
        calls.push("interrupt");
      }),
    stop: () =>
      Effect.sync(() => {
        calls.push("native-stop");
        state.nativeAlive = false;
      }),
    hasSession: () => Effect.sync(() => state.nativeAlive),
    flushDomainEvents: Effect.sync(() => {
      calls.push("flush-domain");
    }),
    flushProviderEvents: Effect.sync(() => {
      calls.push("flush-provider");
    }),
    drainCommands: Effect.sync(() => {
      calls.push("commands");
    }),
    drainIngestion: Effect.sync(() => {
      calls.push("ingestion");
    }),
    drainCheckpoints: Effect.sync(() => {
      calls.push("checkpoints");
    }),
    latestSequence: Effect.succeed(12),
  };
  const setRunning = () => {
    state.thread = {
      id: threadId,
      session: { ...stopped, status: "running", activeTurnId: TurnId.make("turn") },
    };
  };
  return { ports, calls, state, setRunning, publishStopped };
});

it.effect(
  "waits while preflighting and captures completion between subscription and initial snapshot",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.state.record = { ...f.state.record, phase: "preflighting", revision: 0 };
      f.setRunning();
      let firstRead = true;
      const safe = createHandoffSafePoint({
        ...f.ports,
        readThread: () =>
          Effect.gen(function* () {
            const snapshot = f.state.thread;
            if (firstRead) {
              expect(f.calls).toEqual(["subscribe"]);
              expect(f.state.record.phase).toBe("preflighting");
              firstRead = false;
              f.state.thread = { id: threadId, session: stopped };
              yield* f.publishStopped;
            }
            return Option.some(snapshot);
          }),
      });
      expect((yield* safe.waitForCurrentTurn({ threadId })).session.status).toBe("stopped");
      expect(f.calls).toEqual(["subscribe"]);
      expect(f.state.record.phase).toBe("preflighting");
    }),
);

it.effect("wait rejects an already paused source instead of blocking approval replies", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.setRunning();
    expect(
      yield* Effect.flip(createHandoffSafePoint(f.ports).waitForCurrentTurn({ threadId })),
    ).toMatchObject({ code: "notOwner" });
    expect(f.calls).toEqual([]);
  }),
);

it.effect("idle mode rejects active work without interrupting or stopping the provider", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.setRunning();
    expect(
      yield* Effect.flip(createHandoffSafePoint(f.ports).freeze({ threadId, mode: "idle" })),
    ).toMatchObject({ code: "busy" });
    expect(f.calls).toEqual([]);
    expect(f.state.nativeAlive).toBe(true);
  }),
);

it.effect(
  "freeze awaits native stop and all downstream workers before returning its snapshot",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        f.setRunning();
        const checkpointEntered = yield* Deferred.make<void>();
        const checkpointDone = yield* Deferred.make<void>();
        let finished = false;
        const safe = createHandoffSafePoint({
          ...f.ports,
          drainCheckpoints: Effect.gen(function* () {
            f.calls.push("checkpoints");
            yield* Deferred.succeed(checkpointEntered, undefined);
            yield* Deferred.await(checkpointDone);
          }),
        });
        const freeze = yield* safe.freeze({ threadId, mode: "interrupt" }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              finished = true;
            }),
          ),
          Effect.forkScoped,
        );
        yield* Deferred.await(checkpointEntered);
        expect(finished).toBe(false);
        expect(f.state.nativeAlive).toBe(false);
        expect(f.calls).toEqual([
          "interrupt",
          "stop-intent",
          "flush-domain",
          "commands",
          "native-stop",
          "flush-provider",
          "ingestion",
          "checkpoints",
        ]);
        yield* Deferred.succeed(checkpointDone, undefined);
        expect((yield* Fiber.join(freeze)).sequence).toBe(12);
        expect(f.calls.slice(-4)).toEqual(["flush-domain", "ingestion", "checkpoints", "commands"]);
        expect(finished).toBe(true);
      }),
    ),
);

it.effect("fails if native shutdown fails or a session survives all worker drains", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const failedStop = createHandoffSafePoint({
      ...f.ports,
      stop: () =>
        Effect.fail(
          new ThreadHandoffError({ code: "transferFailed", message: "Native shutdown failed" }),
        ),
    });
    expect(yield* Effect.flip(failedStop.freeze({ threadId, mode: "idle" }))).toMatchObject({
      code: "transferFailed",
      message: "Native shutdown failed",
    });
    expect(f.calls).not.toContain("checkpoints");
    const alive = createHandoffSafePoint({ ...f.ports, hasSession: () => Effect.succeed(true) });
    expect(yield* Effect.flip(alive.freeze({ threadId, mode: "idle" }))).toMatchObject({
      code: "busy",
    });
  }),
);

it.effect("a closed completion stream is a failure rather than permission to snapshot", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.state.record = { ...f.state.record, phase: "preflighting", revision: 0 };
    f.setRunning();
    const safe = createHandoffSafePoint({ ...f.ports, subscribe: Effect.succeed(Stream.empty) });
    expect(yield* Effect.flip(safe.waitForCurrentTurn({ threadId }))).toMatchObject({
      code: "transferFailed",
    });
    expect(f.calls).not.toContain("native-stop");
  }),
);

it.effect("does not drain unseen provider work until the delivery barrier acknowledges", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const delivered = yield* Deferred.make<void>();
      const entered = yield* Deferred.make<void>();
      const safe = createHandoffSafePoint({
        ...f.ports,
        flushProviderEvents: Effect.gen(function* () {
          f.calls.push("flush-provider");
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(delivered);
        }),
      });
      const pending = yield* safe.freeze({ threadId, mode: "idle" }).pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      expect(f.calls).not.toContain("ingestion");
      expect(f.calls).not.toContain("checkpoints");
      yield* Deferred.succeed(delivered, undefined);
      expect((yield* Fiber.join(pending)).sequence).toBe(12);
    }),
  ),
);

it.effect("idle freeze retries a deduplicated stop receipt without requiring a new event", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const safe = createHandoffSafePoint({
      ...f.ports,
      dispatchStop: () => Effect.succeed({ sequence: 11 }),
    });
    expect((yield* safe.freeze({ threadId, mode: "idle" })).thread.session.status).toBe("stopped");
    expect((yield* safe.freeze({ threadId, mode: "idle" })).sequence).toBe(12);
    expect(f.calls.filter((call) => call === "native-stop")).toHaveLength(2);
    expect(f.calls).not.toContain("interrupt");
  }),
);
