import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildProviderRateLimitsView,
  formatRateLimitResetCountdown,
} from "./providerRateLimits.ts";

const provider = (kind: "session" | "weekly"): ServerProvider => ({
  instanceId: ProviderInstanceId.make("claude_personal"),
  driver: ProviderDriverKind.make("claudeAgent"),
  displayName: "Claude Personal",
  enabled: true,
  installed: true,
  version: "2.1.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-08-25T10:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  rateLimits: {
    observedAt: "2026-08-25T10:00:00.000Z",
    windows: [
      {
        id: kind === "weekly" ? "seven_day" : "five_hour",
        label: kind === "weekly" ? "Weekly" : "5-hour",
        kind,
        usedPercent: 42,
        resetsAt: "2026-08-30T10:00:00.000Z",
        status: "ok",
      },
    ],
  },
});

describe("buildProviderRateLimitsView", () => {
  it.each(["session", "weekly"] as const)("preserves the %s window kind", (kind) => {
    const view = buildProviderRateLimitsView({
      environments: [
        {
          environmentId: EnvironmentId.make("local"),
          label: "Local",
          providers: [provider(kind)],
        },
      ],
      nowMs: Date.parse("2026-08-25T11:00:00.000Z"),
    });

    expect(view.providers[0]?.windows[0]?.kind).toBe(kind);
  });

  it("projects a second-precision countdown for an exhausted window", () => {
    const exhausted = provider("session");
    const rateLimits = exhausted.rateLimits!;
    const window = rateLimits.windows[0]!;
    const view = buildProviderRateLimitsView({
      environments: [
        {
          environmentId: EnvironmentId.make("local"),
          label: "Local",
          providers: [
            {
              ...exhausted,
              rateLimits: {
                ...rateLimits,
                windows: [
                  {
                    ...window,
                    usedPercent: 100,
                    resetsAt: "2026-08-25T13:14:07.000Z",
                    status: "exhausted",
                  },
                ],
              },
            },
          ],
        },
      ],
      nowMs: Date.parse("2026-08-25T11:00:00.000Z"),
    });

    expect(view.providers[0]?.windows[0]?.resetCountdownLabel).toBe("2h 14m 07s");
  });
});

describe("formatRateLimitResetCountdown", () => {
  const nowMs = Date.parse("2026-08-25T11:00:00.000Z");

  it("keeps hours, minutes, and seconds precise", () => {
    expect(formatRateLimitResetCountdown("2026-08-25T13:14:07.000Z", nowMs)).toBe("2h 14m 07s");
    expect(formatRateLimitResetCountdown("2026-08-26T14:04:09.000Z", nowMs)).toBe("27h 04m 09s");
    expect(formatRateLimitResetCountdown("2026-08-25T11:00:00.001Z", nowMs)).toBe("0h 00m 01s");
  });

  it("returns no countdown for invalid or elapsed resets", () => {
    expect(formatRateLimitResetCountdown("not a date", nowMs)).toBeNull();
    expect(formatRateLimitResetCountdown("2026-08-25T11:00:00.000Z", nowMs)).toBeNull();
  });
});
