import { assert, describe, it } from "@effect/vitest";

import { normalizeKimiCodeUsage, resolveKimiCodeUsageSource } from "./kimiCodeUsage.ts";

const OBSERVED_AT = "2026-08-27T12:00:00.000Z";

/**
 * Captured verbatim from `GET https://api.kimi.com/coding/v1/usages` on a
 * LEVEL_ADVANCED account (2026-08-27): weekly summary, one 300-minute rolling
 * window, an empty `totalQuota`, and no booster wallet.
 */
const REAL_PAYLOAD = {
  user: {
    userId: "da7jkv7a0hfna4oapc9g",
    region: "REGION_OVERSEA",
    membership: { level: "LEVEL_ADVANCED" },
    businessId: "",
  },
  usage: { limit: "100", used: "4", remaining: "96", resetTime: "2026-09-03T13:09:01.801116Z" },
  limits: [
    {
      window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
      detail: {
        limit: "100",
        used: "22",
        remaining: "78",
        resetTime: "2026-08-27T18:09:01.801116Z",
      },
    },
  ],
  parallel: { limit: "30", details: [] },
  totalQuota: {},
  authentication: { method: "METHOD_API_KEY", scope: "FEATURE_CODING" },
  subType: "TYPE_PURCHASE",
  domain: "DOMAIN_NEXUS",
} as const;

describe("resolveKimiCodeUsageSource", () => {
  it("detects the global Kimi Code endpoint with an x-api-key style token", () => {
    const source = resolveKimiCodeUsageSource({
      ANTHROPIC_BASE_URL: "https://api.kimi.com/coding/",
      ANTHROPIC_API_KEY: "sk-kimi-test",
    });
    assert.deepStrictEqual(source, {
      usagesUrl: "https://api.kimi.com/coding/v1/usages",
      token: "sk-kimi-test",
    });
  });

  it("detects the mainland-cn mirror and falls back to ANTHROPIC_AUTH_TOKEN", () => {
    const source = resolveKimiCodeUsageSource({
      ANTHROPIC_BASE_URL: "https://api.kimi.ai/coding",
      ANTHROPIC_AUTH_TOKEN: "sk-kimi-cn",
    });
    assert.deepStrictEqual(source, {
      usagesUrl: "https://api.kimi.ai/coding/v1/usages",
      token: "sk-kimi-cn",
    });
  });

  it("prefers the CLI's KIMI_CODE_BASE_URL override verbatim", () => {
    const source = resolveKimiCodeUsageSource({
      ANTHROPIC_BASE_URL: "https://api.kimi.com/coding/",
      ANTHROPIC_API_KEY: "sk-kimi-test",
      KIMI_CODE_BASE_URL: "https://proxy.internal/coding/v1/",
    });
    assert.deepStrictEqual(source, {
      usagesUrl: "https://proxy.internal/coding/v1/usages",
      token: "sk-kimi-test",
    });
  });

  it("returns null for Anthropic-native and unrelated endpoints", () => {
    assert.isNull(
      resolveKimiCodeUsageSource({
        ANTHROPIC_BASE_URL: "https://api.anthropic.com",
        ANTHROPIC_API_KEY: "sk-ant-test",
      }),
    );
    assert.isNull(
      resolveKimiCodeUsageSource({
        ANTHROPIC_BASE_URL: "https://api.moonshot.ai/anthropic",
        ANTHROPIC_AUTH_TOKEN: "sk-ms-test",
      }),
    );
    assert.isNull(resolveKimiCodeUsageSource({ ANTHROPIC_API_KEY: "sk-no-base-url" }));
    assert.isNull(
      resolveKimiCodeUsageSource({ ANTHROPIC_BASE_URL: "https://api.kimi.com/coding/" }),
    );
    assert.isNull(resolveKimiCodeUsageSource(undefined));
  });
});

describe("normalizeKimiCodeUsage", () => {
  it("maps the live payload: 5-hour session window, weekly quota, plan label", () => {
    const snapshot = normalizeKimiCodeUsage({ payload: REAL_PAYLOAD, observedAt: OBSERVED_AT });

    assert.strictEqual(snapshot.planLabel, "Advanced");
    assert.deepStrictEqual(
      snapshot.windows.map((window) => [window.id, window.kind]),
      [
        ["window_300", "session"],
        ["weekly", "weekly"],
      ],
    );

    const session = snapshot.windows[0]!;
    assert.strictEqual(session.label, "5-hour");
    assert.strictEqual(session.usedPercent, 22);
    assert.strictEqual(session.resetsAt, "2026-08-27T18:09:01.801116Z");
    assert.strictEqual(session.status, "ok");
    assert.strictEqual(session.detail, "22 / 100");

    const weekly = snapshot.windows[1]!;
    assert.strictEqual(weekly.label, "Weekly");
    assert.strictEqual(weekly.usedPercent, 4);
    assert.strictEqual(weekly.resetsAt, "2026-09-03T13:09:01.801116Z");
    assert.strictEqual(weekly.detail, "4 / 100");
  });

  it("marks windows at 80%+ as warning and 100% as exhausted", () => {
    const snapshot = normalizeKimiCodeUsage({
      payload: {
        usage: { used: "100", limit: "100", resetTime: null },
        limits: [
          {
            window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
            detail: { used: "82", limit: "100", resetTime: null },
          },
        ],
      },
      observedAt: OBSERVED_AT,
    });
    const byId = new Map(snapshot.windows.map((window) => [window.id, window]));
    assert.strictEqual(byId.get("window_300")?.status, "warning");
    assert.strictEqual(byId.get("weekly")?.status, "exhausted");
  });

  it("surfaces the Extra Usage wallet as a credits window with the balance", () => {
    const snapshot = normalizeKimiCodeUsage({
      payload: {
        usage: { used: "10", limit: "100", resetTime: null },
        boosterWallet: {
          balance: { type: "BOOSTER", amount: 5_000_000_000, amountLeft: 2_500_000_000 },
          monthlyChargeLimitEnabled: true,
          monthlyChargeLimit: { priceInCents: 10_000_000_000, currency: "CNY" },
          monthlyUsed: { priceInCents: 2_500_000_000, currency: "CNY" },
        },
      },
      observedAt: OBSERVED_AT,
    });
    const extra = snapshot.windows.find((window) => window.id === "extra_usage");
    assert.isDefined(extra);
    assert.strictEqual(extra.kind, "credits");
    assert.strictEqual(extra.usedPercent, 25);
    assert.strictEqual(extra.detail, "25.00 CNY left");
  });

  it("reports an uncapped wallet as 0% used with the remaining balance", () => {
    const snapshot = normalizeKimiCodeUsage({
      payload: {
        boosterWallet: {
          balance: { type: "BOOSTER", amount: 5_000_000_000, amountLeft: 1_000_000_000 },
          monthlyChargeLimitEnabled: false,
        },
      },
      observedAt: OBSERVED_AT,
    });
    const extra = snapshot.windows.find((window) => window.id === "extra_usage");
    assert.isDefined(extra);
    assert.strictEqual(extra.usedPercent, 0);
    assert.strictEqual(extra.detail, "10.00 USD left");
  });

  it("drops rows without usable numbers and tolerates garbage", () => {
    const snapshot = normalizeKimiCodeUsage({
      payload: {
        usage: { used: "lots", limit: "100" },
        limits: [
          { window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: { used: "1" } },
          "not-a-row",
        ],
      },
      observedAt: OBSERVED_AT,
    });
    assert.deepStrictEqual(snapshot.windows, []);
    assert.isUndefined(snapshot.planLabel);

    const empty = normalizeKimiCodeUsage({ payload: null, observedAt: OBSERVED_AT });
    assert.deepStrictEqual(empty, { observedAt: OBSERVED_AT, windows: [] });
  });
});
