import {
  AutomationError,
  type CommandId,
  DelegatedTask,
  type DelegatedTaskId,
  type EnvironmentId,
  InboxEntry,
  type InboxEntryId,
  type InboxEntryStatus,
  type MessageId,
  type OrchestratorDesiredState,
  OrchestratorCheckpoint,
  type OrchestratorId,
  OrchestratorUpsertInput,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { automationError } from "../Caller.ts";

/** The operator-editable part of an orchestrator, as stored in `config_json`. */
export type OrchestratorConfig = Pick<
  OrchestratorUpsertInput,
  | "name"
  | "scope"
  | "projectId"
  | "modelSelection"
  | "profile"
  | "runtimeMode"
  | "instructions"
  | "permissions"
  | "budget"
  | "responsibilityOrder"
  | "batchWindowMs"
>;

export interface StoredOrchestrator {
  readonly id: OrchestratorId;
  readonly revision: number;
  readonly config: OrchestratorConfig;
  readonly hostEnvironmentId: EnvironmentId;
  readonly hostGeneration: number;
  readonly threadId: ThreadId | null;
  readonly desiredState: OrchestratorDesiredState;
  /** Why the last turn could not be dispatched or followed, when that happened. */
  readonly stateReason: string | null;
  readonly usageSince: string;
  readonly lastTurnAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type TurnStatus = "reserved" | "dispatched" | "finished" | "unknown";

export interface StoredTurn {
  readonly orchestratorId: OrchestratorId;
  readonly sequence: number;
  readonly commandId: CommandId;
  readonly messageId: MessageId;
  readonly threadId: ThreadId;
  readonly runId: RunId | null;
  readonly status: TurnStatus;
  readonly outcome: string | null;
  readonly prompt: string;
  readonly taskIds: ReadonlyArray<string>;
  readonly interruptRequestedAt: string | null;
  readonly reservedAt: string;
  readonly dispatchedAt: string | null;
  readonly finishedAt: string | null;
}

export interface StoredInboxEntry {
  readonly sequence: number;
  readonly entry: InboxEntry;
}

interface OrchestratorRow {
  readonly orchestrator_id: string;
  readonly revision: number;
  readonly host_environment_id: string;
  readonly host_generation: number;
  readonly thread_id: string | null;
  readonly desired_state: string;
  readonly state_reason: string | null;
  readonly config_json: string;
  readonly usage_json: string;
  readonly last_turn_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface TurnRow {
  readonly orchestrator_id: string;
  readonly sequence: number;
  readonly command_id: string;
  readonly message_id: string;
  readonly thread_id: string;
  readonly run_id: string | null;
  readonly status: string;
  readonly outcome: string | null;
  readonly prompt: string;
  readonly task_ids_json: string;
  readonly interrupt_requested_at: string | null;
  readonly reserved_at: string;
  readonly dispatched_at: string | null;
  readonly finished_at: string | null;
}

interface InboxRow {
  readonly sequence: number;
  readonly entry_id: string;
  readonly orchestrator_id: string;
  readonly dedup_key: string;
  readonly kind: string;
  readonly status: string;
  readonly relevance: string;
  readonly entry_json: string;
  readonly reserved_by_run_id: string | null;
  readonly received_at: string;
  readonly updated_at: string;
}

const decodeConfig = Schema.decodeUnknownEffect(OrchestratorUpsertInput);
const decodeInboxEntry = Schema.decodeUnknownEffect(InboxEntry);
const decodeCheckpoint = Schema.decodeUnknownEffect(OrchestratorCheckpoint);
const decodeTask = Schema.decodeUnknownEffect(DelegatedTask);
const isAutomationError = Schema.is(AutomationError);

/** Maps a storage or decoding failure to the one error automation callers see. */
export const storageFailure =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, AutomationError, R> =>
    effect.pipe(
      Effect.mapError((cause) =>
        isAutomationError(cause)
          ? cause
          : automationError("INTERNAL", `Automation storage failed: ${operation}.`),
      ),
    );

/** JSON columns hold values this module wrote, so a parse failure is a defect, not an error to handle. */
export const parseJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
export const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export const configOf = (input: OrchestratorConfig): OrchestratorConfig => ({
  name: input.name,
  scope: input.scope,
  projectId: input.projectId,
  modelSelection: input.modelSelection,
  ...(input.profile === undefined ? {} : { profile: input.profile }),
  runtimeMode: input.runtimeMode,
  instructions: input.instructions,
  permissions: input.permissions,
  budget: input.budget,
  responsibilityOrder: input.responsibilityOrder,
  batchWindowMs: input.batchWindowMs,
});

/** SQL access for orchestrators, their inbox, turns and checkpoints. */
export const makeStore = (sql: SqlClient.SqlClient) => {
  const decodeOrchestrator = (row: OrchestratorRow) =>
    Effect.gen(function* () {
      const config = configOf(yield* decodeConfig(parseJson(row.config_json)));
      const usage = parseJson(row.usage_json) as { readonly since?: string };
      return {
        id: row.orchestrator_id as OrchestratorId,
        revision: row.revision,
        config,
        hostEnvironmentId: row.host_environment_id as EnvironmentId,
        hostGeneration: row.host_generation,
        threadId: row.thread_id as ThreadId | null,
        desiredState: row.desired_state as OrchestratorDesiredState,
        stateReason: row.state_reason,
        usageSince: usage.since ?? row.created_at,
        lastTurnAt: row.last_turn_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      } satisfies StoredOrchestrator;
    });

  const decodeTurn = (row: TurnRow): StoredTurn => ({
    orchestratorId: row.orchestrator_id as OrchestratorId,
    sequence: row.sequence,
    commandId: row.command_id as CommandId,
    messageId: row.message_id as MessageId,
    threadId: row.thread_id as ThreadId,
    runId: row.run_id as RunId | null,
    status: row.status as TurnStatus,
    outcome: row.outcome,
    prompt: row.prompt,
    taskIds: parseJson(row.task_ids_json) as ReadonlyArray<string>,
    interruptRequestedAt: row.interrupt_requested_at,
    reservedAt: row.reserved_at,
    dispatchedAt: row.dispatched_at,
    finishedAt: row.finished_at,
  });

  const decodeInbox = (row: InboxRow) =>
    decodeInboxEntry({
      ...(parseJson(row.entry_json) as object),
      id: row.entry_id,
      orchestratorId: row.orchestrator_id,
      kind: row.kind,
      dedupKey: row.dedup_key,
      status: row.status,
      relevance: row.relevance,
      reservedByRunId: row.reserved_by_run_id,
      receivedAt: row.received_at,
      updatedAt: row.updated_at,
    }).pipe(Effect.map((entry) => ({ sequence: row.sequence, entry }) satisfies StoredInboxEntry));

  const listOrchestrators = sql<OrchestratorRow>`
    SELECT * FROM automation_orchestrators ORDER BY created_at ASC, orchestrator_id ASC
  `.pipe(
    Effect.flatMap((rows) => Effect.forEach(rows, decodeOrchestrator)),
    storageFailure("list orchestrators"),
  );

  const getOrchestrator = (id: OrchestratorId) =>
    sql<OrchestratorRow>`
      SELECT * FROM automation_orchestrators WHERE orchestrator_id = ${id}
    `.pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined ? Effect.succeed(null) : decodeOrchestrator(rows[0]),
      ),
      storageFailure("read orchestrator"),
    );

  const requireOrchestrator = (id: OrchestratorId) =>
    getOrchestrator(id).pipe(
      Effect.flatMap((row) =>
        row === null
          ? Effect.fail(automationError("NOT_FOUND", `Orchestrator ${id} does not exist.`))
          : Effect.succeed(row),
      ),
    );

  const getOrchestratorByThread = (threadId: ThreadId) =>
    sql<OrchestratorRow>`
      SELECT * FROM automation_orchestrators WHERE thread_id = ${threadId}
    `.pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined ? Effect.succeed(null) : decodeOrchestrator(rows[0]),
      ),
      storageFailure("read orchestrator by thread"),
    );

  const insertOrchestrator = (row: StoredOrchestrator) =>
    sql`
      INSERT INTO automation_orchestrators (
        orchestrator_id, revision, name, scope, host_environment_id, host_generation,
        thread_id, desired_state, runtime_state, state_reason, active_run_id,
        config_json, usage_json, last_turn_at, observed_at, created_at, updated_at
      ) VALUES (
        ${row.id}, ${row.revision}, ${row.config.name}, ${row.config.scope},
        ${row.hostEnvironmentId}, ${row.hostGeneration}, ${row.threadId}, ${row.desiredState},
        'idle', NULL, NULL, ${toJson(row.config)},
        ${toJson({ since: row.usageSince })}, NULL, ${row.updatedAt},
        ${row.createdAt}, ${row.updatedAt}
      )
    `.pipe(storageFailure("create orchestrator"));

  /** Guarded by the revision the caller read: false means someone else edited first. */
  const updateOrchestratorConfig = (input: {
    readonly id: OrchestratorId;
    readonly expectedRevision: number;
    readonly config: OrchestratorConfig;
    readonly desiredState: OrchestratorDesiredState;
    readonly now: string;
  }) =>
    sql<{ readonly orchestrator_id: string }>`
      UPDATE automation_orchestrators
      SET revision = revision + 1,
          name = ${input.config.name},
          scope = ${input.config.scope},
          desired_state = ${input.desiredState},
          config_json = ${toJson(input.config)},
          observed_at = ${input.now},
          updated_at = ${input.now}
      WHERE orchestrator_id = ${input.id} AND revision = ${input.expectedRevision}
      RETURNING orchestrator_id
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      storageFailure("update orchestrator"),
    );

  const setDesiredState = (
    id: OrchestratorId,
    desiredState: OrchestratorDesiredState,
    now: string,
  ) =>
    sql`
      UPDATE automation_orchestrators
      SET desired_state = ${desiredState}, revision = revision + 1,
          observed_at = ${now}, updated_at = ${now}
      WHERE orchestrator_id = ${id}
    `.pipe(storageFailure("set orchestrator state"));

  const setStateReason = (id: OrchestratorId, reason: string | null, now: string) =>
    sql`
      UPDATE automation_orchestrators
      SET state_reason = ${reason}, observed_at = ${now}
      WHERE orchestrator_id = ${id}
    `.pipe(storageFailure("record orchestrator state reason"));

  const touchLastTurn = (id: OrchestratorId, now: string) =>
    sql`
      UPDATE automation_orchestrators
      SET last_turn_at = ${now}, observed_at = ${now}
      WHERE orchestrator_id = ${id}
    `.pipe(storageFailure("record orchestrator turn time"));

  const deleteOrchestrator = (id: OrchestratorId) =>
    Effect.gen(function* () {
      const removed = yield* sql<{ readonly orchestrator_id: string }>`
        DELETE FROM automation_orchestrators WHERE orchestrator_id = ${id}
        RETURNING orchestrator_id
      `;
      yield* sql`DELETE FROM automation_inbox WHERE orchestrator_id = ${id}`;
      yield* sql`DELETE FROM automation_checkpoints WHERE orchestrator_id = ${id}`;
      yield* sql`DELETE FROM automation_orchestrator_turns WHERE orchestrator_id = ${id}`;
      yield* sql`DELETE FROM automation_orchestrator_turn_entries WHERE orchestrator_id = ${id}`;
      return removed.length > 0;
    }).pipe(storageFailure("delete orchestrator"));

  // -------------------------------------------------------------------------
  // Inbox

  const getInboxByDedup = (orchestratorId: OrchestratorId, dedupKey: string) =>
    sql<InboxRow>`
      SELECT * FROM automation_inbox
      WHERE orchestrator_id = ${orchestratorId} AND dedup_key = ${dedupKey}
    `.pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined ? Effect.succeed(null) : decodeInbox(rows[0]),
      ),
      storageFailure("read inbox entry"),
    );

  const getInboxEntry = (orchestratorId: OrchestratorId, entryId: InboxEntryId) =>
    sql<InboxRow>`
      SELECT * FROM automation_inbox
      WHERE orchestrator_id = ${orchestratorId} AND entry_id = ${entryId}
    `.pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined ? Effect.succeed(null) : decodeInbox(rows[0]),
      ),
      storageFailure("read inbox entry"),
    );

  /** Inserts unless (orchestrator, dedupKey) exists. Returns whether a row was written. */
  const insertInboxEntry = (entry: InboxEntry) =>
    sql<{ readonly sequence: number }>`
      INSERT INTO automation_inbox (
        entry_id, orchestrator_id, dedup_key, kind, status, relevance, entry_json,
        reserved_by_run_id, received_at, updated_at
      ) VALUES (
        ${entry.id}, ${entry.orchestratorId}, ${entry.dedupKey}, ${entry.kind}, ${entry.status},
        ${entry.relevance},
        ${toJson({ entries: entry.entries, text: entry.text, from: entry.from })},
        NULL, ${entry.receivedAt}, ${entry.updatedAt}
      )
      ON CONFLICT (orchestrator_id, dedup_key) DO NOTHING
      RETURNING sequence
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      storageFailure("store inbox entry"),
    );

  const listInbox = (input: {
    readonly orchestratorId: OrchestratorId;
    readonly statuses?: ReadonlyArray<InboxEntryStatus> | undefined;
    readonly limit?: number | undefined;
    readonly order?: "asc" | "desc";
  }) =>
    sql<InboxRow>`
      SELECT * FROM automation_inbox WHERE orchestrator_id = ${input.orchestratorId}
      ORDER BY sequence ASC
    `.pipe(
      Effect.flatMap((rows) => Effect.forEach(rows, decodeInbox)),
      Effect.map((entries) => {
        const filtered =
          input.statuses === undefined || input.statuses.length === 0
            ? entries
            : entries.filter(({ entry }) => input.statuses!.includes(entry.status));
        const ordered = input.order === "desc" ? filtered.toReversed() : filtered;
        return input.limit === undefined ? ordered : ordered.slice(0, input.limit);
      }),
      storageFailure("list inbox"),
    );

  const countInbox = (orchestratorId: OrchestratorId, status: InboxEntryStatus) =>
    sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM automation_inbox
      WHERE orchestrator_id = ${orchestratorId} AND status = ${status}
    `.pipe(
      Effect.map((rows) => rows[0]?.count ?? 0),
      storageFailure("count inbox"),
    );

  /** Moves an entry between statuses only when it still has the expected one. */
  const transitionInboxEntry = (input: {
    readonly orchestratorId: OrchestratorId;
    readonly entryId: InboxEntryId;
    readonly from: ReadonlyArray<InboxEntryStatus>;
    readonly to: InboxEntryStatus;
    readonly runId?: RunId | null;
    readonly now: string;
  }) =>
    sql<{ readonly entry_id: string }>`
      UPDATE automation_inbox
      SET status = ${input.to},
          reserved_by_run_id = ${input.runId === undefined ? null : input.runId},
          updated_at = ${input.now}
      WHERE orchestrator_id = ${input.orchestratorId} AND entry_id = ${input.entryId}
        AND status IN ${sql.in(input.from)}
      RETURNING entry_id
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      storageFailure("update inbox entry"),
    );

  // -------------------------------------------------------------------------
  // Turns

  const listTurns = (orchestratorId: OrchestratorId) =>
    sql<TurnRow>`
      SELECT * FROM automation_orchestrator_turns
      WHERE orchestrator_id = ${orchestratorId} ORDER BY sequence ASC
    `.pipe(
      Effect.map((rows) => rows.map(decodeTurn)),
      storageFailure("list turns"),
    );

  const turnEntryIds = (orchestratorId: OrchestratorId, sequence: number) =>
    sql<{ readonly entry_id: string }>`
      SELECT entry_id FROM automation_orchestrator_turn_entries
      WHERE orchestrator_id = ${orchestratorId} AND turn_sequence = ${sequence}
    `.pipe(
      Effect.map((rows) => rows.map((row) => row.entry_id as InboxEntryId)),
      storageFailure("read turn entries"),
    );

  const insertTurn = (turn: StoredTurn, entryIds: ReadonlyArray<InboxEntryId>) =>
    Effect.gen(function* () {
      yield* sql`
        INSERT INTO automation_orchestrator_turns (
          orchestrator_id, sequence, command_id, message_id, thread_id, run_id, status, outcome,
          prompt, task_ids_json, interrupt_requested_at, reserved_at, dispatched_at, finished_at
        ) VALUES (
          ${turn.orchestratorId}, ${turn.sequence}, ${turn.commandId}, ${turn.messageId},
          ${turn.threadId}, NULL, ${turn.status}, NULL, ${turn.prompt},
          ${toJson(turn.taskIds)}, NULL, ${turn.reservedAt}, NULL, NULL
        )
      `;
      for (const entryId of entryIds) {
        yield* sql`
          INSERT INTO automation_orchestrator_turn_entries (orchestrator_id, turn_sequence, entry_id)
          VALUES (${turn.orchestratorId}, ${turn.sequence}, ${entryId})
        `;
      }
    }).pipe(storageFailure("reserve turn"));

  const updateTurn = (
    turn: Pick<StoredTurn, "orchestratorId" | "sequence">,
    patch: {
      readonly status?: TurnStatus;
      readonly runId?: RunId;
      readonly outcome?: string;
      readonly dispatchedAt?: string;
      readonly finishedAt?: string;
      readonly interruptRequestedAt?: string;
    },
  ) =>
    sql`
      UPDATE automation_orchestrator_turns
      SET status = COALESCE(${patch.status ?? null}, status),
          run_id = COALESCE(${patch.runId ?? null}, run_id),
          outcome = COALESCE(${patch.outcome ?? null}, outcome),
          dispatched_at = COALESCE(${patch.dispatchedAt ?? null}, dispatched_at),
          finished_at = COALESCE(${patch.finishedAt ?? null}, finished_at),
          interrupt_requested_at = COALESCE(${patch.interruptRequestedAt ?? null}, interrupt_requested_at)
      WHERE orchestrator_id = ${turn.orchestratorId} AND sequence = ${turn.sequence}
    `.pipe(storageFailure("update turn"));

  // -------------------------------------------------------------------------
  // Checkpoints

  const listCheckpoints = (orchestratorId: OrchestratorId, limit?: number) =>
    sql<{ readonly checkpoint_json: string }>`
      SELECT checkpoint_json FROM automation_checkpoints
      WHERE orchestrator_id = ${orchestratorId} ORDER BY sequence DESC
    `.pipe(
      Effect.flatMap((rows) =>
        Effect.forEach(limit === undefined ? rows : rows.slice(0, limit), (row) =>
          decodeCheckpoint(parseJson(row.checkpoint_json)),
        ),
      ),
      storageFailure("list checkpoints"),
    );

  const insertCheckpoint = (checkpoint: OrchestratorCheckpoint) =>
    sql`
      INSERT INTO automation_checkpoints (
        orchestrator_id, sequence, host_generation, run_id, checkpoint_json, created_at
      ) VALUES (
        ${checkpoint.orchestratorId}, ${checkpoint.sequence}, ${checkpoint.hostGeneration},
        ${checkpoint.runId}, ${toJson(checkpoint)}, ${checkpoint.createdAt}
      )
    `.pipe(storageFailure("write checkpoint"));

  // -------------------------------------------------------------------------
  // Tasks (owned by the task service; read here for budgets and context)

  const listTasks = (orchestratorId: OrchestratorId) =>
    sql<{ readonly task_json: string }>`
      SELECT task_json FROM automation_tasks WHERE orchestrator_id = ${orchestratorId}
      ORDER BY created_at ASC, task_id ASC
    `.pipe(
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) => Effect.option(decodeTask(parseJson(row.task_json)))),
      ),
      Effect.map((tasks) => tasks.flatMap((task) => (task._tag === "Some" ? [task.value] : []))),
      storageFailure("read delegated tasks"),
    );

  const getTask = (taskId: DelegatedTaskId) =>
    sql<{ readonly task_json: string }>`
      SELECT task_json FROM automation_tasks WHERE task_id = ${taskId}
    `.pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? Effect.succeed(null)
          : Effect.option(decodeTask(parseJson(rows[0].task_json))).pipe(
              Effect.map((task) => (task._tag === "Some" ? task.value : null)),
            ),
      ),
      storageFailure("read delegated task"),
    );

  const getTaskByThread = (threadId: ThreadId) =>
    sql<{ readonly task_json: string }>`
      SELECT task_json FROM automation_tasks WHERE thread_id = ${threadId}
      ORDER BY created_at ASC LIMIT 1
    `.pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? Effect.succeed(null)
          : Effect.option(decodeTask(parseJson(rows[0].task_json))).pipe(
              Effect.map((task) => (task._tag === "Some" ? task.value : null)),
            ),
      ),
      storageFailure("read delegated task by thread"),
    );

  // -------------------------------------------------------------------------
  // Idempotency

  const getIdempotent = (scope: string, key: string) =>
    sql<{ readonly result_json: string }>`
      SELECT result_json FROM automation_idempotency
      WHERE scope = ${scope} AND idempotency_key = ${key}
    `.pipe(
      Effect.map((rows) => (rows[0] === undefined ? null : parseJson(rows[0].result_json))),
      storageFailure("read idempotency record"),
    );

  const putIdempotent = (scope: string, key: string, result: unknown, now: string) =>
    sql`
      INSERT INTO automation_idempotency (scope, idempotency_key, result_json, created_at)
      VALUES (${scope}, ${key}, ${toJson(result)}, ${now})
      ON CONFLICT (scope, idempotency_key) DO NOTHING
    `.pipe(storageFailure("write idempotency record"));

  const transact = <A, R>(
    effect: Effect.Effect<A, AutomationError, R>,
  ): Effect.Effect<A, AutomationError, R> =>
    sql.withTransaction(effect).pipe(storageFailure("commit transaction"));

  return {
    sql,
    transact,
    listOrchestrators,
    getOrchestrator,
    requireOrchestrator,
    getOrchestratorByThread,
    insertOrchestrator,
    updateOrchestratorConfig,
    setDesiredState,
    setStateReason,
    touchLastTurn,
    deleteOrchestrator,
    getInboxByDedup,
    getInboxEntry,
    insertInboxEntry,
    listInbox,
    countInbox,
    transitionInboxEntry,
    listTurns,
    turnEntryIds,
    insertTurn,
    updateTurn,
    listCheckpoints,
    insertCheckpoint,
    listTasks,
    getTask,
    getTaskByThread,
    getIdempotent,
    putIdempotent,
  };
};

export type OrchestratorStore = ReturnType<typeof makeStore>;
