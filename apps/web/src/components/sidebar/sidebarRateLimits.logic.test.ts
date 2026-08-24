import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRateLimits,
  type ServerProvider,
} from "@t3tools/contracts";

import {
  buildSidebarRateLimitsView,
  formatRateLimitResetIn,
  type SidebarRateLimitsEnvironmentInput,
} from "./sidebarRateLimits.logic";

const NOW_MS = Date.parse("2026-08-24T12:00:00.000Z");

function provider(input: {
  readonly instanceId: string;
  readonly driver?: string;
  readonly displayName?: string;
  readonly rateLimits?: ProviderRateLimits;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: ProviderDriverKind.make(input.driver ?? "claudeAgent"),
    ...(input.displayName ? { displayName: input.displayName } : {}),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-24T11:59:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...(input.rateLimits ? { rateLimits: input.rateLimits } : {}),
  };
}

function environment(
  label: string,
  providers: ReadonlyArray<ServerProvider>,
): SidebarRateLimitsEnvironmentInput {
  return { environmentId: label.toLowerCase(), label, providers };
}

const fiveHour = (usedPercent: number, resetsAt: string | null) =>
  ({
    id: "five_hour",
    label: "5-hour",
    kind: "session",
    usedPercent,
    resetsAt,
    status: usedPercent >= 100 ? "exhausted" : usedPercent >= 80 ? "warning" : "ok",
  }) as const;

const weekly = (usedPercent: number) =>
  ({
    id: "seven_day",
    label: "Weekly",
    kind: "weekly",
    usedPercent,
    resetsAt: "2026-08-27T12:00:00.000Z",
    status: "ok",
  }) as const;

describe("formatRateLimitResetIn", () => {
  it("reads as a countdown a user can plan around", () => {
    expect(formatRateLimitResetIn("2026-08-24T14:14:00.000Z", NOW_MS)).toBe("2h 14m");
    expect(formatRateLimitResetIn("2026-08-24T12:45:00.000Z", NOW_MS)).toBe("45m");
    expect(formatRateLimitResetIn("2026-08-24T12:00:30.000Z", NOW_MS)).toBe("under a minute");
    expect(formatRateLimitResetIn("2026-08-27T16:00:00.000Z", NOW_MS)).toBe("3d 4h");
  });

  it("has nothing to say about an instant that already passed", () => {
    expect(formatRateLimitResetIn("2026-08-24T11:00:00.000Z", NOW_MS)).toBeNull();
    expect(formatRateLimitResetIn("not a date", NOW_MS)).toBeNull();
  });
});

describe("buildSidebarRateLimitsView", () => {
  it("reports no data when no provider has observed limits", () => {
    const view = buildSidebarRateLimitsView({
      environments: [environment("Local", [provider({ instanceId: "claudeAgent" })])],
      nowMs: NOW_MS,
    });

    expect(view.providers).toEqual([]);
    expect(view.peakPercent).toBeNull();
    expect(view.tone).toBe("ok");
    expect(view.summary).toBe("Plan limits: no data yet");
  });

  it("peaks on the most constrained live window across providers", () => {
    const view = buildSidebarRateLimitsView({
      environments: [
        environment("Local", [
          provider({
            instanceId: "claudeAgent",
            displayName: "Claude Code",
            rateLimits: {
              observedAt: "2026-08-24T11:58:00.000Z",
              planLabel: "Max",
              windows: [fiveHour(64, "2026-08-24T14:00:00.000Z"), weekly(18)],
            },
          }),
          provider({
            instanceId: "codex",
            driver: "codex",
            displayName: "Codex",
            rateLimits: {
              observedAt: "2026-08-24T11:59:00.000Z",
              windows: [
                {
                  id: "primary",
                  label: "5-hour",
                  kind: "session",
                  usedPercent: 91,
                  resetsAt: "2026-08-24T13:00:00.000Z",
                  status: "warning",
                },
              ],
            },
          }),
        ]),
      ],
      nowMs: NOW_MS,
    });

    expect(view.providers.map((entry) => entry.displayName)).toEqual(["Claude Code", "Codex"]);
    expect(view.peakPercent).toBe(91);
    expect(view.tone).toBe("warning");
    expect(view.summary).toBe("Plan limits: 5-hour 91% used");
  });

  it("empties a window whose reset already passed instead of showing a stale number", () => {
    const view = buildSidebarRateLimitsView({
      environments: [
        environment("Local", [
          provider({
            instanceId: "claudeAgent",
            rateLimits: {
              observedAt: "2026-08-24T06:00:00.000Z",
              windows: [fiveHour(97, "2026-08-24T10:00:00.000Z"), weekly(40)],
            },
          }),
        ]),
      ],
      nowMs: NOW_MS,
    });

    const [session, week] = view.providers[0]!.windows;
    expect(session).toMatchObject({ isReset: true, usedPercent: 0, status: "ok" });
    expect(week).toMatchObject({ isReset: false, usedPercent: 40, resetsInLabel: "3d" });
    // The reset window no longer drives the icon.
    expect(view.peakPercent).toBe(40);
    expect(view.tone).toBe("ok");
  });

  it("names environments only when more than one reports limits", () => {
    const withLimits = provider({
      instanceId: "claudeAgent",
      rateLimits: { observedAt: "2026-08-24T11:58:00.000Z", windows: [weekly(10)] },
    });

    const single = buildSidebarRateLimitsView({
      environments: [
        environment("Local", [withLimits]),
        environment("Laptop", [provider({ instanceId: "codex", driver: "codex" })]),
      ],
      nowMs: NOW_MS,
    });
    expect(single.providers.map((entry) => entry.environmentLabel)).toEqual([null]);

    const both = buildSidebarRateLimitsView({
      environments: [environment("Local", [withLimits]), environment("Laptop", [withLimits])],
      nowMs: NOW_MS,
    });
    expect(both.providers.map((entry) => entry.environmentLabel)).toEqual(["Local", "Laptop"]);
    expect(new Set(both.providers.map((entry) => entry.key)).size).toBe(2);
  });

  it("keeps an exhausted window's tone even when another window peaks higher", () => {
    const view = buildSidebarRateLimitsView({
      environments: [
        environment("Local", [
          provider({
            instanceId: "claudeAgent",
            rateLimits: {
              observedAt: "2026-08-24T11:58:00.000Z",
              notice: "Rate limit reached",
              windows: [
                { ...fiveHour(100, "2026-08-24T14:00:00.000Z"), status: "exhausted" },
                weekly(30),
              ],
            },
          }),
        ]),
      ],
      nowMs: NOW_MS,
    });

    expect(view.tone).toBe("exhausted");
    expect(view.providers[0]?.notice).toBe("Rate limit reached");
  });
});
