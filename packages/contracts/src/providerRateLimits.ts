/**
 * Provider plan rate limits.
 *
 * Providers meter subscription plans on rolling windows — Claude reports a
 * 5-hour window plus 7-day windows (overall, Opus, Sonnet), Codex reports a
 * `primary`/`secondary` pair whose real duration only shows up in
 * `windowDurationMins`, and both can carry extra spend or credit ceilings.
 * The shapes have nothing in common, so adapters normalize their native
 * payload into the provider-agnostic {@link ProviderRateLimitWindow} list
 * below and everything downstream (registry, wire, UI) stays dumb.
 *
 * Snapshots are observations, never live counters: they are refreshed when a
 * provider tells us something changed, and they keep their last known value
 * between runs. `observedAt` plus `resetsAt` is what lets a client say how
 * much to trust a window.
 *
 * @module providerRateLimits
 */
import * as Schema from "effect/Schema";

import {
  ForwardCompatibleArray,
  IsoDateTime,
  PositiveInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/**
 * Coarse bucket a window belongs to, so clients can order and label windows
 * without knowing which provider produced them.
 *
 * - `session` — the short rolling window a burst of work runs into first
 *   (Claude's 5 hours, Codex's `primary`).
 * - `weekly` — the multi-day ceiling (Claude's 7-day windows, Codex's
 *   `secondary` when it spans a week).
 * - `monthly` — longer billing-period ceilings.
 * - `credits` — balance or spend controls rather than time windows.
 * - `other` — anything a provider reports that does not fit above.
 */
export const ProviderRateLimitWindowKind = Schema.Literals([
  "session",
  "weekly",
  "monthly",
  "credits",
  "other",
]);
export type ProviderRateLimitWindowKind = typeof ProviderRateLimitWindowKind.Type;

/**
 * Headroom state of one window. Derived from `usedPercent` by
 * {@link resolveProviderRateLimitStatus} unless the provider says outright
 * that the limit was reached.
 */
export const ProviderRateLimitStatus = Schema.Literals(["ok", "warning", "exhausted"]);
export type ProviderRateLimitStatus = typeof ProviderRateLimitStatus.Type;

/** Percentage at which a window stops being comfortable. */
export const PROVIDER_RATE_LIMIT_WARNING_PERCENT = 80;

/**
 * Map a used percentage onto a status. Adapters that receive an explicit
 * "limit reached" signal pass `exhausted` themselves instead of calling this.
 */
export const resolveProviderRateLimitStatus = (usedPercent: number): ProviderRateLimitStatus =>
  usedPercent >= 100
    ? "exhausted"
    : usedPercent >= PROVIDER_RATE_LIMIT_WARNING_PERCENT
      ? "warning"
      : "ok";

export const ProviderRateLimitWindow = Schema.Struct({
  /** Stable within a provider (`five_hour`, `seven_day_opus`, `primary`, …). */
  id: TrimmedNonEmptyString,
  /** Adapter-authored, already human readable ("5-hour", "Weekly"). Rendered verbatim. */
  label: TrimmedNonEmptyString,
  kind: ProviderRateLimitWindowKind,
  usedPercent: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  /** When the window rolls over. Null when the provider does not say. */
  resetsAt: Schema.NullOr(IsoDateTime),
  /** Nominal window length, when the provider reports one. */
  windowMinutes: Schema.optionalKey(PositiveInt),
  status: ProviderRateLimitStatus,
  /** Extra context, e.g. a credit balance or why a limit is unavailable. */
  detail: Schema.optionalKey(TrimmedNonEmptyString),
});
export type ProviderRateLimitWindow = typeof ProviderRateLimitWindow.Type;

export const ProviderRateLimits = Schema.Struct({
  /** When the provider handed us these numbers. */
  observedAt: IsoDateTime,
  /** Plan the limits belong to (`Pro`, `Max`, `Team`, …). */
  planLabel: Schema.optionalKey(TrimmedNonEmptyString),
  /**
   * Window kinds grow with each provider release; an older client must render
   * the windows it understands rather than drop the whole snapshot.
   */
  windows: ForwardCompatibleArray(ProviderRateLimitWindow),
  /** Provider-level message, e.g. a rate-limit-reached explanation. */
  notice: Schema.optionalKey(TrimmedNonEmptyString),
});
export type ProviderRateLimits = typeof ProviderRateLimits.Type;
