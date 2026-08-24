import { assert, describe, it } from "@effect/vitest";

import {
  describeRateLimitWindowDuration,
  mergeProviderRateLimits,
  normalizeClaudeRateLimitEvent,
  normalizeCodexRateLimits,
} from "./providerRateLimits.ts";

const OBSERVED_AT = "2026-08-24T12:00:00.000Z";

describe("describeRateLimitWindowDuration", () => {
  it("names the durations providers actually meter on", () => {
    assert.strictEqual(describeRateLimitWindowDuration(300), "5-hour");
    assert.strictEqual(describeRateLimitWindowDuration(10_080), "Weekly");
    assert.strictEqual(describeRateLimitWindowDuration(43_200), "30-day");
    assert.strictEqual(describeRateLimitWindowDuration(90), "90-minute");
    assert.strictEqual(describeRateLimitWindowDuration(0), undefined);
  });
});

describe("normalizeClaudeRateLimitEvent", () => {
  it("maps a window with its reset instant", () => {
    const snapshot = normalizeClaudeRateLimitEvent({
      event: {
        status: "allowed",
        rateLimitType: "five_hour",
        utilization: 42,
        resetsAt: 1_787_000_000,
      },
      observedAt: OBSERVED_AT,
    });

    assert.deepStrictEqual(snapshot, {
      observedAt: OBSERVED_AT,
      windows: [
        {
          id: "five_hour",
          label: "5-hour",
          kind: "session",
          usedPercent: 42,
          resetsAt: "2026-08-17T20:53:20.000Z",
          status: "ok",
        },
      ],
    });
  });

  it("trusts the provider's status over the percentage", () => {
    const snapshot = normalizeClaudeRateLimitEvent({
      event: { status: "rejected", rateLimitType: "seven_day", utilization: 99 },
      observedAt: OBSERVED_AT,
    });

    assert.strictEqual(snapshot?.windows[0]?.status, "exhausted");
    assert.strictEqual(snapshot?.windows[0]?.kind, "weekly");
  });

  it("assumes a rejected window without a percentage is full", () => {
    const snapshot = normalizeClaudeRateLimitEvent({
      event: { status: "rejected", rateLimitType: "five_hour" },
      observedAt: OBSERVED_AT,
    });

    assert.strictEqual(snapshot?.windows[0]?.usedPercent, 100);
  });

  it("skips events that name no window", () => {
    assert.strictEqual(
      normalizeClaudeRateLimitEvent({
        event: { status: "allowed", utilization: 10 },
        observedAt: OBSERVED_AT,
      }),
      null,
    );
  });
});

describe("normalizeCodexRateLimits", () => {
  it("labels anonymous windows from their duration", () => {
    const snapshot = normalizeCodexRateLimits({
      rateLimits: {
        primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_787_000_000 },
        secondary: { usedPercent: 87, windowDurationMins: 10_080 },
        planType: "pro",
      },
      observedAt: OBSERVED_AT,
    });

    assert.deepStrictEqual(
      snapshot?.windows.map((window) => [window.label, window.kind, window.status]),
      [
        ["5-hour", "session", "ok"],
        ["Weekly", "weekly", "warning"],
      ],
    );
    assert.strictEqual(snapshot?.planLabel, "Pro");
  });

  it("keeps a window without a duration renderable", () => {
    const snapshot = normalizeCodexRateLimits({
      rateLimits: { primary: { usedPercent: 5 } },
      observedAt: OBSERVED_AT,
    });

    assert.strictEqual(snapshot?.windows[0]?.label, "Primary limit");
    assert.strictEqual(snapshot?.windows[0]?.kind, "other");
    assert.strictEqual(snapshot?.windows[0]?.resetsAt, null);
  });

  it("reports spend controls as a credits window", () => {
    const snapshot = normalizeCodexRateLimits({
      rateLimits: {
        primary: { usedPercent: 10, windowDurationMins: 300 },
        individualLimit: {
          limit: "$50.00",
          used: "$45.00",
          remainingPercent: 10,
          resetsAt: 1_787_000_000,
        },
        spendControlReached: true,
      },
      observedAt: OBSERVED_AT,
    });

    const spend = snapshot?.windows.find((window) => window.id === "individual_limit");
    assert.strictEqual(spend?.kind, "credits");
    assert.strictEqual(spend?.usedPercent, 90);
    assert.strictEqual(spend?.status, "exhausted");
    assert.strictEqual(spend?.detail, "$45.00 / $50.00");
  });

  it("surfaces the reached-limit reason and remaining credits as one notice", () => {
    const snapshot = normalizeCodexRateLimits({
      rateLimits: {
        primary: { usedPercent: 100, windowDurationMins: 300 },
        rateLimitReachedType: "rate_limit_reached",
        credits: { balance: "$3.20", hasCredits: true, unlimited: false },
      },
      observedAt: OBSERVED_AT,
    });

    assert.strictEqual(snapshot?.notice, "Rate limit reached · $3.20 credits left");
    assert.strictEqual(snapshot?.windows[0]?.status, "exhausted");
  });

  it("returns nothing when no window was reported", () => {
    assert.strictEqual(
      normalizeCodexRateLimits({ rateLimits: { planType: "pro" }, observedAt: OBSERVED_AT }),
      null,
    );
  });
});

describe("mergeProviderRateLimits", () => {
  it("keeps windows a sparse update did not mention", () => {
    const previous = normalizeCodexRateLimits({
      rateLimits: {
        primary: { usedPercent: 10, windowDurationMins: 300 },
        secondary: { usedPercent: 20, windowDurationMins: 10_080 },
      },
      observedAt: "2026-08-24T11:00:00.000Z",
    });
    assert.isNotNull(previous);

    const merged = mergeProviderRateLimits(
      previous,
      normalizeCodexRateLimits({
        rateLimits: { primary: { usedPercent: 55, windowDurationMins: 300 } },
        observedAt: OBSERVED_AT,
      })!,
    );

    assert.strictEqual(merged.observedAt, OBSERVED_AT);
    assert.deepStrictEqual(
      merged.windows.map((window) => [window.id, window.usedPercent]),
      [
        ["primary", 55],
        ["secondary", 20],
      ],
    );
  });

  it("orders the window a user hits first at the top", () => {
    const merged = mergeProviderRateLimits(
      {
        observedAt: "2026-08-24T11:00:00.000Z",
        windows: [
          {
            id: "extra_usage",
            label: "Extra usage",
            kind: "credits",
            usedPercent: 5,
            resetsAt: null,
            status: "ok",
          },
          {
            id: "seven_day",
            label: "Weekly",
            kind: "weekly",
            usedPercent: 30,
            resetsAt: null,
            status: "ok",
          },
        ],
      },
      normalizeClaudeRateLimitEvent({
        event: { status: "allowed", rateLimitType: "five_hour", utilization: 1 },
        observedAt: OBSERVED_AT,
      })!,
    );

    assert.deepStrictEqual(
      merged.windows.map((window) => window.id),
      ["five_hour", "seven_day", "extra_usage"],
    );
  });

  it("carries the plan label forward when an update omits it", () => {
    const merged = mergeProviderRateLimits(
      {
        observedAt: "2026-08-24T11:00:00.000Z",
        planLabel: "Max",
        windows: [],
      },
      normalizeClaudeRateLimitEvent({
        event: { status: "allowed", rateLimitType: "five_hour", utilization: 1 },
        observedAt: OBSERVED_AT,
      })!,
    );

    assert.strictEqual(merged.planLabel, "Max");
  });
});
