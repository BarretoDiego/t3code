import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { makeBarrierStream } from "./BarrierStream.ts";
import { makeDrainableWorker } from "./DrainableWorker.ts";

it.effect("a marker cannot overtake gated downstream callbacks in one buffered packet batch", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const bus = yield* makeBarrierStream<number>();
      const events = yield* bus.subscribe;
      const firstStarted = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const secondStarted = yield* Deferred.make<void>();
      const releaseSecond = yield* Deferred.make<void>();
      const flushed = yield* Deferred.make<void>();
      const delivered: number[] = [];
      yield* bus.publish(1);
      yield* bus.publish(2);
      yield* bus.flush.pipe(
        Effect.tap(() => Deferred.succeed(flushed, undefined)),
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* Stream.runForEach(events, (value) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(value === 1 ? firstStarted : secondStarted, undefined);
          yield* Deferred.await(value === 1 ? releaseFirst : releaseSecond);
          delivered.push(value);
        }),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(firstStarted);
      expect(yield* Deferred.isDone(flushed)).toBe(false);
      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Deferred.await(secondStarted);
      expect(yield* Deferred.isDone(flushed)).toBe(false);
      yield* Deferred.succeed(releaseSecond, undefined);
      yield* Deferred.await(flushed);
      expect(delivered).toEqual([1, 2]);
    }),
  ),
);

it.effect("flush delivers to worker queues and worker drain waits for processing separately", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const bus = yield* makeBarrierStream<number>();
      const events = yield* bus.subscribe;
      const release = yield* Deferred.make<void>();
      const completed: number[] = [];
      const worker = yield* makeDrainableWorker((value: number) =>
        Deferred.await(release).pipe(Effect.tap(() => Effect.sync(() => completed.push(value)))),
      );
      yield* Stream.runForEach(events, worker.enqueue).pipe(Effect.forkScoped);
      yield* bus.publish(1);
      yield* bus.publish(2);
      yield* bus.flush;
      expect(completed).toEqual([]);
      yield* Deferred.succeed(release, undefined);
      yield* worker.drain;
      expect(completed).toEqual([1, 2]);
    }),
  ),
);

it.effect(
  "closing a tracked subscription releases outstanding barriers without consuming events",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const bus = yield* makeBarrierStream<number>();
        const consumerScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
          Scope.close(scope, Exit.void),
        );
        yield* bus.subscribe.pipe(Scope.provide(consumerScope), Effect.asVoid);
        yield* bus.publish(1);
        const flushed = yield* Deferred.make<void>();
        yield* bus.flush.pipe(
          Effect.tap(() => Deferred.succeed(flushed, undefined)),
          Effect.forkScoped({ startImmediately: true }),
        );
        expect(yield* Deferred.isDone(flushed)).toBe(false);
        yield* Scope.close(consumerScope, Exit.void);
        yield* Deferred.await(flushed);
        yield* bus.flush;
      }),
    ),
);

it.effect("new subscribers and idle untracked subscribers cannot hold an earlier flush", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const bus = yield* makeBarrierStream<number>();
      const originalScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
        Scope.close(scope, Exit.void),
      );
      yield* bus.subscribe.pipe(Scope.provide(originalScope), Effect.asVoid);
      yield* bus.subscribeUntracked.pipe(Effect.asVoid);
      const flushed = yield* Deferred.make<void>();
      yield* bus.flush.pipe(
        Effect.tap(() => Deferred.succeed(flushed, undefined)),
        Effect.forkScoped({ startImmediately: true }),
      );
      const newScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
        Scope.close(scope, Exit.void),
      );
      yield* bus.subscribe.pipe(Scope.provide(newScope), Effect.asVoid);
      yield* Scope.close(originalScope, Exit.void);
      yield* Deferred.await(flushed);
      yield* Scope.close(newScope, Exit.void);
      yield* bus.flush;
    }),
  ),
);

it.effect(
  "cancelled flushes release waiters and ordinary consumers only receive original values",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const bus = yield* makeBarrierStream<number>();
        const tracked = yield* bus.subscribe;
        const untracked = yield* bus.subscribeUntracked;
        const cancelled = yield* bus.flush.pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Fiber.interrupt(cancelled);
        yield* bus.publish(3);
        const values = yield* Stream.runCollect(Stream.take(untracked, 1));
        expect(Array.from(values)).toEqual([3]);
        yield* Stream.runDrain(tracked).pipe(Effect.forkScoped);
        yield* bus.flush;
      }),
    ),
);
