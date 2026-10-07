import {
  AutomationError,
  AutomationErrorCode,
  type EnvironmentId,
  PeerCapabilities,
  PeerConnectionStatus,
  PeerMessage,
  type PeerMessageId,
  type PeerOutboxEntry,
  type PeerOutboxStatus,
  PeerPermissions,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { automationError } from "../Caller.ts";

/** Everything stored about a peer except its credential, which lives in the secret store. */
export interface PeerRecord {
  readonly environmentId: EnvironmentId;
  readonly name: string;
  readonly enabled: boolean;
  readonly detail: PeerDetail;
  /** Highest origin cursor of the peer's journal entries imported here. */
  readonly inboundCursor: number;
  /** Local journal cursor forwarded to the peer through. */
  readonly forwardedCursor: number;
  readonly nextOutboundSequence: number;
  /** Highest outbox sequence the peer confirmed it stored. */
  readonly ackedThroughSequence: number;
  /** Highest sequence of the peer's messages stored in the inbox here. */
  readonly receivedThroughSequence: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const PeerDetail = Schema.Struct({
  httpBaseUrl: Schema.String,
  permissions: PeerPermissions,
  status: PeerConnectionStatus,
  statusReason: Schema.NullOr(Schema.String),
  negotiatedProtocolVersion: Schema.NullOr(Schema.Int),
  capabilities: Schema.NullOr(PeerCapabilities),
  lastConnectedAt: Schema.NullOr(Schema.String),
  lastObservedAt: Schema.NullOr(Schema.String),
});
export type PeerDetail = typeof PeerDetail.Type;

const PeerDetailJson = Schema.fromJsonString(PeerDetail);
const decodeDetail = Schema.decodeUnknownEffect(PeerDetailJson);
const encodeDetail = Schema.encodeEffect(PeerDetailJson);
const PeerMessageJson = Schema.fromJsonString(PeerMessage);
const decodeMessage = Schema.decodeUnknownEffect(PeerMessageJson);
const encodeMessage = Schema.encodeEffect(PeerMessageJson);
const isErrorCode = Schema.is(AutomationErrorCode);
const isAutomationError = Schema.is(AutomationError);

/**
 * `stored` waits for the processor. A rejection moves through `rejected`
 * (not yet told to the peer), `rejected_sent` (included in a response whose
 * arrival is unconfirmed) and `rejected_reported`.
 */
export type PeerInboxStatus =
  | "stored"
  | "processed"
  | "rejected"
  | "rejected_sent"
  | "rejected_reported";

export interface PeerInboxRow {
  readonly peerEnvironmentId: EnvironmentId;
  readonly message: PeerMessage;
  readonly status: PeerInboxStatus;
  readonly rejection: PeerRejection | null;
}

export interface PeerRejection {
  readonly messageId: PeerMessageId;
  readonly code: AutomationErrorCode;
  readonly message: string;
}

export type PeerSignal =
  | { readonly type: "outbound"; readonly environmentId: EnvironmentId }
  | { readonly type: "inbound" };

interface PeerRow {
  readonly environment_id: string;
  readonly name: string;
  readonly enabled: number;
  readonly peer_json: string;
  readonly inbound_cursor: number;
  readonly forwarded_cursor: number;
  readonly next_outbound_sequence: number;
  readonly acked_through_sequence: number;
  readonly received_through_sequence: number;
  readonly created_at: string;
  readonly updated_at: string;
}

interface OutboxRow {
  readonly message_json: string;
  readonly status: string;
  readonly attempt_count: number;
  readonly last_error: string | null;
  readonly rejection: string | null;
  readonly updated_at: string;
}

interface InboxRow {
  readonly peer_environment_id: string;
  readonly status: string;
  readonly message_json: string;
  readonly error: string | null;
}

const RejectionJson = Schema.fromJsonString(
  Schema.Struct({ code: AutomationErrorCode, message: Schema.String }),
);
const decodeRejection = Schema.decodeUnknownOption(RejectionJson);
const encodeRejection = Schema.encodeSync(RejectionJson);

/** Inbox rows are keyed per peer so one peer cannot occupy another's message ids. */
const inboxKey = (peer: EnvironmentId, messageId: PeerMessageId) => `${peer}/${messageId}`;

const storageFailure = (operation: string) => (cause: unknown) =>
  Effect.logError("Peer storage failed", { operation, cause }).pipe(
    Effect.andThen(
      Effect.fail(automationError("INTERNAL", `Peer storage failed during ${operation}.`)),
    ),
  );

/** Durable peer rows, the per-peer outbox and inbox, and the wake-up signal for the link workers. */
export class PeerStore extends Context.Service<
  PeerStore,
  {
    readonly list: Effect.Effect<ReadonlyArray<PeerRecord>, AutomationError>;
    readonly get: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<PeerRecord | null, AutomationError>;
    readonly insert: (
      record: Pick<PeerRecord, "environmentId" | "name" | "enabled" | "detail" | "createdAt">,
    ) => Effect.Effect<void, AutomationError>;
    readonly update: (
      environmentId: EnvironmentId,
      patch: {
        readonly name?: string;
        readonly enabled?: boolean;
        /** Applied to the stored detail inside the write, so concurrent writers do not undo each other. */
        readonly detail?: (current: PeerDetail) => PeerDetail;
        readonly inboundCursor?: number;
        readonly forwardedCursor?: number;
        readonly ackedThroughSequence?: number;
        readonly updatedAt: string;
      },
    ) => Effect.Effect<void, AutomationError>;
    /** Deletes the peer and cancels what was still waiting to be sent to it. */
    readonly remove: (
      environmentId: EnvironmentId,
      now: string,
    ) => Effect.Effect<boolean, AutomationError>;
    /**
     * Assigns the next sequence and stores the message, or returns the stored
     * one when `messageId` was enqueued before. `forwardedCursor` advances in
     * the same transaction when the message carries forwarded events.
     */
    readonly enqueue: (input: {
      readonly environmentId: EnvironmentId;
      readonly messageId: PeerMessageId;
      readonly build: (sequence: number) => PeerMessage;
      readonly forwardedCursor?: number;
      readonly now: string;
    }) => Effect.Effect<
      { readonly message: PeerMessage; readonly created: boolean },
      AutomationError
    >;
    readonly outbox: (input: {
      readonly environmentId?: EnvironmentId | undefined;
      readonly statuses?: ReadonlyArray<PeerOutboxStatus> | undefined;
      readonly limit: number;
    }) => Effect.Effect<ReadonlyArray<PeerOutboxEntry>, AutomationError>;
    readonly pendingCount: (
      environmentId?: EnvironmentId,
    ) => Effect.Effect<number, AutomationError>;
    readonly setOutboxStatus: (input: {
      readonly environmentId: EnvironmentId;
      readonly messageIds: ReadonlyArray<PeerMessageId>;
      readonly status: PeerOutboxStatus;
      readonly rejection?: { readonly code: AutomationErrorCode; readonly message: string };
      readonly now: string;
    }) => Effect.Effect<void, AutomationError>;
    readonly recordSendFailure: (input: {
      readonly environmentId: EnvironmentId;
      readonly messageIds: ReadonlyArray<PeerMessageId>;
      readonly error: string;
      readonly now: string;
    }) => Effect.Effect<void, AutomationError>;
    /** Moves pending messages whose `expiresAt` has passed to `expired`. Returns how many. */
    readonly expireOutbox: (now: string) => Effect.Effect<number, AutomationError>;
    /**
     * Stores messages not seen before and advances `receivedThroughSequence`,
     * in one transaction. A message whose sequence is already taken by a
     * different id is returned in `conflicts` and not stored.
     */
    readonly storeInbound: (input: {
      readonly environmentId: EnvironmentId;
      readonly messages: ReadonlyArray<PeerMessage>;
      readonly now: string;
    }) => Effect.Effect<
      {
        readonly receivedThroughSequence: number;
        readonly stored: number;
        readonly conflicts: ReadonlyArray<PeerMessageId>;
      },
      AutomationError
    >;
    /** Stored messages awaiting processing, oldest first within each peer. */
    readonly storedInbound: (
      limit: number,
    ) => Effect.Effect<ReadonlyArray<PeerInboxRow>, AutomationError>;
    readonly inbound: (
      environmentId: EnvironmentId,
      messageIds: ReadonlyArray<PeerMessageId>,
    ) => Effect.Effect<ReadonlyArray<PeerInboxRow>, AutomationError>;
    readonly settleInbound: (input: {
      readonly environmentId: EnvironmentId;
      readonly messageId: PeerMessageId;
      readonly rejection: { readonly code: AutomationErrorCode; readonly message: string } | null;
      readonly now: string;
    }) => Effect.Effect<void, AutomationError>;
    /**
     * Rejections the peer has not been told about. `confirmPrevious` first
     * settles the ones sent in the previous response, which the peer proves it
     * received by calling again on the same link.
     */
    readonly takeRejectionsToReport: (
      environmentId: EnvironmentId,
      confirmPrevious: boolean,
    ) => Effect.Effect<ReadonlyArray<PeerRejection>, AutomationError>;
    /** A new link cannot know whether the last response arrived: report those rejections again. */
    readonly resetUnconfirmedRejections: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<void, AutomationError>;
    readonly signal: (signal: PeerSignal) => Effect.Effect<void>;
    readonly signals: PubSub.PubSub<PeerSignal>;
  }
>()("t3/automation/federation/PeerStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const signals = yield* PubSub.sliding<PeerSignal>(256);

  const toRecord = (row: PeerRow) =>
    Effect.map(decodeDetail(row.peer_json), (detail): PeerRecord => ({
      environmentId: row.environment_id as EnvironmentId,
      name: row.name,
      enabled: row.enabled === 1,
      detail,
      inboundCursor: row.inbound_cursor,
      forwardedCursor: row.forwarded_cursor,
      nextOutboundSequence: row.next_outbound_sequence,
      ackedThroughSequence: row.acked_through_sequence,
      receivedThroughSequence: row.received_through_sequence,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));

  const toOutboxEntry = (row: OutboxRow) =>
    Effect.map(decodeMessage(row.message_json), (message): PeerOutboxEntry => ({
      message,
      status: row.status as PeerOutboxStatus,
      attemptCount: row.attempt_count,
      lastError: row.last_error,
      rejection: isErrorCode(row.rejection) ? row.rejection : null,
      updatedAt: row.updated_at,
    }));

  const toInboxRow = (row: InboxRow) =>
    Effect.map(decodeMessage(row.message_json), (message): PeerInboxRow => {
      const decoded = row.error === null ? undefined : decodeRejection(row.error);
      return {
        peerEnvironmentId: row.peer_environment_id as EnvironmentId,
        message,
        status: row.status as PeerInboxStatus,
        rejection:
          decoded === undefined || decoded._tag === "None"
            ? null
            : { messageId: message.messageId, ...decoded.value },
      };
    });

  const list =
    sql<PeerRow>`SELECT * FROM automation_peers ORDER BY name ASC, environment_id ASC`.pipe(
      Effect.flatMap(Effect.forEach(toRecord)),
      Effect.catch(storageFailure("list")),
    );

  const get = (environmentId: EnvironmentId) =>
    sql<PeerRow>`SELECT * FROM automation_peers WHERE environment_id = ${environmentId}`.pipe(
      Effect.flatMap((rows) => (rows[0] === undefined ? Effect.succeed(null) : toRecord(rows[0]))),
      Effect.catch(storageFailure("get")),
    );

  const insert: PeerStore["Service"]["insert"] = (record) =>
    Effect.gen(function* () {
      const detail = yield* encodeDetail(record.detail);
      yield* sql`INSERT INTO automation_peers (
        environment_id, name, enabled, peer_json, inbound_cursor, forwarded_cursor,
        next_outbound_sequence, acked_through_sequence, received_through_sequence,
        created_at, updated_at
      ) VALUES (
        ${record.environmentId}, ${record.name}, ${record.enabled ? 1 : 0}, ${detail}, 0, 0,
        1, 0, 0, ${record.createdAt}, ${record.createdAt}
      )`;
    }).pipe(Effect.catch(storageFailure("insert")));

  const update: PeerStore["Service"]["update"] = (environmentId, patch) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{ peer_json: string }>`SELECT peer_json FROM automation_peers
            WHERE environment_id = ${environmentId}`;
          const current = rows[0];
          if (current === undefined) return;
          const detail =
            patch.detail === undefined
              ? current.peer_json
              : yield* encodeDetail(patch.detail(yield* decodeDetail(current.peer_json)));
          yield* sql`UPDATE automation_peers SET
            name = COALESCE(${patch.name ?? null}, name),
            enabled = COALESCE(${patch.enabled === undefined ? null : patch.enabled ? 1 : 0}, enabled),
            peer_json = ${detail},
            inbound_cursor = MAX(inbound_cursor, ${patch.inboundCursor ?? 0}),
            forwarded_cursor = MAX(forwarded_cursor, ${patch.forwardedCursor ?? 0}),
            acked_through_sequence = MAX(acked_through_sequence, ${patch.ackedThroughSequence ?? 0}),
            updated_at = ${patch.updatedAt}
            WHERE environment_id = ${environmentId}`;
        }),
      )
      .pipe(Effect.catch(storageFailure("update")));

  const remove: PeerStore["Service"]["remove"] = (environmentId, now) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{
            environment_id: string;
          }>`DELETE FROM automation_peers WHERE environment_id = ${environmentId} RETURNING environment_id`;
          yield* sql`UPDATE automation_peer_outbox SET status = 'cancelled', updated_at = ${now}
            WHERE peer_environment_id = ${environmentId} AND status = 'pending_delivery'`;
          return rows.length > 0;
        }),
      )
      .pipe(Effect.catch(storageFailure("remove")));

  const enqueue: PeerStore["Service"]["enqueue"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const existing = yield* sql<OutboxRow>`SELECT * FROM automation_peer_outbox
            WHERE message_id = ${input.messageId}`;
          if (existing[0] !== undefined) {
            return {
              message: yield* decodeMessage(existing[0].message_json),
              created: false,
            };
          }
          const peers = yield* sql<{
            next_outbound_sequence: number;
          }>`SELECT next_outbound_sequence FROM automation_peers
            WHERE environment_id = ${input.environmentId}`;
          const sequence = peers[0]?.next_outbound_sequence;
          if (sequence === undefined) {
            return yield* automationError(
              "NOT_FOUND",
              `Environment ${input.environmentId} is not a peer of this environment.`,
            );
          }
          const message = input.build(sequence);
          yield* sql`INSERT INTO automation_peer_outbox (
            message_id, peer_environment_id, sequence, status, message_json, attempt_count,
            last_error, rejection, expires_at, updated_at
          ) VALUES (
            ${message.messageId}, ${input.environmentId}, ${sequence}, 'pending_delivery',
            ${yield* encodeMessage(message)}, 0, NULL, NULL, ${message.expiresAt}, ${input.now}
          )`;
          yield* sql`UPDATE automation_peers SET
            next_outbound_sequence = ${sequence + 1},
            forwarded_cursor = MAX(forwarded_cursor, ${input.forwardedCursor ?? 0})
            WHERE environment_id = ${input.environmentId}`;
          return { message, created: true };
        }),
      )
      .pipe(
        Effect.catch((cause) =>
          isAutomationError(cause) ? Effect.fail(cause) : storageFailure("enqueue")(cause),
        ),
      );

  const outbox: PeerStore["Service"]["outbox"] = (input) =>
    sql<OutboxRow>`SELECT * FROM automation_peer_outbox
      WHERE ${sql.and([
        input.environmentId === undefined
          ? sql`1 = 1`
          : sql`peer_environment_id = ${input.environmentId}`,
        input.statuses === undefined ? sql`1 = 1` : sql`status IN ${sql.in(input.statuses)}`,
      ])}
      ORDER BY peer_environment_id ASC, sequence ASC LIMIT ${input.limit}`.pipe(
      Effect.flatMap(Effect.forEach(toOutboxEntry)),
      Effect.catch(storageFailure("outbox")),
    );

  const pendingCount: PeerStore["Service"]["pendingCount"] = (environmentId) =>
    sql<{ count: number }>`SELECT COUNT(*) AS count FROM automation_peer_outbox
      WHERE status = 'pending_delivery' AND ${
        environmentId === undefined ? sql`1 = 1` : sql`peer_environment_id = ${environmentId}`
      }`.pipe(
      Effect.map((rows) => rows[0]?.count ?? 0),
      Effect.catch(storageFailure("pendingCount")),
    );

  const setOutboxStatus: PeerStore["Service"]["setOutboxStatus"] = (input) =>
    input.messageIds.length === 0
      ? Effect.void
      : sql`UPDATE automation_peer_outbox SET
          status = ${input.status},
          rejection = ${input.rejection?.code ?? null},
          last_error = ${input.rejection?.message ?? null},
          updated_at = ${input.now}
          WHERE peer_environment_id = ${input.environmentId}
            AND message_id IN ${sql.in(input.messageIds)}
            AND status IN ('pending_delivery', 'delivered')`.pipe(
          Effect.asVoid,
          Effect.catch(storageFailure("setOutboxStatus")),
        );

  const recordSendFailure: PeerStore["Service"]["recordSendFailure"] = (input) =>
    input.messageIds.length === 0
      ? Effect.void
      : sql`UPDATE automation_peer_outbox SET
          attempt_count = attempt_count + 1, last_error = ${input.error}, updated_at = ${input.now}
          WHERE peer_environment_id = ${input.environmentId}
            AND message_id IN ${sql.in(input.messageIds)}
            AND status = 'pending_delivery'`.pipe(
          Effect.asVoid,
          Effect.catch(storageFailure("recordSendFailure")),
        );

  const expireOutbox: PeerStore["Service"]["expireOutbox"] = (now) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{ message_id: string; expires_at: string }>`SELECT
            message_id, expires_at FROM automation_peer_outbox
            WHERE status = 'pending_delivery' AND expires_at IS NOT NULL`;
          // Compared as instants: two valid ISO strings need not sort the same way as text.
          const expired = rows
            .filter((row) => Date.parse(row.expires_at) <= Date.parse(now))
            .map((row) => row.message_id);
          if (expired.length > 0) {
            yield* sql`UPDATE automation_peer_outbox SET status = 'expired', updated_at = ${now}
              WHERE message_id IN ${sql.in(expired)}`;
          }
          return expired.length;
        }),
      )
      .pipe(Effect.catch(storageFailure("expireOutbox")));

  const storeInbound: PeerStore["Service"]["storeInbound"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          let stored = 0;
          const conflicts: Array<PeerMessageId> = [];
          for (const message of input.messages) {
            const key = inboxKey(input.environmentId, message.messageId);
            const known = yield* sql<{ message_id: string }>`SELECT message_id
              FROM automation_peer_inbox
              WHERE message_id = ${key}
                 OR (peer_environment_id = ${input.environmentId} AND sequence = ${message.sequence})`;
            if (known.some((row) => row.message_id === key)) continue;
            if (known.length > 0) {
              conflicts.push(message.messageId);
              continue;
            }
            yield* sql`INSERT INTO automation_peer_inbox (
              message_id, peer_environment_id, sequence, status, message_json, error,
              received_at, processed_at
            ) VALUES (
              ${key}, ${input.environmentId}, ${message.sequence}, 'stored',
              ${yield* encodeMessage(message)}, NULL, ${input.now}, NULL
            )`;
            stored += 1;
          }
          const highest = Math.max(0, ...input.messages.map((message) => message.sequence));
          const rows = yield* sql<{ received_through_sequence: number }>`UPDATE automation_peers
            SET received_through_sequence = MAX(received_through_sequence, ${highest})
            WHERE environment_id = ${input.environmentId}
            RETURNING received_through_sequence`;
          return {
            receivedThroughSequence: rows[0]?.received_through_sequence ?? 0,
            stored,
            conflicts,
          };
        }),
      )
      .pipe(Effect.catch(storageFailure("storeInbound")));

  const storedInbound: PeerStore["Service"]["storedInbound"] = (limit) =>
    sql<InboxRow>`SELECT * FROM automation_peer_inbox WHERE status = 'stored'
      ORDER BY peer_environment_id ASC, sequence ASC LIMIT ${limit}`.pipe(
      Effect.flatMap(Effect.forEach(toInboxRow)),
      Effect.catch(storageFailure("storedInbound")),
    );

  const inbound: PeerStore["Service"]["inbound"] = (environmentId, messageIds) =>
    messageIds.length === 0
      ? Effect.succeed([])
      : sql<InboxRow>`SELECT * FROM automation_peer_inbox
          WHERE message_id IN ${sql.in(messageIds.map((id) => inboxKey(environmentId, id)))}
          ORDER BY sequence ASC`.pipe(
          Effect.flatMap(Effect.forEach(toInboxRow)),
          Effect.catch(storageFailure("inbound")),
        );

  const settleInbound: PeerStore["Service"]["settleInbound"] = (input) =>
    sql`UPDATE automation_peer_inbox SET
      status = ${input.rejection === null ? "processed" : "rejected"},
      error = ${input.rejection === null ? null : encodeRejection(input.rejection)},
      processed_at = ${input.now}
      WHERE message_id = ${inboxKey(input.environmentId, input.messageId)} AND status = 'stored'`.pipe(
      Effect.asVoid,
      Effect.catch(storageFailure("settleInbound")),
    );

  const takeRejectionsToReport: PeerStore["Service"]["takeRejectionsToReport"] = (
    environmentId,
    confirmPrevious,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          if (confirmPrevious) {
            yield* sql`UPDATE automation_peer_inbox SET status = 'rejected_reported'
              WHERE peer_environment_id = ${environmentId} AND status = 'rejected_sent'`;
          }
          const rows = yield* sql<InboxRow>`UPDATE automation_peer_inbox
            SET status = 'rejected_sent'
            WHERE peer_environment_id = ${environmentId} AND status = 'rejected'
            RETURNING *`;
          const decoded = yield* Effect.forEach(rows, toInboxRow);
          return decoded.flatMap((row) => (row.rejection === null ? [] : [row.rejection]));
        }),
      )
      .pipe(Effect.catch(storageFailure("takeRejectionsToReport")));

  const resetUnconfirmedRejections: PeerStore["Service"]["resetUnconfirmedRejections"] = (
    environmentId,
  ) =>
    sql`UPDATE automation_peer_inbox SET status = 'rejected'
      WHERE peer_environment_id = ${environmentId} AND status = 'rejected_sent'`.pipe(
      Effect.asVoid,
      Effect.catch(storageFailure("resetUnconfirmedRejections")),
    );

  return PeerStore.of({
    list,
    get,
    insert,
    update,
    remove,
    enqueue,
    outbox,
    pendingCount,
    setOutboxStatus,
    recordSendFailure,
    expireOutbox,
    storeInbound,
    storedInbound,
    inbound,
    settleInbound,
    takeRejectionsToReport,
    resetUnconfirmedRejections,
    signal: (signal) => Effect.asVoid(PubSub.publish(signals, signal)),
    signals,
  });
});

export const layer = Layer.effect(PeerStore, make);
