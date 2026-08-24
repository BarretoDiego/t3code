/**
 * ProviderRateLimitsReactor - records plan rate-limit observations.
 *
 * Providers only report their plan headroom while a session is live, so the
 * observation has to be captured as it flies past on the runtime stream and
 * stored on the provider snapshot the clients already subscribe to.
 *
 * @module ProviderRateLimitsReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface ProviderRateLimitsReactorShape {
  /**
   * Start forwarding `account.rate-limits.updated` observations into the
   * provider registry. Must be run in a scope so the worker is finalized on
   * shutdown.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /** Resolves once every observed event has been applied. Test seam. */
  readonly drain: Effect.Effect<void>;
}

export class ProviderRateLimitsReactor extends Context.Service<
  ProviderRateLimitsReactor,
  ProviderRateLimitsReactorShape
>()("t3/orchestration/Services/ProviderRateLimitsReactor") {}
