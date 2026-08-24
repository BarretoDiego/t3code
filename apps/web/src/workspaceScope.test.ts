import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveScopeEnvironmentLabel,
  shelveScopeThreads,
  summarizeEnvironmentProjects,
} from "./workspaceScope";

const environmentId = (value: string) => value as EnvironmentId;
const projectId = (value: string) => value as ProjectId;

const NOW = "2026-08-24T12:00:00.000Z";
const ALWAYS = () => true;
const NEVER = () => false;

function thread(input: {
  id: string;
  environmentId?: string;
  projectId?: string;
  createdAt?: string;
  updatedAt?: string;
  settledOverride?: "settled" | "active" | null;
  settledAt?: string | null;
  snoozedUntil?: string | null;
  hasPendingApprovals?: boolean;
}): EnvironmentThreadShell {
  return {
    id: input.id,
    environmentId: environmentId(input.environmentId ?? "local"),
    projectId: projectId(input.projectId ?? "app"),
    title: input.id,
    modelSelection: { instanceId: "claude" },
    runtimeMode: "local",
    interactionMode: "chat",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: input.createdAt ?? "2026-08-20T10:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-08-24T11:00:00.000Z",
    archivedAt: null,
    settledOverride: input.settledOverride ?? null,
    settledAt: input.settledAt ?? null,
    snoozedUntil: input.snoozedUntil ?? null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: input.hasPendingApprovals ?? false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  } as unknown as EnvironmentThreadShell;
}

function shelve(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  overrides?: Partial<{
    supportsSettlement: (id: EnvironmentId) => boolean;
    supportsSnooze: (id: EnvironmentId) => boolean;
  }>,
) {
  return shelveScopeThreads({
    threads,
    now: NOW,
    autoSettleAfterDays: null,
    autoSettleOnMerge: false,
    supportsSettlement: overrides?.supportsSettlement ?? ALWAYS,
    supportsSnooze: overrides?.supportsSnooze ?? ALWAYS,
    ...overrides,
  });
}

describe("shelveScopeThreads", () => {
  it("files an explicitly settled thread under Settled", () => {
    const shelves = shelve([
      thread({ id: "live" }),
      thread({ id: "done", settledOverride: "settled", settledAt: "2026-08-23T09:00:00.000Z" }),
    ]);
    expect(shelves.active.map((t) => t.id)).toEqual(["live"]);
    expect(shelves.settled.map((t) => t.id)).toEqual(["done"]);
  });

  it("lets snooze outrank settlement, as the sidebar does", () => {
    const shelves = shelve([
      thread({
        id: "later",
        settledOverride: "settled",
        settledAt: "2026-08-23T09:00:00.000Z",
        snoozedUntil: "2026-08-25T09:00:00.000Z",
      }),
    ]);
    expect(shelves.snoozed.map((t) => t.id)).toEqual(["later"]);
    expect(shelves.settled).toEqual([]);
  });

  it("keeps threads active on a server that cannot settle them", () => {
    const shelves = shelve(
      [thread({ id: "done", settledOverride: "settled", settledAt: "2026-08-23T09:00:00.000Z" })],
      { supportsSettlement: NEVER },
    );
    expect(shelves.active.map((t) => t.id)).toEqual(["done"]);
    expect(shelves.settled).toEqual([]);
  });

  it("keeps threads active on a server that cannot snooze them", () => {
    const shelves = shelve([thread({ id: "later", snoozedUntil: "2026-08-25T09:00:00.000Z" })], {
      supportsSnooze: NEVER,
    });
    expect(shelves.active.map((t) => t.id)).toEqual(["later"]);
    expect(shelves.snoozed).toEqual([]);
  });

  it("never hides blocked work, even when it was settled", () => {
    const shelves = shelve([
      thread({
        id: "blocked",
        settledOverride: "settled",
        settledAt: "2026-08-23T09:00:00.000Z",
        hasPendingApprovals: true,
      }),
    ]);
    expect(shelves.active.map((t) => t.id)).toEqual(["blocked"]);
  });

  it("orders active threads newest-created first and snoozed by soonest wake", () => {
    const shelves = shelve([
      thread({ id: "older", createdAt: "2026-08-19T10:00:00.000Z" }),
      thread({ id: "newer", createdAt: "2026-08-22T10:00:00.000Z" }),
      thread({ id: "wakes-late", snoozedUntil: "2026-08-27T09:00:00.000Z" }),
      thread({ id: "wakes-soon", snoozedUntil: "2026-08-25T09:00:00.000Z" }),
    ]);
    expect(shelves.active.map((t) => t.id)).toEqual(["newer", "older"]);
    expect(shelves.snoozed.map((t) => t.id)).toEqual(["wakes-soon", "wakes-late"]);
  });
});

describe("summarizeEnvironmentProjects", () => {
  const project = (input: { id: string; environmentId?: string; updatedAt?: string }) => ({
    id: projectId(input.id),
    environmentId: environmentId(input.environmentId ?? "local"),
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-08-02T10:00:00.000Z",
  });

  it("gives a project with no threads a row of its own", () => {
    const summaries = summarizeEnvironmentProjects({
      environmentId: environmentId("local"),
      projects: [project({ id: "quiet" })],
      threads: [],
      isActiveThread: ALWAYS,
    });
    expect(summaries.map((entry) => [entry.project.id, entry.threadCount])).toEqual([["quiet", 0]]);
    expect(summaries[0]?.lastActivityAt).toBe("2026-08-02T10:00:00.000Z");
  });

  it("counts only this environment's threads", () => {
    const summaries = summarizeEnvironmentProjects({
      environmentId: environmentId("local"),
      projects: [project({ id: "app" }), project({ id: "elsewhere", environmentId: "remote" })],
      threads: [
        thread({ id: "a", projectId: "app" }),
        thread({ id: "b", projectId: "app", environmentId: "remote" }),
      ],
      isActiveThread: ALWAYS,
    });
    expect(summaries.map((entry) => [entry.project.id, entry.threadCount])).toEqual([["app", 1]]);
  });

  it("separates the active count from the total", () => {
    const summaries = summarizeEnvironmentProjects({
      environmentId: environmentId("local"),
      projects: [project({ id: "app" })],
      threads: [thread({ id: "live", projectId: "app" }), thread({ id: "done", projectId: "app" })],
      isActiveThread: (candidate) => candidate.id === "live",
    });
    expect(summaries[0]?.activeThreadCount).toBe(1);
    expect(summaries[0]?.threadCount).toBe(2);
  });

  it("sorts by newest thread activity, and by the project itself when it has none", () => {
    const summaries = summarizeEnvironmentProjects({
      environmentId: environmentId("local"),
      projects: [
        project({ id: "stale", updatedAt: "2026-08-01T10:00:00.000Z" }),
        project({ id: "busy", updatedAt: "2026-08-01T10:00:00.000Z" }),
        project({ id: "fresh-empty", updatedAt: "2026-08-23T10:00:00.000Z" }),
      ],
      threads: [
        thread({ id: "old", projectId: "stale", updatedAt: "2026-08-10T10:00:00.000Z" }),
        thread({ id: "recent", projectId: "busy", updatedAt: "2026-08-24T10:00:00.000Z" }),
      ],
      isActiveThread: ALWAYS,
    });
    expect(summaries.map((entry) => entry.project.id)).toEqual(["busy", "fresh-empty", "stale"]);
  });
});

describe("resolveScopeEnvironmentLabel", () => {
  it("keeps a real label, trimmed", () => {
    expect(resolveScopeEnvironmentLabel("  Work laptop  ")).toBe("Work laptop");
  });

  it("treats a blank or missing name as no environment to show", () => {
    expect(resolveScopeEnvironmentLabel("   ")).toBeNull();
    expect(resolveScopeEnvironmentLabel("")).toBeNull();
    expect(resolveScopeEnvironmentLabel(null)).toBeNull();
    expect(resolveScopeEnvironmentLabel(undefined)).toBeNull();
  });
});
