import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as Stream from "effect/Stream";
import {
  SourceControlHubError,
  type AiReviewActivity,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { ProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import type {
  ProviderAdapterV2Event,
  ProviderAdapterV2OpenSessionInput,
  ProviderAdapterV2RuntimeRequestResponseInput,
  ProviderAdapterV2TurnInput,
} from "../orchestration-v2/ProviderAdapter.ts";
import { make } from "./ReviewAgentExecutor.ts";

const driver = ProviderDriverKind.make("codex");

const turnItem = (fields: Record<string, unknown>) =>
  ({
    type: "turn_item.updated",
    driver,
    turnItem: { title: null, ordinal: 1, status: "running", ...fields },
  }) as unknown as ProviderAdapterV2Event;

const pendingRequest = (id: string, kind: string) =>
  ({
    type: "runtime_request.updated",
    driver,
    runtimeRequest: { id, kind, status: "pending" },
  }) as unknown as ProviderAdapterV2Event;

const terminal = (status: "completed" | "failed") =>
  ({ type: "turn.terminal", driver, status }) as unknown as ProviderAdapterV2Event;

/** A provider instance whose orchestration adapter runs one scripted session. */
function fakeInstance(options: {
  readonly instanceId: ProviderInstanceId;
  readonly events: Stream.Stream<ProviderAdapterV2Event>;
  readonly onStartTurn: (input: ProviderAdapterV2TurnInput) => Effect.Effect<void>;
  readonly respond: (
    input: ProviderAdapterV2RuntimeRequestResponseInput,
  ) => Effect.Effect<void, unknown>;
  readonly opened: Array<ProviderAdapterV2OpenSessionInput>;
  readonly stopped: Array<string>;
  readonly ensureThread?: Effect.Effect<void>;
}) {
  return {
    enabled: true,
    instanceId: options.instanceId,
    driverKind: driver,
    orchestrationAdapter: {
      instanceId: options.instanceId,
      driver,
      openSession: (input: ProviderAdapterV2OpenSessionInput) =>
        Effect.gen(function* () {
          options.opened.push(input);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              options.stopped.push(input.providerSessionId);
            }),
          );
          return {
            providerSessionId: input.providerSessionId,
            events: options.events,
            ensureThread: () =>
              (options.ensureThread ?? Effect.void).pipe(
                Effect.as({ id: "provider-thread", driver }),
              ),
            startTurn: options.onStartTurn,
            respondToRuntimeRequest: options.respond,
          };
        }),
    },
  } as unknown as ProviderInstance;
}

it.effect("rejects approvals, reports activity and closes the isolated session", () =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
    const opened: ProviderAdapterV2OpenSessionInput[] = [];
    const stopped: string[] = [];
    const decisions: string[] = [];
    const prompts: string[] = [];
    const activity: AiReviewActivity[] = [];
    const instanceId = ProviderInstanceId.make("test-reviewer");
    const instance = fakeInstance({
      instanceId,
      opened,
      stopped,
      events: Stream.fromQueue(events),
      respond: (input) =>
        Effect.sync(() => {
          decisions.push(input.decision ?? "none");
        }),
      onStartTurn: (input) =>
        Effect.gen(function* () {
          prompts.push(input.message.text);
          for (const event of [
            pendingRequest("approval", "command"),
            turnItem({ id: "reasoning-1", type: "reasoning", text: "private reasoning" }),
            turnItem({
              id: "security",
              type: "subagent",
              subagentId: "security",
              title: "Security check",
              status: "running",
              progress: null,
              result: null,
            }),
            turnItem({ id: "read", type: "command_execution", title: "Read", input: "cat a.ts" }),
            turnItem({
              id: "read",
              type: "command_execution",
              title: "Read",
              input: "cat a.ts",
              status: "completed",
            }),
            turnItem({
              id: "security",
              type: "subagent",
              subagentId: "security",
              title: "Security check",
              status: "failed",
              result: "Unavailable context",
            }),
            turnItem({ id: "answer", type: "assistant_message", text: "structured output" }),
            terminal("completed"),
          ])
            yield* Queue.offer(events, event);
        }),
    });
    const executor = yield* make.pipe(
      Effect.provide(
        Layer.mock(ProviderInstanceRegistry)({ getInstance: () => Effect.succeed(instance) }),
      ),
    );
    expect(
      yield* executor.execute({
        onActivity: (row) =>
          Effect.sync(() => {
            activity.push(row);
          }),
        cwd: "/isolated-review",
        prompt: "Review",
        modelSelection: { instanceId, model: "test-model" },
      }),
    ).toBe("structured output");
    expect(prompts).toEqual(["Review"]);
    expect(opened[0]?.runtimePolicy).toMatchObject({
      runtimeMode: "approval-required",
      cwd: "/isolated-review",
    });
    expect(activity).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "security", status: "running" }),
        expect.objectContaining({ id: "security", status: "failed" }),
        expect.objectContaining({ id: "read", status: "completed", text: "cat a.ts" }),
        expect.objectContaining({ id: "output", status: "running", text: "structured output" }),
        expect.objectContaining({ id: "output", status: "completed" }),
      ]),
    );
    expect(activity.some((item) => item.text.includes("private reasoning"))).toBe(false);
    expect(decisions).toEqual(["decline"]);
    expect(stopped).toEqual([opened[0]?.providerSessionId]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each([
  "approval failure",
  "activity failure",
  "closed stream",
  "startup timeout",
] as const)("stops the isolated reviewer on %s without waiting forever", (scenario) =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
    const startup = yield* Deferred.make<void>();
    const opened: ProviderAdapterV2OpenSessionInput[] = [];
    const stopped: string[] = [];
    const instanceId = ProviderInstanceId.make("review-failure-test");
    const instance = fakeInstance({
      instanceId,
      opened,
      stopped,
      events: scenario === "closed stream" ? Stream.empty : Stream.fromQueue(events),
      ensureThread: Deferred.succeed(startup, undefined).pipe(
        Effect.andThen(scenario === "startup timeout" ? Effect.never : Effect.void),
      ),
      respond: () => Effect.fail(new SourceControlHubError({ message: "approval unavailable" })),
      onStartTurn: () =>
        Queue.offer(
          events,
          scenario === "approval failure"
            ? pendingRequest("approval", "command")
            : turnItem({ id: "answer", type: "assistant_message", text: "hello" }),
        ).pipe(Effect.asVoid),
    });
    const executor = yield* make.pipe(
      Effect.provide(
        Layer.mock(ProviderInstanceRegistry)({ getInstance: () => Effect.succeed(instance) }),
      ),
    );
    const fiber = yield* executor
      .execute({
        cwd: "/isolated",
        prompt: "Review",
        modelSelection: { instanceId, model: "test" },
        onActivity: () =>
          scenario === "activity failure"
            ? Effect.die(new Error("activity callback failed"))
            : Effect.void,
      })
      .pipe(Effect.exit, Effect.forkScoped);
    yield* Deferred.await(startup);
    if (scenario === "startup timeout") yield* TestClock.adjust("20 minutes");
    const result = yield* Fiber.join(fiber);
    expect(Exit.isFailure(result)).toBe(true);
    expect(stopped).toHaveLength(1);
    if (Exit.isFailure(result)) {
      const description = String(result.cause);
      expect(description).toContain(
        scenario === "approval failure"
          ? "Could not decline"
          : scenario === "activity failure"
            ? "event processing failed"
            : scenario === "closed stream"
              ? "stream closed"
              : "timed out",
      );
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
