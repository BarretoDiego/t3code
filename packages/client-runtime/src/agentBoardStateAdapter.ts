import type { OrchestrationThreadShell } from "@t3tools/contracts";

/**
 * Temporary public shape expected from feat/agent-state-model.
 *
 * When that feature lands, this module is replaced by an import-only bridge.
 * Board consumers must not inspect shell flags themselves.
 */
export type AgentOperationalState =
  | {
      readonly kind: "needs-you";
      readonly reason: "approval" | "user-input";
      readonly since: string | null;
    }
  | {
      readonly kind: "working";
      readonly reason: "turn" | "background" | "monitoring";
      readonly since: string | null;
    }
  | {
      readonly kind: "review";
      readonly reason: "actionable-plan";
      readonly since: string | null;
    }
  | {
      readonly kind: "settled";
      readonly reason: "completed" | "lifecycle";
      readonly since: string | null;
    }
  | {
      readonly kind: "issue";
      readonly reason: "session-failed" | "turn-failed";
      readonly since: string | null;
    }
  | {
      readonly kind: "idle";
      readonly reason: "quiet";
      readonly since: string | null;
    };

function firstValidTimestamp(
  ...candidates: ReadonlyArray<string | null | undefined>
): string | null {
  for (const candidate of candidates) {
    if (candidate !== null && candidate !== undefined && Number.isFinite(Date.parse(candidate))) {
      return candidate;
    }
  }
  return null;
}

/**
 * The only pre-feature-1 classifier used by the Board. Its precedence is the
 * compatibility contract: direct user requests, failure, liveness, review,
 * completion/lifecycle, then quiet history.
 */
export function deriveAgentOperationalState(
  shell: OrchestrationThreadShell,
): AgentOperationalState {
  const activityAt = firstValidTimestamp(
    shell.session?.updatedAt,
    shell.latestTurn?.completedAt,
    shell.latestTurn?.startedAt,
    shell.latestTurn?.requestedAt,
    shell.updatedAt,
    shell.createdAt,
  );

  if (shell.hasPendingApprovals) {
    return { kind: "needs-you", reason: "approval", since: activityAt };
  }
  if (shell.hasPendingUserInput) {
    return { kind: "needs-you", reason: "user-input", since: activityAt };
  }
  if (shell.session?.status === "error") {
    return {
      kind: "issue",
      reason: "session-failed",
      since: firstValidTimestamp(shell.session.updatedAt, activityAt),
    };
  }
  if (shell.latestTurn?.state === "error") {
    return {
      kind: "issue",
      reason: "turn-failed",
      since: firstValidTimestamp(shell.latestTurn.completedAt, activityAt),
    };
  }
  if (shell.session?.status === "running" || shell.session?.status === "starting") {
    return {
      kind: "working",
      reason: "turn",
      since: firstValidTimestamp(shell.latestTurn?.startedAt, shell.session.updatedAt, activityAt),
    };
  }
  if (shell.backgroundLiveness === "working") {
    return { kind: "working", reason: "background", since: activityAt };
  }
  if (shell.backgroundLiveness === "monitoring") {
    return { kind: "working", reason: "monitoring", since: activityAt };
  }
  if (shell.hasActionableProposedPlan) {
    return { kind: "review", reason: "actionable-plan", since: activityAt };
  }
  if (shell.latestTurn?.state === "completed") {
    return {
      kind: "settled",
      reason: "completed",
      since: firstValidTimestamp(shell.latestTurn.completedAt, activityAt),
    };
  }
  if (shell.settledOverride === "settled" || shell.settledAt !== null) {
    return {
      kind: "settled",
      reason: "lifecycle",
      since: firstValidTimestamp(shell.settledAt, activityAt),
    };
  }
  return { kind: "idle", reason: "quiet", since: activityAt };
}
