import { describe, expect, it } from "vite-plus/test";

import {
  getEarliestExhaustedResetAt,
  getExhaustedRateLimitResetAt,
  isUsageLimitErrorMessage,
  msUntilRateLimitReset,
} from "./providerRateLimits.ts";

const NOW = Date.parse("2026-09-18T12:00:00.000Z");
const inMs = (ms: number): string => new Date(NOW + ms).toISOString();

describe("queued auto-send on reset", () => {
  it("picks the earliest future reset among exhausted windows", () => {
    expect(
      getEarliestExhaustedResetAt(
        [
          { status: "exhausted", resetsAt: inMs(3_600_000) },
          { status: "exhausted", resetsAt: inMs(600_000) },
          { status: "warning", resetsAt: inMs(60_000) },
          { status: "exhausted", resetsAt: null },
          { status: "exhausted", resetsAt: new Date(NOW - 1_000).toISOString() },
        ],
        NOW,
      ),
    ).toBe(inMs(600_000));
  });

  it("returns null when nothing is exhausted", () => {
    expect(
      getEarliestExhaustedResetAt([{ status: "ok", resetsAt: inMs(600_000) }], NOW),
    ).toBeNull();
  });

  it("scopes the reset to one provider instance", () => {
    const providers = [
      {
        instanceId: "codex-a",
        rateLimits: { windows: [{ status: "exhausted", resetsAt: inMs(600_000) }] },
      },
      {
        instanceId: "claude-b",
        rateLimits: { windows: [{ status: "exhausted", resetsAt: inMs(3_600_000) }] },
      },
    ];
    expect(
      getExhaustedRateLimitResetAt(providers, { instanceId: "claude-b", nowMs: NOW }),
    ).toBe(inMs(3_600_000));
    expect(getExhaustedRateLimitResetAt(providers, { nowMs: NOW })).toBe(inMs(600_000));
    expect(
      getExhaustedRateLimitResetAt(providers, { instanceId: "missing", nowMs: NOW }),
    ).toBeNull();
  });

  it("floors past resets at zero", () => {
    expect(msUntilRateLimitReset(inMs(90_000), NOW)).toBe(90_000);
    expect(msUntilRateLimitReset(new Date(NOW - 5_000).toISOString(), NOW)).toBe(0);
  });

  it("recognizes usage-limit failures", () => {
    expect(isUsageLimitErrorMessage("Codex usage limit reached. Send the message again.")).toBe(
      true,
    );
    expect(
      isUsageLimitErrorMessage("You've hit your usage limit for GPT. Try again at 5:21 AM."),
    ).toBe(true);
    expect(isUsageLimitErrorMessage("socket read failed")).toBe(false);
    expect(isUsageLimitErrorMessage(null)).toBe(false);
  });
});
