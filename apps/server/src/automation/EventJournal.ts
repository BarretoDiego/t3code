import {
  CUSTOM_EVENT_TYPE_PATTERN,
  type AutomationError,
  type AutomationEvent,
  type AutomationEventEmitInput,
  type AutomationEventEmitResult,
  type AutomationEventFilter,
  type AutomationEventsReadInput,
  type AutomationEventsReadResult,
  type AutomationEventsStreamItem,
  type AutomationEventsSubscribeInput,
  AutomationJournalEntry,
  type AutomationJournalStatus,
  type EventConsumer,
  type EventConsumerAckInput,
  type EventConsumerId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { type AutomationCaller, automationError } from "./Caller.ts";
import { filterProblem, matchesFilter } from "./events/filter.ts";
import * as JournalStore from "./events/JournalStore.ts";
import { makeOrchestratorAccess } from "./orchestrator/Access.ts";
import { makeStore } from "./orchestrator/Store.ts";

/**
 * An event a server component records. The journal assigns `eventId`, cursors,
 * the origin environment, `recordedAt`, and the aggregate revision.
 */
export type EventJournalAppend = Pick<AutomationEvent, "type" | "scope" | "payload"> & {
  readonly origin: Omit<AutomationEvent["origin"], "environmentId">;
  readonly aggregate: Omit<AutomationEvent["aggregate"], "revision">;
  readonly occurredAt?: AutomationEvent["occurredAt"];
  readonly correlationId?: AutomationEvent["correlationId"];
  /** The event this one reacts to. Its hop count carries over, plus one. */
  readonly causedBy?: Pick<AutomationEvent, "eventId" | "correlationId" | "hops">;
  readonly refs?: AutomationEvent["refs"];
  /** Stable key that makes a repeated append return the first entry. */
  readonly dedupKey?: string;
};

/** The environment's durable, cursor-addressed journal of public automation events. */
export class EventJournal extends Context.Service<
  EventJournal,
  {
    readonly status: Effect.Effect<AutomationJournalStatus, AutomationError>;
    readonly read: (
      caller: AutomationCaller,
      input: AutomationEventsReadInput,
    ) => Effect.Effect<AutomationEventsReadResult, AutomationError>;
    readonly subscribe: (
      caller: AutomationCaller,
      input: AutomationEventsSubscribeInput,
    ) => Stream.Stream<AutomationEventsStreamItem, AutomationError>;
    readonly emit: (
      caller: AutomationCaller,
      input: AutomationEventEmitInput,
    ) => Effect.Effect<AutomationEventEmitResult, AutomationError>;
    readonly append: (
      events: ReadonlyArray<EventJournalAppend>,
    ) => Effect.Effect<ReadonlyArray<AutomationJournalEntry>, AutomationError>;
    readonly importPeerEntries: (
      entries: ReadonlyArray<AutomationJournalEntry>,
    ) => Effect.Effect<ReadonlyArray<AutomationJournalEntry>, AutomationError>;
    readonly listConsumers: (
      caller: AutomationCaller,
    ) => Effect.Effect<ReadonlyArray<EventConsumer>, AutomationError>;
    readonly ackConsumer: (
      caller: AutomationCaller,
      input: EventConsumerAckInput,
    ) => Effect.Effect<EventConsumer, AutomationError>;
    readonly deleteConsumer: (
      caller: AutomationCaller,
      input: EventConsumerId,
    ) => Effect.Effect<boolean, AutomationError>;
  }
>()("t3/automation/EventJournal") {}

const DEFAULT_READ_LIMIT = 200;
const REPLAY_PAGE_SIZE = 256;
const EMIT_IDEMPOTENCY_SCOPE = "events.emit";

const StoredEntryJson = Schema.fromJsonString(AutomationJournalEntry);
const decodeStoredEntry = Schema.decodeUnknownEffect(StoredEntryJson);
const encodeStoredEntry = Schema.encodeEffect(StoredEntryJson);

interface ConsumerRow {
  readonly consumer_id: EventConsumerId;
  readonly cursor: number;
  readonly updated_at: string;
}

const toConsumer = (row: ConsumerRow): EventConsumer => ({
  consumerId: row.consumer_id,
  cursor: row.cursor,
  updatedAt: row.updated_at,
});

const storageFailure = (operation: string) => (cause: SqlError) =>
  Effect.logWarning("Automation journal storage failed", { operation, cause }).pipe(
    Effect.andThen(
      Effect.fail(automationError("INTERNAL", `The event journal could not ${operation}.`)),
    ),
  );

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* JournalStore.JournalStore;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const access = makeOrchestratorAccess(makeStore(sql), yield* environment.getEnvironmentId);

  const checkFilter = (filter: AutomationEventFilter | undefined) => {
    const problem = filter === undefined ? null : filterProblem(filter);
    return problem === null ? Effect.void : Effect.fail(automationError("INVALID_INPUT", problem));
  };

  const read: EventJournal["Service"]["read"] = Effect.fn("EventJournal.read")(
    function* (_caller, input) {
      yield* checkFilter(input.filter);
      const status = yield* store.status;
      if (input.afterCursor !== undefined) yield* store.assertRetained(input.afterCursor);
      const afterCursor =
        input.afterCursor ?? (status.oldestCursor === null ? 0 : status.oldestCursor - 1);
      const page = yield* store.page({
        afterCursor,
        throughCursor: status.headCursor,
        filter: input.filter,
        limit: input.limit ?? DEFAULT_READ_LIMIT,
      });
      return {
        entries: page.entries,
        nextCursor: Math.max(afterCursor, page.scannedThrough),
        status,
      };
    },
  );

  const replay = (
    afterCursor: number,
    throughCursor: number,
    filter: AutomationEventFilter | undefined,
  ) =>
    Stream.paginate(afterCursor, (cursor) =>
      Effect.map(
        store.page({ afterCursor: cursor, throughCursor, filter, limit: REPLAY_PAGE_SIZE }),
        (page) =>
          [
            page.entries,
            page.scannedThrough >= throughCursor
              ? Option.none<number>()
              : Option.some(page.scannedThrough),
          ] as const,
      ),
    );

  const readConsumer = (consumerId: EventConsumerId) =>
    sql<ConsumerRow>`
      SELECT consumer_id, cursor, updated_at
      FROM automation_consumers
      WHERE consumer_id = ${consumerId}
    `.pipe(
      Effect.catchTags({ SqlError: storageFailure("read the consumer") }),
      Effect.map((rows) => rows[0]),
    );

  /** A named consumer exists from its first subscription on, at the cursor it started from. */
  const consumerStart = Effect.fnUntraced(function* (
    consumerId: EventConsumerId,
    afterCursor: number | undefined,
    headCursor: number,
  ) {
    const existing = yield* readConsumer(consumerId);
    if (existing !== undefined) return afterCursor ?? existing.cursor;
    const start = afterCursor ?? headCursor;
    yield* sql`
      INSERT INTO automation_consumers (consumer_id, cursor, updated_at)
      VALUES (${consumerId}, ${start}, ${DateTime.formatIso(yield* DateTime.now)})
      ON CONFLICT(consumer_id) DO NOTHING
    `.pipe(Effect.catchTags({ SqlError: storageFailure("create the consumer") }));
    return start;
  });

  const subscribe: EventJournal["Service"]["subscribe"] = (_caller, input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        yield* checkFilter(input.filter);
        // Subscribe before reading the head: an entry committed in between is
        // then either at or below the head (replayed, and dropped from live)
        // or above it (delivered live), never both and never neither.
        const subscription = yield* store.live;
        const { headCursor } = yield* store.status;
        const start =
          input.consumerId === undefined
            ? (input.afterCursor ?? headCursor)
            : yield* consumerStart(input.consumerId, input.afterCursor, headCursor);
        yield* store.assertRetained(start);
        const liveAfter = Math.max(start, headCursor);
        const toItem = (entry: AutomationJournalEntry): AutomationEventsStreamItem => ({
          type: "entry",
          entry,
        });
        return Stream.concat(
          Stream.concat(
            Stream.map(replay(start, headCursor, input.filter), toItem),
            Stream.succeed<AutomationEventsStreamItem>({ type: "live", cursor: liveAfter }),
          ),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter(
              (entry) => entry.cursor > liveAfter && matchesFilter(entry.event, input.filter),
            ),
            Stream.map(toItem),
          ),
        );
      }),
    );

  const emit: EventJournal["Service"]["emit"] = Effect.fn("EventJournal.emit")(
    function* (caller, input) {
      if (caller.kind === "peer") {
        return yield* automationError(
          "PERMISSION_DENIED",
          "A peer forwards events from its own journal; it cannot emit into this one.",
        );
      }
      // An orchestrator's agent needs event.emit, may name only projects in its
      // scope, and cannot publish an event as being about another orchestrator.
      yield* access.authorize(caller, "event.emit", { projectId: input.scope?.projectId });
      if (
        caller.kind === "orchestrator" &&
        input.scope?.orchestratorId !== undefined &&
        input.scope.orchestratorId !== caller.orchestratorId
      ) {
        return yield* automationError(
          "PERMISSION_DENIED",
          `Orchestrator ${caller.orchestratorId} cannot emit an event scoped to another orchestrator.`,
          { orchestratorId: caller.orchestratorId },
        );
      }
      const type: string = input.type;
      if (!CUSTOM_EVENT_TYPE_PATTERN.test(type)) {
        return yield* type.startsWith("custom.")
          ? automationError(
              "INVALID_INPUT",
              `'${type}' is not a valid custom event type. Use custom.<namespace>.<name> in lowercase.`,
            )
          : automationError(
              "PERMISSION_DENIED",
              `'${type}' is produced only by the server. Emit a custom.<namespace>.<name> event instead.`,
              { type },
            );
      }
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const repeated = yield* sql<{ readonly result_json: string }>`
              SELECT result_json
              FROM automation_idempotency
              WHERE scope = ${EMIT_IDEMPOTENCY_SCOPE}
                AND idempotency_key = ${input.idempotencyKey}
            `;
            if (repeated[0] !== undefined) {
              const entry = yield* Effect.orDie(decodeStoredEntry(repeated[0].result_json));
              return { entry, created: false };
            }
            const cause =
              input.causationId === undefined
                ? undefined
                : yield* store.findByEventId(input.causationId);
            if (input.causationId !== undefined && cause === undefined) {
              return yield* automationError(
                "INVALID_INPUT",
                `causationId ${input.causationId} does not name an event this journal holds.`,
                { causationId: input.causationId },
              );
            }
            const [entry] = yield* store.append([
              {
                type: input.type,
                // The origin is what the session proves, never what the body says.
                origin: {
                  kind: "custom",
                  actorId: caller.subject,
                  ...(input.nodeId === undefined ? {} : { nodeId: input.nodeId }),
                },
                scope: input.scope ?? {},
                aggregate: { kind: "custom", id: input.type },
                payload: input.payload ?? {},
                ...(input.correlationId === undefined
                  ? {}
                  : { correlationId: input.correlationId }),
                ...(cause === undefined ? {} : { causedBy: cause.event }),
                ...(input.refs === undefined ? {} : { refs: input.refs }),
              },
            ]);
            if (entry === undefined) {
              return yield* Effect.die(new Error("The journal recorded no entry for an emit."));
            }
            const stored = yield* Effect.orDie(encodeStoredEntry(entry));
            yield* sql`
              INSERT INTO automation_idempotency (scope, idempotency_key, result_json, created_at)
              VALUES (
                ${EMIT_IDEMPOTENCY_SCOPE},
                ${input.idempotencyKey},
                ${stored},
                ${entry.event.recordedAt}
              )
            `;
            return { entry, created: true };
          }),
        )
        .pipe(Effect.catchTags({ SqlError: storageFailure("record the event") }));
    },
  );

  const listConsumers: EventJournal["Service"]["listConsumers"] = () =>
    sql<ConsumerRow>`
      SELECT consumer_id, cursor, updated_at
      FROM automation_consumers
      ORDER BY consumer_id
    `.pipe(
      Effect.catchTags({ SqlError: storageFailure("list consumers") }),
      Effect.map((rows) => rows.map(toConsumer)),
    );

  const ackConsumer: EventJournal["Service"]["ackConsumer"] = Effect.fn("EventJournal.ackConsumer")(
    function* (_caller, input) {
      const { headCursor } = yield* store.status;
      if (input.cursor > headCursor) {
        return yield* automationError(
          "INVALID_INPUT",
          `Cursor ${input.cursor} is past the journal head ${headCursor}.`,
          { cursor: input.cursor, headCursor },
        );
      }
      const now = DateTime.formatIso(yield* DateTime.now);
      // An acknowledgement that arrives late or twice never moves the consumer back.
      const rows = yield* sql<ConsumerRow>`
      INSERT INTO automation_consumers (consumer_id, cursor, updated_at)
      VALUES (${input.consumerId}, ${input.cursor}, ${now})
      ON CONFLICT(consumer_id) DO UPDATE SET
        updated_at = CASE WHEN excluded.cursor > cursor THEN excluded.updated_at ELSE updated_at END,
        cursor = MAX(cursor, excluded.cursor)
      RETURNING consumer_id, cursor, updated_at
    `.pipe(Effect.catchTags({ SqlError: storageFailure("acknowledge the cursor") }));
      const row = rows[0];
      if (row === undefined) {
        return yield* Effect.die(new Error(`Consumer ${input.consumerId} was not stored.`));
      }
      return toConsumer(row);
    },
  );

  const deleteConsumer: EventJournal["Service"]["deleteConsumer"] = (_caller, consumerId) =>
    sql<{ readonly consumer_id: string }>`
      DELETE FROM automation_consumers
      WHERE consumer_id = ${consumerId}
      RETURNING consumer_id
    `.pipe(
      Effect.catchTags({ SqlError: storageFailure("delete the consumer") }),
      Effect.map((rows) => rows.length > 0),
    );

  return EventJournal.of({
    status: store.status,
    read,
    subscribe,
    emit,
    append: store.append,
    importPeerEntries: store.importPeerEntries,
    listConsumers,
    ackConsumer,
    deleteConsumer,
  });
});

/**
 * The journal together with its store. Needs `SqlClient` and
 * `ServerEnvironment`; hooks and retention read the store it also provides.
 */
export const layer = Layer.effect(EventJournal, make).pipe(Layer.provideMerge(JournalStore.layer));
