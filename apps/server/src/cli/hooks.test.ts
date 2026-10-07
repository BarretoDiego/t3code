import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AutomationEventEmitInput,
  EnvironmentId,
  EventConsumerId,
  EventId,
  type Hook,
  HookDeliveryId,
  HookId,
  OrchestratorId,
  ThreadId,
  type AutomationJournalEntry,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { decodeBody, filterFromFlags, formatEntryLine } from "./events.ts";
import { decodeHookBody, formatDeliveryLine, formatHookLine } from "./hooks.ts";

const existing: Hook = {
  id: HookId.make("hook-1"),
  version: 1,
  revision: 4,
  name: "existing",
  enabled: true,
  filter: { types: ["task.*"] },
  target: { type: "cli_consumer", consumerId: EventConsumerId.make("watcher") },
  deliveryMode: "batch",
  batchWindowMs: 2_000,
  retry: { maxAttempts: 3, initialDelayMs: 1_000, maxDelayMs: 5_000 },
  timeoutMs: 5_000,
  priority: 1,
  cooldownMs: 30_000,
  cursor: 12,
  createdBy: "session",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("hook definitions", () => {
  it.effect("accepts the shipped examples as they are", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = path.resolve(
        import.meta.dirname,
        "../../../../docs/user/examples/automation",
      );
      const examples = (yield* fs.readDirectory(directory)).filter((name) =>
        name.startsWith("hook-"),
      );
      assert.deepStrictEqual(examples.toSorted(), [
        "hook-pending-question.json",
        "hook-task-completed.json",
      ]);
      for (const name of examples) {
        const text = yield* fs.readFileString(path.join(directory, name));
        const input = yield* decodeHookBody(text);
        assert.isAbove(input.filter.types?.length ?? 0, 0, name);
        assert.strictEqual(input.target.type, "orchestrator_inbox", name);
        // An example is a new hook: it names no id and replaces no revision.
        assert.deepStrictEqual([input.id, input.expectedRevision], [undefined, undefined], name);
        assert.notMatch(text, /secret|token|password|@|\/Users\//i, name);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps what an edit does not mention and names the revision it replaces", () =>
    Effect.gen(function* () {
      const edited = yield* decodeHookBody('{ "priority": 9, "enabled": false }', existing);
      assert.deepStrictEqual(
        [edited.id, edited.expectedRevision, edited.priority, edited.enabled],
        [existing.id, 4, 9, false],
      );
      assert.deepStrictEqual(
        [edited.name, edited.filter, edited.target, edited.batchWindowMs, edited.cooldownMs],
        [existing.name, existing.filter, existing.target, 2_000, 30_000],
      );
      // A revision in the body wins, so a script can pin the one it read.
      const pinned = yield* decodeHookBody('{ "expectedRevision": 2 }', existing);
      assert.strictEqual(pinned.expectedRevision, 2);
    }),
  );

  it.effect("explains a body that cannot be used", () =>
    Effect.gen(function* () {
      const notJson = yield* decodeHookBody("{ not json").pipe(Effect.flip);
      assert.include(notJson.message, "not a JSON object");
      const array = yield* decodeHookBody("[]").pipe(Effect.flip);
      assert.include(array.message, "not a JSON object");
      const incomplete = yield* decodeHookBody('{ "name": "only a name" }').pipe(Effect.flip);
      assert.include(incomplete.message, "not valid");
      const badTarget = yield* decodeHookBody(
        '{ "target": { "type": "carrier_pigeon" } }',
        existing,
      ).pipe(Effect.flip);
      assert.include(badTarget.message, "not valid");
    }),
  );
});

describe("event bodies and filters", () => {
  it.effect("fills in an idempotency key only when the body has none", () =>
    Effect.gen(function* () {
      const defaults = { idempotencyKey: "generated" };
      const filled = yield* decodeBody(
        AutomationEventEmitInput,
        '{ "type": "custom.ci.finished", "payload": { "ok": true } }',
        defaults,
      );
      assert.deepStrictEqual(
        [filled.idempotencyKey, filled.type, filled.payload],
        ["generated", "custom.ci.finished", { ok: true }],
      );
      const kept = yield* decodeBody(
        AutomationEventEmitInput,
        '{ "type": "custom.ci.finished", "idempotencyKey": "mine" }',
        defaults,
      );
      assert.strictEqual(kept.idempotencyKey, "mine");
      // The schema refuses a type only the server may publish before anything is sent.
      const privileged = yield* decodeBody(
        AutomationEventEmitInput,
        '{ "type": "task.validated" }',
        defaults,
      ).pipe(Effect.flip);
      assert.include(privileged.message, "not valid");
    }),
  );

  it("builds a filter only from the flags that were passed", () => {
    const none = { type: [], thread: [], root: [], project: [], task: [], orchestrator: [] };
    assert.isUndefined(filterFromFlags(none));
    assert.deepStrictEqual(
      filterFromFlags({ ...none, type: ["task.*", "turn.completed"], thread: ["thread-1"] }),
      { types: ["task.*", "turn.completed"], threadIds: [ThreadId.make("thread-1")] },
    );
    assert.deepStrictEqual(filterFromFlags({ ...none, orchestrator: ["main"] }), {
      orchestratorIds: [OrchestratorId.make("main")],
    });
  });

  it("formats events, hooks and deliveries as single scannable lines", () => {
    const entry: AutomationJournalEntry = {
      cursor: 42,
      event: {
        version: 1,
        eventId: EventId.make("event-42"),
        type: "turn.completed",
        origin: { kind: "service", environmentId: EnvironmentId.make("env") },
        originCursor: 42,
        scope: { threadId: ThreadId.make("thread-child"), parentThreadId: ThreadId.make("root") },
        aggregate: { kind: "thread", id: "thread-child", revision: 3 },
        occurredAt: "2026-01-01T00:00:00.000Z",
        recordedAt: "2026-01-01T00:00:01.000Z",
        correlationId: "event-42",
        causationId: null,
        hops: 0,
        payload: {},
      },
    };
    assert.strictEqual(
      formatEntryLine(entry),
      "42  2026-01-01T00:00:01.000Z  turn.completed  thread=thread-child parent=root",
    );
    assert.strictEqual(
      formatHookLine(existing),
      "hook-1  enabled  priority 1  task.*  -> consumer watcher  existing",
    );
    assert.strictEqual(
      formatDeliveryLine({
        id: HookDeliveryId.make("delivery-1"),
        hookId: existing.id,
        dedupKey: "hook-1:event-42",
        eventIds: [entry.event.eventId],
        firstCursor: 42,
        lastCursor: 44,
        status: "suppressed",
        attemptCount: 0,
        nextAttemptAt: null,
        lastError: null,
        suppressedReason: "cooldown",
        createdAt: "2026-01-01T00:00:01.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
      }),
      "delivery-1  suppressed  cursors 42-44  attempts 0  suppressed: cooldown",
    );
  });
});
