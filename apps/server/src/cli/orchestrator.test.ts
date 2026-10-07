import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { AUTOMATION_WS_METHODS, type Orchestrator, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import { internalCaller } from "../automation/Caller.ts";
import {
  awaitThreadEvent,
  makeAutomationLayer,
  modelSelection,
  orchestratorInput,
  projectId,
  startThreadWithRequest,
  withEngine,
} from "../automation/orchestrator/Orchestrator.testkit.ts";
import * as OrchestratorRuntime from "../automation/orchestrator/Runtime.ts";
import * as OrchestratorService from "../automation/OrchestratorService.ts";
import * as ResponsibilityService from "../automation/ResponsibilityService.ts";
import {
  decodeDefinition,
  formatInboxEntry,
  formatOrchestratorDetail,
  formatOrchestratorLine,
  mergeDefinition,
  type OrchestratorCliClient,
  orchestratorOperations,
  parseDefinition,
  parseOwner,
  resolveOrchestrator,
} from "./orchestrator.ts";

const M = AUTOMATION_WS_METHODS;
const TIMEOUT = 60_000;
const caller = internalCaller("cli-test");
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const examplePath = (name: string) =>
  decodeURIComponent(
    new URL(`../../../../docs/user/examples/automation/${name}`, import.meta.url).pathname,
  );

const readExample = (name: string) =>
  FileSystem.FileSystem.use((fileSystem) => fileSystem.readFileString(examplePath(name))).pipe(
    Effect.provide(NodeServices.layer),
  );

/**
 * The RPC surface the commands use, served by the real services in process.
 * Each method does what its thin WebSocket handler does: one service call.
 */
const inProcessClient = Effect.gen(function* () {
  const orchestrators = yield* OrchestratorService.OrchestratorService;
  const responsibility = yield* ResponsibilityService.ResponsibilityService;
  const runtime = yield* OrchestratorRuntime.OrchestratorRuntime;
  yield* runtime.start();
  yield* runtime.drain;
  const client = {
    [M.orchestratorsList]: () =>
      orchestrators.list(caller).pipe(Effect.map((list) => ({ orchestrators: list }))),
    [M.orchestratorsUpsert]: (payload) => orchestrators.upsert(caller, payload),
    [M.orchestratorsSetState]: (payload) => orchestrators.setState(caller, payload),
    [M.orchestratorsDelete]: (payload) =>
      orchestrators
        .delete(caller, payload.orchestratorId)
        .pipe(Effect.map((removed) => ({ removed }))),
    [M.orchestratorsSend]: (payload) => orchestrators.send(caller, payload),
    [M.orchestratorsInbox]: (payload) =>
      orchestrators.inbox(caller, payload).pipe(Effect.map((entries) => ({ entries }))),
    [M.orchestratorsResolveInbox]: (payload) => orchestrators.resolveInbox(caller, payload),
    [M.orchestratorsCheckpoints]: (payload) =>
      orchestrators
        .checkpoints(caller, payload)
        .pipe(Effect.map((checkpoints) => ({ checkpoints }))),
    [M.requestsList]: (payload) =>
      responsibility.listRequests(caller, payload).pipe(Effect.map((requests) => ({ requests }))),
    [M.claimsTransfer]: (payload) => responsibility.transferClaim(caller, payload),
  } as OrchestratorCliClient;
  return { operations: orchestratorOperations(client), runtime };
});

const record = (overrides: Partial<Orchestrator>): Orchestrator =>
  ({
    ...orchestratorInput(),
    id: "orchestrator:11111111-aaaa",
    version: 1,
    revision: 3,
    hostEnvironmentId: "environment:here",
    hostGeneration: 1,
    threadId: "thread:main",
    desiredState: "active",
    effectiveState: "idle",
    stateReason: null,
    inboxPending: 0,
    usage: {
      tokens: null,
      tokensComplete: false,
      turns: 2,
      turnsLastHour: 1,
      activeChildren: 0,
      since: "2026-06-20T00:00:00.000Z",
    },
    lastTurnAt: null,
    lastCheckpointAt: null,
    observedAt: "2026-06-20T00:00:00.000Z",
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
    ...overrides,
  }) as Orchestrator;

describe("orchestrator CLI", () => {
  it.effect.each(["orchestrator-local.json", "orchestrator-global.json"])(
    "the %s example is a definition `create` accepts",
    (name) =>
      Effect.gen(function* () {
        const definition = yield* decodeDefinition(
          yield* parseDefinition(yield* readExample(name)),
        );
        assert.isAbove(definition.name.length, 0);
        assert.strictEqual(definition.scope, name.includes("global") ? "global" : "local");
        assert.isAbove(definition.permissions.actions.length, 0);
        // Approvals are only ever granted by an explicit pre-authorization.
        assert.strictEqual(
          definition.permissions.actions.includes("request.approve"),
          (definition.permissions.preAuthorizedApprovals ?? []).length > 0,
        );
      }),
  );

  it.effect("rejects definitions it cannot use, naming what is wrong", () =>
    Effect.gen(function* () {
      for (const text of ["", "[]", "not json", '"a string"']) {
        const error = yield* parseDefinition(text).pipe(Effect.flip);
        assert.include(error.message, "JSON object");
      }
      const incomplete = yield* decodeDefinition({ name: "No scope" }).pipe(Effect.flip);
      assert.include(incomplete.message, "not valid");
      const badScope = yield* decodeDefinition({ ...orchestratorInput(), scope: "galactic" }).pipe(
        Effect.flip,
      );
      assert.include(badScope.message, "scope");
      const badBudget = yield* decodeDefinition({
        ...orchestratorInput(),
        budget: { ...orchestratorInput().budget, maxTokens: -5 },
      }).pipe(Effect.flip);
      assert.include(badBudget.message, "maxTokens");
    }),
  );

  it.effect("an edit keeps what the file leaves out and pins the revision it read", () =>
    Effect.gen(function* () {
      const existing = record({ name: "Before", batchWindowMs: 1_000 });
      const merged = yield* mergeDefinition(existing, { batchWindowMs: 9_000 });
      assert.strictEqual(merged.name, "Before");
      assert.strictEqual(merged.batchWindowMs, 9_000);
      assert.strictEqual(merged.id, existing.id);
      assert.strictEqual(merged.expectedRevision, 3);
      // Server-computed fields never travel back.
      assert.notProperty(merged, "effectiveState");
      assert.notProperty(merged, "usage");

      const pinned = yield* mergeDefinition(existing, { expectedRevision: 2 });
      assert.strictEqual(pinned.expectedRevision, 2);
      const wrongTarget = yield* mergeDefinition(existing, { id: "orchestrator:other" }).pipe(
        Effect.flip,
      );
      assert.include(wrongTarget.message, "orchestrator:other");
      const invalid = yield* mergeDefinition(existing, { batchWindowMs: "soon" }).pipe(Effect.flip);
      assert.include(invalid.message, "batchWindowMs");
    }),
  );

  it.effect("finds an orchestrator by id, unique prefix or name, and refuses to guess", () =>
    Effect.gen(function* () {
      const first = record({ id: "orchestrator:11111111-aaaa" as never, name: "Release captain" });
      const second = record({ id: "orchestrator:11112222-bbbb" as never, name: "Night watch" });
      const all = [first, second];
      assert.strictEqual((yield* resolveOrchestrator(all, first.id)).id, first.id);
      assert.strictEqual((yield* resolveOrchestrator(all, "11112")).id, second.id);
      assert.strictEqual((yield* resolveOrchestrator(all, "night WATCH")).id, second.id);
      const ambiguous = yield* resolveOrchestrator(all, "1111").pipe(Effect.flip);
      assert.include(ambiguous.message, "matches 2");
      const missing = yield* resolveOrchestrator(all, "nobody").pipe(Effect.flip);
      assert.include(missing.message, "No orchestrator");
      const empty = yield* resolveOrchestrator(all, "  ").pipe(Effect.flip);
      assert.include(empty.message, "No orchestrator");

      assert.deepStrictEqual(yield* parseOwner(all, "user"), { kind: "user" });
      assert.deepStrictEqual(yield* parseOwner(all, "thread:abc"), {
        kind: "thread",
        threadId: ThreadId.make("thread:abc"),
      });
      assert.deepStrictEqual(yield* parseOwner(all, "orchestrator:11112"), {
        kind: "orchestrator",
        orchestratorId: second.id,
        environmentId: second.hostEnvironmentId,
      });
      assert.deepStrictEqual(yield* parseOwner(all, first.id), {
        kind: "orchestrator",
        orchestratorId: first.id,
        environmentId: first.hostEnvironmentId,
      });
      for (const bad of ["me", "thread:", "orchestrator:nobody", ""]) {
        assert.isDefined(yield* parseOwner(all, bad).pipe(Effect.flip));
      }
    }),
  );

  it("prints unknown token usage as unknown and a paused wish next to the real state", () => {
    const paused = record({
      desiredState: "paused",
      effectiveState: "running",
      stateReason: "Paused: the current turn is finishing and no new turn will start.",
      inboxPending: 4,
    });
    assert.include(formatOrchestratorLine(paused), "running (wanted paused)");
    assert.include(formatOrchestratorLine(paused), "inbox 4");
    const detail = formatOrchestratorDetail(paused);
    assert.include(detail, "tokens unknown");
    assert.include(detail, "Reason:      Paused");
    assert.include(detail, "no limits");
    assert.include(
      formatOrchestratorDetail(
        record({
          usage: { ...paused.usage, tokens: 120, tokensComplete: false },
          budget: { ...paused.budget, maxTokens: 500 },
        }),
      ),
      "tokens 120+ (incomplete)",
    );
    assert.include(
      formatInboxEntry({
        id: "inbox:1" as never,
        orchestratorId: paused.id,
        kind: "user_message",
        dedupKey: "k",
        status: "unknown",
        relevance: "actionable",
        entries: [],
        text: "  first line\nsecond line  ",
        from: { kind: "user" },
        reservedByRunId: null,
        receivedAt: "2026-06-20T00:00:00.000Z",
        updatedAt: "2026-06-20T00:00:00.000Z",
      }),
      "unknown  actionable  user_message  2026-06-20T00:00:00.000Z  first line second line",
    );
  });

  it.effect(
    "the commands drive a real orchestrator: create, send, pause, inbox, edit, claims, remove",
    () =>
      withEngine("orchestrator-cli", ({ cwd, provider, journal }) =>
        Effect.gen(function* () {
          const { operations, runtime } = yield* inProcessClient;
          const definition = encodeJson({
            ...orchestratorInput({ name: "From the CLI" }),
            projectId,
            modelSelection,
          });
          const created = yield* operations.create(definition);
          assert.strictEqual(created.name, "From the CLI");
          assert.strictEqual((yield* operations.list).length, 1);
          assert.strictEqual((yield* operations.find("from the cli")).id, created.id);

          const paused = yield* operations.setState(created.id, "paused", false);
          assert.strictEqual(paused.effectiveState, "paused");
          const empty = yield* operations.send(created.id, "   ", Option.none()).pipe(Effect.flip);
          assert.include(empty.message, "empty");
          const sent = yield* operations.send(created.id, "Hello.", Option.some("cli-key"));
          const repeat = yield* operations.send(created.id, "Hello.", Option.some("cli-key"));
          assert.strictEqual(sent.entry.id, repeat.entry.id);
          yield* runtime.drain;
          assert.strictEqual((yield* Ref.get(provider.turns)).length, 0);
          const pending = yield* operations.inbox(created.id, ["pending"], 10);
          assert.deepStrictEqual(
            pending.map((entry) => entry.id),
            [sent.entry.id],
          );
          assert.strictEqual((yield* operations.inbox(created.id, ["processed"], 10)).length, 0);
          // Interrupting with nothing running leaves the wanted state alone.
          assert.strictEqual(
            (yield* operations.setState(created.id, "unchanged", true)).desiredState,
            "paused",
          );

          const edited = yield* operations.edit(
            created.id,
            '{"batchWindowMs": 0, "name": "Renamed"}',
          );
          assert.strictEqual(edited.name, "Renamed");
          assert.strictEqual(edited.revision, paused.revision + 1);
          assert.strictEqual(edited.desiredState, "paused");

          yield* operations.setState("Renamed", "active", false);
          yield* journal.untilTurnsFinished(1);
          const checkpoints = yield* operations.checkpoints(created.id, 5);
          assert.strictEqual(checkpoints.length, 1);
          const stale = yield* operations.resolveInbox(sent.entry.id, "requeue").pipe(Effect.flip);
          assert.include(stale.message, "No pending or unknown inbox entry");

          // A worker's question is claimed by this orchestrator and can be handed to the user.
          const worker = ThreadId.make("thread:cli-worker");
          yield* startThreadWithRequest({ threadId: worker, kind: "user_input", cwd });
          yield* awaitThreadEvent(
            worker,
            (event) =>
              event.type === "runtime-request.updated" && event.payload.status === "pending",
          );
          const [claimed] = yield* operations.claims(created.id);
          assert.strictEqual(claimed?.threadId, worker);
          const unnamed = yield* operations
            .transferClaim({
              thread: Option.some(worker),
              request: Option.none(),
              task: Option.none(),
              to: "user",
              expectedGeneration: Option.none(),
              reason: Option.none(),
            })
            .pipe(Effect.flip);
          assert.include(unnamed.message, "--thread with --request");
          const moved = yield* operations.transferClaim({
            thread: Option.some(worker),
            request: Option.some(claimed!.requestId),
            task: Option.none(),
            to: "user",
            expectedGeneration: Option.some(claimed!.claim!.generation),
            reason: Option.some("needs a person"),
          });
          assert.deepStrictEqual(moved.owner, { kind: "user" });
          assert.strictEqual((yield* operations.claims(created.id)).length, 0);

          const { removed } = yield* operations.remove(created.id);
          assert.isTrue(removed);
          assert.strictEqual((yield* operations.list).length, 0);
        }).pipe(Effect.provide(makeAutomationLayer())),
      ),
    TIMEOUT,
  );
});
