import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  RunId,
  ThreadHandoffError,
  ThreadHandoffId,
  ThreadId,
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
type Thread = {
  readonly id: ThreadId;
  readonly activeRunId: RunId | null;
  readonly activityRunStatus: "running" | null;
};
const idle: Thread = { id: threadId, activeRunId: null, activityRunStatus: null };
const fixture = Effect.gen(function* () {
  const changes = yield* PubSub.unbounded<void>();
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
    thread: idle,
    nativeAlive: true,
  };
  const settle = Effect.gen(function* () {
    state.thread = idle;
    yield* PubSub.publish(changes, undefined);
  });
  const ports: HandoffSafePointPorts<Thread> = {
    readHandoff: () => Effect.sync(() => state.record),
    readThread: () => Effect.sync(() => Option.some(state.thread)),
    subscribe: () =>
      Effect.gen(function* () {
        calls.push("subscribe");
        return Stream.fromSubscription(yield* PubSub.subscribe(changes));
      }),
    interrupt: () =>
      Effect.gen(function* () {
        calls.push("interrupt");
        yield* settle;
      }),
    dispatchStop: () =>
      Effect.sync(() => {
        calls.push("stop-intent");
      }),
    stop: () =>
      Effect.sync(() => {
        calls.push("native-stop");
        state.nativeAlive = false;
      }),
    hasSession: () => Effect.sync(() => state.nativeAlive),
    latestSequence: () => Effect.succeed(12),
  };
  const setRunning = () => {
    state.thread = {
      id: threadId,
      activeRunId: RunId.make("run-1"),
      activityRunStatus: "running",
    };
  };
  return { ports, calls, state, setRunning, settle };
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
              yield* f.settle;
            }
            return Option.some(snapshot);
          }),
      });
      expect((yield* safe.waitForCurrentTurn({ threadId })).activeRunId).toBeNull();
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

it.effect("freeze interrupts, awaits the settled run and native stop before its snapshot", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      f.setRunning();
      const stopEntered = yield* Deferred.make<void>();
      const stopDone = yield* Deferred.make<void>();
      let finished = false;
      const safe = createHandoffSafePoint({
        ...f.ports,
        stop: () =>
          Effect.gen(function* () {
            f.calls.push("native-stop");
            yield* Deferred.succeed(stopEntered, undefined);
            yield* Deferred.await(stopDone);
            f.state.nativeAlive = false;
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
      yield* Deferred.await(stopEntered);
      expect(finished).toBe(false);
      expect(f.calls).toEqual(["subscribe", "interrupt", "stop-intent", "native-stop"]);
      yield* Deferred.succeed(stopDone, undefined);
      expect((yield* Fiber.join(freeze)).sequence).toBe(12);
      expect(finished).toBe(true);
    }),
  ),
);

it.effect("fails if native shutdown fails or a session survives the stop", () =>
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
    const safe = createHandoffSafePoint({
      ...f.ports,
      subscribe: () => Effect.succeed(Stream.empty),
    });
    expect(yield* Effect.flip(safe.waitForCurrentTurn({ threadId }))).toMatchObject({
      code: "transferFailed",
    });
    expect(f.calls).not.toContain("native-stop");
  }),
);

it.effect("idle freeze retries a deduplicated stop without requiring a new event", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const safe = createHandoffSafePoint(f.ports);
    expect((yield* safe.freeze({ threadId, mode: "idle" })).thread.activeRunId).toBeNull();
    expect((yield* safe.freeze({ threadId, mode: "idle" })).sequence).toBe(12);
    expect(f.calls.filter((call) => call === "native-stop")).toHaveLength(2);
    expect(f.calls).not.toContain("interrupt");
  }),
);
