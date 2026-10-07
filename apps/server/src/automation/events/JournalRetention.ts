import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Scheduler from "../../scheduling/Scheduler.ts";
import * as JournalStore from "./JournalStore.ts";

/** The scheduler ticks every few seconds; the journal is pruned this often. */
export const JOURNAL_PRUNE_INTERVAL_MS = 10 * 60 * 1_000;

/**
 * Prunes the journal on the shared scheduler clock. What may go is decided
 * from durable state on every run, so a restart needs nothing restored.
 */
export const workerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const store = yield* JournalStore.JournalStore;
    const scheduler = yield* Scheduler.Scheduler;
    let lastRunAt: number | undefined;
    const pruneWhenDue = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      if (lastRunAt !== undefined && now - lastRunAt < JOURNAL_PRUNE_INTERVAL_MS) return;
      lastRunAt = now;
      const prunedThrough = yield* store.prune();
      if (prunedThrough > 0) {
        yield* Effect.logInfo("Pruned the automation journal", { prunedThrough });
      }
    });
    yield* scheduler.register("automation-journal-retention", pruneWhenDue);
  }),
);
