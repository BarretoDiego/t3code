/**
 * ProviderRateLimitsReactorLive - runtime stream -> provider snapshot.
 *
 * Adapters normalize their native plan-limit payload and attach it to
 * `account.rate-limits.updated`; this reactor is the only thing that knows
 * where that observation ends up. Events without a normalized snapshot (a
 * provider shape we cannot map yet) are ignored — they are still logged as raw
 * runtime events for diagnostics.
 *
 * @module ProviderRateLimitsReactorLive
 */
import type { ProviderRuntimeEvent } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { forkParked } from "../../serverActivation.ts";
import {
  ProviderRateLimitsReactor,
  type ProviderRateLimitsReactorShape,
} from "../Services/ProviderRateLimitsReactor.ts";

type AccountRateLimitsUpdatedEvent = Extract<
  ProviderRuntimeEvent,
  { type: "account.rate-limits.updated" }
>;

export const make = Effect.gen(function* () {
  const providerService = yield* ProviderService;
  const providerRegistry = yield* ProviderRegistry;

  const processEvent = (event: AccountRateLimitsUpdatedEvent) => {
    const snapshot = event.payload.snapshot;
    const instanceId = event.providerInstanceId;
    // `ProviderService` stamps the instance id on every event it fans out; an
    // event without one predates that and cannot be attributed to a snapshot.
    if (!snapshot || instanceId === undefined) {
      return Effect.void;
    }
    return providerRegistry
      .setProviderRateLimits({
        instanceId,
        rateLimits: snapshot,
        ...(event.payload.updateMode ? { mode: event.payload.updateMode } : {}),
      })
      .pipe(
        Effect.asVoid,
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("failed to record provider rate limits", {
                instanceId,
                provider: event.provider,
                cause: Cause.pretty(cause),
              }),
        ),
      );
  };

  const worker = yield* makeDrainableWorker(processEvent);

  const start: ProviderRateLimitsReactorShape["start"] = () =>
    forkParked(
      Stream.runForEach(providerService.streamEvents, (event) =>
        event.type === "account.rate-limits.updated" ? worker.enqueue(event) : Effect.void,
      ),
    ).pipe(Effect.asVoid);

  return {
    start,
    drain: worker.drain,
  } satisfies ProviderRateLimitsReactorShape;
});

export const ProviderRateLimitsReactorLive = Layer.effect(ProviderRateLimitsReactor, make);
