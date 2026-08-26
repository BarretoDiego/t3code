import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationSession,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";

import { deriveAgentOperationalState } from "./agentBoardStateAdapter.ts";

function shell(overrides: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell {
  return {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Test thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
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
  } as OrchestrationThreadShell;
}

function session(status: OrchestrationSession["status"]): OrchestrationSession {
  return {
    threadId: ThreadId.make("thread-1"),
    status,
    providerName: null,
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: "private provider output",
    updatedAt: "2026-01-03T00:00:00.000Z",
  };
}

describe("deriveAgentOperationalState", () => {
  it("keeps approval and structured input as separate needs-you reasons", () => {
    expect(deriveAgentOperationalState(shell({ hasPendingApprovals: true }))).toMatchObject({
      kind: "needs-you",
      reason: "approval",
    });
    expect(deriveAgentOperationalState(shell({ hasPendingUserInput: true }))).toMatchObject({
      kind: "needs-you",
      reason: "user-input",
    });
  });

  it("makes failure outrank liveness and liveness outrank settlement", () => {
    const runningSession = session("error");
    expect(
      deriveAgentOperationalState(
        shell({
          session: runningSession,
          backgroundLiveness: "working",
          settledOverride: "settled",
          settledAt: "2026-01-02T00:00:00.000Z",
        }),
      ),
    ).toMatchObject({ kind: "issue", reason: "session-failed" });

    expect(
      deriveAgentOperationalState(
        shell({
          session: session("running"),
          settledOverride: "settled",
          settledAt: "2026-01-02T00:00:00.000Z",
        }),
      ),
    ).toMatchObject({ kind: "working" });
  });

  it("routes actionable plans to review and completed work to settled", () => {
    expect(deriveAgentOperationalState(shell({ hasActionableProposedPlan: true }))).toMatchObject({
      kind: "review",
      reason: "actionable-plan",
    });
    expect(
      deriveAgentOperationalState(
        shell({
          latestTurn: {
            turnId: TurnId.make("turn-1"),
            state: "completed",
            requestedAt: "2026-01-01T00:00:00.000Z",
            startedAt: "2026-01-01T00:01:00.000Z",
            completedAt: "2026-01-01T00:02:00.000Z",
            assistantMessageId: null,
          },
        }),
      ),
    ).toMatchObject({ kind: "settled", reason: "completed" });
  });

  it("falls back to idle and never emits an invalid since timestamp", () => {
    expect(deriveAgentOperationalState(shell({ createdAt: "bad", updatedAt: "also-bad" }))).toEqual(
      { kind: "idle", reason: "quiet", since: null },
    );
  });
});
