import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

import { SidebarPinnedRateLimitsDock } from "./SidebarPinnedRateLimitsDock";
import type { SidebarRateLimitsMonitor } from "./useSidebarRateLimitsMonitor";

vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: ReactNode }) => render,
  TooltipPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const monitor: SidebarRateLimitsMonitor = {
  view: {
    providers: [
      {
        key: "local:claude_work",
        environmentId: EnvironmentId.make("local"),
        instanceId: ProviderInstanceId.make("claude_work"),
        driver: ProviderDriverKind.make("claudeAgent"),
        displayName: "Claude Work",
        accentColor: "#d97757",
        environmentLabel: null,
        planLabel: "Max",
        notice: undefined,
        observedAt: "2026-08-24T11:58:00.000Z",
        windows: [
          {
            id: "five_hour",
            label: "5-hour",
            kind: "session",
            usedPercent: 64,
            status: "ok",
            resetsInLabel: "2h 14m",
            isReset: false,
            detail: undefined,
          },
          {
            id: "model_scoped:fable-5",
            label: "Weekly (Fable 5)",
            kind: "weekly",
            usedPercent: 27,
            status: "ok",
            resetsInLabel: "3d",
            isReset: false,
            detail: undefined,
          },
        ],
      },
    ],
    refreshTargets: [],
    peakPercent: 64,
    tone: "ok",
    summary: "Plan limits: 5-hour 64% used",
  },
  nowMs: Date.parse("2026-08-24T12:00:00.000Z"),
  isRefreshing: false,
  refreshFailed: false,
  preferencesHydrated: true,
  pinnedProviderKeys: new Set(["local:claude_work"]),
  collapsedWeeklyProviderKeys: new Set(),
  refreshLimits: () => {},
  toggleProviderPinned: () => {},
  toggleProviderWeeklyCollapsed: () => {},
};

describe("SidebarPinnedRateLimitsDock", () => {
  it("renders thick full-width bars with availability, reset, and model layers", () => {
    const markup = renderToStaticMarkup(<SidebarPinnedRateLimitsDock monitor={monitor} />);

    expect(markup).toContain('aria-label="Pinned provider plan limits"');
    expect(markup).toContain('data-layout="adaptive-grid"');
    expect(markup.match(/role="progressbar"/gu)).toHaveLength(2);
    expect(markup).toContain('aria-valuenow="36"');
    expect(markup).toContain('data-available-percent="36"');
    expect(markup).toContain("36% available");
    expect(markup).toContain("Resets in 2h 14m");
    expect(markup).toContain("Weekly (Fable 5)");
    expect(markup).toContain("73% available");
    expect(markup).toContain('data-rate-limit-bar="five_hour"');
    expect(markup).toContain('data-rate-limit-bar="model_scoped:fable-5"');
    expect(markup).toContain("h-2.5 w-full");
    expect(markup).not.toContain("<circle");
    expect(markup).toContain('data-rate-limit-layer="model_scoped:fable-5"');
    expect(markup).toContain("claude_work");
    expect(markup).toContain('aria-label="Unpin Claude Work, claude_work, plan limits"');
  });

  it("lays pinned providers out in an intrinsic-height adaptive grid", () => {
    const provider = monitor.view.providers[0]!;
    const gridMonitor: SidebarRateLimitsMonitor = {
      ...monitor,
      view: {
        ...monitor.view,
        providers: [
          provider,
          { ...provider, key: "local:codex_personal", displayName: "Codex Personal" },
          { ...provider, key: "local:codex_work", displayName: "Codex Work" },
        ],
      },
      pinnedProviderKeys: new Set([
        "local:claude_work",
        "local:codex_personal",
        "local:codex_work",
      ]),
    };

    const markup = renderToStaticMarkup(<SidebarPinnedRateLimitsDock monitor={gridMonitor} />);

    expect(markup.match(/data-rate-limit-widget=/gu)).toHaveLength(3);
    expect(markup).toContain("auto-rows-max");
    expect(markup).toContain("items-start");
    expect(markup).toContain("grid-cols-[repeat(auto-fit,minmax(7rem,1fr))]");
    expect(markup).toContain("self-start");
    expect(markup).not.toContain("min-h-14");
  });

  it("shares the persisted weekly collapse state with each pinned widget", () => {
    const toggleProviderWeeklyCollapsed = vi.fn();
    const markup = renderToStaticMarkup(
      <SidebarPinnedRateLimitsDock
        monitor={{
          ...monitor,
          collapsedWeeklyProviderKeys: new Set(["local:claude_work"]),
          toggleProviderWeeklyCollapsed,
        }}
      />,
    );

    expect(markup).toContain('aria-label="Show weekly limits for Claude Work"');
    expect(markup).toContain("-rotate-90");
    expect(markup).toContain('data-rate-limit-bar="five_hour"');
    expect(markup).not.toContain('data-rate-limit-bar="model_scoped:fable-5"');
    expect(markup).not.toContain('data-pinned-weekly-limits="local:claude_work"');
  });

  it("does not describe non-resetting credits as missing reset data", () => {
    const provider = monitor.view.providers[0]!;
    const creditMonitor: SidebarRateLimitsMonitor = {
      ...monitor,
      view: {
        ...monitor.view,
        providers: [
          {
            ...provider,
            windows: [
              {
                id: "extra_usage",
                label: "Extra usage",
                kind: "credits",
                usedPercent: 12,
                status: "ok",
                resetsInLabel: null,
                isReset: false,
                detail: "$8.80 available",
              },
            ],
          },
        ],
      },
    };
    const markup = renderToStaticMarkup(<SidebarPinnedRateLimitsDock monitor={creditMonitor} />);

    expect(markup).toContain("No scheduled reset");
    expect(markup).not.toContain("Reset time unavailable");
  });

  it("stays absent when no connected account is pinned", () => {
    const markup = renderToStaticMarkup(
      <SidebarPinnedRateLimitsDock
        monitor={{ ...monitor, pinnedProviderKeys: new Set(["missing:provider"]) }}
      />,
    );

    expect(markup).toBe("");
  });

  it("waits for persisted preferences before mounting a saved dock", () => {
    const markup = renderToStaticMarkup(
      <SidebarPinnedRateLimitsDock monitor={{ ...monitor, preferencesHydrated: false }} />,
    );

    expect(markup).toBe("");
  });
});
