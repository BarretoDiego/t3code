/**
 * ProviderRateLimitsReactorLive - runtime stream -> provider snapshot.
 *
 * Adapters normalize their native plan-limit payload and attach it to
 * `account.rate-limits.updated`; this reactor applies those sparse updates to
 * the owning instance snapshot. Events without an owning instance are ignored
 * — they are still logged as raw runtime events for diagnostics.
 *
 * @module ProviderRateLimitsReactorLive
 */
import type { ProviderRuntimeEvent } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ProviderInstanceRegistry } from "../../provider/Services/ProviderInstanceRegistry.ts";
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
  const instanceRegistry = yield* ProviderInstanceRegistry;

  const processEvent = (event: AccountRateLimitsUpdatedEvent) =>
    Effect.gen(function* () {
      const instanceId = event.providerInstanceId;
      // `ProviderService` stamps the instance id on every event it fans out; an
      // event without one predates that and cannot be attributed to an instance.
      if (instanceId === undefined) {
        return;
      }
      const instance = yield* instanceRegistry.getInstance(instanceId);
      if (!instance) {
        return;
      }
      const checkedAt = DateTime.formatIso(yield* DateTime.now);
      yield* instance.snapshot.applyUsageLimits({ ...event.payload.limits, checkedAt });
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("failed to record provider rate limits", {
              instanceId: event.providerInstanceId,
              provider: event.provider,
              cause: Cause.pretty(cause),
            }),
      ),
    );

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
