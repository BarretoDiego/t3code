import {
  AUTOMATION_ADMINISTRATIVE_EVENT_TYPES,
  AUTOMATION_CONTRACT_VERSION,
  AUTOMATION_EVENT_MAX_PAYLOAD_BYTES,
  type AutomationError,
  type AutomationEvent,
  type AutomationEventFilter,
  type AutomationJournalEntry,
  type AutomationJournalStatus,
  type EnvironmentId,
  EventId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { automationError } from "../Caller.ts";
import type { EventJournalAppend } from "../EventJournal.ts";
import { filterProblem, typeSelectors } from "./filter.ts";
import { randomId } from "./ids.ts";

/** Entries kept when nothing else holds the journal back. */
export const JOURNAL_RETENTION_MAX_ENTRIES = 50_000;
/** Entries older than this are pruned even when the journal is short. */
export const JOURNAL_RETENTION_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1_000;
/**
 * A durable consumer, hook, undelivered delivery or peer holds entries back
 * only up to these limits. Past them the entries go and the laggard gets
 * `CURSOR_EXPIRED` on its next read.
 */
export const JOURNAL_RETENTION_HARD_MAX_ENTRIES = 250_000;
export const JOURNAL_RETENTION_HARD_MAX_AGE_MS = 60 * 24 * 60 * 60 * 1_000;

export interface JournalRetentionLimits {
  readonly maxEntries: number;
  readonly maxAgeMs: number;
  readonly hardMaxEntries: number;
  readonly hardMaxAgeMs: number;
}

const DEFAULT_RETENTION: JournalRetentionLimits = {
  maxEntries: JOURNAL_RETENTION_MAX_ENTRIES,
  maxAgeMs: JOURNAL_RETENTION_MAX_AGE_MS,
  hardMaxEntries: JOURNAL_RETENTION_HARD_MAX_ENTRIES,
  hardMaxAgeMs: JOURNAL_RETENTION_HARD_MAX_AGE_MS,
};

const PUBLISH_PAGE_SIZE = 500;

interface JournalRow {
  readonly cursor: number;
  readonly origin_cursor: number;
  readonly event_json: string;
}

type StoredEvent = Omit<AutomationEvent, "originCursor">;

const parseStoredEvent = (json: string): StoredEvent => JSON.parse(json);

const toEntry = (row: JournalRow): AutomationJournalEntry => ({
  cursor: row.cursor,
  event: { ...parseStoredEvent(row.event_json), originCursor: row.origin_cursor },
});

const storageFailure = (operation: string) => (cause: SqlError) =>
  Effect.logWarning("Automation journal storage failed", { operation, cause }).pipe(
    Effect.andThen(
      Effect.fail(automationError("INTERNAL", `The event journal could not ${operation}.`)),
    ),
  );

const payloadTooLarge = (type: string, bytes: number) =>
  automationError(
    "INVALID_INPUT",
    `The payload of '${type}' is ${bytes} bytes; the limit is ${AUTOMATION_EVENT_MAX_PAYLOAD_BYTES}. Put large content behind a reference instead.`,
    { type, bytes, maxBytes: AUTOMATION_EVENT_MAX_PAYLOAD_BYTES },
  );

const payloadBytes = (payload: AutomationEvent["payload"]) =>
  Buffer.byteLength(JSON.stringify(payload));

/**
 * Storage and live fan-out behind `EventJournal`. Hook matching and retention
 * use it directly because they need what the public service does not offer:
 * unfiltered ranges, a commit notification, and pruning.
 */
export class JournalStore extends Context.Service<
  JournalStore,
  {
    readonly environmentId: EnvironmentId;
    /**
     * Records events. Inside a caller's transaction the rows join it; either
     * way subscribers hear about them only once that transaction has committed.
     */
    readonly append: (
      events: ReadonlyArray<EventJournalAppend>,
    ) => Effect.Effect<ReadonlyArray<AutomationJournalEntry>, AutomationError>;
    readonly importPeerEntries: (
      entries: ReadonlyArray<AutomationJournalEntry>,
    ) => Effect.Effect<ReadonlyArray<AutomationJournalEntry>, AutomationError>;
    readonly status: Effect.Effect<AutomationJournalStatus, AutomationError>;
    /** Fails with `CURSOR_EXPIRED` when entries after this cursor have been pruned. */
    readonly assertRetained: (afterCursor: number) => Effect.Effect<void, AutomationError>;
    /**
     * Matching entries in `(afterCursor, throughCursor]`, oldest first.
     * `scannedThrough` is how far the journal was examined, which is past the
     * last returned entry when the rest of the range did not match.
     */
    readonly page: (input: {
      readonly afterCursor: number;
      readonly throughCursor: number;
      /** `"all"` reads the range as it is, administrative types included. */
      readonly filter?: AutomationEventFilter | "all" | undefined;
      readonly limit: number;
    }) => Effect.Effect<
      {
        readonly entries: ReadonlyArray<AutomationJournalEntry>;
        readonly scannedThrough: number;
      },
      AutomationError
    >;
    readonly findByEventId: (
      eventId: EventId,
    ) => Effect.Effect<AutomationJournalEntry | undefined, AutomationError>;
    /** Committed entries in commit order, starting with the next one published. */
    readonly live: Effect.Effect<PubSub.Subscription<AutomationJournalEntry>, never, Scope.Scope>;
    /** Runs after each batch of committed entries has been published, with the new head. */
    readonly onCommitted: (
      listener: (headCursor: number) => Effect.Effect<void>,
    ) => Effect.Effect<void, never, Scope.Scope>;
    /**
     * Resolves once everything committed so far has reached subscribers and
     * listeners. Never await it inside a transaction: it waits for that
     * transaction to end.
     */
    readonly flush: Effect.Effect<void>;
    /** Deletes entries past retention and returns the highest cursor removed, or 0. */
    readonly prune: (
      limits?: Partial<JournalRetentionLimits>,
    ) => Effect.Effect<number, AutomationError>;
  }
>()("t3/automation/events/JournalStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;

  const readHead = sql<{ readonly head: number | null }>`
    SELECT MAX(cursor) AS head FROM automation_journal
  `.pipe(Effect.map((rows) => rows[0]?.head ?? 0));

  const live = yield* PubSub.unbounded<AutomationJournalEntry>();
  const listeners = new Set<(headCursor: number) => Effect.Effect<void>>();
  // Appends signal here before their transaction commits. The publisher reads
  // outside any transaction, and this client serializes plain statements
  // behind an open transaction, so it sees the rows only after the commit and
  // sees nothing when the transaction rolled back.
  const signals = yield* Queue.unbounded<Deferred.Deferred<void> | undefined>();
  let published = yield* Effect.orDie(readHead);

  const publishCommitted = Effect.gen(function* () {
    let advanced = false;
    while (true) {
      const rows = yield* sql<JournalRow>`
        SELECT cursor, origin_cursor, event_json
        FROM automation_journal
        WHERE cursor > ${published}
        ORDER BY cursor
        LIMIT ${PUBLISH_PAGE_SIZE}
      `;
      const last = rows.at(-1);
      if (last === undefined) break;
      yield* PubSub.publishAll(live, rows.map(toEntry));
      published = last.cursor;
      advanced = true;
      if (rows.length < PUBLISH_PAGE_SIZE) break;
    }
    if (advanced) {
      yield* Effect.forEach(listeners, (listener) => listener(published), { discard: true });
    }
  });

  yield* Queue.takeAll(signals).pipe(
    Effect.map((taken) => taken.filter((item) => item !== undefined)),
    Effect.flatMap((waiters) =>
      publishCommitted.pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) => Effect.logWarning("Automation journal publisher failed", { cause }),
        ),
        Effect.ensuring(
          Effect.forEach(waiters, (waiter) => Deferred.succeed(waiter, undefined), {
            discard: true,
          }),
        ),
      ),
    ),
    Effect.forever,
    Effect.forkScoped,
  );

  const notify = Queue.offer(signals, undefined).pipe(Effect.asVoid);
  const flush = Effect.gen(function* () {
    const done = yield* Deferred.make<void>();
    yield* Queue.offer(signals, done);
    yield* Deferred.await(done);
  });

  const insertEvent = (event: StoredEvent, originCursor: number | null) => sql<{
    readonly cursor: number;
  }>`
    INSERT INTO automation_journal (
      event_id, type, origin_environment_id, origin_cursor, origin_kind,
      project_id, thread_id, parent_thread_id, root_thread_id, orchestrator_id, task_id, node_id,
      aggregate_kind, aggregate_id, aggregate_revision,
      correlation_id, causation_id, hops, occurred_at, recorded_at, event_json
    )
    VALUES (
      ${event.eventId},
      ${event.type},
      ${event.origin.environmentId},
      ${
        originCursor === null
          ? sql`(SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'automation_journal'), 0) + 1)`
          : originCursor
      },
      ${event.origin.kind},
      ${event.scope.projectId ?? null},
      ${event.scope.threadId ?? null},
      ${event.scope.parentThreadId ?? null},
      ${event.scope.rootThreadId ?? null},
      ${event.scope.orchestratorId ?? null},
      ${event.scope.taskId ?? null},
      ${event.scope.nodeId ?? event.origin.nodeId ?? null},
      ${event.aggregate.kind},
      ${event.aggregate.id},
      ${event.aggregate.revision},
      ${event.correlationId},
      ${event.causationId},
      ${event.hops},
      ${event.occurredAt},
      ${event.recordedAt},
      ${JSON.stringify(event)}
    )
    ON CONFLICT DO NOTHING
    RETURNING cursor
  `;

  const appendOne = Effect.fnUntraced(function* (input: EventJournalAppend, recordedAt: string) {
    if (input.dedupKey !== undefined) {
      const existing = yield* sql<JournalRow>`
        SELECT j.cursor, j.origin_cursor, j.event_json
        FROM automation_journal_dedup d
        JOIN automation_journal j ON j.cursor = d.cursor
        WHERE d.dedup_key = ${input.dedupKey}
      `;
      if (existing[0] !== undefined) return toEntry(existing[0]);
    }
    const revisions = yield* sql<{ readonly revision: number }>`
      INSERT INTO automation_aggregate_revisions (aggregate_kind, aggregate_id, revision)
      VALUES (${input.aggregate.kind}, ${input.aggregate.id}, 1)
      ON CONFLICT(aggregate_kind, aggregate_id) DO UPDATE SET revision = revision + 1
      RETURNING revision
    `;
    const eventId = EventId.make(yield* randomId);
    const event: StoredEvent = {
      version: AUTOMATION_CONTRACT_VERSION,
      eventId,
      type: input.type,
      origin: { ...input.origin, environmentId },
      scope: input.scope,
      aggregate: { ...input.aggregate, revision: revisions[0]?.revision ?? 1 },
      occurredAt: input.occurredAt ?? recordedAt,
      recordedAt,
      correlationId: input.causedBy?.correlationId ?? input.correlationId ?? eventId,
      causationId: input.causedBy?.eventId ?? null,
      hops: input.causedBy === undefined ? 0 : input.causedBy.hops + 1,
      payload: input.payload,
      ...(input.refs === undefined ? {} : { refs: input.refs }),
    };
    const inserted = yield* insertEvent(event, null);
    const cursor = inserted[0]?.cursor;
    if (cursor === undefined) {
      return yield* Effect.die(new Error(`Journal event ${eventId} collided with a stored event.`));
    }
    if (input.dedupKey !== undefined) {
      yield* sql`
        INSERT INTO automation_journal_dedup (dedup_key, cursor)
        VALUES (${input.dedupKey}, ${cursor})
        ON CONFLICT(dedup_key) DO UPDATE SET cursor = excluded.cursor
      `;
    }
    return { cursor, event: { ...event, originCursor: cursor } } satisfies AutomationJournalEntry;
  });

  const append: JournalStore["Service"]["append"] = Effect.fn("JournalStore.append")(
    function* (events) {
      if (events.length === 0) return [];
      for (const event of events) {
        const bytes = payloadBytes(event.payload);
        if (bytes > AUTOMATION_EVENT_MAX_PAYLOAD_BYTES) {
          return yield* payloadTooLarge(event.type, bytes);
        }
      }
      const recordedAt = DateTime.formatIso(yield* DateTime.now);
      const entries = yield* sql
        .withTransaction(
          Effect.forEach(events, (event) => appendOne(event, recordedAt), { concurrency: 1 }),
        )
        .pipe(Effect.catchTag("SqlError", storageFailure("record events")));
      yield* notify;
      return entries;
    },
  );

  const importPeerEntries: JournalStore["Service"]["importPeerEntries"] = Effect.fn(
    "JournalStore.importPeerEntries",
  )(function* (entries) {
    const foreign = entries.filter((entry) => entry.event.origin.environmentId !== environmentId);
    if (foreign.length === 0) return [];
    for (const entry of foreign) {
      const bytes = payloadBytes(entry.event.payload);
      if (bytes > AUTOMATION_EVENT_MAX_PAYLOAD_BYTES) {
        return yield* payloadTooLarge(entry.event.type, bytes);
      }
    }
    const stored = yield* sql
      .withTransaction(
        Effect.forEach(
          foreign,
          Effect.fnUntraced(function* (entry) {
            const { originCursor, ...event } = entry.event;
            // Looked up first: a refused insert would still use up a cursor.
            const existing = yield* sql<JournalRow>`
              SELECT cursor, origin_cursor, event_json
              FROM automation_journal
              WHERE (origin_environment_id = ${event.origin.environmentId}
                     AND origin_cursor = ${originCursor})
                 OR event_id = ${event.eventId}
              ORDER BY cursor
              LIMIT 1
            `;
            if (existing[0] !== undefined) return toEntry(existing[0]);
            const inserted = yield* insertEvent(event, originCursor);
            const cursor = inserted[0]?.cursor;
            return cursor === undefined ? undefined : { cursor, event: entry.event };
          }),
          { concurrency: 1 },
        ),
      )
      .pipe(Effect.catchTag("SqlError", storageFailure("store peer events")));
    yield* notify;
    return stored.filter((entry) => entry !== undefined);
  });

  const status: JournalStore["Service"]["status"] = Effect.gen(function* () {
    const rows = yield* sql<{
      readonly head: number | null;
      readonly oldest: number | null;
      readonly retained: number;
    }>`
      SELECT MAX(cursor) AS head, MIN(cursor) AS oldest, COUNT(*) AS retained
      FROM automation_journal
    `;
    return {
      environmentId,
      headCursor: rows[0]?.head ?? 0,
      oldestCursor: rows[0]?.oldest ?? null,
      retainedEntries: rows[0]?.retained ?? 0,
      observedAt: DateTime.formatIso(yield* DateTime.now),
    };
  }).pipe(Effect.catchTag("SqlError", storageFailure("report its status")));

  const assertRetained: JournalStore["Service"]["assertRetained"] = (afterCursor) =>
    sql<{ readonly oldest: number | null }>`
      SELECT MIN(cursor) AS oldest FROM automation_journal
    `.pipe(
      Effect.catchTag("SqlError", storageFailure("check retention")),
      Effect.flatMap((rows) => {
        const oldest = rows[0]?.oldest ?? null;
        return oldest !== null && afterCursor < oldest - 1
          ? Effect.fail(
              automationError(
                "CURSOR_EXPIRED",
                `Cursor ${afterCursor} is older than the journal keeps. The oldest retained entry is ${oldest}; continue from ${oldest - 1} and treat what lies between as lost.`,
                { requestedCursor: afterCursor, oldestCursor: oldest },
              ),
            )
          : Effect.void;
      }),
    );

  const filterClauses = (filter: AutomationEventFilter | undefined) => {
    const types = filter?.types ?? [];
    const clauses = [
      types.length === 0
        ? sql`type NOT IN ${sql.in(AUTOMATION_ADMINISTRATIVE_EVENT_TYPES)}`
        : sql.or(
            typeSelectors(types).map((selector) =>
              selector.kind === "exact"
                ? sql`type = ${selector.type}`
                : sql`substr(type, 1, ${selector.prefix.length}) = ${selector.prefix}`,
            ),
          ),
    ];
    const column = (name: string, values: ReadonlyArray<string> | undefined) => {
      if (values !== undefined && values.length > 0) clauses.push(sql.in(name, values));
    };
    column("origin_environment_id", filter?.originEnvironmentIds);
    column("node_id", filter?.nodeIds);
    column("project_id", filter?.projectIds);
    column("thread_id", filter?.threadIds);
    column("parent_thread_id", filter?.parentThreadIds);
    column("root_thread_id", filter?.rootThreadIds);
    column("orchestrator_id", filter?.orchestratorIds);
    column("task_id", filter?.taskIds);
    return clauses;
  };

  const page: JournalStore["Service"]["page"] = Effect.fn("JournalStore.page")(function* (input) {
    const filter = input.filter === "all" ? undefined : input.filter;
    const problem = filter === undefined ? null : filterProblem(filter);
    if (problem !== null) return yield* automationError("INVALID_INPUT", problem);
    if (input.throughCursor <= input.afterCursor) {
      return { entries: [], scannedThrough: input.afterCursor };
    }
    const rows = yield* sql<JournalRow>`
      SELECT cursor, origin_cursor, event_json
      FROM automation_journal
      WHERE cursor > ${input.afterCursor}
        AND cursor <= ${input.throughCursor}
        AND ${input.filter === "all" ? sql`1 = 1` : sql.and(filterClauses(filter))}
      ORDER BY cursor
      LIMIT ${input.limit}
    `.pipe(Effect.catchTag("SqlError", storageFailure("be read")));
    const last = rows.at(-1);
    return {
      entries: rows.map(toEntry),
      scannedThrough:
        rows.length < input.limit || last === undefined ? input.throughCursor : last.cursor,
    };
  });

  const findByEventId: JournalStore["Service"]["findByEventId"] = (eventId) =>
    sql<JournalRow>`
      SELECT cursor, origin_cursor, event_json
      FROM automation_journal
      WHERE event_id = ${eventId}
    `.pipe(
      Effect.catchTag("SqlError", storageFailure("be read")),
      Effect.map((rows) => (rows[0] === undefined ? undefined : toEntry(rows[0]))),
    );

  const prune: JournalStore["Service"]["prune"] = Effect.fn("JournalStore.prune")(
    function* (overrides) {
      const limits = { ...DEFAULT_RETENTION, ...overrides };
      const now = yield* DateTime.now;
      const cutoff = (ageMs: number) =>
        DateTime.formatIso(DateTime.subtract(now, { milliseconds: ageMs }));
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const bounds = yield* sql<{
              readonly head: number | null;
              readonly oldest: number | null;
            }>`SELECT MAX(cursor) AS head, MIN(cursor) AS oldest FROM automation_journal`;
            const head = bounds[0]?.head ?? 0;
            const oldest = bounds[0]?.oldest ?? 0;
            if (head <= 1) return 0;
            const aged = yield* sql<{
              readonly soft: number | null;
              readonly hard: number | null;
            }>`
              SELECT
                (SELECT MAX(cursor) FROM automation_journal
                  WHERE recorded_at < ${cutoff(limits.maxAgeMs)}) AS soft,
                (SELECT MAX(cursor) FROM automation_journal
                  WHERE recorded_at < ${cutoff(limits.hardMaxAgeMs)}) AS hard
            `;
            const wanted = Math.max(head - limits.maxEntries, aged[0]?.soft ?? 0);
            const forced = Math.max(head - limits.hardMaxEntries, aged[0]?.hard ?? 0);
            // What a durable reader has not consumed yet. A consumer or hook at
            // cursor N has read through N, so entries up to N may go.
            const held = yield* sql<{ readonly cursor: number | null }>`
              SELECT MIN(cursor) AS cursor FROM (
                SELECT cursor FROM automation_consumers
                UNION ALL
                SELECT cursor FROM automation_hooks WHERE enabled = 1
                UNION ALL
                SELECT forwarded_cursor AS cursor FROM automation_peers WHERE enabled = 1
                UNION ALL
                SELECT first_cursor - 1 AS cursor FROM automation_hook_deliveries
                WHERE status IN ('pending', 'delivering', 'retrying', 'failed', 'suppressed')
              )
            `;
            const protectedThrough = held[0]?.cursor ?? Number.POSITIVE_INFINITY;
            // The newest entry always stays, so the oldest retained cursor
            // keeps telling a late reader how much it missed.
            const through = Math.min(wanted, Math.max(protectedThrough, forced), head - 1);
            if (through < oldest) return 0;
            yield* sql`DELETE FROM automation_journal WHERE cursor <= ${through}`;
            yield* sql`DELETE FROM automation_journal_dedup WHERE cursor <= ${through}`;
            return through;
          }),
        )
        .pipe(Effect.catchTag("SqlError", storageFailure("be pruned")));
    },
  );

  return JournalStore.of({
    environmentId,
    append,
    importPeerEntries,
    status,
    assertRetained,
    page,
    findByEventId,
    live: PubSub.subscribe(live),
    onCommitted: (listener) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          listeners.add(listener);
        }),
        () =>
          Effect.sync(() => {
            listeners.delete(listener);
          }),
      ),
    flush,
    prune,
  });
});

export const layer = Layer.effect(JournalStore, make);
