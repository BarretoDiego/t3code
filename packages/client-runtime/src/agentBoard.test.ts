import { describe, expect, it } from "@effect/vitest";
import type { EnvironmentThreadShell } from "./state/models.ts";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationSession,
} from "@t3tools/contracts";

import {
  boardProjectKey,
  boardProviderInstanceKey,
  buildAgentBoard,
  createAgentBoardProjector,
  EMPTY_AGENT_BOARD_FILTERS,
  nextAgentBoardSnoozeWakeAt,
  type AgentBoardFilters,
  type AgentBoardInput,
} from "./agentBoard.ts";

function thread(
  id: string,
  environmentId: string,
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell {
  return {
    environmentId: EnvironmentId.make(environmentId),
    id: ThreadId.make(id),
    projectId: ProjectId.make("project-1"),
    title: `Thread ${id}`,
    modelSelection: { instanceId: ProviderInstanceId.make("codex_work"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "feat/board",
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  } as EnvironmentThreadShell;
}

function session(status: OrchestrationSession["status"]): OrchestrationSession {
  return {
    threadId: ThreadId.make("same-id"),
    status,
    providerName: null,
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: status === "error" ? "private provider output" : null,
    updatedAt: "2026-01-06T00:00:00.000Z",
  };
}

const filters = (overrides: Partial<AgentBoardFilters> = {}): AgentBoardFilters => ({
  ...EMPTY_AGENT_BOARD_FILTERS,
  ...overrides,
});

function input(
  threads: readonly EnvironmentThreadShell[],
  filterOverrides: Partial<AgentBoardFilters> = {},
): AgentBoardInput {
  return {
    threads,
    projects: [
      {
        environmentId: EnvironmentId.make("env-a"),
        id: ProjectId.make("project-1"),
        title: "Alpha",
        workspaceRoot: "/repo/alpha",
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        environmentId: EnvironmentId.make("env-b"),
        id: ProjectId.make("project-1"),
        title: "Beta",
        workspaceRoot: "/repo/beta",
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    environments: [
      {
        environmentId: EnvironmentId.make("env-a"),
        label: "Machine A",
        platform: "darwin",
        connectivity: "connected",
        cachedAt: null,
      },
      {
        environmentId: EnvironmentId.make("env-b"),
        label: "Machine B",
        platform: "linux",
        connectivity: "disconnected",
        cachedAt: "2026-01-02T00:00:00.000Z",
      },
    ],
    providers: [
      {
        environmentId: EnvironmentId.make("env-a"),
        instanceId: ProviderInstanceId.make("codex_work"),
        driver: "codex",
        label: "Work account",
      },
      {
        environmentId: EnvironmentId.make("env-b"),
        instanceId: ProviderInstanceId.make("codex_work"),
        driver: "codex",
        label: "Other account",
      },
    ],
    filters: filters(filterOverrides),
    now: "2026-02-01T00:00:00.000Z",
  };
}

describe("buildAgentBoard", () => {
  it("places every display state in its column and preserves scoped IDs", () => {
    const running = session("running");
    const model = buildAgentBoard(
      input(
        [
          thread("same-id", "env-a", { hasPendingApprovals: true }),
          thread("same-id", "env-b", { session: running }),
          thread("review", "env-a", { hasActionableProposedPlan: true }),
          thread("done", "env-a", {
            settledOverride: "settled",
            settledAt: "2026-01-04T00:00:00.000Z",
          }),
          thread("broken", "env-a", { session: session("error") }),
          thread("idle", "env-a"),
        ],
        { onlyActive: false },
      ),
    );

    expect(model.columns.needsYou.map((card) => card.ref)).toEqual([
      { environmentId: "env-a", threadId: "same-id" },
    ]);
    expect(model.columns.working.map((card) => card.ref)).toEqual([
      { environmentId: "env-b", threadId: "same-id" },
    ]);
    expect(model.columns.review).toHaveLength(1);
    expect(model.columns.settled).toHaveLength(1);
    expect(model.columns.issue).toHaveLength(1);
    expect(model.columns.idle).toHaveLength(1);
    expect(model.columns.working[0]?.environment.connectivity).toBe("disconnected");
    expect(model.columns.working[0]?.providerLabel).toBe("Other account");
  });

  it("uses NaN-safe ordering and deterministic environment/thread tie breaks", () => {
    const model = buildAgentBoard(
      input([
        thread("z", "env-a", { hasPendingApprovals: true, updatedAt: "bad" }),
        thread("a", "env-b", { hasPendingApprovals: true, updatedAt: "bad" }),
        thread("a", "env-a", { hasPendingApprovals: true, updatedAt: "bad" }),
      ]),
    );
    expect(
      model.columns.needsYou.map((card) => `${card.ref.environmentId}:${card.ref.threadId}`),
    ).toEqual(["env-a:a", "env-a:z", "env-b:a"]);
  });

  it("applies OR within a dimension and AND between dimensions", () => {
    const model = buildAgentBoard(
      input(
        [
          thread("a", "env-a", { hasPendingApprovals: true }),
          thread("b", "env-b", {
            hasPendingApprovals: true,
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex_work"),
              model: "gpt-5-mini",
            },
          }),
        ],
        {
          environmentIds: ["env-a", "env-b"],
          projectKeys: [boardProjectKey("env-b", "project-1")],
          models: ["gpt-5-mini"],
        },
      ),
    );
    expect(model.columns.needsYou.map((card) => card.ref.threadId)).toEqual(["b"]);
  });

  it("signals and ignores stale filters after environment/provider removal", () => {
    const model = buildAgentBoard(
      input([thread("a", "env-a", { hasPendingApprovals: true })], {
        environmentIds: ["removed-env"],
        providerInstanceKeys: [boardProviderInstanceKey("env-a", "removed-account")],
      }),
    );
    expect(model.staleFilterCount).toBe(2);
    expect(model.columns.needsYou).toHaveLength(1);
  });

  it("enforces archived, deleted, snoozed, settled, and only-active inclusion", () => {
    const quietSnoozed = thread("snoozed", "env-a", {
      snoozedAt: "2026-01-01T00:00:00.000Z",
      snoozedUntil: "2026-03-01T00:00:00.000Z",
    });
    const raisedHand = thread("raised", "env-a", {
      snoozedAt: "2026-01-01T00:00:00.000Z",
      snoozedUntil: "2026-03-01T00:00:00.000Z",
      hasPendingUserInput: true,
      settledOverride: "settled",
    });
    const deleted = { ...thread("deleted", "env-a"), deletedAt: "2026-01-02T00:00:00.000Z" };
    const model = buildAgentBoard(
      input([
        thread("archived", "env-a", { archivedAt: "2026-01-02T00:00:00.000Z" }),
        deleted,
        quietSnoozed,
        raisedHand,
        thread("idle", "env-a"),
      ]),
    );
    expect(model.totalEligible).toBe(2);
    expect(model.columns.needsYou.map((card) => card.ref.threadId)).toEqual(["raised"]);
    expect(model.columns.idle).toHaveLength(0);
  });

  it("keeps unknown projects/environments honest instead of inventing metadata", () => {
    const model = buildAgentBoard(
      input([thread("orphan", "env-removed", { hasPendingApprovals: true })]),
    );
    const card = model.columns.needsYou[0];
    expect(card?.project).toBeNull();
    expect(card?.environment).toMatchObject({
      label: null,
      removed: true,
      connectivity: "disconnected",
    });
    expect(card?.providerDriver).toBeNull();
  });

  it("handles the target 100-thread/10-environment dataset in one projection", () => {
    const threads = Array.from({ length: 100 }, (_, index) =>
      thread(`thread-${index}`, `env-${index % 10}`, {
        hasPendingApprovals: index % 5 === 0,
        backgroundLiveness: index % 5 === 1 ? "working" : null,
      }),
    );
    const model = buildAgentBoard({ ...input([]), threads });
    expect(model.totalEligible).toBe(100);
    expect(model.columns.needsYou).toHaveLength(20);
    expect(model.columns.working).toHaveLength(20);
  });

  it("preserves referential identity when source and filter identities do not change", () => {
    const project = createAgentBoardProjector();
    const value = input([thread("a", "env-a", { hasPendingApprovals: true })]);
    expect(project(value)).toBe(project(value));
    expect(project({ ...value })).toBe(project(value));
  });

  it("reacts to shell upserts without changing filters or requiring detail data", () => {
    const selectedFilters = { environmentIds: ["env-a"] };
    const working = thread("live", "env-a", {
      session: session("running"),
      backgroundLiveness: "working",
    });
    const first = buildAgentBoard(input([working], selectedFilters));
    expect(first.columns.working).toHaveLength(1);

    const needsYou = buildAgentBoard(
      input([{ ...working, hasPendingApprovals: true }], selectedFilters),
    );
    expect(needsYou.columns.working).toHaveLength(0);
    expect(needsYou.columns.needsYou).toHaveLength(1);

    const resolved = buildAgentBoard(
      input(
        [
          {
            ...working,
            session: session("ready"),
            backgroundLiveness: null,
            latestTurn: {
              turnId: "turn-1",
              state: "completed",
              requestedAt: "2026-01-06T00:00:00.000Z",
              startedAt: "2026-01-06T00:01:00.000Z",
              completedAt: "2026-01-06T00:02:00.000Z",
              assistantMessageId: null,
            },
          } as EnvironmentThreadShell,
        ],
        selectedFilters,
      ),
    );
    expect(resolved.columns.settled).toHaveLength(1);

    const failed = buildAgentBoard(
      input([{ ...working, session: session("error") }], selectedFilters),
    );
    expect(failed.columns.issue).toHaveLength(1);

    const archived = buildAgentBoard(
      input([{ ...working, archivedAt: "2026-01-07T00:00:00.000Z" }], selectedFilters),
    );
    expect(archived.totalVisible).toBe(0);
  });
});

describe("nextAgentBoardSnoozeWakeAt", () => {
  it("returns the earliest valid future wake boundary", () => {
    expect(
      nextAgentBoardSnoozeWakeAt(
        [
          thread("past", "env-a", { snoozedUntil: "2026-01-01T09:00:00.000Z" }),
          thread("later", "env-a", { snoozedUntil: "2026-01-01T12:00:00.000Z" }),
          thread("invalid", "env-a", { snoozedUntil: "not-a-date" }),
          thread("first", "env-a", { snoozedUntil: "2026-01-01T11:00:00.000Z" }),
        ],
        Date.parse("2026-01-01T10:00:00.000Z"),
      ),
    ).toBe(Date.parse("2026-01-01T11:00:00.000Z"));
  });

  it("returns null when no snooze can wake in the future", () => {
    expect(
      nextAgentBoardSnoozeWakeAt(
        [
          thread("quiet", "env-a"),
          thread("past", "env-a", { snoozedUntil: "2025-12-31T23:00:00.000Z" }),
        ],
        Date.parse("2026-01-01T10:00:00.000Z"),
      ),
    ).toBeNull();
  });
});
