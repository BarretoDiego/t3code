import {
  ApprovalRequestId,
  ThreadId,
  SourceControlHubError,
  type ModelSelection,
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
                if (
                  event.type === "content.delta" &&
                  event.payload.streamKind === "assistant_text"
                ) {
                  text += event.payload.delta;
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
                  if (event.payload.state === "completed") yield* Deferred.succeed(completed, text);
                  else
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
