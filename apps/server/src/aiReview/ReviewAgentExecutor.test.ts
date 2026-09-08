import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import {
  SourceControlHubError,
  type AiReviewActivity,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSessionStartInput,
  type ProviderSendTurnInput,
} from "@t3tools/contracts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import { make } from "./ReviewAgentExecutor.ts";

it.effect(
  "subscribes before synchronous output, rejects approvals and closes the isolated session",
  () =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
      const broadcast = yield* PubSub.unbounded<ProviderRuntimeEvent>();
      const normalEvents: ProviderRuntimeEvent[] = [];
      yield* Stream.fromQueue(events).pipe(
        Stream.runForEach((event) => PubSub.publish(broadcast, event)),
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* Stream.fromPubSub(broadcast).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            normalEvents.push(event);
          }),
        ),
        Effect.forkScoped({ startImmediately: true }),
      );
      const started: ProviderSessionStartInput[] = [];
      const decisions: string[] = [];
      const activity: AiReviewActivity[] = [];
      const stopped: string[] = [];
      const instanceId = ProviderInstanceId.make("test-reviewer");
      const instance = {
        enabled: true,
        instanceId,
        driverKind: ProviderDriverKind.make("codex"),
        adapter: {
          streamEvents: Stream.fromQueue(events),
          startSession: (input: ProviderSessionStartInput) =>
            Effect.sync(() => {
              started.push(input);
            }),
          stopSession: (threadId: string) =>
            Effect.sync(() => {
              stopped.push(threadId);
            }),
          respondToRequest: (_threadId: string, _id: string, decision: string) =>
            Effect.sync(() => {
              decisions.push(decision);
            }),
          sendTurn: (input: ProviderSendTurnInput) =>
            Effect.gen(function* () {
              for (const event of [
                { type: "request.opened", requestId: "approval", payload: {} },
                {
                  type: "content.delta",
                  payload: { streamKind: "reasoning_text", delta: "private reasoning" },
                },
                {
                  type: "task.started",
                  payload: { taskId: "security", description: "Security check" },
                },
                {
                  type: "tool.progress",
                  payload: { toolUseId: "read", toolName: "Read", summary: "Reading file" },
                },
                {
                  type: "tool.summary",
                  payload: { precedingToolUseIds: ["read"], summary: "Read complete" },
                },
                {
                  type: "task.completed",
                  payload: { taskId: "security", status: "failed", summary: "Unavailable context" },
                },
                {
                  type: "content.delta",
                  payload: { streamKind: "assistant_text", delta: "structured output" },
                },
                { type: "turn.completed", payload: { state: "completed" } },
              ])
                yield* Queue.offer(events, {
                  ...event,
                  threadId: input.threadId,
                  providerInstanceId: instanceId,
                } as ProviderRuntimeEvent);
            }),
        },
      } as unknown as ProviderInstance;
      const executor = yield* make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(ProviderInstanceRegistry)({ getInstance: () => Effect.succeed(instance) }),
            Layer.mock(ProviderService)({ streamEvents: Stream.fromPubSub(broadcast) }),
          ),
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
      expect(started[0]).toMatchObject({
        sandboxMode: "read-only",
        runtimeMode: "approval-required",
        approvalPolicy: "untrusted",
        cwd: "/isolated-review",
      });
      expect(activity).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "security", status: "running" }),
          expect.objectContaining({ id: "security", status: "failed" }),
          expect.objectContaining({ id: "read", status: "completed", text: "Read complete" }),
          expect.objectContaining({ id: "output", status: "running", text: "structured output" }),
          expect.objectContaining({ id: "output", status: "completed" }),
        ]),
      );
      expect(activity.some((item) => item.text.includes("private reasoning"))).toBe(false);
      expect(decisions).toEqual(["decline"]);
      expect(normalEvents.some((event) => event.type === "turn.completed")).toBe(true);
      expect(stopped).toEqual([started[0]?.threadId]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

for (const scenario of [
  "approval failure",
  "activity failure",
  "closed stream",
  "startup timeout",
] as const) {
  it.effect(`stops the isolated reviewer on ${scenario} without waiting forever`, () =>
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
      const startup = yield* Deferred.make<void>();
      const stopped: string[] = [];
      const instanceId = ProviderInstanceId.make("review-failure-test");
      const instance = {
        enabled: true,
        instanceId,
        driverKind: ProviderDriverKind.make("codex"),
        adapter: {
          startSession: () =>
            Deferred.succeed(startup, undefined).pipe(
              Effect.andThen(scenario === "startup timeout" ? Effect.never : Effect.void),
            ),
          stopSession: (id: string) =>
            Effect.sync(() => {
              stopped.push(id);
            }),
          respondToRequest: () =>
            Effect.fail(new SourceControlHubError({ message: "approval unavailable" })),
          sendTurn: (input: ProviderSendTurnInput) =>
            PubSub.publish(events, {
              threadId: input.threadId,
              providerInstanceId: instanceId,
              ...(scenario === "approval failure"
                ? {
                    type: "request.opened",
                    requestId: "approval",
                    payload: { requestType: "command_execution_approval" },
                  }
                : {
                    type: "content.delta",
                    payload: { streamKind: "assistant_text", delta: "hello" },
                  }),
            } as ProviderRuntimeEvent),
        },
      } as unknown as ProviderInstance;
      const executor = yield* make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(ProviderInstanceRegistry)({ getInstance: () => Effect.succeed(instance) }),
            Layer.mock(ProviderService)({
              streamEvents: scenario === "closed stream" ? Stream.empty : Stream.fromPubSub(events),
            }),
          ),
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
}
