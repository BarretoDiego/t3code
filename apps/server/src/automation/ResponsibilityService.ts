import {
  type AutomationError,
  type ClaimTransferInput,
  CommandId,
  DEFAULT_RESPONSIBILITY_ORDER,
  type EnvironmentId,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ThreadShell,
  type PendingRequestSummary,
  type PendingRequestsListInput,
  type RequestRespondInput,
  type RequestRespondResult,
  ResponsibilityClaim,
  type ResponsibilityOwner,
  type ResponsibilityRule,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { type AutomationCaller, automationError } from "./Caller.ts";
import * as EventJournal from "./EventJournal.ts";
import {
  makeStore,
  parseJson,
  storageFailure,
  type StoredOrchestrator,
  toJson,
} from "./orchestrator/Store.ts";

/** Decides who owns a pending request or task, and admits only the owner's answer. */
export class ResponsibilityService extends Context.Service<
  ResponsibilityService,
  {
    readonly listRequests: (
      caller: AutomationCaller,
      input: PendingRequestsListInput,
    ) => Effect.Effect<ReadonlyArray<PendingRequestSummary>, AutomationError>;
    readonly respond: (
      caller: AutomationCaller,
      input: RequestRespondInput,
    ) => Effect.Effect<RequestRespondResult, AutomationError>;
    readonly transferClaim: (
      caller: AutomationCaller,
      input: ClaimTransferInput,
    ) => Effect.Effect<ResponsibilityClaim, AutomationError>;
  }
>()("t3/automation/ResponsibilityService") {}

type ClaimSubject = ResponsibilityClaim["subject"];

interface ClaimRow {
  readonly subject_json: string;
  readonly owner_json: string;
  readonly rule: string;
  readonly generation: number;
  readonly lease_expires_at: string | null;
  readonly claimed_at: string;
}

interface ResponseRow {
  readonly idempotency_key: string;
  readonly command_id: string;
  readonly responder_json: string;
  readonly status: string;
}

/** How long an orchestrator's claim is presumed live. Expiry alone never moves a claim. */
const CLAIM_LEASE_MS = 15 * 60 * 1_000;
const RESPOND_SCOPE = "requests.respond";
const TRANSFER_SCOPE = "claims.transfer";
const APPROVAL_KINDS: ReadonlySet<string> = new Set([
  "command",
  "file-read",
  "file-change",
  "permission",
]);
const USER_INPUT_KINDS: ReadonlySet<string> = new Set(["user_input", "mcp-elicitation"]);

const decodeClaim = Schema.decodeUnknownEffect(ResponsibilityClaim);
const asJsonValue = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

const subjectKey = (subject: ClaimSubject) =>
  subject.kind === "request"
    ? `request:${subject.threadId}:${subject.requestId}`
    : `task:${subject.taskId}`;

const sameOwner = (left: ResponsibilityOwner, right: ResponsibilityOwner) => {
  if (left.kind === "user") return right.kind === "user";
  if (left.kind === "thread") return right.kind === "thread" && left.threadId === right.threadId;
  return (
    right.kind === "orchestrator" &&
    left.orchestratorId === right.orchestratorId &&
    left.environmentId === right.environmentId
  );
};

const summaryKind = (kind: OrchestrationV2RuntimeRequest["kind"]): PendingRequestSummary["kind"] =>
  APPROVAL_KINDS.has(kind) ? "approval" : USER_INPUT_KINDS.has(kind) ? "user_input" : "other";

const projectInScope = (orchestrator: StoredOrchestrator, projectId: string) => {
  const projectIds = orchestrator.config.permissions.projectIds;
  return projectIds === undefined || projectIds.some((candidate) => candidate === projectId);
};

/** The pre-authorization of this orchestrator that covers a request kind in a project, if any. */
const preAuthorization = (orchestrator: StoredOrchestrator, kind: string, projectId: string) =>
  (orchestrator.config.permissions.preAuthorizedApprovals ?? []).find(
    (entry) =>
      entry.requestKind === kind &&
      (entry.projectIds === undefined ||
        entry.projectIds.some((candidate) => candidate === projectId)),
  );

/**
 * Picks the owner of a request on `thread`, in code, from stored facts. Rules
 * are tried in the default order; an orchestrator is a candidate for a rule
 * only when its own `responsibilityOrder` lists that rule. Ties go to the
 * orchestrator that ranks the rule earliest, then to the oldest, so the same
 * inputs always name the same single owner.
 */
const resolveRequestOwner = (input: {
  readonly thread: Pick<OrchestrationV2ThreadShell, "id" | "projectId" | "lineage">;
  readonly orchestrators: ReadonlyArray<StoredOrchestrator>;
  readonly environmentId: EnvironmentId;
  readonly explicitOwner: ResponsibilityOwner | null;
  readonly managingOrchestratorId: string | null;
}): { readonly owner: ResponsibilityOwner; readonly rule: ResponsibilityRule } => {
  const { thread, orchestrators, environmentId } = input;
  const user = { owner: { kind: "user" }, rule: "user" } as const;
  // An orchestrator's own questions go to the user, never to another agent.
  if (orchestrators.some((orchestrator) => orchestrator.threadId === thread.id)) return user;
  const eligible = orchestrators.filter(
    (orchestrator) =>
      orchestrator.hostEnvironmentId === environmentId &&
      orchestrator.desiredState === "active" &&
      projectInScope(orchestrator, thread.projectId),
  );
  const pick = (rule: ResponsibilityRule, candidates: ReadonlyArray<StoredOrchestrator>) => {
    const winner = candidates
      .filter((orchestrator) => orchestrator.config.responsibilityOrder.includes(rule))
      .toSorted(
        (left, right) =>
          left.config.responsibilityOrder.indexOf(rule) -
            right.config.responsibilityOrder.indexOf(rule) ||
          left.createdAt.localeCompare(right.createdAt) ||
          left.id.localeCompare(right.id),
      )[0];
    return winner === undefined
      ? null
      : {
          owner: {
            kind: "orchestrator" as const,
            orchestratorId: winner.id,
            environmentId: winner.hostEnvironmentId,
          },
          rule,
        };
  };
  for (const rule of DEFAULT_RESPONSIBILITY_ORDER) {
    switch (rule) {
      case "explicit_owner":
        if (input.explicitOwner !== null) return { owner: input.explicitOwner, rule };
        break;
      case "managing_parent": {
        const managing = pick(
          rule,
          eligible.filter(
            (orchestrator) =>
              orchestrator.id === input.managingOrchestratorId ||
              (orchestrator.threadId !== null &&
                (orchestrator.threadId === thread.lineage.parentThreadId ||
                  orchestrator.threadId === thread.lineage.rootThreadId)),
          ),
        );
        if (managing !== null) return managing;
        break;
      }
      case "local_orchestrator": {
        const local = pick(
          rule,
          eligible.filter(
            (orchestrator) =>
              orchestrator.config.scope === "local" &&
              orchestrator.config.projectId === thread.projectId,
          ),
        );
        if (local !== null) return local;
        break;
      }
      case "global_orchestrator": {
        const global = pick(
          rule,
          eligible.filter((orchestrator) => orchestrator.config.scope === "global"),
        );
        if (global !== null) return global;
        break;
      }
      case "user":
        return user;
    }
  }
  return user;
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const journal = yield* EventJournal.EventJournal;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  const store = makeStore(sql);

  const isoNow = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const readClaim = (subject: ClaimSubject) =>
    sql<ClaimRow>`
      SELECT subject_json, owner_json, rule, generation, lease_expires_at, claimed_at
      FROM automation_claims WHERE subject_key = ${subjectKey(subject)}
    `.pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? Effect.succeed(null)
          : decodeClaim({
              subject: parseJson(rows[0].subject_json),
              owner: parseJson(rows[0].owner_json),
              rule: rows[0].rule,
              generation: rows[0].generation,
              leaseExpiresAt: rows[0].lease_expires_at,
              claimedAt: rows[0].claimed_at,
            }),
      ),
      storageFailure("read claim"),
    );

  const leaseFor = (owner: ResponsibilityOwner, now: string) =>
    owner.kind === "user"
      ? null
      : DateTime.formatIso(
          DateTime.add(DateTime.makeUnsafe(now), { milliseconds: CLAIM_LEASE_MS }),
        );

  const claimChanged = (claim: ResponsibilityClaim, projectId: string | null, reason: string) =>
    journal.append([
      {
        type: "claim.changed",
        origin: { kind: "service" },
        scope: {
          ...(claim.subject.kind === "request"
            ? { threadId: claim.subject.threadId, requestId: claim.subject.requestId }
            : { taskId: claim.subject.taskId }),
          ...(claim.owner.kind === "orchestrator"
            ? { orchestratorId: claim.owner.orchestratorId }
            : {}),
          ...(projectId === null ? {} : { projectId: projectId as never }),
        },
        aggregate: {
          kind: claim.subject.kind === "request" ? "request" : "task",
          id: claim.subject.kind === "request" ? claim.subject.requestId : claim.subject.taskId,
        },
        payload: {
          owner: claim.owner,
          rule: claim.rule,
          generation: claim.generation,
          reason,
        },
      },
    ]);

  /**
   * Moves a claim to a new owner in one statement guarded by the generation the
   * caller saw. Returns null when another transfer got there first.
   */
  const transfer = Effect.fn("ResponsibilityService.transfer")(function* (input: {
    readonly subject: ClaimSubject;
    readonly expectedGeneration: number;
    readonly owner: ResponsibilityOwner;
    readonly rule: ResponsibilityRule;
    readonly now: string;
  }) {
    const rows = yield* sql<{ readonly generation: number }>`
      UPDATE automation_claims
      SET owner_json = ${toJson(input.owner)},
          rule = ${input.rule},
          generation = generation + 1,
          lease_expires_at = ${leaseFor(input.owner, input.now)},
          claimed_at = ${input.now}
      WHERE subject_key = ${subjectKey(input.subject)} AND generation = ${input.expectedGeneration}
      RETURNING generation
    `.pipe(storageFailure("transfer claim"));
    return rows.length === 0 ? null : yield* readClaim(input.subject);
  });

  /** True when this server can verify that a claim's owner no longer acts. */
  const ownerHasStopped = (
    owner: ResponsibilityOwner,
    orchestrators: ReadonlyArray<StoredOrchestrator>,
  ) => {
    // Another environment's orchestrator cannot be verified from here, however
    // old its lease is, so its claim stays where it is.
    if (owner.kind !== "orchestrator" || owner.environmentId !== environmentId) return false;
    const current = orchestrators.find((orchestrator) => orchestrator.id === owner.orchestratorId);
    return current === undefined || current.desiredState === "disabled";
  };

  /**
   * The claim on a pending request, created on first sight. Run inside the
   * caller's transaction: the insert is a single statement that cannot produce
   * two owners, whoever races.
   */
  const ensureRequestClaim = Effect.fn("ResponsibilityService.ensureRequestClaim")(function* (
    thread: OrchestrationV2ThreadShell,
    subject: Extract<ClaimSubject, { readonly kind: "request" }>,
    orchestrators: ReadonlyArray<StoredOrchestrator>,
    now: string,
  ) {
    const existing = yield* readClaim(subject);
    if (existing !== null && !ownerHasStopped(existing.owner, orchestrators)) return existing;
    const task = yield* store.getTaskByThread(thread.id);
    const taskClaim = task === null ? null : yield* readClaim({ kind: "task", taskId: task.id });
    const resolved = resolveRequestOwner({
      thread,
      orchestrators,
      environmentId,
      explicitOwner:
        taskClaim !== null && !ownerHasStopped(taskClaim.owner, orchestrators)
          ? taskClaim.owner
          : null,
      managingOrchestratorId: task?.orchestratorId ?? null,
    });
    if (existing !== null) {
      const moved = yield* transfer({
        subject,
        expectedGeneration: existing.generation,
        ...resolved,
        now,
      });
      const claim = moved ?? (yield* readClaim(subject)) ?? existing;
      if (moved !== null) yield* claimChanged(claim, thread.projectId, "previous owner stopped");
      return claim;
    }
    const inserted = yield* sql<{ readonly generation: number }>`
      INSERT INTO automation_claims (
        subject_key, subject_json, owner_json, rule, generation, lease_expires_at, claimed_at
      ) VALUES (
        ${subjectKey(subject)}, ${toJson(subject)}, ${toJson(resolved.owner)},
        ${resolved.rule}, 1, ${leaseFor(resolved.owner, now)}, ${now}
      )
      ON CONFLICT (subject_key) DO NOTHING
      RETURNING generation
    `.pipe(storageFailure("claim request"));
    const claim = yield* readClaim(subject);
    if (claim === null) {
      return yield* automationError("INTERNAL", "The claim could not be recorded.");
    }
    if (inserted.length > 0) yield* claimChanged(claim, thread.projectId, "claimed");
    return claim;
  });

  const reservedForUser = (
    request: OrchestrationV2RuntimeRequest,
    claim: ResponsibilityClaim,
    thread: OrchestrationV2ThreadShell,
    orchestrators: ReadonlyArray<StoredOrchestrator>,
  ) => {
    if (!APPROVAL_KINDS.has(request.kind)) return false;
    if (claim.owner.kind !== "orchestrator") return true;
    const { orchestratorId } = claim.owner;
    const owner = orchestrators.find((orchestrator) => orchestrator.id === orchestratorId);
    return (
      owner === undefined ||
      !owner.config.permissions.actions.includes("request.approve") ||
      preAuthorization(owner, request.kind, thread.projectId) === undefined
    );
  };

  const listRequests: ResponsibilityService["Service"]["listRequests"] = Effect.fn(
    "ResponsibilityService.listRequests",
  )(function* (_caller, input) {
    const snapshot = yield* threads
      .getShellSnapshot()
      .pipe(Effect.mapError(() => automationError("INTERNAL", "Threads could not be listed.")));
    const candidates = [...snapshot.threads, ...snapshot.archivedThreads].filter(
      (thread) =>
        thread.deletedAt === null &&
        thread.pendingRuntimeRequest !== null &&
        (input.threadId === undefined || thread.id === input.threadId) &&
        (input.rootThreadId === undefined || thread.lineage.rootThreadId === input.rootThreadId),
    );
    const orchestrators = yield* store.listOrchestrators;
    const now = yield* isoNow;
    const summaries: Array<PendingRequestSummary> = [];
    for (const thread of candidates) {
      const records = yield* threads
        .getThreadRecords(thread.id, ["runtimeRequests", "turnItems"])
        .pipe(Effect.option);
      if (records._tag === "None") continue;
      for (const request of records.value.runtimeRequests) {
        if (request.status !== "pending") continue;
        const subject = { kind: "request", threadId: thread.id, requestId: request.id } as const;
        const claim = yield* store.transact(
          ensureRequestClaim(thread, subject, orchestrators, now),
        );
        if (
          input.orchestratorId !== undefined &&
          !(
            claim.owner.kind === "orchestrator" &&
            claim.owner.orchestratorId === input.orchestratorId
          )
        ) {
          continue;
        }
        const item = records.value.turnItems.find(
          (candidate) => "requestId" in candidate && candidate.requestId === request.id,
        );
        summaries.push({
          environmentId,
          threadId: thread.id,
          threadTitle: thread.title,
          parentThreadId: thread.lineage.parentThreadId,
          requestId: request.id,
          kind: summaryKind(request.kind),
          reservedForUser: reservedForUser(request, claim, thread, orchestrators),
          // Changes whenever the claim moves, which is what makes an earlier read stale.
          revision: claim.generation - 1,
          createdAt: DateTime.formatIso(request.createdAt),
          request: asJsonValue(toJson({ ...request, item: item ?? null })),
          claim,
        });
      }
    }
    return summaries;
  });

  const requestStatus = (threadId: ThreadId, requestId: string) =>
    sql<{ readonly status: string }>`
      SELECT status FROM orchestration_v2_projection_runtime_requests
      WHERE runtime_request_id = ${requestId} AND thread_id = ${threadId}
    `.pipe(
      Effect.map((rows) => rows[0]?.status ?? null),
      storageFailure("read request status"),
    );

  const notPending = (status: string | null, requestId: string) =>
    status === null
      ? automationError("NOT_FOUND", `Request ${requestId} does not exist on that thread.`)
      : status === "expired" || status === "cancelled"
        ? automationError("REQUEST_EXPIRED", `Request ${requestId} is ${status}.`, { status })
        : automationError(
            "REQUEST_ALREADY_RESOLVED",
            `Request ${requestId} is already ${status}.`,
            {
              status,
            },
          );

  const requireCallerMayActAs = (caller: AutomationCaller, responder: ResponsibilityOwner) => {
    // A peer speaks only for orchestrators its own environment hosts.
    if (
      caller.kind === "peer" &&
      !(responder.kind === "orchestrator" && responder.environmentId === caller.environmentId)
    ) {
      return Effect.fail(
        automationError(
          "PERMISSION_DENIED",
          "A peer environment can only answer as its own orchestrators.",
        ),
      );
    }
    return Effect.void;
  };

  const respond: ResponsibilityService["Service"]["respond"] = Effect.fn(
    "ResponsibilityService.respond",
  )(function* (caller, input) {
    const given = [input.decision, input.answers, input.dismiss === true ? true : undefined].filter(
      (value) => value !== undefined,
    ).length;
    if (given !== 1) {
      return yield* automationError(
        "INVALID_INPUT",
        "Give exactly one of decision, answers, or dismiss.",
      );
    }
    yield* requireCallerMayActAs(caller, input.responder);
    const subject = {
      kind: "request",
      threadId: input.threadId,
      requestId: input.requestId,
    } as const;
    const key = subjectKey(subject);
    const commandId = CommandId.make(`automation:request-respond:${input.idempotencyKey}`);
    const result = { threadId: input.threadId, requestId: input.requestId, commandId };
    const replay = (yield* store.getIdempotent(RESPOND_SCOPE, input.idempotencyKey)) as
      | typeof result
      | null;
    if (replay !== null) {
      if (replay.threadId !== input.threadId || replay.requestId !== input.requestId) {
        return yield* automationError(
          "CONFLICT",
          "That idempotency key was already used for a different request.",
        );
      }
      return { ...replay, status: "replayed" as const };
    }
    const thread = yield* threads.getThreadShell(input.threadId).pipe(
      Effect.mapError(() => automationError("INTERNAL", "The thread could not be read.")),
      Effect.flatMap((shell) =>
        shell === null
          ? Effect.fail(automationError("NOT_FOUND", `Thread ${input.threadId} does not exist.`))
          : Effect.succeed(shell),
      ),
    );
    const request = (yield* threads
      .getThreadRecords(input.threadId, ["runtimeRequests"])
      .pipe(
        Effect.mapError(() => automationError("INTERNAL", "The request could not be read.")),
      )).runtimeRequests.find((candidate) => candidate.id === input.requestId);
    if (request === undefined) return yield* notPending(null, input.requestId);
    const approval = APPROVAL_KINDS.has(request.kind);
    if (input.dismiss === true && request.kind !== "user_input") {
      return yield* automationError("INVALID_INPUT", "Only a user-input request can be dismissed.");
    }
    if ((input.decision !== undefined) !== approval && input.dismiss !== true) {
      return yield* automationError(
        "INVALID_INPUT",
        approval
          ? "An approval request needs a decision."
          : "This request needs answers, not a decision.",
      );
    }
    const now = yield* isoNow;

    // Everything that makes the answer admissible is checked in the transaction
    // that records the intent to answer, so the facts cannot change in between.
    yield* store.transact(
      Effect.gen(function* () {
        const status = yield* requestStatus(input.threadId, input.requestId);
        if (status !== "pending") return yield* notPending(status, input.requestId);
        const orchestrators = yield* store.listOrchestrators;
        const claim = yield* ensureRequestClaim(thread, subject, orchestrators, now);
        const { responder } = input;
        if (responder.kind !== "user") {
          if (!sameOwner(claim.owner, responder) || input.generation !== claim.generation) {
            return yield* automationError(
              "NOT_OWNER",
              sameOwner(claim.owner, responder)
                ? `The claim is at generation ${claim.generation}; the response carried ${input.generation ?? "none"}.`
                : `Request ${input.requestId} is owned by someone else.`,
              { owner: claim.owner, generation: claim.generation },
            );
          }
        }
        if (
          input.expectedRevision !== undefined &&
          input.expectedRevision !== claim.generation - 1
        ) {
          return yield* automationError(
            "REVISION_MISMATCH",
            `Request ${input.requestId} is at revision ${claim.generation - 1}, not ${input.expectedRevision}.`,
            { currentRevision: claim.generation - 1 },
          );
        }
        if (responder.kind === "orchestrator") {
          const orchestrator = orchestrators.find(
            (candidate) =>
              candidate.id === responder.orchestratorId &&
              candidate.hostEnvironmentId === responder.environmentId,
          );
          const denied = (message: string) => automationError("PERMISSION_DENIED", message);
          if (orchestrator === undefined) {
            return yield* denied(`Orchestrator ${responder.orchestratorId} is not known here.`);
          }
          if (!orchestrator.config.permissions.actions.includes("request.answer")) {
            return yield* denied(`Orchestrator ${orchestrator.id} does not hold request.answer.`);
          }
          if (approval) {
            const grant = preAuthorization(orchestrator, request.kind, thread.projectId);
            if (
              !orchestrator.config.permissions.actions.includes("request.approve") ||
              grant === undefined ||
              input.decision === undefined ||
              !grant.decisions.includes(input.decision)
            ) {
              return yield* denied(
                `Approving a ${request.kind} request is reserved for the user: orchestrator ${orchestrator.id} has no pre-authorization for this decision.`,
              );
            }
          }
        } else if (responder.kind === "thread" && approval) {
          return yield* automationError(
            "PERMISSION_DENIED",
            "Approvals are reserved for the user.",
          );
        }

        const prior = (yield* sql<ResponseRow>`
          SELECT idempotency_key, command_id, responder_json, status
          FROM automation_request_responses WHERE subject_key = ${key}
        `.pipe(storageFailure("read response intent")))[0];
        if (prior === undefined) {
          yield* sql`
            INSERT INTO automation_request_responses (
              subject_key, idempotency_key, command_id, responder_json, status, created_at
            ) VALUES (
              ${key}, ${input.idempotencyKey}, ${commandId}, ${toJson(responder)},
              'intended', ${now}
            )
          `.pipe(storageFailure("record response intent"));
          return;
        }
        if (prior.idempotency_key === input.idempotencyKey) return;
        const priorResponder = parseJson(prior.responder_json) as ResponsibilityOwner;
        // The user outranks an agent's answer that has not been applied yet.
        // Nothing else may replace an answer that was already admitted.
        if (
          responder.kind === "user" &&
          priorResponder.kind !== "user" &&
          prior.status === "intended"
        ) {
          yield* sql`
            UPDATE automation_request_responses
            SET idempotency_key = ${input.idempotencyKey}, command_id = ${commandId},
                responder_json = ${toJson(responder)}, created_at = ${now}
            WHERE subject_key = ${key}
          `.pipe(storageFailure("record response intent"));
          return;
        }
        return yield* automationError(
          "REQUEST_ALREADY_RESOLVED",
          `Request ${input.requestId} already has an admitted answer.`,
          { respondedBy: priorResponder },
        );
      }),
    );

    const dispatched = yield* threads
      .dispatch(
        input.dismiss === true
          ? {
              type: "thread.user-input.dismiss",
              commandId,
              threadId: input.threadId,
              requestId: input.requestId,
            }
          : {
              type: "runtime-request.respond",
              commandId,
              threadId: input.threadId,
              requestId: input.requestId,
              ...(input.decision === undefined ? {} : { decision: input.decision }),
              ...(input.answers === undefined ? {} : { answers: input.answers }),
            },
      )
      .pipe(Effect.result);
    if (dispatched._tag === "Failure") {
      // The engine refused it, so this intent must not keep blocking others.
      yield* sql`
        DELETE FROM automation_request_responses
        WHERE subject_key = ${key} AND idempotency_key = ${input.idempotencyKey}
      `.pipe(storageFailure("clear response intent"));
      const status = yield* requestStatus(input.threadId, input.requestId);
      if (status !== "pending") return yield* notPending(status, input.requestId);
      return yield* automationError(
        "CONFLICT",
        `The thread did not accept the response: ${dispatched.failure.message}`,
      );
    }
    yield* store.transact(
      Effect.gen(function* () {
        yield* sql`
          UPDATE automation_request_responses SET status = 'dispatched'
          WHERE subject_key = ${key} AND idempotency_key = ${input.idempotencyKey}
        `.pipe(storageFailure("confirm response intent"));
        yield* store.putIdempotent(RESPOND_SCOPE, input.idempotencyKey, result, now);
      }),
    );
    return { ...result, status: "accepted" as const };
  });

  const transferClaim: ResponsibilityService["Service"]["transferClaim"] = Effect.fn(
    "ResponsibilityService.transferClaim",
  )(function* (caller, input) {
    const replay = yield* store.getIdempotent(TRANSFER_SCOPE, input.idempotencyKey);
    if (replay !== null) {
      return yield* decodeClaim(replay).pipe(storageFailure("read stored transfer"));
    }
    const orchestrators = yield* store.listOrchestrators;
    const now = yield* isoNow;
    const { subject } = input;
    if (
      input.to.kind === "orchestrator" &&
      input.to.environmentId === environmentId &&
      !orchestrators.some(
        (orchestrator) =>
          orchestrator.id === (input.to as { orchestratorId: string }).orchestratorId,
      )
    ) {
      return yield* automationError("NOT_FOUND", "The orchestrator to transfer to does not exist.");
    }
    let projectId: string | null = null;
    let current: ResponsibilityClaim;
    if (subject.kind === "request") {
      const thread = yield* threads
        .getThreadShell(subject.threadId)
        .pipe(Effect.mapError(() => automationError("INTERNAL", "The thread could not be read.")));
      if (thread === null) {
        return yield* automationError("NOT_FOUND", `Thread ${subject.threadId} does not exist.`);
      }
      const status = yield* requestStatus(subject.threadId, subject.requestId);
      if (status !== "pending") return yield* notPending(status, subject.requestId);
      projectId = thread.projectId;
      current = yield* store.transact(ensureRequestClaim(thread, subject, orchestrators, now));
    } else {
      const task = yield* store.getTask(subject.taskId);
      if (task === null) {
        return yield* automationError("NOT_FOUND", `Task ${subject.taskId} does not exist.`);
      }
      projectId = task.target.projectId;
      const existing = yield* readClaim(subject);
      // A task nobody claimed yet belongs to the orchestrator that delegated it, or to the user.
      const owner: ResponsibilityOwner =
        task.orchestratorId === null
          ? { kind: "user" }
          : {
              kind: "orchestrator",
              orchestratorId: task.orchestratorId,
              environmentId: task.originEnvironmentId,
            };
      if (existing === null) {
        yield* sql`
          INSERT INTO automation_claims (
            subject_key, subject_json, owner_json, rule, generation, lease_expires_at, claimed_at
          ) VALUES (
            ${subjectKey(subject)}, ${toJson(subject)}, ${toJson(owner)},
            ${owner.kind === "user" ? "user" : "managing_parent"}, 1, ${leaseFor(owner, now)}, ${now}
          )
          ON CONFLICT (subject_key) DO NOTHING
        `.pipe(storageFailure("claim task"));
      }
      const claim = existing ?? (yield* readClaim(subject));
      if (claim === null) return yield* automationError("INTERNAL", "The claim could not be read.");
      current = claim;
    }
    // Only the user, the runtime, or the current owner's own environment may
    // move a claim. An agent proposing a transfer in a message changes nothing.
    if (
      caller.kind === "peer" &&
      !(
        current.owner.kind === "orchestrator" &&
        current.owner.environmentId === caller.environmentId
      )
    ) {
      return yield* automationError(
        "PERMISSION_DENIED",
        "Only the current owner, the user, or the runtime may transfer a claim.",
        { owner: current.owner },
      );
    }
    if (input.expectedGeneration !== undefined && input.expectedGeneration !== current.generation) {
      return yield* automationError(
        "REVISION_MISMATCH",
        `The claim is at generation ${current.generation}, not ${input.expectedGeneration}.`,
        { currentGeneration: current.generation },
      );
    }
    return yield* store.transact(
      Effect.gen(function* () {
        const moved = yield* transfer({
          subject,
          expectedGeneration: current.generation,
          owner: input.to,
          rule: "explicit_owner",
          now,
        });
        if (moved === null) {
          return yield* automationError(
            "REVISION_MISMATCH",
            "The claim moved while it was being transferred; read it again.",
          );
        }
        // The new owner answers with its own permissions; a transfer grants none.
        yield* claimChanged(moved, projectId, input.reason ?? "transferred");
        yield* store.putIdempotent(TRANSFER_SCOPE, input.idempotencyKey, moved, now);
        return moved;
      }),
    );
  });

  return ResponsibilityService.of({ listRequests, respond, transferClaim });
});

/** The service alone: the caller provides the journal. */
export const layerCore = Layer.effect(ResponsibilityService, make);

export const layer = layerCore.pipe(Layer.provide(EventJournal.layer));
