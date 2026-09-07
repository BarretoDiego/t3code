import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import {
  type AiReviewActivity,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSessionStartInput,
  type ProviderSendTurnInput,
} from "@t3tools/contracts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import { make } from "./ReviewAgentExecutor.ts";

it.effect(
  "subscribes before synchronous output, rejects approvals and closes the isolated session",
  () =>
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
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
          streamEvents: Stream.fromPubSub(events),
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
                yield* PubSub.publish(events, {
                  ...event,
                  threadId: input.threadId,
                } as ProviderRuntimeEvent);
            }),
        },
      } as unknown as ProviderInstance;
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
      expect(stopped).toEqual([started[0]?.threadId]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
