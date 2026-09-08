import {
  ThreadHandoffError,
  ThreadHandoffRecord,
  type ThreadHandoffId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { committedOwner, transitionHandoff } from "./lifecycle.ts";

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(ThreadHandoffRecord));
const encode = Schema.encodeEffect(Schema.fromJsonString(ThreadHandoffRecord));
const isHandoffError = Schema.is(ThreadHandoffError);

/** The journal shares the orchestration database. Callers must serialize
 * freezing with command dispatch, then drain provider/checkpoint receipts.
 * Revisions protect retries and competing clients; time never expires a fence. */
export const makeHandoffJournal = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const get = Effect.fn("HandoffJournal.get")(function* (handoffId: ThreadHandoffId) {
    const rows = yield* sql<{ readonly record_json: string }>`
      SELECT record_json FROM thread_handoffs WHERE handoff_id = ${handoffId}
    `;
    return rows[0] ? yield* decode(rows[0].record_json) : null;
  });
  const head = Effect.fn("HandoffJournal.head")(function* (threadId: ThreadId) {
    const rows = yield* sql<{ readonly record_json: string }>`
      SELECT h.record_json FROM thread_handoffs h JOIN thread_handoff_heads t
      ON t.handoff_id = h.handoff_id WHERE t.thread_id = ${threadId}
    `;
    return rows[0] ? yield* decode(rows[0].record_json) : null;
  });
  const begin = Effect.fn("HandoffJournal.begin")(function* (record: ThreadHandoffRecord) {
    if (
      record.phase !== "preflighting" ||
      record.revision !== 0 ||
      record.owner.environmentId === record.destinationEnvironmentId ||
      (record.localEnvironmentId !== undefined &&
        record.localEnvironmentId !== record.owner.environmentId)
    )
      return yield* new ThreadHandoffError({
        code: "conflict",
        message: "Invalid initial handoff state.",
      });
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const encoded = yield* encode(record);
        const existing = yield* get(record.handoffId);
        if (existing) {
          if (
            existing.owner.threadId === record.owner.threadId &&
            existing.owner.environmentId === record.owner.environmentId &&
            existing.localEnvironmentId === record.localEnvironmentId &&
            existing.owner.generation === record.owner.generation &&
            existing.destinationEnvironmentId === record.destinationEnvironmentId
          )
            return existing;
          return yield* new ThreadHandoffError({
            code: "conflict",
            message: "Handoff ID already belongs to another request.",
          });
        }
        const previous = yield* head(record.owner.threadId);
        if (previous) {
          const owner = committedOwner(previous);
          if (
            owner.environmentId !== record.owner.environmentId ||
            owner.generation !== record.owner.generation ||
            (previous.localEnvironmentId !== undefined &&
              previous.localEnvironmentId !== record.owner.environmentId)
          ) {
            return yield* new ThreadHandoffError({
              code: "notOwner",
              message: "The requested execution owner is stale.",
            });
          }
          if (!["completed", "failed", "cancelled"].includes(previous.phase)) {
            return yield* new ThreadHandoffError({
              code: "busy",
              message: "Another handoff is pending for this thread.",
            });
          }
        }
        yield* sql`INSERT INTO thread_handoffs (handoff_id, thread_id, revision, phase, record_json)
        VALUES (${record.handoffId}, ${record.owner.threadId}, ${record.revision}, ${record.phase}, ${encoded})`;
        yield* sql`INSERT INTO thread_handoff_heads (thread_id, handoff_id)
        VALUES (${record.owner.threadId}, ${record.handoffId})
        ON CONFLICT(thread_id) DO UPDATE SET handoff_id = excluded.handoff_id`;
        return record;
      }),
    );
  });
  const advance = Effect.fn("HandoffJournal.advance")(function* (input: {
    readonly handoffId: ThreadHandoffId;
    readonly expectedRevision: number;
    readonly phase: ThreadHandoffRecord["phase"];
    readonly updatedAt: string;
    readonly failure?: string;
  }) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const record = yield* get(input.handoffId);
        if (!record)
          return yield* new ThreadHandoffError({ code: "conflict", message: "Unknown handoff." });
        if (
          record.localEnvironmentId === record.destinationEnvironmentId &&
          record.phase !== "committed" &&
          record.phase !== "completed"
        ) {
          return yield* new ThreadHandoffError({
            code: "notOwner",
            message: "A destination reservation cannot advance source execution.",
          });
        }
        if (
          record.revision === input.expectedRevision + 1 &&
          record.phase === input.phase &&
          (input.failure === undefined || input.failure === record.failure)
        )
          return record;
        if (record.revision !== input.expectedRevision) {
          return yield* new ThreadHandoffError({
            code: "conflict",
            message: "Handoff revision is stale.",
          });
        }
        const next = yield* Effect.try({
          try: () => transitionHandoff(record, input.phase, input.updatedAt, input.failure),
          catch: (error) =>
            isHandoffError(error)
              ? error
              : new ThreadHandoffError({
                  code: "conflict",
                  message: "Invalid handoff transition.",
                }),
        });
        const encoded = yield* encode(next);
        const changed = yield* sql<{ readonly handoff_id: string }>`UPDATE thread_handoffs
        SET phase = ${next.phase}, revision = ${next.revision}, record_json = ${encoded}
        WHERE handoff_id = ${next.handoffId} AND revision = ${input.expectedRevision}
        RETURNING handoff_id`;
        if (changed.length !== 1)
          return yield* new ThreadHandoffError({
            code: "conflict",
            message: "Handoff changed concurrently.",
          });
        return next;
      }),
    );
  });
  const sameIncomingIdentity = (left: ThreadHandoffRecord, right: ThreadHandoffRecord) =>
    left.owner.threadId === right.owner.threadId &&
    left.owner.environmentId === right.owner.environmentId &&
    left.owner.generation === right.owner.generation &&
    left.localEnvironmentId === right.localEnvironmentId &&
    left.destinationEnvironmentId === right.destinationEnvironmentId;

  /** Reserve the destination before touching its workspace or thread history.
   * Ownership stays remote throughout preparation, cancellation and retries. */
  const reserveIncoming = Effect.fn("HandoffJournal.reserveIncoming")(function* (
    record: ThreadHandoffRecord,
  ) {
    if (
      record.phase !== "preflighting" ||
      record.revision !== 0 ||
      record.localEnvironmentId !== record.destinationEnvironmentId ||
      record.owner.environmentId === record.destinationEnvironmentId
    ) {
      return yield* new ThreadHandoffError({
        code: "conflict",
        message: "Invalid incoming handoff reservation.",
      });
    }
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const existing = yield* get(record.handoffId);
        const previous = yield* head(record.owner.threadId);
        if (existing) {
          if (
            !sameIncomingIdentity(existing, record) ||
            previous?.handoffId !== existing.handoffId ||
            existing.phase !== "preflighting"
          ) {
            return yield* new ThreadHandoffError({
              code: "conflict",
              message: "Incoming reservation is no longer preparable.",
            });
          }
          return existing;
        }
        if (previous) {
          const owner = committedOwner(previous);
          if (
            !["completed", "failed", "cancelled"].includes(previous.phase) ||
            owner.environmentId === record.destinationEnvironmentId ||
            owner.generation > record.owner.generation ||
            (owner.generation === record.owner.generation &&
              owner.environmentId !== record.owner.environmentId) ||
            (previous.localEnvironmentId !== undefined &&
              previous.localEnvironmentId !== record.localEnvironmentId)
          ) {
            return yield* new ThreadHandoffError({
              code: "conflict",
              message:
                "Destination already owns this thread, has pending work, or received stale ownership.",
            });
          }
        }
        const encoded = yield* encode(record);
        yield* sql`INSERT INTO thread_handoffs (handoff_id, thread_id, revision, phase, record_json)
        VALUES (${record.handoffId}, ${record.owner.threadId}, ${record.revision}, ${record.phase}, ${encoded})`;
        yield* sql`INSERT INTO thread_handoff_heads (thread_id, handoff_id)
        VALUES (${record.owner.threadId}, ${record.handoffId})
        ON CONFLICT(thread_id) DO UPDATE SET handoff_id = excluded.handoff_id`;
        return record;
      }),
    );
  });

  const rejectIncoming = Effect.fn("HandoffJournal.rejectIncoming")(function* (
    handoffId: ThreadHandoffId,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const record = yield* get(handoffId);
        if (
          !record ||
          record.localEnvironmentId !== record.destinationEnvironmentId ||
          record.owner.environmentId === record.destinationEnvironmentId ||
          record.phase === "committed" ||
          record.phase === "completed"
        ) {
          return yield* new ThreadHandoffError({
            code: "conflict",
            message: "Only an uncommitted destination reservation can be rejected.",
          });
        }
        if (record.phase === "cancelled" || record.phase === "failed") return record;
        const current = yield* head(record.owner.threadId);
        if (current?.handoffId !== handoffId)
          return yield* new ThreadHandoffError({
            code: "conflict",
            message: "Incoming reservation is no longer current.",
          });
        const next: ThreadHandoffRecord = {
          ...record,
          phase: "cancelled",
          revision: record.revision + 1,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        };
        const encoded = yield* encode(next);
        const changed = yield* sql<{ readonly handoff_id: string }>`UPDATE thread_handoffs
        SET phase = ${next.phase}, revision = ${next.revision}, record_json = ${encoded}
        WHERE handoff_id = ${handoffId} AND revision = ${record.revision} RETURNING handoff_id`;
        if (changed.length !== 1)
          return yield* new ThreadHandoffError({
            code: "conflict",
            message: "Incoming reservation changed concurrently.",
          });
        return next;
      }),
    );
  });
  /** Incoming records are authenticated by the transport before reaching here.
   * Always read the durable head: another database handle can advance ownership. */
  const acceptIncoming = Effect.fn("HandoffJournal.acceptIncoming")(function* (
    record: ThreadHandoffRecord,
  ) {
    if (
      (record.phase !== "committed" && record.phase !== "completed") ||
      record.localEnvironmentId !== record.destinationEnvironmentId ||
      record.owner.environmentId === record.destinationEnvironmentId
    ) {
      return yield* new ThreadHandoffError({
        code: "conflict",
        message: "Only a committed handoff can activate on its destination.",
      });
    }
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const encoded = yield* encode(record);
        const existing = yield* get(record.handoffId);
        const previous = yield* head(record.owner.threadId);
        if (existing) {
          if (
            existing.owner.threadId !== record.owner.threadId ||
            existing.owner.environmentId !== record.owner.environmentId ||
            existing.destinationEnvironmentId !== record.destinationEnvironmentId ||
            existing.localEnvironmentId !== record.localEnvironmentId ||
            existing.owner.generation !== record.owner.generation ||
            (existing.phase !== "preflighting" &&
              existing.phase !== "committed" &&
              existing.phase !== "completed") ||
            previous?.handoffId !== existing.handoffId
          ) {
            return yield* new ThreadHandoffError({
              code: "conflict",
              message: "Incoming handoff conflicts with current persisted ownership.",
            });
          }
          if (existing.phase === "preflighting") {
            if (record.revision <= existing.revision)
              return yield* new ThreadHandoffError({
                code: "conflict",
                message: "Incoming commit revision must advance the reservation.",
              });
            const changed = yield* sql<{ readonly handoff_id: string }>`UPDATE thread_handoffs
              SET phase = ${record.phase}, revision = ${record.revision}, record_json = ${encoded}
              WHERE handoff_id = ${record.handoffId} AND revision = ${existing.revision} RETURNING handoff_id`;
            if (changed.length !== 1)
              return yield* new ThreadHandoffError({
                code: "conflict",
                message: "Incoming reservation changed concurrently.",
              });
            return record;
          }
          if (record.revision > existing.revision) {
            if (existing.phase !== "committed" || record.phase !== "completed")
              return yield* new ThreadHandoffError({
                code: "conflict",
                message: "Incoming ownership cannot regress its committed state.",
              });
            yield* sql`UPDATE thread_handoffs SET phase = ${record.phase}, revision = ${record.revision}, record_json = ${encoded} WHERE handoff_id = ${record.handoffId} AND revision = ${existing.revision}`;
            return record;
          }
          return existing;
        }
        if (previous) {
          const owner = committedOwner(previous);
          // This environment may have missed intermediate transfers. At the
          // immediately following generation, however, the source must match.
          if (
            !["completed", "failed", "cancelled"].includes(previous.phase) ||
            owner.generation > record.owner.generation ||
            (owner.generation === record.owner.generation &&
              owner.environmentId !== record.owner.environmentId) ||
            (previous.localEnvironmentId !== undefined &&
              previous.localEnvironmentId !== record.localEnvironmentId)
          ) {
            return yield* new ThreadHandoffError({
              code: "conflict",
              message: "Incoming ownership is stale or another transfer is pending.",
            });
          }
        }
        yield* sql`INSERT INTO thread_handoffs (handoff_id, thread_id, revision, phase, record_json)
        VALUES (${record.handoffId}, ${record.owner.threadId}, ${record.revision}, ${record.phase}, ${encoded})`;
        yield* sql`INSERT INTO thread_handoff_heads (thread_id, handoff_id)
        VALUES (${record.owner.threadId}, ${record.handoffId})
        ON CONFLICT(thread_id) DO UPDATE SET handoff_id = excluded.handoff_id`;
        return record;
      }),
    );
  });
  return { get, head, begin, advance, reserveIncoming, rejectIncoming, acceptIncoming };
});
