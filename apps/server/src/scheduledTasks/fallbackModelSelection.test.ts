import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";

import { pickModelSelection } from "./fallbackModelSelection.ts";

const selection = (instanceId: string): ModelSelection => ({
  instanceId: ProviderInstanceId.make(instanceId),
  model: "m",
});

const provider = (
  instanceId: string,
  quota: { readonly rate?: "ok" | "warning" | "exhausted"; readonly usedPercent?: number } = {},
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make(instanceId),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-06T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  ...(quota.rate === undefined
    ? {}
    : {
        rateLimits: {
          observedAt: "2026-11-06T00:00:00.000Z",
          windows: [
            {
              id: "five_hour",
              label: "5-hour",
              kind: "session",
              usedPercent: 50,
              resetsAt: null,
              status: quota.rate,
            },
          ],
        },
      }),
  ...(quota.usedPercent === undefined
    ? {}
    : {
        usageLimits: {
          checkedAt: "2026-11-06T00:00:00.000Z",
          windows: [
            { id: "weekly", kind: "weekly", label: "Weekly", usedPercent: quota.usedPercent },
          ],
        },
      }),
});

describe("pickModelSelection", () => {
  const primary = selection("claudeAgent");
  const fallback = selection("codex");

  it("keeps the primary while it has quota", () => {
    const providers = [provider("claudeAgent", { rate: "warning" }), provider("codex")];
    expect(pickModelSelection(primary, [fallback], providers)).toBe(primary);
  });

  it("moves to the first fallback with quota when the primary is exhausted", () => {
    const providers = [provider("claudeAgent", { rate: "exhausted" }), provider("codex")];
    expect(pickModelSelection(primary, [fallback], providers)).toBe(fallback);
  });

  it("treats a full usage-limit window as exhausted", () => {
    const providers = [provider("claudeAgent", { usedPercent: 100 }), provider("codex")];
    expect(pickModelSelection(primary, [fallback], providers)).toBe(fallback);
  });

  it("skips exhausted fallbacks", () => {
    const second = selection("opencode");
    const providers = [
      provider("claudeAgent", { rate: "exhausted" }),
      provider("codex", { rate: "exhausted" }),
      provider("opencode"),
    ];
    expect(pickModelSelection(primary, [fallback, second], providers)).toBe(second);
  });

  it("returns the primary when every candidate is exhausted", () => {
    const providers = [
      provider("claudeAgent", { rate: "exhausted" }),
      provider("codex", { usedPercent: 100 }),
    ];
    expect(pickModelSelection(primary, [fallback], providers)).toBe(primary);
  });

  it("treats unknown quota as available", () => {
    expect(pickModelSelection(primary, [fallback], [])).toBe(primary);
    expect(pickModelSelection(primary, [fallback], [provider("claudeAgent")])).toBe(primary);
  });
});
