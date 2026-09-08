import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

export interface BarrierStream<A> {
  readonly publish: (value: A) => Effect.Effect<void>;
  readonly stream: Stream.Stream<A>;
  readonly subscribeUntracked: Effect.Effect<Stream.Stream<A>, never, Scope.Scope>;
  readonly subscribe: Effect.Effect<Stream.Stream<A>, never, Scope.Scope>;
  /** Wait for current tracked consumers to deliver earlier events downstream.
   * Processing in a separately enqueued worker still requires worker.drain. */
  readonly flush: Effect.Effect<void>;
}

type Packet<A> =
  | { readonly kind: "event"; readonly value: A }
  | { readonly kind: "barrier"; readonly id: symbol };
interface PendingBarrier {
  readonly subscribers: Set<symbol>;
  readonly done: Deferred.Deferred<void>;
}

/** A hot stream with delivery barriers for explicitly tracked reactor consumers.
 * UI and other ordinary consumers never delay a flush. Subscribe within the
 * consumer's own scope so closing it releases outstanding delivery barriers. */
export const makeBarrierStream = <A>(): Effect.Effect<BarrierStream<A>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const pubsub = yield* Effect.acquireRelease(PubSub.unbounded<Packet<A>>(), PubSub.shutdown);
    const subscribers = new Set<symbol>();
    const pending = new Map<symbol, PendingBarrier>();

    const acknowledge = (barrierId: symbol, subscriberId: symbol) =>
      Effect.gen(function* () {
        const barrier = pending.get(barrierId);
        if (!barrier) return;
        barrier.subscribers.delete(subscriberId);
        if (barrier.subscribers.size === 0) yield* Deferred.succeed(barrier.done, undefined);
      });

    const events = (stream: Stream.Stream<Packet<A>>, subscriberId?: symbol): Stream.Stream<A> =>
      stream.pipe(
        // PubSub batches buffered packets. Split before flatMap so reaching a
        // marker cannot acknowledge ahead of downstream event callbacks.
        Stream.rechunk(1),
        Stream.flatMap((packet) =>
          packet.kind === "event"
            ? Stream.succeed(packet.value)
            : subscriberId === undefined
              ? Stream.empty
              : Stream.fromEffect(acknowledge(packet.id, subscriberId)).pipe(Stream.drain),
        ),
      );

    const subscribe = Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(pubsub);
      const subscriberId = Symbol("subscriber");
      subscribers.add(subscriberId);
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          subscribers.delete(subscriberId);
          for (const barrierId of pending.keys()) yield* acknowledge(barrierId, subscriberId);
        }),
      );
      return events(Stream.fromSubscription(subscription), subscriberId);
    }).pipe(Effect.uninterruptible);

    const flush = Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        if (subscribers.size === 0) return;
        const id = Symbol("barrier");
        const done = yield* Deferred.make<void>();
        pending.set(id, { subscribers: new Set(subscribers), done });
        yield* Effect.gen(function* () {
          yield* PubSub.publish(pubsub, { kind: "barrier", id });
          yield* restore(Deferred.await(done));
        }).pipe(Effect.ensuring(Effect.sync(() => pending.delete(id))));
      }),
    );

    return {
      publish: (value) => PubSub.publish(pubsub, { kind: "event", value }).pipe(Effect.asVoid),
      get stream() {
        return events(Stream.fromPubSub(pubsub));
      },
      subscribeUntracked: PubSub.subscribe(pubsub).pipe(
        Effect.map((subscription) => events(Stream.fromSubscription(subscription))),
      ),
      subscribe,
      flush,
    } satisfies BarrierStream<A>;
  });
