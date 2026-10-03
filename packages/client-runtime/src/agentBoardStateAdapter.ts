import type { EnvironmentThreadShell } from "./state/models.ts";

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
 *
 * Reads the v2 presentation shell: `runtime` carries the activity-owning run
 * status (or idle), `latestRun` the latest root run, and post-settlement
 * background work arrives as `pendingBackgroundTasks`.
 */
export function deriveAgentOperationalState(
  shell: Pick<
    EnvironmentThreadShell,
    | "runtime"
    | "latestRun"
    | "pendingBackgroundTasks"
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "hasActionableProposedPlan"
    | "settledOverride"
    | "settledAt"
    | "updatedAt"
    | "createdAt"
  >,
): AgentOperationalState {
  const runtime = shell.runtime;
  const latestRun = shell.latestRun;
  const activityAt = firstValidTimestamp(
    runtime?.updatedAt,
    latestRun?.completedAt,
    latestRun?.startedAt,
    latestRun?.requestedAt,
    shell.updatedAt,
    shell.createdAt,
  );

  if (shell.hasPendingApprovals) {
    return { kind: "needs-you", reason: "approval", since: activityAt };
  }
  if (shell.hasPendingUserInput) {
    return { kind: "needs-you", reason: "user-input", since: activityAt };
  }
  if (latestRun?.status === "failed") {
    return {
      kind: "issue",
      reason: "turn-failed",
      since: firstValidTimestamp(latestRun.completedAt, activityAt),
    };
  }
  if (runtime?.status === "failed") {
    return {
      kind: "issue",
      reason: "session-failed",
      since: firstValidTimestamp(runtime.updatedAt, activityAt),
    };
  }
  if (
    runtime?.status === "preparing" ||
    runtime?.status === "queued" ||
    runtime?.status === "starting" ||
    runtime?.status === "running" ||
    runtime?.status === "waiting"
  ) {
    return {
      kind: "working",
      reason: "turn",
      since: firstValidTimestamp(runtime.activityStartedAt, latestRun?.startedAt, activityAt),
    };
  }
  if (shell.pendingBackgroundTasks.length > 0) {
    return shell.pendingBackgroundTasks.every((task) => task.kind === "monitor")
      ? { kind: "working", reason: "monitoring", since: activityAt }
      : { kind: "working", reason: "background", since: activityAt };
  }
  if (shell.hasActionableProposedPlan) {
    return { kind: "review", reason: "actionable-plan", since: activityAt };
  }
  if (latestRun?.status === "completed") {
    return {
      kind: "settled",
      reason: "completed",
      since: firstValidTimestamp(latestRun.completedAt, activityAt),
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
