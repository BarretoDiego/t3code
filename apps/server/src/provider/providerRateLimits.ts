/**
 * Normalizes provider-native plan rate limits into {@link ProviderRateLimits}.
 *
 * Every provider meters its plan differently — Claude names its windows
 * (`five_hour`, `seven_day_opus`, …) and reports percentages, Codex reports an
 * anonymous `primary`/`secondary` pair whose meaning only comes from
 * `windowDurationMins`. Both land here so the rest of the server, the wire, and
 * the clients only ever see labelled windows with a used percentage.
 *
 * Everything in this module is pure: adapters call it with the payload they
 * just received and hand the result to the registry.
 *
 * @module provider/providerRateLimits
 */
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import {
  type ProviderRateLimits,
  type ProviderRateLimitStatus,
  type ProviderRateLimitWindow,
  type ProviderRateLimitWindowKind,
  resolveProviderRateLimitStatus,
} from "@t3tools/contracts";

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 60 * 24;

/**
 * Epoch values below this are seconds, above are milliseconds. The boundary
 * sits in 2001 as milliseconds and in year 33658 as seconds, so no real reset
 * timestamp is ambiguous.
 */
const EPOCH_MILLISECONDS_THRESHOLD = 1e12;

const clampPercent = (value: number): number => Math.min(100, Math.max(0, value));

const trimmed = (value: string | null | undefined): string | undefined => {
  const text = value?.trim();
  return text && text.length > 0 ? text : undefined;
};

const isoOrNull = (input: number | string): string | null =>
  Option.match(DateTime.make(input), {
    onNone: () => null,
    onSome: (dateTime) => DateTime.formatIso(dateTime),
  });

/** Reject the placeholder timestamps providers send for "no reset known". */
const isoFromEpoch = (epoch: number | null | undefined): string | null => {
  if (typeof epoch !== "number" || !Number.isFinite(epoch) || epoch <= 0) {
    return null;
  }
  return isoOrNull(epoch < EPOCH_MILLISECONDS_THRESHOLD ? epoch * 1000 : epoch);
};

/** `300` -> `"5-hour"`, `10080` -> `"Weekly"`. Used by providers that only report a duration. */
export const describeRateLimitWindowDuration = (windowMinutes: number): string | undefined => {
  if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) {
    return undefined;
  }
  if (windowMinutes % MINUTES_PER_DAY === 0) {
    const days = windowMinutes / MINUTES_PER_DAY;
    return days === 7 ? "Weekly" : `${days}-day`;
  }
  if (windowMinutes % MINUTES_PER_HOUR === 0) {
    return `${windowMinutes / MINUTES_PER_HOUR}-hour`;
  }
  return `${windowMinutes}-minute`;
};

const kindFromWindowMinutes = (
  windowMinutes: number | null | undefined,
): ProviderRateLimitWindowKind => {
  if (typeof windowMinutes !== "number" || !Number.isFinite(windowMinutes) || windowMinutes <= 0) {
    return "other";
  }
  if (windowMinutes <= MINUTES_PER_DAY) {
    return "session";
  }
  return windowMinutes <= MINUTES_PER_DAY * 10 ? "weekly" : "monthly";
};

const makeWindow = (input: {
  readonly id: string;
  readonly label: string;
  readonly kind: ProviderRateLimitWindowKind;
  readonly usedPercent: number;
  readonly resetsAt: string | null;
  readonly windowMinutes?: number | undefined;
  readonly status?: ProviderRateLimitStatus | undefined;
  readonly detail?: string | undefined;
}): ProviderRateLimitWindow => {
  const usedPercent = clampPercent(input.usedPercent);
  return {
    id: input.id,
    label: input.label,
    kind: input.kind,
    usedPercent,
    resetsAt: input.resetsAt,
    status: input.status ?? resolveProviderRateLimitStatus(usedPercent),
    ...(typeof input.windowMinutes === "number" &&
    Number.isInteger(input.windowMinutes) &&
    input.windowMinutes > 0
      ? { windowMinutes: input.windowMinutes }
      : {}),
    ...(input.detail ? { detail: input.detail } : {}),
  };
};

/**
 * Claude's `rate_limit_event`, which reports one window at a time while a turn
 * runs. Its `status` is authoritative for headroom — `utilization` only moves
 * the bar.
 */
export interface ClaudeRateLimitEventPayload {
  readonly status?: string | null;
  readonly resetsAt?: number | null;
  readonly rateLimitType?: string | null;
  /** Fraction from 0 to 1 on Claude's live rate_limit_event. */
  readonly utilization?: number | null;
}

const CLAUDE_EVENT_WINDOWS: Readonly<
  Record<string, { readonly label: string; readonly kind: ProviderRateLimitWindowKind }>
> = {
  five_hour: { label: "5-hour", kind: "session" },
  seven_day: { label: "Weekly", kind: "weekly" },
  seven_day_opus: { label: "Weekly (Opus)", kind: "weekly" },
  seven_day_sonnet: { label: "Weekly (Sonnet)", kind: "weekly" },
  seven_day_oauth_apps: { label: "Weekly (apps)", kind: "weekly" },
  overage: { label: "Extra usage", kind: "credits" },
};

const claudeEventStatus = (
  status: string | null | undefined,
): ProviderRateLimitStatus | undefined =>
  status === "rejected"
    ? "exhausted"
    : status === "allowed_warning"
      ? "warning"
      : status === "allowed"
        ? "ok"
        : undefined;

/**
 * Build a single-window snapshot from a live `rate_limit_event`. The registry
 * merges it onto the last full observation, so reporting one window is enough.
 */
export const normalizeClaudeRateLimitEvent = (input: {
  readonly event: ClaudeRateLimitEventPayload | null | undefined;
  readonly observedAt: string;
}): ProviderRateLimits | null => {
  const event = input.event;
  const windowId = trimmed(event?.rateLimitType);
  if (!event || !windowId) {
    return null;
  }
  const status = claudeEventStatus(event.status);
  const usedPercent =
    typeof event.utilization === "number"
      ? event.utilization * 100
      : status === "exhausted"
        ? 100
        : undefined;
  if (usedPercent === undefined) {
    return null;
  }
  // A window kind the CLI adds later still renders, under its raw name.
  const descriptor = CLAUDE_EVENT_WINDOWS[windowId] ?? { label: windowId, kind: "other" as const };
  return {
    observedAt: input.observedAt,
    windows: [
      makeWindow({
        id: windowId,
        label: descriptor.label,
        kind: descriptor.kind,
        usedPercent,
        resetsAt: isoFromEpoch(event.resetsAt),
        ...(status ? { status } : {}),
      }),
    ],
  };
};

interface ClaudeUsageWindowPayload {
  readonly utilization: number | null;
  readonly resets_at: string | null;
}

interface ClaudeExtraUsagePayload {
  readonly is_enabled: boolean;
  readonly monthly_limit: number | null;
  readonly used_credits: number | null;
  readonly utilization: number | null;
  readonly currency?: string | null;
}

export interface ClaudeStructuredUsagePayload {
  readonly subscription_type: string | null;
  readonly rate_limits_available: boolean;
  readonly rate_limits: {
    readonly five_hour?: ClaudeUsageWindowPayload | null;
    readonly seven_day?: ClaudeUsageWindowPayload | null;
    readonly seven_day_oauth_apps?: ClaudeUsageWindowPayload | null;
    readonly seven_day_opus?: ClaudeUsageWindowPayload | null;
    readonly seven_day_sonnet?: ClaudeUsageWindowPayload | null;
    readonly extra_usage?: ClaudeExtraUsagePayload | null;
  } | null;
}

const CLAUDE_USAGE_WINDOWS = [
  ["five_hour", "5-hour", "session"],
  ["seven_day", "Weekly", "weekly"],
  ["seven_day_opus", "Weekly (Opus)", "weekly"],
  ["seven_day_sonnet", "Weekly (Sonnet)", "weekly"],
  ["seven_day_oauth_apps", "Weekly (apps)", "weekly"],
] as const satisfies ReadonlyArray<
  readonly [
    Exclude<keyof NonNullable<ClaudeStructuredUsagePayload["rate_limits"]>, "extra_usage">,
    string,
    ProviderRateLimitWindowKind,
  ]
>;

const describeClaudeSubscription = (subscriptionType: string | null): string | undefined => {
  const value = trimmed(subscriptionType);
  if (!value) {
    return undefined;
  }
  return value
    .split(/[_-]+/u)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
};

const describeClaudeExtraUsage = (extraUsage: ClaudeExtraUsagePayload): string | undefined => {
  if (extraUsage.used_credits === null || extraUsage.monthly_limit === null) {
    return undefined;
  }
  const currency = trimmed(extraUsage.currency);
  return `${extraUsage.used_credits} / ${extraUsage.monthly_limit}${currency ? ` ${currency}` : ""}`;
};

/**
 * Normalize the structured data behind Claude's `/usage` command.
 *
 * Unlike `rate_limit_event`, this response is a complete observation: callers
 * must replace the previous Claude windows so disappeared or unavailable
 * limits do not survive an account or plan change.
 */
export const normalizeClaudeUsageRateLimits = (input: {
  readonly usage: ClaudeStructuredUsagePayload;
  readonly observedAt: string;
}): ProviderRateLimits => {
  const windows: Array<ProviderRateLimitWindow> = [];
  const rateLimits = input.usage.rate_limits_available ? input.usage.rate_limits : null;

  if (rateLimits) {
    for (const [id, label, kind] of CLAUDE_USAGE_WINDOWS) {
      const window = rateLimits[id];
      if (!window || typeof window.utilization !== "number") {
        continue;
      }
      windows.push(
        makeWindow({
          id,
          label,
          kind,
          usedPercent: window.utilization,
          resetsAt: window.resets_at === null ? null : isoOrNull(window.resets_at),
        }),
      );
    }

    const extraUsage = rateLimits.extra_usage;
    if (extraUsage?.is_enabled === true && typeof extraUsage.utilization === "number") {
      windows.push(
        makeWindow({
          id: "extra_usage",
          label: "Extra usage",
          kind: "credits",
          usedPercent: extraUsage.utilization,
          resetsAt: null,
          detail: describeClaudeExtraUsage(extraUsage),
        }),
      );
    }
  }

  const planLabel = describeClaudeSubscription(input.usage.subscription_type);
  return {
    observedAt: input.observedAt,
    windows,
    ...(planLabel ? { planLabel } : {}),
  };
};

/**
 * Codex's `account/rateLimits/updated` snapshot. Rolling updates are sparse:
 * an absent window is "unchanged", not "cleared", which is why the registry
 * merges snapshots by window id instead of replacing them.
 */
export interface CodexRateLimitWindowPayload {
  readonly resetsAt?: number | null;
  readonly usedPercent: number;
  readonly windowDurationMins?: number | null;
}

export interface CodexRateLimitsPayload {
  readonly primary?: CodexRateLimitWindowPayload | null;
  readonly secondary?: CodexRateLimitWindowPayload | null;
  readonly credits?: {
    readonly balance?: string | null;
    readonly hasCredits?: boolean;
    readonly unlimited?: boolean;
  } | null;
  readonly individualLimit?: {
    readonly limit?: string;
    readonly remainingPercent?: number;
    readonly resetsAt?: number;
    readonly used?: string;
  } | null;
  readonly limitName?: string | null;
  readonly planType?: string | null;
  readonly rateLimitReachedType?: string | null;
  readonly spendControlReached?: boolean | null;
}

const CODEX_FALLBACK_LABELS = {
  primary: "Primary limit",
  secondary: "Secondary limit",
} as const;

const codexWindow = (
  id: "primary" | "secondary",
  payload: CodexRateLimitWindowPayload,
): ProviderRateLimitWindow => {
  const windowMinutes = payload.windowDurationMins ?? undefined;
  const duration =
    typeof windowMinutes === "number" ? describeRateLimitWindowDuration(windowMinutes) : undefined;
  return makeWindow({
    id,
    label: duration ?? CODEX_FALLBACK_LABELS[id],
    kind: kindFromWindowMinutes(windowMinutes),
    usedPercent: payload.usedPercent,
    resetsAt: isoFromEpoch(payload.resetsAt),
    ...(typeof windowMinutes === "number" ? { windowMinutes } : {}),
  });
};

const CODEX_LIMIT_REACHED_NOTICES: Readonly<Record<string, string>> = {
  rate_limit_reached: "Rate limit reached",
  workspace_owner_credits_depleted: "Workspace credits depleted",
  workspace_member_credits_depleted: "Workspace credits depleted",
  workspace_owner_usage_limit_reached: "Workspace usage limit reached",
  workspace_member_usage_limit_reached: "Workspace usage limit reached",
};

const codexPlanLabel = (input: CodexRateLimitsPayload): string | undefined => {
  const named = trimmed(input.limitName);
  if (named) {
    return named;
  }
  const plan = trimmed(input.planType);
  if (!plan || plan === "unknown") {
    return undefined;
  }
  return plan.charAt(0).toUpperCase() + plan.slice(1);
};

export const normalizeCodexRateLimits = (input: {
  readonly rateLimits: CodexRateLimitsPayload | null | undefined;
  readonly observedAt: string;
}): ProviderRateLimits | null => {
  const payload = input.rateLimits;
  if (!payload) {
    return null;
  }

  const windows: Array<ProviderRateLimitWindow> = [];
  for (const id of ["primary", "secondary"] as const) {
    const window = payload[id];
    if (!window || typeof window.usedPercent !== "number") {
      continue;
    }
    windows.push(codexWindow(id, window));
  }

  const individualLimit = payload.individualLimit;
  if (individualLimit && typeof individualLimit.remainingPercent === "number") {
    const used = trimmed(individualLimit.used);
    const limit = trimmed(individualLimit.limit);
    windows.push(
      makeWindow({
        id: "individual_limit",
        label: "Spend limit",
        kind: "credits",
        usedPercent: 100 - individualLimit.remainingPercent,
        resetsAt: isoFromEpoch(individualLimit.resetsAt),
        ...(used && limit ? { detail: `${used} / ${limit}` } : {}),
        ...(payload.spendControlReached === true ? { status: "exhausted" as const } : {}),
      }),
    );
  }

  if (windows.length === 0) {
    return null;
  }

  const planLabel = codexPlanLabel(payload);
  // `rateLimitReachedType` does not say which window ran out, so it stays a
  // provider-level notice rather than forcing one window to look exhausted.
  const reachedType = trimmed(payload.rateLimitReachedType);
  const balance =
    payload.credits?.unlimited === true ? undefined : trimmed(payload.credits?.balance);
  const limitReached = reachedType
    ? (CODEX_LIMIT_REACHED_NOTICES[reachedType] ?? "Rate limit reached")
    : undefined;
  const notice = [limitReached, balance ? `${balance} credits left` : undefined]
    .filter((part): part is string => part !== undefined)
    .join(" \u00b7 ");
  return {
    observedAt: input.observedAt,
    windows,
    ...(planLabel ? { planLabel } : {}),
    ...(notice.length > 0 ? { notice } : {}),
  };
};

/** Order windows so the tightest one a user hits first comes first. */
const WINDOW_KIND_ORDER: Readonly<Record<ProviderRateLimitWindowKind, number>> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  credits: 3,
  other: 4,
};

/**
 * Merge a fresh observation onto the last one, by window id.
 *
 * Providers send sparse updates (Codex says so explicitly, Claude's live event
 * carries one window), so a window missing from `next` keeps its previous
 * value instead of disappearing from the UI.
 */
export const mergeProviderRateLimits = (
  previous: ProviderRateLimits | undefined,
  next: ProviderRateLimits,
): ProviderRateLimits => {
  const windowsById = new Map(previous?.windows.map((window) => [window.id, window] as const));
  for (const window of next.windows) {
    windowsById.set(window.id, window);
  }
  const windows = [...windowsById.values()].sort(
    (left, right) =>
      WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind] ||
      left.label.localeCompare(right.label),
  );
  const planLabel = next.planLabel ?? previous?.planLabel;
  // A notice describes the moment it was observed ("rate limit reached"), so it
  // is replaced rather than merged: the newest observation not carrying one
  // means the condition cleared.
  const notice = next.notice;
  return {
    observedAt: next.observedAt,
    windows,
    ...(planLabel ? { planLabel } : {}),
    ...(notice ? { notice } : {}),
  };
};
