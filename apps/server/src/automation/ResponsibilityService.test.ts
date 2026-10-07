import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  IdempotencyKey,
  type Orchestrator,
  type OrchestrationV2RuntimeRequest,
  type OrchestratorUpsertInput,
  type PendingRequestSummary,
  type RequestRespondInput,
  type ResponsibilityOwner,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { TestClock } from "effect/testing";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import type { AutomationCaller } from "./Caller.ts";
import {
  awaitThreadEvent,
  environmentId,
  makeAutomationLayer,
  orchestratorInput,
  startThreadWithRequest,
  withEngine,
} from "./orchestrator/Orchestrator.testkit.ts";
import * as OrchestratorRuntime from "./orchestrator/Runtime.ts";
import * as OrchestratorService from "./OrchestratorService.ts";
import * as ResponsibilityService from "./ResponsibilityService.ts";

const TIMEOUT = 60_000;
const client: AutomationCaller = { kind: "client", subject: "user-session", scopes: [] };
const user: ResponsibilityOwner = { kind: "user" };
const worker = ThreadId.make("thread:worker");

const ownerOf = (orchestrator: Orchestrator): ResponsibilityOwner => ({
  kind: "orchestrator",
  orchestratorId: orchestrator.id,
  environmentId,
});

const requestIs =
  (status: OrchestrationV2RuntimeRequest["status"]) =>
  (event: { readonly type: string; readonly payload: unknown }) =>
    event.type === "runtime-request.updated" &&
    (event.payload as { readonly status: string }).status === status;

/** A started runtime, and a worker thread stopped on a pending request of `kind`. */
const scene = (cwd: string, kind: OrchestrationV2RuntimeRequest["kind"]) =>
  Effect.gen(function* () {
    const orchestrators = yield* OrchestratorService.OrchestratorService;
    const responsibility = yield* ResponsibilityService.ResponsibilityService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const runtime = yield* OrchestratorRuntime.OrchestratorRuntime;
    yield* runtime.start();
    yield* runtime.drain;
    const create = (overrides: Partial<OrchestratorUpsertInput> = {}) =>
      orchestrators.upsert(client, orchestratorInput(overrides));
    const raise = Effect.gen(function* () {
      yield* startThreadWithRequest({ threadId: worker, kind, cwd });
      yield* awaitThreadEvent(worker, requestIs("pending"));
    });
    const pending = responsibility
      .listRequests(client, { threadId: worker })
      .pipe(Effect.map((requests) => requests[0] as PendingRequestSummary));
    let keys = 0;
    const respond = (
      request: PendingRequestSummary,
      responder: ResponsibilityOwner,
      rest: Partial<RequestRespondInput> = {},
    ) =>
      responsibility.respond(client, {
        idempotencyKey: IdempotencyKey.make(`respond:${(keys += 1)}`),
        threadId: request.threadId,
        requestId: request.requestId,
        responder,
        ...(responder.kind === "user" ? {} : { generation: request.claim!.generation }),
        ...(request.kind === "approval"
          ? { decision: "accept" as const }
          : { answers: { choice: responder.kind } }),
        ...rest,
      });
    const stored = (requestId: string) =>
      threads
        .getThreadRecords(worker, ["runtimeRequests"])
        .pipe(
          Effect.map(
            (records) =>
              records.runtimeRequests.find(
                (request) => request.id === requestId,
              ) as OrchestrationV2RuntimeRequest,
          ),
        );
    return { orchestrators, responsibility, threads, create, raise, pending, respond, stored };
  });

describe("ResponsibilityService", () => {
  it.effect(
    "a local and a global orchestrator both eligible: one claim, one answer, both can see it",
    () =>
      withEngine("responsibility-local-global", ({ cwd, journal }) =>
        Effect.gen(function* () {
          const { responsibility, create, raise, pending, respond, stored } = yield* scene(
            cwd,
            "user_input",
          );
          const global = yield* create({ name: "Global", scope: "global" });
          const local = yield* create({ name: "Local", scope: "local" });
          yield* raise;

          const request = yield* pending;
          assert.deepStrictEqual(request.claim?.owner, ownerOf(local));
          assert.strictEqual(request.claim?.rule, "local_orchestrator");
          assert.strictEqual(request.claim?.generation, 1);
          assert.isFalse(request.reservedForUser);
          assert.strictEqual(request.kind, "user_input");
          // Observation is open to both; ownership is not.
          const seenByGlobal = yield* responsibility.listRequests(client, {});
          assert.strictEqual(seenByGlobal.length, 1);
          assert.strictEqual(
            (yield* responsibility.listRequests(client, { orchestratorId: global.id })).length,
            0,
          );
          assert.strictEqual(
            (yield* responsibility.listRequests(client, { orchestratorId: local.id })).length,
            1,
          );

          const loser = yield* respond(request, ownerOf(global)).pipe(Effect.flip);
          assert.strictEqual(loser.code, "NOT_OWNER");
          assert.strictEqual((yield* stored(request.requestId)).status, "pending");

          const winner = yield* respond(request, ownerOf(local));
          assert.strictEqual(winner.status, "accepted");
          yield* awaitThreadEvent(worker, requestIs("resolved"));
          const resolved = yield* stored(request.requestId);
          assert.deepStrictEqual(resolved.answers, { choice: "orchestrator" });
          assert.strictEqual((yield* responsibility.listRequests(client, {})).length, 0);
          const claims = (yield* SubscriptionRef.get(journal.events)).filter(
            (event) => event.type === "claim.changed",
          );
          assert.strictEqual(claims.length, 1);
        }).pipe(Effect.provide(makeAutomationLayer())),
      ),
    TIMEOUT,
  );

  it.effect(
    "a second response to a resolved request is rejected and changes nothing",
    () =>
      withEngine("responsibility-second-response", ({ cwd }) =>
        Effect.gen(function* () {
          const { responsibility, create, raise, pending, respond, stored } = yield* scene(
            cwd,
            "user_input",
          );
          const local = yield* create();
          yield* raise;
          const request = yield* pending;
          const key = IdempotencyKey.make("first-answer");
          const first = yield* respond(request, ownerOf(local), {
            idempotencyKey: key,
            answers: { choice: "first" },
          });
          yield* awaitThreadEvent(worker, requestIs("resolved"));

          const second = yield* respond(request, ownerOf(local), {
            answers: { choice: "second" },
          }).pipe(Effect.flip);
          assert.strictEqual(second.code, "REQUEST_ALREADY_RESOLVED");
          const byUser = yield* respond(request, user, { answers: { choice: "user" } }).pipe(
            Effect.flip,
          );
          assert.strictEqual(byUser.code, "REQUEST_ALREADY_RESOLVED");
          assert.deepStrictEqual((yield* stored(request.requestId)).answers, { choice: "first" });

          // The same key again is the same answer, not a new one.
          const replay = yield* responsibility.respond(client, {
            idempotencyKey: key,
            threadId: request.threadId,
            requestId: request.requestId,
            responder: ownerOf(local),
            generation: 1,
            answers: { choice: "first" },
          });
          assert.strictEqual(replay.status, "replayed");
          assert.strictEqual(replay.commandId, first.commandId);
        }).pipe(Effect.provide(makeAutomationLayer())),
      ),
    TIMEOUT,
  );

  it.effect(
    "a generation that was valid when the owner was notified is rejected once the claim has moved",
    () =>
      withEngine("responsibility-stale-generation", ({ cwd, journal }) =>
        Effect.gen(function* () {
          const { responsibility, create, raise, pending, respond, stored } = yield* scene(
            cwd,
            "user_input",
          );
          const local = yield* create();
          yield* raise;
          const notified = yield* pending;
          assert.strictEqual(notified.claim?.generation, 1);

          const subject = {
            kind: "request",
            threadId: notified.threadId,
            requestId: notified.requestId,
          } as const;
          const toUser = yield* responsibility.transferClaim(client, {
            idempotencyKey: IdempotencyKey.make("escalate"),
            subject,
            to: user,
            expectedGeneration: 1,
            reason: "needs a human",
          });
          assert.strictEqual(toUser.generation, 2);
          const back = yield* responsibility.transferClaim(client, {
            idempotencyKey: IdempotencyKey.make("hand-back"),
            subject,
            to: ownerOf(local),
          });
          assert.strictEqual(back.generation, 3);
          assert.deepStrictEqual(back.owner, ownerOf(local));
          // Repeating a transfer returns its first result instead of moving the claim again.
          const repeated = yield* responsibility.transferClaim(client, {
            idempotencyKey: IdempotencyKey.make("hand-back"),
            subject,
            to: ownerOf(local),
          });
          assert.strictEqual(repeated.generation, 3);

          // Same owner, old token: rejected when the answer is executed.
          const stale = yield* respond(notified, ownerOf(local)).pipe(Effect.flip);
          assert.strictEqual(stale.code, "NOT_OWNER");
          assert.strictEqual(stale.detail?.generation, 3);
          assert.strictEqual((yield* stored(notified.requestId)).status, "pending");
          const staleRevision = yield* respond(notified, ownerOf(local), {
            generation: 3,
            expectedRevision: notified.revision,
          }).pipe(Effect.flip);
          assert.strictEqual(staleRevision.code, "REVISION_MISMATCH");
          const staleTransfer = yield* responsibility
            .transferClaim(client, {
              idempotencyKey: IdempotencyKey.make("late-transfer"),
              subject,
              to: user,
              expectedGeneration: 1,
            })
            .pipe(Effect.flip);
          assert.strictEqual(staleTransfer.code, "REVISION_MISMATCH");

          const current = yield* pending;
          assert.strictEqual(current.revision, 2);
          const accepted = yield* respond(current, ownerOf(local), {
            expectedRevision: current.revision,
          });
          assert.strictEqual(accepted.status, "accepted");
          const changes = (yield* SubscriptionRef.get(journal.events)).filter(
            (event) => event.type === "claim.changed",
          );
          assert.deepStrictEqual(
            changes.map((event) => event.payload.generation),
            [1, 2, 3],
          );
        }).pipe(Effect.provide(makeAutomationLayer())),
      ),
    TIMEOUT,
  );

  it.effect(
    "the user can always answer, and a late orchestrator response does not overwrite it",
    () =>
      withEngine("responsibility-user-wins", ({ cwd }) =>
        Effect.gen(function* () {
          const { create, raise, pending, respond, stored, threads } = yield* scene(
            cwd,
            "user_input",
          );
          const local = yield* create();
          yield* raise;
          const request = yield* pending;
          assert.deepStrictEqual(request.claim?.owner, ownerOf(local));

          // The user is not the claimed owner and carries no generation.
          const byUser = yield* respond(request, user, { answers: { choice: "user" } });
          assert.strictEqual(byUser.status, "accepted");
          const late = yield* respond(request, ownerOf(local), {
            answers: { choice: "orchestrator" },
          }).pipe(Effect.flip);
          assert.strictEqual(late.code, "REQUEST_ALREADY_RESOLVED");
          yield* awaitThreadEvent(worker, requestIs("resolved"));
          assert.deepStrictEqual((yield* stored(request.requestId)).answers, { choice: "user" });

          // The same holds when the user answered in the app, outside this service.
          const second = ThreadId.make("thread:worker-2");
          yield* startThreadWithRequest({ threadId: second, kind: "user_input", cwd });
          yield* awaitThreadEvent(second, requestIs("pending"));
          const responsibility = yield* ResponsibilityService.ResponsibilityService;
          const [other] = yield* responsibility.listRequests(client, { threadId: second });
          yield* threads.dispatch({
            type: "runtime-request.respond",
            commandId: CommandId.make("command:user-in-app"),
            threadId: second,
            requestId: other!.requestId,
            answers: { choice: "app" },
          });
          const lateAgain = yield* respond(other!, ownerOf(local)).pipe(Effect.flip);
          assert.strictEqual(lateAgain.code, "REQUEST_ALREADY_RESOLVED");
        }).pipe(Effect.provide(makeAutomationLayer())),
      ),
    TIMEOUT,
  );

  it.effect(
    "when the owner and the user answer at once exactly one answer is admitted",
    () =>
      withEngine("responsibility-race", ({ cwd }) =>
        Effect.gen(function* () {
          const { create, raise, pending, respond, stored } = yield* scene(cwd, "user_input");
          const local = yield* create();
          yield* raise;
          const request = yield* pending;
          const outcomes = yield* Effect.all(
            [
              respond(request, ownerOf(local), { answers: { choice: "orchestrator" } }),
              respond(request, user, { answers: { choice: "user" } }),
            ].map((attempt) => Effect.result(attempt)),
            { concurrency: 2 },
          );
          assert.strictEqual(outcomes.filter((outcome) => outcome._tag === "Success").length, 1);
          yield* awaitThreadEvent(worker, requestIs("resolved"));
          const answer = (yield* stored(request.requestId)).answers as { choice: string };
          const winner = outcomes[0]!._tag === "Success" ? "orchestrator" : "user";
          assert.strictEqual(answer.choice, winner);
        }).pipe(Effect.provide(makeAutomationLayer())),
      ),
    TIMEOUT,
  );

  it.effect(
    "an approval is reserved for the user unless the owner is pre-authorized for that decision",
    () =>
      withEngine("responsibility-approval", ({ cwd }) =>
        Effect.gen(function* () {
          const { orchestrators, create, raise, pending, respond, stored } = yield* scene(
            cwd,
            "command",
          );
          const local = yield* create({
            permissions: { actions: ["thread.read", "request.answer", "request.approve"] },
          });
          yield* raise;
          const reserved = yield* pending;
          assert.strictEqual(reserved.kind, "approval");
          assert.isTrue(reserved.reservedForUser);
          const denied = yield* respond(reserved, ownerOf(local)).pipe(Effect.flip);
          assert.strictEqual(denied.code, "PERMISSION_DENIED");
          assert.strictEqual((yield* stored(reserved.requestId)).status, "pending");

          // The operator pre-authorizes accepting commands in this project, nothing more.
          yield* orchestrators.upsert(
            client,
            orchestratorInput({
              id: local.id,
              expectedRevision: local.revision,
              permissions: {
                actions: ["thread.read", "request.answer", "request.approve"],
                preAuthorizedApprovals: [{ requestKind: "command", decisions: ["accept"] }],
              },
            }),
          );
          const allowed = yield* pending;
          assert.isFalse(allowed.reservedForUser);
          const wider = yield* respond(allowed, ownerOf(local), {
            decision: "acceptAlways",
          }).pipe(Effect.flip);
          assert.strictEqual(wider.code, "PERMISSION_DENIED");
          const accepted = yield* respond(allowed, ownerOf(local));
          assert.strictEqual(accepted.status, "accepted");
          yield* awaitThreadEvent(worker, requestIs("resolved"));
          assert.strictEqual((yield* stored(allowed.requestId)).decision, "accept");
        }).pipe(Effect.provide(makeAutomationLayer())),
      ),
    TIMEOUT,
  );

  it.effect(
    "an orchestrator without request.answer owns the request but may not answer it; the user still can",
    () =>
      withEngine("responsibility-no-answer", ({ cwd }) =>
        Effect.gen(function* () {
          const { responsibility, create, raise, pending, respond, stored } = yield* scene(
            cwd,
            "user_input",
          );
          const watcher = yield* create({ permissions: { actions: ["thread.read"] } });
          const approver = yield* create({
            name: "Approver",
            scope: "global",
            permissions: {
              actions: ["request.answer", "request.approve"],
              preAuthorizedApprovals: [{ requestKind: "command", decisions: ["accept"] }],
            },
          });
          yield* raise;
          const request = yield* pending;
          assert.deepStrictEqual(request.claim?.owner, ownerOf(watcher));
          const denied = yield* respond(request, ownerOf(watcher)).pipe(Effect.flip);
          assert.strictEqual(denied.code, "PERMISSION_DENIED");

          // Handing the claim on moves ownership only; the new owner answers with
          // its own permissions.
          const moved = yield* responsibility.transferClaim(client, {
            idempotencyKey: IdempotencyKey.make("to-approver"),
            subject: { kind: "request", threadId: request.threadId, requestId: request.requestId },
            to: ownerOf(approver),
          });
          assert.strictEqual(moved.rule, "explicit_owner");
          const previousOwner = yield* respond(request, ownerOf(watcher), {
            generation: moved.generation,
          }).pipe(Effect.flip);
          assert.strictEqual(previousOwner.code, "NOT_OWNER");

          // A peer cannot move a claim it does not own.
          const peer: AutomationCaller = {
            kind: "peer",
            environmentId: EnvironmentId.make("environment:peer"),
            subject: "peer:environment:peer",
            scopes: [],
          };
          const hijack = yield* responsibility
            .transferClaim(peer, {
              idempotencyKey: IdempotencyKey.make("hijack"),
              subject: {
                kind: "request",
                threadId: request.threadId,
                requestId: request.requestId,
              },
              to: {
                kind: "orchestrator",
                orchestratorId: watcher.id,
                environmentId: peer.environmentId,
              },
            })
            .pipe(Effect.flip);
          assert.strictEqual(hijack.code, "PERMISSION_DENIED");
          const impersonation = yield* responsibility
            .respond(peer, {
              idempotencyKey: IdempotencyKey.make("impersonate"),
              threadId: request.threadId,
              requestId: request.requestId,
              responder: user,
              answers: { choice: "peer" },
            })
            .pipe(Effect.flip);
          assert.strictEqual(impersonation.code, "PERMISSION_DENIED");

          const byUser = yield* respond(request, user);
          assert.strictEqual(byUser.status, "accepted");
          yield* awaitThreadEvent(worker, requestIs("resolved"));
          assert.deepStrictEqual((yield* stored(request.requestId)).answers, { choice: "user" });
        }).pipe(Effect.provide(makeAutomationLayer())),
      ),
    TIMEOUT,
  );

  it.effect(
    "an expired lease moves nothing; an owner this server knows has stopped is replaced",
    () =>
      withEngine("responsibility-lease", ({ cwd }) =>
        Effect.gen(function* () {
          const { orchestrators, create, raise, pending } = yield* scene(cwd, "user_input");
          const global = yield* create({ name: "Global", scope: "global" });
          const local = yield* create();
          yield* raise;
          const first = yield* pending;
          assert.deepStrictEqual(first.claim?.owner, ownerOf(local));
          assert.isNotNull(first.claim?.leaseExpiresAt);

          yield* TestClock.adjust("2 hours");
          const afterExpiry = yield* pending;
          assert.deepStrictEqual(afterExpiry.claim?.owner, ownerOf(local));
          assert.strictEqual(afterExpiry.claim?.generation, 1);

          // Pausing does not release a claim: the orchestrator still exists and may resume.
          yield* orchestrators.setState(client, {
            orchestratorId: local.id,
            desiredState: "paused",
          });
          assert.strictEqual((yield* pending).claim?.generation, 1);

          // Disabled is a fact this server holds, so the claim moves on, fenced.
          yield* orchestrators.setState(client, {
            orchestratorId: local.id,
            desiredState: "disabled",
          });
          const moved = yield* pending;
          assert.deepStrictEqual(moved.claim?.owner, ownerOf(global));
          assert.strictEqual(moved.claim?.rule, "global_orchestrator");
          assert.strictEqual(moved.claim?.generation, 2);

          yield* orchestrators.delete(client, global.id);
          const toUser = yield* pending;
          assert.deepStrictEqual(toUser.claim?.owner, user);
          assert.strictEqual(toUser.claim?.generation, 3);
          assert.isNull(toUser.claim?.leaseExpiresAt);
        }).pipe(Effect.provide(makeAutomationLayer())),
      ),
    TIMEOUT,
  );
});
