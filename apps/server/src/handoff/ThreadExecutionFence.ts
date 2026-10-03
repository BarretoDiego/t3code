import { ThreadHandoffError, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { makeHandoffJournal } from "./HandoffJournal.ts";
import { assertExecutionOwner, committedOwner } from "./lifecycle.ts";

const isHandoffError = Schema.is(ThreadHandoffError);
const unverifiable = () =>
  new ThreadHandoffError({
    code: "notOwner",
    message: "Thread execution ownership could not be verified.",
  });

/**
 * Provider startup checks this before running a thread's agent. A thread whose
 * execution moved to another environment, or that is frozen while it
 * transfers, must not start a provider process here.
 */
export class ThreadExecutionFence extends Context.Service<
  ThreadExecutionFence,
  {
    readonly assertCanExecute: (threadId: ThreadId) => Effect.Effect<void, ThreadHandoffError>;
  }
>()("t3/handoff/ThreadExecutionFence") {}

export const make = Effect.gen(function* () {
  const journal = yield* makeHandoffJournal;
  const identity = yield* ServerEnvironmentIdentity;
  const environmentId = yield* identity.getEnvironmentId;
  return ThreadExecutionFence.of({
    assertCanExecute: (threadId) =>
      journal.head(threadId).pipe(
        Effect.mapError(unverifiable),
        Effect.flatMap((record) =>
          record === null
            ? Effect.void
            : Effect.try({
                try: () =>
                  assertExecutionOwner({
                    record,
                    environmentId,
                    generation: committedOwner(record).generation,
                  }),
                catch: (cause) => (isHandoffError(cause) ? cause : unverifiable()),
              }),
        ),
      ),
  });
});

export const layer = Layer.effect(ThreadExecutionFence, make);
