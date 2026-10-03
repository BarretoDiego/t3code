import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, RunId } from "@t3tools/contracts";

import { deriveAgentOperationalState } from "./agentBoardStateAdapter.ts";
import type { ThreadRuntimeSummary } from "./state/models.ts";

type ClassifierShell = Parameters<typeof deriveAgentOperationalState>[0];

function shell(overrides: Partial<ClassifierShell> = {}): ClassifierShell {
  return {
    runtime: null,
    latestRun: null,
    pendingBackgroundTasks: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    settledOverride: null,
    settledAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function runtime(status: ThreadRuntimeSummary["status"]): ThreadRuntimeSummary {
  return {
    status,
    activeRunId: status === "idle" ? null : RunId.make("run-1"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: null,
    lastError: status === "failed" ? "private provider output" : null,
    updatedAt: "2026-01-03T00:00:00.000Z",
  };
}

const backgroundTask = {
  kind: "command",
} as unknown as ClassifierShell["pendingBackgroundTasks"][number];

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
    expect(
      deriveAgentOperationalState(
        shell({
          runtime: runtime("failed"),
          pendingBackgroundTasks: [backgroundTask],
          settledOverride: "settled",
          settledAt: "2026-01-02T00:00:00.000Z",
        }),
      ),
    ).toMatchObject({ kind: "issue", reason: "session-failed" });

    expect(
      deriveAgentOperationalState(
        shell({
          runtime: runtime("running"),
          settledOverride: "settled",
          settledAt: "2026-01-02T00:00:00.000Z",
        }),
      ),
    ).toMatchObject({ kind: "working", reason: "turn" });

    expect(
      deriveAgentOperationalState(shell({ pendingBackgroundTasks: [backgroundTask] })),
    ).toMatchObject({ kind: "working", reason: "background" });
  });

  it("routes actionable plans to review and completed work to settled", () => {
    expect(deriveAgentOperationalState(shell({ hasActionableProposedPlan: true }))).toMatchObject({
      kind: "review",
      reason: "actionable-plan",
    });
    expect(
      deriveAgentOperationalState(
        shell({
          latestRun: {
            runId: RunId.make("run-1"),
            status: "completed",
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
