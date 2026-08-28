/**
 * Kimi For Coding plan usage.
 *
 * Claude Code instances pointed at the Kimi Code endpoint
 * (`ANTHROPIC_BASE_URL=https://api.kimi.com/coding/`) never emit
 * `rate_limit_event`s and the SDK `get_usage` control API reports
 * `rate_limits_available: false` for third-party backends — so plan limits
 * for those instances come straight from Kimi's account API instead:
 *
 *   GET {baseUrl}/usages   (Authorization: Bearer <instance API key>)
 *
 * The payload carries stringly-typed numbers and proto-style enums:
 *
 *   {
 *     "user":  { "membership": { "level": "LEVEL_ADVANCED" } },
 *     "usage": { "used": "4", "limit": "100", "resetTime": "..." },   // weekly quota
 *     "limits": [{ "window": { "duration": 300, "timeUnit": "TIME_UNIT_MINUTE" },
 *                  "detail": { "used": "22", "limit": "100", "resetTime": "..." } }],
 *     "boosterWallet": { "balance": { "amountLeft": ... }, ... }       // Extra Usage
 *   }
 *
 * Mirrors the normalization approach of `providerRateLimits.ts`: adapters hand
 * the result to the registry, everything downstream stays provider-agnostic.
 *
 * @module provider/kimiCodeUsage
 */
import {
  resolveProviderRateLimitStatus,
  type ProviderRateLimits,
  type ProviderRateLimitWindow,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { describeRateLimitWindowDuration } from "./providerRateLimits.ts";

/** Kimi Code regions: `.com` is global, `.ai` is mainland-cn. */
const KIMI_CODE_HOSTS = new Set(["api.kimi.com", "api.kimi.ai"]);

/** Same override the Kimi Code CLI honors (`KIMI_CODE_BASE_URL`). */
const KIMI_CODE_BASE_URL_OVERRIDE = "KIMI_CODE_BASE_URL";

const USAGE_FETCH_TIMEOUT_MS = 8_000;

/** The fixed-point scale Kimi money fields use: 1_000_000 = one cent. */
const KIMI_FIXED_POINT_CENTS = 1_000_000;

export interface KimiCodeUsageSource {
  /** Absolute URL of the `/usages` endpoint for this instance's region. */
  readonly usagesUrl: string;
  /** API key bearer for the account the instance talks to. */
  readonly token: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const trimmed = (value: string | null | undefined): string | undefined => {
  const text = value?.trim();
  return text && text.length > 0 ? text : undefined;
};

/**
 * Detect whether a Claude instance's resolved environment talks to Kimi For
 * Coding, and if so where its usage endpoint lives and with what token.
 *
 * Recognized shapes:
 *   - `ANTHROPIC_BASE_URL=https://api.kimi.com/coding/` (Claude Code guide)
 *   - `ANTHROPIC_BASE_URL=https://api.kimi.ai/coding/`  (mainland-cn mirror)
 *   - `KIMI_CODE_BASE_URL` override (Kimi Code CLI convention) wins outright
 *
 * The token comes from `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`, matching
 * what the spawned CLI would authenticate with.
 */
export function resolveKimiCodeUsageSource(
  environment: NodeJS.ProcessEnv | undefined,
): KimiCodeUsageSource | null {
  if (!environment) return null;
  const token =
    trimmed(environment["ANTHROPIC_API_KEY"]) ?? trimmed(environment["ANTHROPIC_AUTH_TOKEN"]);

  const override = trimmed(environment[KIMI_CODE_BASE_URL_OVERRIDE]);
  if (override !== undefined) {
    return token === undefined
      ? null
      : { usagesUrl: `${override.replace(/\/+$/, "")}/usages`, token };
  }

  const baseUrl = trimmed(environment["ANTHROPIC_BASE_URL"]);
  if (baseUrl === undefined || token === undefined) return null;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (!KIMI_CODE_HOSTS.has(host)) return null;
  if (!url.pathname.replace(/\/+$/, "").endsWith("/coding")) return null;
  return {
    usagesUrl: `${url.origin}/coding/v1/usages`,
    token,
  };
}

/* -------------------------------------------------------------------------- */
/* Wire payload parsing                                                       */
/* -------------------------------------------------------------------------- */

interface KimiUsageDetail {
  readonly used: number | null;
  readonly limit: number | null;
  readonly resetAt: string | null;
}

interface KimiUsageWindowRow {
  readonly detail: KimiUsageDetail;
  readonly windowMinutes: number | null;
}

interface KimiCodeUsagePayload {
  readonly membershipLevel: string | null;
  readonly summary: KimiUsageDetail | null;
  readonly rows: ReadonlyArray<KimiUsageWindowRow>;
  readonly extraUsage: {
    readonly balanceCents: number;
    readonly totalCents: number;
    readonly monthlyChargeLimitEnabled: boolean;
    readonly monthlyChargeLimitCents: number;
    readonly monthlyUsedCents: number;
    readonly currency: string;
  } | null;
}

/** Numbers arrive as decimal strings; accept both. */
function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readDetail(raw: unknown): KimiUsageDetail | null {
  if (!isRecord(raw)) return null;
  const resetTime = raw["resetTime"];
  return {
    used: toNumber(raw["used"]),
    limit: toNumber(raw["limit"]),
    resetAt: typeof resetTime === "string" && resetTime.length > 0 ? resetTime : null,
  };
}

const TIME_UNIT_MINUTES: Readonly<Record<string, number>> = {
  TIME_UNIT_MINUTE: 1,
  TIME_UNIT_HOUR: 60,
  TIME_UNIT_DAY: 60 * 24,
  TIME_UNIT_WEEK: 60 * 24 * 7,
};

function readWindowMinutes(raw: unknown): number | null {
  if (!isRecord(raw)) return null;
  const duration = toNumber(raw["duration"]);
  const unit = typeof raw["timeUnit"] === "string" ? raw["timeUnit"] : "";
  const minutesPerUnit = TIME_UNIT_MINUTES[unit];
  if (duration === null || duration <= 0 || minutesPerUnit === undefined) return null;
  return duration * minutesPerUnit;
}

function fixedPointToCents(value: number): number {
  const cents = value / KIMI_FIXED_POINT_CENTS;
  // Sub-cent remainders still mean "something left"; round up so a nonzero
  // wallet never displays as empty.
  if (cents > 0 && cents < 1) return 1;
  return Math.round(cents);
}

function readMoneyCents(
  raw: unknown,
): { readonly cents: number; readonly currency: string } | null {
  if (!isRecord(raw)) return null;
  const cents = toNumber(raw["priceInCents"]);
  if (cents === null) return null;
  const currency = typeof raw["currency"] === "string" ? raw["currency"] : "";
  return { cents, currency };
}

function readExtraUsage(raw: unknown): KimiCodeUsagePayload["extraUsage"] {
  if (!isRecord(raw)) return null;
  const balance = raw["balance"];
  if (!isRecord(balance) || balance["type"] !== "BOOSTER") return null;
  const amount = toNumber(balance["amount"]);
  if (amount === null || amount <= 0) return null;
  const amountLeft = toNumber(balance["amountLeft"]);

  const monthlyLimit = readMoneyCents(raw["monthlyChargeLimit"]);
  const monthlyUsed = readMoneyCents(raw["monthlyUsed"]);

  return {
    totalCents: fixedPointToCents(amount),
    balanceCents: amountLeft === null ? 0 : fixedPointToCents(amountLeft),
    monthlyChargeLimitEnabled: raw["monthlyChargeLimitEnabled"] === true,
    monthlyChargeLimitCents: monthlyLimit?.cents ?? 0,
    monthlyUsedCents: monthlyUsed?.cents ?? 0,
    currency:
      (monthlyLimit && monthlyLimit.currency.length > 0 && monthlyLimit.currency) ||
      (monthlyUsed && monthlyUsed.currency.length > 0 && monthlyUsed.currency) ||
      "USD",
  };
}

function parseKimiCodeUsagePayload(payload: unknown): KimiCodeUsagePayload {
  if (!isRecord(payload)) {
    return { membershipLevel: null, summary: null, rows: [], extraUsage: null };
  }
  const user = payload["user"];
  const membership = isRecord(user) ? user["membership"] : undefined;
  const level = isRecord(membership) ? membership["level"] : undefined;

  const rows: KimiUsageWindowRow[] = [];
  const limits = payload["limits"];
  if (Array.isArray(limits)) {
    for (const item of limits) {
      if (!isRecord(item)) continue;
      const detail = readDetail(item["detail"]);
      if (detail === null) continue;
      rows.push({ detail, windowMinutes: readWindowMinutes(item["window"]) });
    }
  }

  return {
    membershipLevel: typeof level === "string" && level.length > 0 ? level : null,
    summary: readDetail(payload["usage"]),
    rows,
    extraUsage: readExtraUsage(payload["boosterWallet"]),
  };
}

/* -------------------------------------------------------------------------- */
/* Normalization                                                              */
/* -------------------------------------------------------------------------- */

const MINUTES_PER_DAY = 60 * 24;

const kindFromWindowMinutes = (
  windowMinutes: number | null,
): "session" | "weekly" | "monthly" | "other" => {
  if (windowMinutes === null || windowMinutes <= 0) return "other";
  if (windowMinutes <= MINUTES_PER_DAY) return "session";
  return windowMinutes <= MINUTES_PER_DAY * 10 ? "weekly" : "monthly";
};

const usedPercentOf = (detail: KimiUsageDetail): number | null => {
  if (detail.used === null || detail.limit === null || detail.limit <= 0) return null;
  return Math.min(100, Math.max(0, (detail.used / detail.limit) * 100));
};

const makeWindow = (input: {
  readonly id: string;
  readonly label: string;
  readonly kind: ProviderRateLimitWindow["kind"];
  readonly usedPercent: number;
  readonly resetsAt: string | null;
  readonly detail?: string | undefined;
}): ProviderRateLimitWindow => {
  const usedPercent = Math.min(100, Math.max(0, input.usedPercent));
  return {
    id: input.id,
    label: input.label,
    kind: input.kind,
    usedPercent,
    resetsAt: input.resetsAt,
    status: resolveProviderRateLimitStatus(usedPercent),
    ...(input.detail ? { detail: input.detail } : {}),
  };
};

const formatCents = (cents: number, currency: string): string => {
  const amount = (cents / 100).toFixed(2);
  return currency.length > 0 ? `${amount} ${currency}` : amount;
};

const describeMembershipLevel = (level: string | null): string | undefined => {
  const normalized = level?.trim().replace(/^LEVEL_+/i, "");
  if (!normalized) return undefined;
  return normalized
    .toLowerCase()
    .split(/[_-]+/u)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
};

/**
 * Normalize a `/usages` payload into provider-agnostic windows.
 *
 * The payload is a complete observation, so callers replace the instance's
 * previous windows: the weekly summary, every rolling window Kimi reports
 * (the 5-hour window arrives as 300 TIME_UNIT_MINUTE), and the Extra Usage
 * wallet when the account has one.
 */
export function normalizeKimiCodeUsage(input: {
  readonly payload: unknown;
  readonly observedAt: string;
}): ProviderRateLimits {
  const parsed = parseKimiCodeUsagePayload(input.payload);
  const windows: ProviderRateLimitWindow[] = [];

  for (const row of parsed.rows) {
    const usedPercent = usedPercentOf(row.detail);
    if (usedPercent === null) continue;
    const label =
      row.windowMinutes !== null
        ? (describeRateLimitWindowDuration(row.windowMinutes) ?? "Rolling window")
        : "Rolling window";
    windows.push(
      makeWindow({
        id: `window_${row.windowMinutes ?? "unknown"}`,
        label,
        kind: kindFromWindowMinutes(row.windowMinutes),
        usedPercent,
        resetsAt: row.detail.resetAt,
      }),
    );
  }

  if (parsed.summary !== null) {
    const usedPercent = usedPercentOf(parsed.summary);
    if (usedPercent !== null) {
      // The summary row carries no window; it is the plan's weekly quota.
      windows.push(
        makeWindow({
          id: "weekly",
          label: "Weekly",
          kind: "weekly",
          usedPercent,
          resetsAt: parsed.summary.resetAt,
        }),
      );
    }
  }

  const extraUsage = parsed.extraUsage;
  if (extraUsage !== null) {
    const capped = extraUsage.monthlyChargeLimitEnabled && extraUsage.monthlyChargeLimitCents > 0;
    windows.push(
      makeWindow({
        id: "extra_usage",
        label: "Extra usage",
        kind: "credits",
        usedPercent: capped
          ? (extraUsage.monthlyUsedCents / extraUsage.monthlyChargeLimitCents) * 100
          : 0,
        resetsAt: null,
        detail: `${formatCents(extraUsage.balanceCents, extraUsage.currency)} left`,
      }),
    );
  }

  const planLabel = describeMembershipLevel(parsed.membershipLevel);
  return {
    observedAt: input.observedAt,
    windows,
    ...(planLabel ? { planLabel } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/* Fetch                                                                      */
/* -------------------------------------------------------------------------- */

export class KimiCodeUsageFetchError extends Schema.TaggedErrorClass<KimiCodeUsageFetchError>()(
  "KimiCodeUsageFetchError",
  {
    message: Schema.String,
    status: Schema.optionalKey(Schema.Number),
  },
) {}

/**
 * Reads the account's current plan usage from Kimi. Transport and HTTP errors
 * arrive as `KimiCodeUsageFetchError`; callers re-raise them in the
 * provider-adapter error vocabulary.
 */
export const fetchKimiCodeUsage = Effect.fn("fetchKimiCodeUsage")(function* (
  source: KimiCodeUsageSource,
): Effect.fn.Return<unknown, KimiCodeUsageFetchError, HttpClient.HttpClient> {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client
    .execute(HttpClientRequest.bearerToken(HttpClientRequest.get(source.usagesUrl), source.token))
    .pipe(
      Effect.timeout(USAGE_FETCH_TIMEOUT_MS),
      Effect.mapError(
        (cause) =>
          new KimiCodeUsageFetchError({ message: `Kimi usage request failed: ${cause.message}` }),
      ),
    );
  if (response.status === 401) {
    return yield* new KimiCodeUsageFetchError({
      message: "Kimi rejected the instance API key.",
      status: response.status,
    });
  }
  if (response.status < 200 || response.status >= 300) {
    return yield* new KimiCodeUsageFetchError({
      message: `Kimi usage endpoint answered HTTP ${response.status}.`,
      status: response.status,
    });
  }
  return yield* response.json.pipe(
    Effect.mapError(
      () => new KimiCodeUsageFetchError({ message: "Kimi usage endpoint returned invalid JSON." }),
    ),
  );
});
