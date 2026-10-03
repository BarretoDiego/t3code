import {
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  SourceControlHubError,
  type ModelSelection,
  type AiReviewActivity,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { ProviderAdapterV2RuntimePolicy } from "../orchestration-v2/ProviderAdapter.ts";
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

const isHubError = Schema.is(SourceControlHubError);

/** Turn items that show the reviewer inspecting the repository. */
const TOOL_ITEM_TYPES: ReadonlySet<OrchestrationV2TurnItem["type"]> = new Set([
  "command_execution",
  "file_change",
  "file_search",
  "web_search",
  "dynamic_tool",
]);

function activityStatus(status: OrchestrationV2TurnItem["status"]): AiReviewActivity["status"] {
  switch (status) {
    case "failed":
      return "failed";
    case "cancelled":
    case "interrupted":
      return "cancelled";
    case "completed":
      return "completed";
    default:
      return "running";
  }
}

function toolText(item: OrchestrationV2TurnItem): string {
  switch (item.type) {
    case "command_execution":
      return item.input;
    case "file_change":
      return item.fileName;
    case "file_search":
      return item.pattern ?? "";
    case "web_search":
      return (item.patterns ?? []).join(", ");
    default:
      return "";
  }
}

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
          const adapter = instance.orchestrationAdapter;
          const id = yield* crypto.randomUUIDv4;
          const threadId = ThreadId.make(`ai-review-${id}`);
          const emit = input.onActivity ?? (() => Effect.void);
          // Supervised mode is each provider's read-only sandbox: Codex runs
          // `readOnly` with `untrusted` approvals, and approvals are declined below.
          const runtimePolicy: ProviderAdapterV2RuntimePolicy = {
            runtimeMode: "approval-required",
            interactionMode: "default",
            cwd: input.cwd,
          };
          // A private provider session: not an app thread, so nothing is
          // projected or shown in the sidebar. Closing the scope stops it.
          const runtime = yield* adapter.openSession({
            threadId,
            providerSessionId: ProviderSessionId.make(`ai-review-session-${id}`),
            modelSelection: input.modelSelection,
            runtimePolicy,
          });
          const completed = yield* Deferred.make<string, SourceControlHubError>();
          const assistantText = new Map<string, { readonly ordinal: number; text: string }>();
          const outputText = () =>
            [...assistantText.values()]
              .toSorted((left, right) => left.ordinal - right.ordinal)
              .map((entry) => entry.text)
              .join("\n\n");
          const declined = new Set<string>();
          yield* runtime.events.pipe(
            Stream.runForEach((event) =>
              Effect.gen(function* () {
                if (event.type === "turn_item.updated") {
                  const item = event.turnItem;
                  if (item.type === "assistant_message") {
                    assistantText.set(item.id, { ordinal: item.ordinal, text: item.text });
                    const text = outputText();
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
                  } else if (item.type === "reasoning") {
                    yield* emit({
                      id: "reasoning",
                      kind: "task",
                      label: "Reasoning",
                      status: "running",
                      text: "The provider is processing the review.",
                    });
                  } else if (item.type === "subagent") {
                    yield* emit({
                      id: item.subagentId,
                      kind: "task",
                      label: item.title ?? "Agent task",
                      status: activityStatus(item.status),
                      text: item.result ?? item.progress ?? "",
                    });
                  } else if (TOOL_ITEM_TYPES.has(item.type)) {
                    yield* emit({
                      id: item.id,
                      kind: "tool",
                      label: item.title ?? item.type.replaceAll("_", " "),
                      status: activityStatus(item.status),
                      text: toolText(item),
                    });
                  }
                }
                if (
                  event.type === "runtime_request.updated" &&
                  event.runtimeRequest.status === "pending" &&
                  !declined.has(event.runtimeRequest.id)
                ) {
                  const request = event.runtimeRequest;
                  declined.add(request.id);
                  yield* emit({
                    id: request.id,
                    kind: "tool",
                    label: "Declining approval request",
                    status: "running",
                    text: "AI reviews cannot grant additional permissions.",
                  });
                  yield* runtime
                    .respondToRuntimeRequest({
                      requestId: request.id,
                      // Questions are closed unanswered; permissions are refused.
                      decision: request.kind === "user_input" ? "cancel" : "decline",
                    })
                    .pipe(
                      Effect.timeout("10 seconds"),
                      Effect.mapError(
                        () =>
                          new SourceControlHubError({
                            message:
                              "Could not decline the review provider's approval request. The review was stopped; retry with a provider that supports unattended read-only analysis.",
                          }),
                      ),
                    );
                  yield* emit({
                    id: request.id,
                    kind: "tool",
                    label: "Approval declined",
                    status: "completed",
                    text: "The agent must continue with its existing read-only access.",
                  });
                }
                if (event.type === "turn.terminal") {
                  if (event.status === "completed") {
                    const text = outputText();
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
                        message:
                          event.status === "failed"
                            ? "The review agent stopped unexpectedly."
                            : "The review agent did not complete its analysis.",
                      }),
                    );
                }
              }),
            ),
            Effect.onExit((exit) =>
              Deferred.fail(
                completed,
                new SourceControlHubError({
                  message:
                    exit._tag === "Failure"
                      ? (Option.getOrUndefined(Cause.findErrorOption(exit.cause))?.message ??
                        "Review event processing failed. Check the provider and retry.")
                      : "The review provider event stream closed before analysis completed.",
                }),
              ),
            ),
            Effect.forkScoped({ startImmediately: true }),
          );
          const providerThread = yield* runtime.ensureThread({
            threadId,
            modelSelection: input.modelSelection,
            runtimePolicy,
            providerSessionId: runtime.providerSessionId,
          });
          const now = yield* DateTime.now;
          const appThread: OrchestrationV2AppThread = {
            createdBy: "system",
            creationSource: "server",
            id: threadId,
            projectId: ProjectId.make(`ai-review-${id}`),
            title: "AI review",
            providerInstanceId: instance.instanceId,
            modelSelection: input.modelSelection,
            runtimeMode: runtimePolicy.runtimeMode,
            interactionMode: runtimePolicy.interactionMode,
            branch: null,
            worktreePath: input.cwd,
            activeProviderThreadId: providerThread.id,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          };
          yield* runtime.startTurn({
            appThread,
            threadId,
            runId: RunId.make(`ai-review-run-${id}`),
            runOrdinal: 1,
            providerTurnOrdinal: 1,
            attemptId: RunAttemptId.make(`ai-review-attempt-${id}`),
            rootNodeId: NodeId.make(`ai-review-node-${id}`),
            providerThread,
            message: {
              messageId: MessageId.make(`ai-review-message-${id}`),
              text: input.prompt,
              attachments: [],
              createdBy: "user",
              creationSource: "server",
            },
            modelSelection: input.modelSelection,
            runtimePolicy,
          });
          return yield* Deferred.await(completed);
        }),
      ).pipe(
        Effect.timeout("20 minutes"),
        Effect.mapError((cause) =>
          isHubError(cause)
            ? cause
            : new SourceControlHubError({
                message:
                  "Review execution failed or timed out. Check the selected agent and retry.",
              }),
        ),
      ),
  });
});
export const layer = Layer.effect(ReviewAgentExecutor, make);
