import {
  AUTOMATION_CONTRACT_VERSION,
  type AutomationError,
  type AutomationJournalEntry,
  type EventId,
  type Hook,
  type HookDelivery,
  HookDeliveryId,
  type HookDeliveryPayload,
  type HookDeliveryStatus,
  type HookId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import * as Scheduler from "../../scheduling/Scheduler.ts";
import { automationError } from "../Caller.ts";
import { randomId } from "../events/ids.ts";
import * as JournalStore from "../events/JournalStore.ts";
import {
  deliveryDedupKey,
  type HookConfig,
  planDeliveries,
  type PlannedDelivery,
  retryDelayMs,
} from "./planning.ts";
import { HookDeliveryFailure, makeHookTargets } from "./targets.ts";

/**
 * Deliveries one hook may have waiting. At the cap its cursor stops, the
 * journal keeps the events, and matching resumes as deliveries complete.
 */
export const HOOK_MAX_PENDING_DELIVERIES = 500;
const MATCH_PAGE_SIZE = 200;
const DELIVERY_BATCH_SIZE = 50;
const DELIVERY_CONCURRENCY = 4;
const LAST_ERROR_LIMIT = 500;

export interface HookRow {
  readonly hook_id: HookId;
  readonly revision: number;
  readonly enabled: number;
  readonly priority: number;
  readonly cursor: number;
  readonly hook_json: string;
  readonly created_by: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface DeliveryRow {
  readonly delivery_id: HookDeliveryId;
  readonly hook_id: HookId;
  readonly dedup_key: string;
  readonly status: HookDeliveryStatus;
  readonly first_cursor: number;
  readonly last_cursor: number;
  readonly event_ids_json: string;
  readonly attempt_count: number;
  readonly next_attempt_at: string | null;
  readonly last_error: string | null;
  readonly suppressed_reason: HookDelivery["suppressedReason"];
  readonly created_at: string;
  readonly updated_at: string;
}

/** A hook's stored settings, plus whether backpressure is currently holding its cursor. */
type StoredHookConfig = HookConfig & { readonly stalled?: boolean };

const parseConfig = (json: string): StoredHookConfig => JSON.parse(json);
const parseEventIds = (json: string): ReadonlyArray<EventId> => JSON.parse(json);
export const encodeJson = (value: unknown) => JSON.stringify(value);

export const hookConfigOf = (row: HookRow): StoredHookConfig => parseConfig(row.hook_json);

export const toHook = (row: HookRow): Hook => {
  const { stalled: _stalled, ...config } = parseConfig(row.hook_json);
  return {
    id: row.hook_id,
    version: AUTOMATION_CONTRACT_VERSION,
    revision: row.revision,
    enabled: row.enabled === 1,
    priority: row.priority,
    cursor: row.cursor,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...config,
  };
};

export const toDelivery = (row: DeliveryRow): HookDelivery => ({
  id: row.delivery_id,
  hookId: row.hook_id,
  dedupKey: row.dedup_key,
  eventIds: parseEventIds(row.event_ids_json),
  firstCursor: row.first_cursor,
  lastCursor: row.last_cursor,
  status: row.status,
  attemptCount: row.attempt_count,
  nextAttemptAt: row.next_attempt_at,
  lastError: row.last_error,
  suppressedReason: row.suppressed_reason,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const hookStorageFailure = (operation: string) => (cause: SqlError) =>
  Effect.logWarning("Automation hook storage failed", { operation, cause }).pipe(
    Effect.andThen(Effect.fail(automationError("INTERNAL", `Hooks could not ${operation}.`))),
  );

/**
 * Matches hooks against the journal and delivers what they match. It keeps no
 * state of its own: cursors and deliveries are rows, so a restart resumes
 * exactly where the last commit left off.
 */
export class HookRuntime extends Context.Service<
  HookRuntime,
  {
    /** Checks a hook target against server policy and prepares what it needs. */
    readonly prepareTarget: (target: Hook["target"]) => Effect.Effect<void, AutomationError>;
    /** Asks the worker to match and deliver. Returns at once. */
    readonly wake: Effect.Effect<void>;
    /** Resolves once the journal has been published and the worker has nothing left to do now. */
    readonly drain: Effect.Effect<void>;
    /** Records one delivery for these entries, outside the hook's cursor, and attempts it now. */
    readonly deliverEntries: (
      hook: HookRow,
      entries: ReadonlyArray<AutomationJournalEntry>,
      dedupKey: string,
    ) => Effect.Effect<HookDelivery, AutomationError>;
    /** Puts deliveries a previous process left mid-attempt back in the queue. */
    readonly recover: Effect.Effect<void, AutomationError>;
  }
>()("t3/automation/hooks/HookRuntime") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* JournalStore.JournalStore;
  const targets = yield* makeHookTargets;

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const newDeliveryId = Effect.map(randomId, (id) => HookDeliveryId.make(`delivery-${id}`));

  const insertDelivery = (input: {
    readonly id: HookDeliveryId;
    readonly hookId: HookId;
    readonly dedupKey: string;
    readonly planned: PlannedDelivery;
    readonly status: HookDeliveryStatus;
    readonly attemptCount: number;
    readonly now: string;
  }) => {
    const first = input.planned.entries[0];
    const last = input.planned.entries.at(-1);
    return sql`
      INSERT INTO automation_hook_deliveries (
        delivery_id, hook_id, dedup_key, status, first_cursor, last_cursor, event_ids_json,
        correlation_id, task_id, attempt_count, next_attempt_at, last_error, suppressed_reason,
        created_at, updated_at
      )
      VALUES (
        ${input.id},
        ${input.hookId},
        ${input.dedupKey},
        ${input.status},
        ${first?.cursor ?? 0},
        ${last?.cursor ?? 0},
        ${encodeJson(input.planned.entries.map((entry) => entry.event.eventId))},
        ${first?.event.correlationId ?? null},
        ${first?.event.scope.taskId ?? null},
        ${input.attemptCount},
        ${input.status === "pending" ? input.now : null},
        ${null},
        ${input.planned.suppressedReason},
        ${input.now},
        ${input.now}
      )
      ON CONFLICT(dedup_key) DO NOTHING
    `;
  };

  const writeConfig = (hookId: HookId, config: StoredHookConfig) =>
    sql`UPDATE automation_hooks SET hook_json = ${encodeJson(config)} WHERE hook_id = ${hookId}`;

  const hookEvent = (hookId: HookId, payload: Record<string, string | number>) =>
    store.append([
      {
        type: "hook.changed",
        origin: { kind: "service" },
        scope: {},
        aggregate: { kind: "hook", id: hookId },
        payload,
      },
    ]);

  const loadHistory = Effect.fnUntraced(function* (
    hookId: HookId,
    config: HookConfig,
    entries: ReadonlyArray<AutomationJournalEntry>,
  ) {
    const taskDeliveries = new Map<string, number>();
    const lastDeliveryAt = new Map<string, number>();
    const taskIds = [...new Set(entries.flatMap((entry) => entry.event.scope.taskId ?? []))];
    if (config.maxDeliveriesPerTask !== undefined && taskIds.length > 0) {
      const rows = yield* sql<{ readonly task_id: string; readonly deliveries: number }>`
        SELECT task_id, COUNT(*) AS deliveries
        FROM automation_hook_deliveries
        WHERE hook_id = ${hookId}
          AND status != 'suppressed'
          AND task_id IN ${sql.in(taskIds)}
        GROUP BY task_id
      `;
      for (const row of rows) taskDeliveries.set(row.task_id, row.deliveries);
    }
    const correlationIds = [...new Set(entries.map((entry) => entry.event.correlationId))];
    if ((config.cooldownMs ?? 0) > 0 && correlationIds.length > 0) {
      const rows = yield* sql<{ readonly correlation_id: string; readonly last: string }>`
        SELECT correlation_id, MAX(created_at) AS last
        FROM automation_hook_deliveries
        WHERE hook_id = ${hookId}
          AND status != 'suppressed'
          AND correlation_id IN ${sql.in(correlationIds)}
        GROUP BY correlation_id
      `;
      for (const row of rows) lastDeliveryAt.set(row.correlation_id, Date.parse(row.last));
    }
    return { taskDeliveries, lastDeliveryAt };
  });

  /**
   * Advances one hook: the deliveries for what it matched and its new cursor
   * commit together, so a crash never leaves an event matched but undelivered
   * or delivered twice under different keys. Returns whether more can be
   * matched right away.
   */
  const matchHook = (hookId: HookId) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql<HookRow>`
          SELECT * FROM automation_hooks WHERE hook_id = ${hookId} AND enabled = 1
        `;
        const hook = rows[0];
        if (hook === undefined) return false;
        const config = hookConfigOf(hook);
        const { headCursor, oldestCursor } = yield* store.status;
        if (hook.cursor >= headCursor) return false;

        if (oldestCursor !== null && hook.cursor < oldestCursor - 1) {
          // Retention outran the hook. Say so, then continue with what is left.
          yield* hookEvent(hookId, {
            change: "cursor_expired",
            lostAfterCursor: hook.cursor,
            resumedAtCursor: oldestCursor - 1,
          });
          yield* sql`
            UPDATE automation_hooks SET cursor = ${oldestCursor - 1} WHERE hook_id = ${hookId}
          `;
          return true;
        }

        const waiting = yield* sql<{ readonly waiting: number }>`
          SELECT COUNT(*) AS waiting
          FROM automation_hook_deliveries
          WHERE hook_id = ${hookId} AND status IN ('pending', 'delivering', 'retrying')
        `;
        const room = HOOK_MAX_PENDING_DELIVERIES - (waiting[0]?.waiting ?? 0);
        if (room <= 0) {
          if (config.stalled !== true) {
            yield* writeConfig(hookId, { ...config, stalled: true });
            yield* hookEvent(hookId, {
              change: "backpressure",
              heldAtCursor: hook.cursor,
              waitingDeliveries: HOOK_MAX_PENDING_DELIVERIES - room,
            });
          }
          return false;
        }
        if (config.stalled === true) {
          const { stalled: _stalled, ...resumed } = config;
          yield* writeConfig(hookId, resumed);
          yield* hookEvent(hookId, { change: "backpressure_cleared", cursor: hook.cursor });
        }

        const page = yield* store.page({
          afterCursor: hook.cursor,
          throughCursor: headCursor,
          filter: config.filter,
          limit: Math.min(room, MATCH_PAGE_SIZE),
        });
        const now = yield* DateTime.now;
        const plan = planDeliveries({
          config,
          entries: page.entries,
          scannedThrough: page.scannedThrough,
          nowMs: DateTime.toEpochMillis(now),
          history: yield* loadHistory(hookId, config, page.entries),
        });
        const createdAt = DateTime.formatIso(now);
        for (const planned of plan.deliveries) {
          yield* insertDelivery({
            id: yield* newDeliveryId,
            hookId,
            dedupKey: deliveryDedupKey(hookId, planned.entries),
            planned,
            // A CLI consumer reads the journal itself: once the entry is
            // matched it is there for the consumer, which is all delivery means.
            status:
              planned.suppressedReason !== null
                ? "suppressed"
                : config.target.type === "cli_consumer"
                  ? "delivered"
                  : "pending",
            attemptCount: 0,
            now: createdAt,
          });
        }
        if (plan.cursor <= hook.cursor) return false;
        yield* sql`UPDATE automation_hooks SET cursor = ${plan.cursor} WHERE hook_id = ${hookId}`;
        return plan.cursor < headCursor;
      }),
    );

  /** Matches a hook page by page until it is caught up, held, or waiting on a batch window. */
  const matchHookFully = (hookId: HookId): Effect.Effect<void, SqlError | AutomationError> =>
    Effect.flatMap(matchHook(hookId), (more) => (more ? matchHookFully(hookId) : Effect.void));

  const matchAll = Effect.gen(function* () {
    const behind = yield* sql<{ readonly hook_id: HookId }>`
      SELECT hook_id
      FROM automation_hooks
      WHERE enabled = 1
        AND cursor < (SELECT COALESCE(MAX(cursor), 0) FROM automation_journal)
      ORDER BY priority DESC, created_at, hook_id
    `;
    // One hook that cannot be matched must not stop the others.
    yield* Effect.forEach(
      behind,
      (row) =>
        matchHookFully(row.hook_id).pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterruptsOnly(cause),
            (cause) =>
              Effect.logWarning("Automation hook could not be matched", {
                hookId: row.hook_id,
                cause,
              }),
          ),
        ),
      { discard: true },
    );
  });

  const finish = (deliveryId: HookDeliveryId, now: string) =>
    sql`
      UPDATE automation_hook_deliveries
      SET status = 'delivered', next_attempt_at = NULL, last_error = NULL, updated_at = ${now}
      WHERE delivery_id = ${deliveryId}
    `;

  const recordFailure = Effect.fnUntraced(function* (input: {
    readonly hook: HookRow;
    readonly delivery: DeliveryRow;
    readonly attempt: number;
    readonly failure: HookDeliveryFailure;
    readonly entries: ReadonlyArray<AutomationJournalEntry>;
  }) {
    const config = hookConfigOf(input.hook);
    const now = yield* DateTime.now;
    const lastError = input.failure.reason.slice(0, LAST_ERROR_LIMIT);
    const exhausted = input.failure.permanent || input.attempt >= config.retry.maxAttempts;
    if (!exhausted) {
      const delay = retryDelayMs(config.retry, input.attempt, yield* Random.next);
      yield* sql`
        UPDATE automation_hook_deliveries
        SET status = 'retrying',
            next_attempt_at = ${DateTime.formatIso(DateTime.add(now, { milliseconds: delay }))},
            last_error = ${lastError},
            updated_at = ${DateTime.formatIso(now)}
        WHERE delivery_id = ${input.delivery.delivery_id}
      `;
      return;
    }
    // The failure and the event announcing it commit together.
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          UPDATE automation_hook_deliveries
          SET status = 'failed',
              next_attempt_at = NULL,
              last_error = ${lastError},
              updated_at = ${DateTime.formatIso(now)}
          WHERE delivery_id = ${input.delivery.delivery_id}
        `;
        const cause = input.entries[0]?.event;
        yield* store.append([
          {
            type: "hook.delivery.failed",
            origin: { kind: "service" },
            scope:
              config.target.type === "orchestrator_inbox"
                ? { orchestratorId: config.target.orchestratorId }
                : {},
            aggregate: { kind: "hook", id: input.hook.hook_id },
            payload: {
              deliveryId: input.delivery.delivery_id,
              dedupKey: input.delivery.dedup_key,
              targetType: config.target.type,
              attemptCount: input.attempt,
              permanent: input.failure.permanent,
              lastError,
            },
            ...(cause === undefined ? {} : { causedBy: cause }),
          },
        ]);
      }),
    );
  });

  /** One attempt at one delivery. The claim makes sure two workers never send the same attempt. */
  const attempt = Effect.fnUntraced(function* (hook: HookRow, delivery: DeliveryRow) {
    const claimed = yield* sql<{ readonly attempt_count: number }>`
      UPDATE automation_hook_deliveries
      SET status = 'delivering', attempt_count = attempt_count + 1, updated_at = ${yield* nowIso}
      WHERE delivery_id = ${delivery.delivery_id} AND status IN ('pending', 'retrying')
      RETURNING attempt_count
    `;
    const attemptCount = claimed[0]?.attempt_count;
    if (attemptCount === undefined) return;

    const config = hookConfigOf(hook);
    const eventIds = new Set(parseEventIds(delivery.event_ids_json));
    const page = yield* store.page({
      afterCursor: delivery.first_cursor - 1,
      throughCursor: delivery.last_cursor,
      // The delivery names its events, so read the range without filtering.
      filter: "all",
      limit: delivery.last_cursor - delivery.first_cursor + 1,
    });
    const entries = page.entries.filter((entry) => eventIds.has(entry.event.eventId));
    const payload: HookDeliveryPayload = {
      version: AUTOMATION_CONTRACT_VERSION,
      deliveryId: delivery.delivery_id,
      dedupKey: delivery.dedup_key,
      hookId: hook.hook_id,
      attempt: attemptCount,
      sentAt: yield* nowIso,
      entries,
    };
    const outcome = yield* (
      entries.length === eventIds.size
        ? targets.send(config.target, payload).pipe(
            Effect.timeoutOption(Duration.millis(config.timeoutMs)),
            Effect.flatMap(
              Option.match({
                onSome: () => Effect.void,
                onNone: () =>
                  Effect.fail(
                    new HookDeliveryFailure({
                      reason: `The target did not answer within ${config.timeoutMs} ms.`,
                      permanent: false,
                    }),
                  ),
              }),
            ),
          )
        : Effect.fail(
            new HookDeliveryFailure({
              reason: "The events of this delivery are no longer in the journal.",
              permanent: true,
            }),
          )
    ).pipe(Effect.result);

    if (outcome._tag === "Success") {
      yield* finish(delivery.delivery_id, yield* nowIso);
    } else {
      yield* recordFailure({
        hook,
        delivery,
        attempt: attemptCount,
        failure: outcome.failure,
        entries,
      });
    }
  });

  const deliverDue = Effect.gen(function* () {
    // A delivery whose attempt could not even be recorded stays due. Trying
    // each one once per run keeps that from spinning; the next run retries it.
    const attempted = new Set<HookDeliveryId>();
    while (true) {
      const due = yield* sql<DeliveryRow & { readonly priority: number }>`
        SELECT d.*, h.priority
        FROM automation_hook_deliveries d
        JOIN automation_hooks h ON h.hook_id = d.hook_id
        WHERE h.enabled = 1
          AND d.status IN ('pending', 'retrying')
          AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= ${yield* nowIso})
        ORDER BY h.priority DESC, d.first_cursor, d.created_at
        LIMIT ${DELIVERY_BATCH_SIZE}
      `;
      const fresh = due.filter((delivery) => !attempted.has(delivery.delivery_id));
      if (fresh.length === 0) return attempted.size;
      for (const delivery of fresh) attempted.add(delivery.delivery_id);
      // One lane per hook keeps a hook's deliveries in order while a slow
      // target does not hold the others up. Higher priority hooks start first.
      const lanes = new Map<HookId, Array<DeliveryRow>>();
      for (const delivery of fresh) {
        const lane = lanes.get(delivery.hook_id) ?? [];
        lane.push(delivery);
        lanes.set(delivery.hook_id, lane);
      }
      yield* Effect.forEach(
        lanes,
        Effect.fnUntraced(
          function* ([hookId, deliveries]) {
            const hooks = yield* sql<HookRow>`
            SELECT * FROM automation_hooks WHERE hook_id = ${hookId}
          `;
            const hook = hooks[0];
            if (hook === undefined) return;
            for (const delivery of deliveries) yield* attempt(hook, delivery);
          },
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterruptsOnly(cause),
            (cause) => Effect.logWarning("Automation hook delivery lane failed", { cause }),
          ),
        ),
        { concurrency: DELIVERY_CONCURRENCY, discard: true },
      );
    }
  });

  // Completed deliveries make room for a hook held by backpressure, so match
  // again after each round that attempted something.
  const matchAndDeliver: Effect.Effect<void, SqlError | AutomationError> = Effect.gen(function* () {
    while (true) {
      yield* matchAll;
      if ((yield* deliverDue) === 0) return;
    }
  });

  let queued = false;
  let runs = 0;
  const worker = yield* makeDrainableWorker(() =>
    Effect.sync(() => {
      queued = false;
      runs++;
    }).pipe(
      Effect.andThen(matchAndDeliver),
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) => Effect.logWarning("Automation hook worker failed", { cause }),
      ),
    ),
  );
  const wake = Effect.suspend(() => {
    if (queued) return Effect.void;
    queued = true;
    return worker.enqueue(undefined);
  });
  yield* store.onCommitted(() => wake);

  // A run can record events of its own, which wake the worker again, so wait
  // until a full round of publishing and working starts nothing new.
  const drain = Effect.gen(function* () {
    while (true) {
      const before = runs;
      yield* store.flush;
      yield* worker.drain;
      if (runs === before && !queued) return;
    }
  });

  const deliverEntries: HookRuntime["Service"]["deliverEntries"] = Effect.fn(
    "HookRuntime.deliverEntries",
  )(function* (hook, entries, dedupKey) {
    const id = yield* newDeliveryId;
    return yield* Effect.gen(function* () {
      yield* insertDelivery({
        id,
        hookId: hook.hook_id,
        dedupKey,
        planned: { entries, suppressedReason: null },
        status: "pending",
        attemptCount: 0,
        now: yield* nowIso,
      });
      const read = sql<DeliveryRow>`
        SELECT * FROM automation_hook_deliveries WHERE dedup_key = ${dedupKey}
      `;
      const stored = (yield* read)[0];
      if (stored === undefined) {
        return yield* Effect.die(new Error(`Delivery ${dedupKey} was not stored.`));
      }
      yield* attempt(hook, stored);
      return toDelivery((yield* read)[0] ?? stored);
    }).pipe(Effect.catchTag("SqlError", hookStorageFailure("record the delivery")));
  });

  const recover: HookRuntime["Service"]["recover"] = Effect.gen(function* () {
    // Whether the interrupted attempt reached its target is unknown. The
    // delivery keeps its dedup key, so trying again cannot add a second one.
    const now = yield* nowIso;
    yield* sql`
      UPDATE automation_hook_deliveries
      SET status = 'retrying', next_attempt_at = ${now}, updated_at = ${now}
      WHERE status = 'delivering'
    `;
  }).pipe(Effect.catchTag("SqlError", hookStorageFailure("recover deliveries")));

  return HookRuntime.of({ prepareTarget: targets.prepare, wake, drain, deliverEntries, recover });
});

export const layer = Layer.effect(HookRuntime, make);

/**
 * Starts hook delivery for a server: recovers what a previous process left
 * mid-attempt, works off anything already due, and sweeps on the shared
 * scheduler clock so retries and closing batch windows happen without a new
 * event to wake the worker.
 */
export const workerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const runtime = yield* HookRuntime;
    const scheduler = yield* Scheduler.Scheduler;
    yield* runtime.recover.pipe(
      Effect.catch((error) => Effect.logWarning("Hook delivery recovery failed", { error })),
    );
    // Work off what is already due now rather than at the first tick.
    yield* runtime.wake;
    yield* scheduler.register("automation-hooks", runtime.wake);
  }),
);
