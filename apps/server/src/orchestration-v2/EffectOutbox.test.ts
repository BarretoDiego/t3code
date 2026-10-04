import { assert, it } from "@effect/vitest";
import { CheckpointScopeId, CommandId, RunId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { EffectOutboxV2, layer } from "./EffectOutbox.ts";

it.effect(
  "reports queued, leased and deferred server work without claiming it; drops settled work",
  () =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutboxV2;
      const now = yield* DateTime.now;
      yield* outbox.enqueue([
        {
          id: "checkpoint",
          commandId: CommandId.make("command-1"),
          threadId: ThreadId.make("thread-1"),
          request: {
            type: "checkpoint.capture",
            runId: RunId.make("run-1"),
            scopeId: CheckpointScopeId.make("scope-1"),
          },
        },
        {
          id: "deferred",
          commandId: CommandId.make("command-2"),
          threadId: ThreadId.make("thread-2"),
          request: { type: "terminal.cleanup" },
          availableAt: DateTime.add(now, { hours: 1 }),
        },
      ]);
      const pending = yield* outbox.pendingWork;
      assert.deepStrictEqual(
        pending.effects.map((effect) => [effect.id, effect.status]),
        [
          ["checkpoint", "pending"],
          ["deferred", "pending"],
        ],
      );
      assert.strictEqual(Option.getOrThrow(yield* outbox.get("checkpoint")).attemptCount, 0);
      const claimed = Option.getOrThrow(
        yield* outbox.claimNext({ workerId: "worker", leaseDurationMs: 30_000 }),
      );
      assert.strictEqual(claimed.id, "checkpoint");
      assert.strictEqual((yield* outbox.pendingWork).effects[0]?.status, "running");
      yield* outbox.retry({
        effectId: "checkpoint",
        workerId: "worker",
        error: "filesystem busy",
        delayMs: 60_000,
      });
      const retry = (yield* outbox.pendingWork).effects.find(
        (effect) => effect.id === "checkpoint",
      );
      assert.strictEqual(retry?.lastError, "filesystem busy");
      assert.strictEqual(retry?.status, "pending");
      yield* outbox.cancelUnsettled({
        threadId: ThreadId.make("thread-1"),
        effectTypes: ["checkpoint.capture"],
        reason: "explicit stop",
      });
      assert.deepStrictEqual(
        (yield* outbox.pendingWork).effects.map((effect) => effect.id),
        ["deferred"],
      );
    }).pipe(Effect.provide(layer.pipe(Layer.provide(SqlitePersistenceMemory)))),
);
