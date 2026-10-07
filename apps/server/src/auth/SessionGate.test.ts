import { AuthSessionId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { makeSessionGate } from "./SessionGate.ts";
import type { SessionCredentialChange } from "./SessionStore.ts";

const sessionId = AuthSessionId.make("session-1");
const otherSessionId = AuthSessionId.make("session-2");

const setup = Effect.gen(function* () {
  const changes = yield* PubSub.unbounded<SessionCredentialChange>();
  const gate = yield* makeSessionGate({
    sessionId,
    scopes: ["orchestration:read"],
    changes: Stream.fromPubSub(changes),
  });
  return { changes, gate };
});

it.effect("runs a call the session's scopes allow", () =>
  Effect.gen(function* () {
    const { gate } = yield* setup;
    const result = yield* gate.authorizeEffect("orchestration:read", Effect.succeed("ok"));
    assert.strictEqual(result, "ok");
  }).pipe(Effect.scoped),
);

it.effect("refuses a call needing a scope the session lacks, without running it", () =>
  Effect.gen(function* () {
    const { gate } = yield* setup;
    let ran = false;
    const error = yield* gate
      .authorizeEffect(
        "orchestration:operate",
        Effect.sync(() => {
          ran = true;
        }),
      )
      .pipe(Effect.flip);
    assert.strictEqual(error.requiredScope, "orchestration:operate");
    assert.isFalse(ran);
  }).pipe(Effect.scoped),
);

it.effect("refuses every later call once the session is revoked", () =>
  Effect.gen(function* () {
    const { changes, gate } = yield* setup;
    // An open subscription ends when the revocation lands; joining it is the
    // observable signal that the gate has seen it.
    const source = yield* Queue.unbounded<number>();
    const received = yield* Queue.unbounded<number>();
    const open = yield* gate.authorizeStream("orchestration:read", Stream.fromQueue(source)).pipe(
      Stream.runForEach((value) => Queue.offer(received, value)),
      Effect.forkChild,
    );
    yield* Queue.offer(source, 1);
    yield* Queue.take(received);
    yield* PubSub.publish(changes, { type: "clientRemoved", sessionId });
    yield* Fiber.join(open);
    let ran = false;
    const error = yield* gate
      .authorizeEffect(
        "orchestration:read",
        Effect.sync(() => {
          ran = true;
        }),
      )
      .pipe(Effect.flip);
    assert.include(error.message, "revoked");
    assert.isFalse(ran);
    const streamError = yield* gate
      .authorizeStream("orchestration:read", Stream.make(1))
      .pipe(Stream.runCollect, Effect.flip);
    assert.include(streamError.message, "revoked");
  }).pipe(Effect.scoped),
);

it.effect("ends a subscription that was already open when the session is revoked", () =>
  Effect.gen(function* () {
    const { changes, gate } = yield* setup;
    const source = yield* Queue.unbounded<number>();
    const received = yield* Queue.unbounded<number>();
    const fiber = yield* gate.authorizeStream("orchestration:read", Stream.fromQueue(source)).pipe(
      Stream.runForEach((value) => Queue.offer(received, value)),
      Effect.forkChild,
    );
    yield* Queue.offer(source, 1);
    assert.strictEqual(yield* Queue.take(received), 1);

    yield* PubSub.publish(changes, { type: "clientRemoved", sessionId });
    // The subscription ends on its own: nothing else is offered to the source.
    yield* Fiber.join(fiber);
    yield* Queue.offer(source, 2);
    assert.strictEqual(yield* Queue.size(received), 0);
  }).pipe(Effect.scoped),
);

it.effect("ignores the revocation of a different session", () =>
  Effect.gen(function* () {
    const { changes, gate } = yield* setup;
    yield* PubSub.publish(changes, { type: "clientRemoved", sessionId: otherSessionId });
    yield* Effect.yieldNow;
    const result = yield* gate.authorizeEffect("orchestration:read", Effect.succeed("ok"));
    assert.strictEqual(result, "ok");
  }).pipe(Effect.scoped),
);
