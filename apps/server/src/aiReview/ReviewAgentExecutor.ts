import {
  isToolLifecycleItemType,
  ApprovalRequestId,
  ThreadId,
  SourceControlHubError,
  type ModelSelection,
  type AiReviewActivity,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";

export class ReviewAgentExecutor extends Context.Service<
  ReviewAgentExecutor,
  {
    readonly execute: (input: {
      readonly cwd: string;
      readonly prompt: string;
      readonly modelSelection: ModelSelection;
      readonly onActivity?: (activity: AiReviewActivity) => Effect.Effect<void>;
    }) => Effect.Effect<string, SourceControlHubError>;
  }
>()("t3/aiReview/ReviewAgentExecutor") {}

export const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry;
  const crypto = yield* Crypto.Crypto;
  return ReviewAgentExecutor.of({
    execute: (input) =>
      Effect.scoped(
        Effect.gen(function* () {
          const instance = yield* registry.getInstance(input.modelSelection.instanceId);
          if (!instance?.enabled)
            return yield* new SourceControlHubError({ message: "Selected agent is unavailable." });
          const adapter = instance.adapter;
          const threadId = ThreadId.make(`ai-review-${yield* crypto.randomUUIDv4}`);
          const completed = yield* Deferred.make<string, SourceControlHubError>();
          let text = "";
          yield* adapter.streamEvents.pipe(
            Stream.filter((event) => event.threadId === threadId),
            Stream.runForEach((event) =>
              Effect.gen(function* () {
                const emit = input.onActivity ?? (() => Effect.void);
                if (
                  event.type === "task.started" ||
                  event.type === "task.progress" ||
                  event.type === "task.updated" ||
                  event.type === "task.completed"
                ) {
                  const payload = event.payload;
                  yield* emit({
                    id: payload.taskId,
                    kind: "task",
                    label:
                      payload.title ??
                      ("description" in payload ? payload.description : undefined) ??
                      "Agent task",
                    status:
                      "status" in payload && payload.status === "failed"
                        ? "failed"
                        : "status" in payload &&
                            (payload.status === "stopped" ||
                              payload.status === "cancelled" ||
                              payload.status === "interrupted")
                          ? "cancelled"
                          : "status" in payload && payload.status === "completed"
                            ? "completed"
                            : "running",
                    text: "summary" in payload ? (payload.summary ?? "") : "",
                  });
                }
                if (
                  (event.type === "item.started" ||
                    event.type === "item.updated" ||
                    event.type === "item.completed") &&
                  isToolLifecycleItemType(event.payload.itemType)
                ) {
                  yield* emit({
                    id: event.itemId ?? event.payload.itemType,
                    kind: "tool",
                    label: event.payload.title ?? event.payload.itemType.replaceAll("_", " "),
                    text: event.payload.detail ?? "",
                    status:
                      event.payload.status === "failed"
                        ? "failed"
                        : event.payload.status === "declined"
                          ? "cancelled"
                          : event.type === "item.completed"
                            ? "completed"
                            : "running",
                  });
                }
                if (event.type === "tool.progress") {
                  yield* emit({
                    id: event.payload.toolUseId ?? "tool",
                    kind: "tool",
                    label: event.payload.toolName ?? "Inspecting repository",
                    status: "running",
                    text: event.payload.summary ?? "",
                  });
                }
                if (event.type === "tool.summary") {
                  for (const id of event.payload.precedingToolUseIds ?? ["tool"]) {
                    yield* emit({
                      id,
                      kind: "tool",
                      label: "Repository inspection",
                      status: "completed",
                      text: event.payload.summary,
                    });
                  }
                }
                if (
                  event.type === "content.delta" &&
                  event.payload.streamKind === "assistant_text"
                ) {
                  text += event.payload.delta;
                  yield* emit({
                    id: "output",
                    kind: "agent",
                    label: "Reviewer",
                    status: "running",
                    text: text.slice(-32_000),
                  });
                  if (text.length > 500_000)
                    yield* Deferred.fail(
                      completed,
                      new SourceControlHubError({
                        message: "Review output exceeded the allowed size.",
                      }),
                    );
                }
                if (event.type === "request.opened" && event.requestId)
                  yield* adapter
                    .respondToRequest(threadId, ApprovalRequestId.make(event.requestId), "decline")
                    .pipe(Effect.ignore);
                if (event.type === "turn.completed") {
                  if (event.payload.state === "completed") {
                    yield* emit({
                      id: "output",
                      kind: "agent",
                      label: "Reviewer",
                      status: "completed",
                      text: text.slice(-32_000),
                    });
                    yield* Deferred.succeed(completed, text);
                  } else
                    yield* Deferred.fail(
                      completed,
                      new SourceControlHubError({
                        message: "The review agent did not complete its analysis.",
                      }),
                    );
                }
                if (event.type === "runtime.error" || event.type === "turn.aborted")
                  yield* Deferred.fail(
                    completed,
                    new SourceControlHubError({
                      message: "The review agent stopped unexpectedly.",
                    }),
                  );
              }),
            ),
            Effect.forkScoped({ startImmediately: true }),
          );
          yield* Effect.addFinalizer(() => adapter.stopSession(threadId).pipe(Effect.ignore));
          yield* adapter.startSession({
            threadId,
            providerInstanceId: instance.instanceId,
            provider: instance.driverKind,
            cwd: input.cwd,
            modelSelection: input.modelSelection,
            runtimeMode: "approval-required",
            sandboxMode: "read-only",
            approvalPolicy: "untrusted",
          });
          yield* adapter.sendTurn({
            threadId,
            input: input.prompt,
            modelSelection: input.modelSelection,
          });
          return yield* Deferred.await(completed).pipe(Effect.timeout("20 minutes"));
        }),
      ).pipe(
        Effect.mapError(
          () =>
            new SourceControlHubError({
              message: "Review execution failed or timed out. Check the selected agent and retry.",
            }),
        ),
      ),
  });
});
export const layer = Layer.effect(ReviewAgentExecutor, make);
