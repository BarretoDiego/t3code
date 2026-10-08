import {
  AUTOMATION_CONTRACT_VERSION,
  type AutomationError,
  Hook,
  type HookDelivery,
  type HookDeliveryId,
  HookId,
  type HookTestResult,
  type HookUpsertInput,
  type HooksDeliveriesInput,
  type HooksTestInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { Fragment } from "effect/sql/Statement";

import { type AutomationCaller, automationError } from "./Caller.ts";
import { filterProblem } from "./events/filter.ts";
import { randomId } from "./events/ids.ts";
import * as JournalStore from "./events/JournalStore.ts";
import * as HookRuntime from "./hooks/HookRuntime.ts";
import * as OrchestratorInbox from "./OrchestratorInbox.ts";
import * as HookTargetPolicy from "./hooks/HookTargetPolicy.ts";
import type { HookConfig } from "./hooks/planning.ts";
import { describeTarget } from "./hooks/targets.ts";
import * as WebhookTransport from "./hooks/WebhookTransport.ts";

/** Persisted hook subscriptions and their deliveries. */
export class HookService extends Context.Service<
  HookService,
  {
    readonly list: (
      caller: AutomationCaller,
    ) => Effect.Effect<ReadonlyArray<Hook>, AutomationError>;
    readonly upsert: (
      caller: AutomationCaller,
      input: HookUpsertInput,
    ) => Effect.Effect<Hook, AutomationError>;
    readonly setEnabled: (
      caller: AutomationCaller,
      input: { readonly hookId: HookId; readonly enabled: boolean },
    ) => Effect.Effect<Hook, AutomationError>;
    readonly delete: (
      caller: AutomationCaller,
      input: HookId,
    ) => Effect.Effect<boolean, AutomationError>;
    readonly test: (
      caller: AutomationCaller,
      input: HooksTestInput,
    ) => Effect.Effect<HookTestResult, AutomationError>;
    readonly deliveries: (
      caller: AutomationCaller,
      input: HooksDeliveriesInput,
    ) => Effect.Effect<ReadonlyArray<HookDelivery>, AutomationError>;
    readonly redeliver: (
      caller: AutomationCaller,
      input: HookDeliveryId,
    ) => Effect.Effect<HookDelivery, AutomationError>;
    readonly dismissDelivery: (
      caller: AutomationCaller,
      input: HookDeliveryId,
    ) => Effect.Effect<HookDelivery, AutomationError>;
  }
>()("t3/automation/HookService") {}

const UPSERT_IDEMPOTENCY_SCOPE = "hooks.upsert";
const DEFAULT_TEST_RANGE = 50;
const DEFAULT_DELIVERIES_LIMIT = 100;
const MAX_DELIVERIES_LIMIT = 1_000;

const HookJson = Schema.fromJsonString(Hook);
const decodeHook = Schema.decodeUnknownEffect(HookJson);
const encodeHook = Schema.encodeEffect(HookJson);
const toJsonRecord = Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Json));

const configOf = (input: HookUpsertInput): HookConfig => ({
  name: input.name,
  filter: input.filter,
  target: input.target,
  deliveryMode: input.deliveryMode,
  retry: input.retry,
  timeoutMs: input.timeoutMs,
  ...(input.batchWindowMs === undefined ? {} : { batchWindowMs: input.batchWindowMs }),
  ...(input.cooldownMs === undefined ? {} : { cooldownMs: input.cooldownMs }),
  ...(input.maxDeliveriesPerTask === undefined
    ? {}
    : { maxDeliveriesPerTask: input.maxDeliveriesPerTask }),
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* JournalStore.JournalStore;
  const runtime = yield* HookRuntime.HookRuntime;

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const readHook = (hookId: HookId) =>
    sql<HookRuntime.HookRow>`SELECT * FROM automation_hooks WHERE hook_id = ${hookId}`.pipe(
      Effect.map((rows) => rows[0]),
    );

  const requireHook = Effect.fnUntraced(function* (hookId: HookId) {
    const row = yield* readHook(hookId);
    return row === undefined
      ? yield* automationError("NOT_FOUND", `No hook has the id ${hookId}.`, { hookId })
      : row;
  });

  const readDelivery = (deliveryId: HookDeliveryId) =>
    sql<HookRuntime.DeliveryRow>`
      SELECT * FROM automation_hook_deliveries WHERE delivery_id = ${deliveryId}
    `.pipe(Effect.map((rows) => rows[0]));

  const requireDelivery = Effect.fnUntraced(function* (deliveryId: HookDeliveryId) {
    const row = yield* readDelivery(deliveryId);
    return row === undefined
      ? yield* automationError("NOT_FOUND", `No delivery has the id ${deliveryId}.`, {
          deliveryId,
        })
      : row;
  });

  const recordChange = (
    caller: AutomationCaller,
    hook: Pick<HookRuntime.HookRow, "hook_id" | "revision" | "enabled">,
    change: "created" | "updated" | "enabled" | "disabled" | "deleted",
  ) =>
    store.append([
      {
        type: "hook.changed",
        origin: {
          kind: caller.kind === "internal" ? "service" : caller.kind === "peer" ? "peer" : "user",
          actorId: caller.subject,
        },
        scope: {},
        aggregate: { kind: "hook", id: hook.hook_id },
        payload: { change, revision: hook.revision, enabled: hook.enabled === 1 },
      },
    ]);

  const ensureConsumer = (target: Hook["target"], cursor: number, now: string) =>
    target.type === "cli_consumer"
      ? sql`
          INSERT INTO automation_consumers (consumer_id, cursor, updated_at)
          VALUES (${target.consumerId}, ${cursor}, ${now})
          ON CONFLICT(consumer_id) DO NOTHING
        `.pipe(Effect.asVoid)
      : Effect.void;

  const list: HookService["Service"]["list"] = () =>
    sql<HookRuntime.HookRow>`
      SELECT * FROM automation_hooks ORDER BY priority DESC, created_at, hook_id
    `.pipe(
      Effect.catchTags({ SqlError: HookRuntime.hookStorageFailure("be listed") }),
      Effect.map((rows) => rows.map(HookRuntime.toHook)),
    );

  const upsert: HookService["Service"]["upsert"] = Effect.fn("HookService.upsert")(
    function* (caller, input) {
      const problem = filterProblem(input.filter);
      if (problem !== null) return yield* automationError("INVALID_INPUT", problem);
      if (input.retry.initialDelayMs > input.retry.maxDelayMs) {
        return yield* automationError(
          "INVALID_INPUT",
          "retry.initialDelayMs must not be larger than retry.maxDelayMs.",
        );
      }
      yield* runtime.prepareTarget(input.target);

      const hook = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            if (input.idempotencyKey !== undefined) {
              const repeated = yield* sql<{ readonly result_json: string }>`
                SELECT result_json
                FROM automation_idempotency
                WHERE scope = ${UPSERT_IDEMPOTENCY_SCOPE}
                  AND idempotency_key = ${input.idempotencyKey}
              `;
              if (repeated[0] !== undefined) {
                return yield* Effect.orDie(decodeHook(repeated[0].result_json));
              }
            }
            const now = yield* nowIso;
            const existing = input.id === undefined ? undefined : yield* readHook(input.id);
            let hookId: HookId;
            let change: "created" | "updated";
            if (existing !== undefined) {
              if (input.expectedRevision === undefined) {
                return yield* automationError(
                  "INVALID_INPUT",
                  `Hook ${existing.hook_id} exists. Name the revision you are replacing in expectedRevision.`,
                  { hookId: existing.hook_id, currentRevision: existing.revision },
                );
              }
              if (input.expectedRevision !== existing.revision) {
                return yield* automationError(
                  "REVISION_MISMATCH",
                  `Hook ${existing.hook_id} is at revision ${existing.revision}, not ${input.expectedRevision}. Read it again and reapply your change.`,
                  { hookId: existing.hook_id, currentRevision: existing.revision },
                );
              }
              const stalled = HookRuntime.hookConfigOf(existing).stalled === true;
              const config = { ...configOf(input), ...(stalled ? { stalled } : {}) };
              yield* sql`
                UPDATE automation_hooks
                SET revision = revision + 1,
                    enabled = ${input.enabled ? 1 : 0},
                    priority = ${input.priority},
                    hook_json = ${HookRuntime.encodeJson(config)},
                    updated_at = ${now}
                WHERE hook_id = ${existing.hook_id}
              `;
              yield* ensureConsumer(input.target, existing.cursor, now);
              hookId = existing.hook_id;
              change = "updated";
            } else {
              if (input.expectedRevision !== undefined) {
                return yield* automationError(
                  "NOT_FOUND",
                  `No hook has the id ${input.id ?? "(none given)"}, so there is no revision to replace.`,
                );
              }
              const { headCursor } = yield* store.status;
              const startAt = input.startAt ?? "head";
              if (startAt !== "head") {
                if (startAt > headCursor) {
                  return yield* automationError(
                    "INVALID_INPUT",
                    `startAt ${startAt} is past the journal head ${headCursor}.`,
                    { startAt, headCursor },
                  );
                }
                yield* store.assertRetained(startAt);
              }
              const cursor = startAt === "head" ? headCursor : startAt;
              hookId = input.id ?? HookId.make(`hook-${yield* randomId}`);
              yield* sql`
                INSERT INTO automation_hooks (
                  hook_id, revision, enabled, priority, cursor, hook_json,
                  created_by, created_at, updated_at
                )
                VALUES (
                  ${hookId}, 1, ${input.enabled ? 1 : 0}, ${input.priority}, ${cursor},
                  ${HookRuntime.encodeJson(configOf(input))}, ${caller.subject}, ${now}, ${now}
                )
              `;
              yield* ensureConsumer(input.target, cursor, now);
              change = "created";
            }
            const stored = yield* requireHook(hookId);
            yield* recordChange(caller, stored, change);
            const result = HookRuntime.toHook(stored);
            if (input.idempotencyKey !== undefined) {
              yield* sql`
                INSERT INTO automation_idempotency
                  (scope, idempotency_key, result_json, created_at)
                VALUES (
                  ${UPSERT_IDEMPOTENCY_SCOPE},
                  ${input.idempotencyKey},
                  ${yield* Effect.orDie(encodeHook(result))},
                  ${now}
                )
              `;
            }
            return result;
          }),
        )
        .pipe(Effect.catchTags({ SqlError: HookRuntime.hookStorageFailure("be saved") }));
      yield* runtime.wake;
      return hook;
    },
  );

  const setEnabled: HookService["Service"]["setEnabled"] = Effect.fn("HookService.setEnabled")(
    function* (caller, input) {
      const hook = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const existing = yield* requireHook(input.hookId);
            if ((existing.enabled === 1) === input.enabled) return HookRuntime.toHook(existing);
            yield* sql`
              UPDATE automation_hooks
              SET enabled = ${input.enabled ? 1 : 0},
                  revision = revision + 1,
                  updated_at = ${yield* nowIso}
              WHERE hook_id = ${input.hookId}
            `;
            const stored = yield* requireHook(input.hookId);
            yield* recordChange(caller, stored, input.enabled ? "enabled" : "disabled");
            return HookRuntime.toHook(stored);
          }),
        )
        .pipe(Effect.catchTags({ SqlError: HookRuntime.hookStorageFailure("be updated") }));
      yield* runtime.wake;
      return hook;
    },
  );

  const remove: HookService["Service"]["delete"] = (caller, hookId) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const existing = yield* readHook(hookId);
          if (existing === undefined) return false;
          // A named CLI consumer outlives the hook that fed it.
          yield* sql`DELETE FROM automation_hook_deliveries WHERE hook_id = ${hookId}`;
          yield* sql`DELETE FROM automation_hooks WHERE hook_id = ${hookId}`;
          yield* recordChange(caller, existing, "deleted");
          return true;
        }),
      )
      .pipe(Effect.catchTags({ SqlError: HookRuntime.hookStorageFailure("be deleted") }));

  const test: HookService["Service"]["test"] = Effect.fn("HookService.test")(
    function* (_caller, input) {
      const hook = yield* requireHook(input.hookId).pipe(
        Effect.catchTags({ SqlError: HookRuntime.hookStorageFailure("be read") }),
      );
      const config = HookRuntime.hookConfigOf(hook);
      const limit = input.limit ?? DEFAULT_TEST_RANGE;
      const { headCursor, oldestCursor } = yield* store.status;
      if (input.afterCursor !== undefined) yield* store.assertRetained(input.afterCursor);
      const afterCursor =
        input.afterCursor ??
        Math.max(headCursor - limit, oldestCursor === null ? 0 : oldestCursor - 1);
      const page = yield* store.page({
        afterCursor,
        throughCursor: headCursor,
        filter: config.filter,
        limit,
      });
      const matched = page.entries;
      if (matched.length === 0) {
        return { dryRun: input.deliver !== true, matched, preview: null, delivery: null };
      }
      if (input.deliver === true) {
        const delivery = yield* runtime.deliverEntries(
          hook,
          matched,
          `test:${hook.hook_id}:${yield* randomId}`,
        );
        return { dryRun: false, matched, preview: null, delivery };
      }
      const preview = yield* Effect.orDie(
        toJsonRecord({
          target: describeTarget(config.target),
          payload: {
            version: AUTOMATION_CONTRACT_VERSION,
            deliveryId: "(assigned when delivered)",
            dedupKey: "(assigned when delivered)",
            hookId: hook.hook_id,
            attempt: 1,
            sentAt: yield* nowIso,
            entries: matched,
          },
        }),
      );
      return { dryRun: true, matched, preview, delivery: null };
    },
  );

  const deliveries: HookService["Service"]["deliveries"] = (_caller, input) => {
    const clauses: Array<Fragment> = [sql`1 = 1`];
    if (input.hookId !== undefined) clauses.push(sql`hook_id = ${input.hookId}`);
    if (input.statuses !== undefined && input.statuses.length > 0) {
      clauses.push(sql.in("status", input.statuses));
    }
    return sql<HookRuntime.DeliveryRow>`
      SELECT * FROM automation_hook_deliveries
      WHERE ${sql.and(clauses)}
      ORDER BY created_at DESC, first_cursor DESC
      LIMIT ${Math.min(input.limit ?? DEFAULT_DELIVERIES_LIMIT, MAX_DELIVERIES_LIMIT)}
    `.pipe(
      Effect.catchTags({ SqlError: HookRuntime.hookStorageFailure("list deliveries") }),
      Effect.map((rows) => rows.map(HookRuntime.toDelivery)),
    );
  };

  const redeliver: HookService["Service"]["redeliver"] = Effect.fn("HookService.redeliver")(
    function* (_caller, deliveryId) {
      const delivery = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const existing = yield* requireDelivery(deliveryId);
            if (
              existing.status === "pending" ||
              existing.status === "delivering" ||
              existing.status === "retrying"
            ) {
              return yield* automationError(
                "CONFLICT",
                `Delivery ${deliveryId} is already ${existing.status}.`,
                { deliveryId, status: existing.status },
              );
            }
            const now = yield* nowIso;
            // The dedup key stays, so a target that already has this delivery keeps one copy.
            yield* sql`
              UPDATE automation_hook_deliveries
              SET status = 'pending',
                  attempt_count = 0,
                  next_attempt_at = ${now},
                  last_error = NULL,
                  suppressed_reason = NULL,
                  updated_at = ${now}
              WHERE delivery_id = ${deliveryId}
            `;
            return HookRuntime.toDelivery(yield* requireDelivery(deliveryId));
          }),
        )
        .pipe(Effect.catchTags({ SqlError: HookRuntime.hookStorageFailure("redeliver") }));
      yield* runtime.wake;
      return delivery;
    },
  );

  const dismissDelivery: HookService["Service"]["dismissDelivery"] = (_caller, deliveryId) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const existing = yield* requireDelivery(deliveryId);
          if (existing.status !== "failed" && existing.status !== "suppressed") {
            return yield* automationError(
              "CONFLICT",
              `Only a failed or suppressed delivery can be dismissed; ${deliveryId} is ${existing.status}.`,
              { deliveryId, status: existing.status },
            );
          }
          yield* sql`DELETE FROM automation_hook_deliveries WHERE delivery_id = ${deliveryId}`;
          return HookRuntime.toDelivery(existing);
        }),
      )
      .pipe(Effect.catchTags({ SqlError: HookRuntime.hookStorageFailure("dismiss the delivery") }));

  return HookService.of({
    list,
    upsert,
    setEnabled,
    delete: remove,
    test,
    deliveries,
    redeliver,
    dismissDelivery,
  });
});

/**
 * Hooks with the runtime that matches and delivers them, but without a target
 * policy or a webhook transport, so a test can supply its own.
 */
export const layerWithoutTargetPolicy = Layer.effect(HookService, make).pipe(
  Layer.provideMerge(HookRuntime.layer),
);

/**
 * Needs `SqlClient`, `ServerEnvironment`, `ServerSecretStore` and
 * `ChildProcessSpawner`. The journal store and the orchestrator inbox are the
 * same layers `EventJournal` and the inbox module export, so a composition
 * that also provides those shares one instance of each. Add
 * `HookRuntime.workerLive` to start delivery.
 */
export const layer = layerWithoutTargetPolicy.pipe(
  Layer.provide(
    Layer.mergeAll(
      HookTargetPolicy.layer,
      WebhookTransport.layer,
      JournalStore.layer,
      OrchestratorInbox.layer,
    ),
  ),
);
