import { assert, describe, it } from "@effect/vitest";
import { type AutomationJournalEntry, EnvironmentId, EventId } from "@t3tools/contracts";

import * as DateTime from "effect/DateTime";

import { hookInput } from "./hooks.testkit.ts";
import {
  deliveryDedupKey,
  type HookConfig,
  HOOK_MAX_BATCH_ENTRIES,
  planDeliveries,
  retryDelayMs,
} from "./planning.ts";
import { isPublicAddress, literalAddress, signWebhook } from "./webhook.ts";

const isoAt = (epochMs: number) => DateTime.formatIso(DateTime.makeUnsafe(epochMs));

const entryAt = (cursor: number, recordedAtMs: number): AutomationJournalEntry => ({
  cursor,
  event: {
    version: 1,
    eventId: EventId.make(`event-${cursor}`),
    type: "task.progress",
    origin: { kind: "service", environmentId: EnvironmentId.make("env-local") },
    originCursor: cursor,
    scope: {},
    aggregate: { kind: "task", id: "task-1", revision: cursor },
    occurredAt: isoAt(recordedAtMs),
    recordedAt: isoAt(recordedAtMs),
    correlationId: `chain-${cursor}`,
    causationId: null,
    hops: 0,
    payload: {},
  },
});

const noHistory = {
  taskDeliveries: new Map<string, number>(),
  lastDeliveryAt: new Map<string, number>(),
};
const batchConfig: HookConfig = { ...hookInput(), deliveryMode: "batch", batchWindowMs: 1_000 };

const cursorsOf = (plan: ReturnType<typeof planDeliveries>) =>
  plan.deliveries.map((delivery) => delivery.entries.map((entry) => entry.cursor));

describe("planDeliveries", () => {
  it("delivers each entry on its own and moves past entries the filter skipped", () => {
    const plan = planDeliveries({
      config: hookInput(),
      entries: [entryAt(3, 0), entryAt(7, 0)],
      scannedThrough: 12,
      nowMs: 0,
      history: noHistory,
    });
    assert.deepStrictEqual(cursorsOf(plan), [[3], [7]]);
    assert.strictEqual(plan.cursor, 12);
    // With nothing matched the cursor still advances over what was examined.
    const empty = planDeliveries({
      config: hookInput(),
      entries: [],
      scannedThrough: 12,
      nowMs: 0,
      history: noHistory,
    });
    assert.deepStrictEqual([empty.deliveries.length, empty.cursor], [0, 12]);
  });

  it("closes a batch when its window ends and holds the next one open", () => {
    const entries = [entryAt(1, 0), entryAt(2, 400), entryAt(3, 1_000), entryAt(4, 1_001)];
    const open = planDeliveries({
      config: batchConfig,
      entries,
      scannedThrough: 4,
      nowMs: 999,
      history: noHistory,
    });
    assert.deepStrictEqual([cursorsOf(open), open.cursor], [[], 0]);

    // The window covers its end instant; the entry after it starts a new window.
    const closed = planDeliveries({
      config: batchConfig,
      entries,
      scannedThrough: 4,
      nowMs: 1_000,
      history: noHistory,
    });
    assert.deepStrictEqual([cursorsOf(closed), closed.cursor], [[[1, 2, 3]], 3]);

    const both = planDeliveries({
      config: batchConfig,
      entries,
      scannedThrough: 9,
      nowMs: 2_001,
      history: noHistory,
    });
    assert.deepStrictEqual([cursorsOf(both), both.cursor], [[[1, 2, 3], [4]], 9]);
  });

  it("caps a batch and carries the remainder into the next one", () => {
    const entries = Array.from({ length: HOOK_MAX_BATCH_ENTRIES + 2 }, (_, index) =>
      entryAt(index + 1, 0),
    );
    const plan = planDeliveries({
      config: batchConfig,
      entries,
      scannedThrough: entries.length,
      nowMs: 5_000,
      history: noHistory,
    });
    assert.deepStrictEqual(
      plan.deliveries.map((delivery) => delivery.entries.length),
      [HOOK_MAX_BATCH_ENTRIES, 2],
    );
  });

  it("keeps a suppressed entry out of the batch and in a delivery of its own", () => {
    const looping = entryAt(2, 0);
    const plan = planDeliveries({
      config: batchConfig,
      entries: [entryAt(1, 0), { ...looping, event: { ...looping.event, hops: 8 } }, entryAt(3, 0)],
      scannedThrough: 3,
      nowMs: 5_000,
      history: noHistory,
    });
    assert.deepStrictEqual(
      plan.deliveries.map((delivery) => [
        delivery.entries.map((entry) => entry.cursor),
        delivery.suppressedReason,
      ]),
      [
        [[2], "hop_limit"],
        [[1, 3], null],
      ],
    );
  });
});

describe("delivery keys and retry delays", () => {
  it("derives the same key for the same hook and events, and a different one otherwise", () => {
    const one = [entryAt(1, 0)];
    const two = [entryAt(1, 0), entryAt(2, 0)];
    assert.strictEqual(
      deliveryDedupKey("hook-a", one),
      deliveryDedupKey("hook-a", [entryAt(1, 50)]),
    );
    assert.notStrictEqual(deliveryDedupKey("hook-a", one), deliveryDedupKey("hook-b", one));
    assert.notStrictEqual(deliveryDedupKey("hook-a", one), deliveryDedupKey("hook-a", two));
    assert.notStrictEqual(
      deliveryDedupKey("hook-a", two),
      deliveryDedupKey("hook-a", [entryAt(1, 0), entryAt(3, 0)]),
    );
  });

  it("doubles the delay per attempt up to the cap, jittering the upper half", () => {
    const retry = { maxAttempts: 10, initialDelayMs: 1_000, maxDelayMs: 5_000 };
    assert.deepStrictEqual(
      [1, 2, 3, 4, 9].map((attempt) => retryDelayMs(retry, attempt, 0)),
      [500, 1_000, 2_000, 2_500, 2_500],
    );
    assert.deepStrictEqual(
      [1, 2, 3, 4, 9].map((attempt) => retryDelayMs(retry, attempt, 0.999_999)),
      [1_000, 2_000, 4_000, 5_000, 5_000],
    );
  });
});

describe("webhook address and signature rules", () => {
  it("treats loopback, link-local, private and unspecified addresses as not public", () => {
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "::1",
      "::",
      "fe80::1",
      "fd00::1",
      "::ffff:10.0.0.1",
      "::ffff:127.0.0.1",
      "not-an-address",
    ]) {
      assert.isFalse(isPublicAddress(address), address);
    }
    for (const address of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700:4700::1111"]) {
      assert.isTrue(isPublicAddress(address), address);
    }
  });

  it("recognises a literal address in a URL, with or without brackets", () => {
    assert.strictEqual(literalAddress(new URL("https://127.0.0.1:8443/x")), "127.0.0.1");
    assert.strictEqual(literalAddress(new URL("https://[::1]/x")), "::1");
    assert.strictEqual(literalAddress(new URL("https://hooks.example.com/x")), null);
  });

  it("changes the signature when the body, delivery or timestamp changes", () => {
    const base = {
      secret: new Uint8Array([1, 2, 3]),
      timestamp: "100",
      deliveryId: "delivery-1",
      body: "{}",
    };
    const signature = signWebhook(base);
    assert.match(signature, /^v1=[0-9a-f]{64}$/);
    assert.strictEqual(signWebhook({ ...base }), signature);
    for (const changed of [
      { ...base, body: "{ }" },
      { ...base, deliveryId: "delivery-2" },
      { ...base, timestamp: "101" },
      { ...base, secret: new Uint8Array([1, 2, 4]) },
    ]) {
      assert.notStrictEqual(signWebhook(changed), signature);
    }
  });
});
