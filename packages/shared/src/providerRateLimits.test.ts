import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildProviderRateLimitsView } from "./providerRateLimits.ts";

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
});
