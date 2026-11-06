import type { EnvironmentId, ScheduledTask } from "@t3tools/contracts";

import { formatRelativeTimeLabel } from "../../timestampFormat";

/** The fork's upstream-reconcile task is created under this id on the homelab server. */
export const UPSTREAM_RECONCILE_TASK_ID = "upstream-reconcile";

export interface ReconcileEnvironmentInput {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** Null until the environment's task list has loaded. */
  readonly tasks: ReadonlyArray<ScheduledTask> | null;
  readonly canRun: boolean;
}

export interface ReconcileTarget {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly task: ScheduledTask;
}

/** The first environment that both has the task and lets this client run it. */
export function resolveReconcileTarget(
  environments: ReadonlyArray<ReconcileEnvironmentInput>,
): ReconcileTarget | null {
  for (const { environmentId, label, tasks, canRun } of environments) {
    if (!canRun) continue;
    const task = tasks?.find((candidate) => candidate.id === UPSTREAM_RECONCILE_TASK_ID);
    if (task) return { environmentId, label, task };
  }
  return null;
}

export function isReconcileRunning(task: ScheduledTask, isRequestPending: boolean): boolean {
  return isRequestPending || task.lastRunStatus === "running";
}

function formatUntil(iso: string, nowMs: number): string | null {
  const untilMs = Date.parse(iso) - nowMs;
  if (Number.isNaN(untilMs)) return null;
  const minutes = Math.floor(untilMs / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.floor(hours / 24)}d`;
}

export function getReconcileTooltip(
  target: ReconcileTarget,
  isRequestPending: boolean,
  nowMs: number,
): string {
  const { task, label } = target;
  const running = isReconcileRunning(task, isRequestPending);
  const lines = [
    running ? `Reconciling with upstream on ${label}…` : `Reconcile fork with upstream on ${label}`,
  ];
  if (!running && task.lastRunAt !== null && task.lastRunStatus !== "never") {
    const when = formatRelativeTimeLabel(task.lastRunAt, nowMs);
    lines.push(`Last run ${task.lastRunStatus}${when ? ` ${when}` : ""}`);
  }
  if (task.enabled && task.nextRunAt !== null) {
    const next = formatUntil(task.nextRunAt, nowMs);
    if (next !== null) lines.push(`Next run ${next}`);
  }
  return lines.join("\n");
}

export const RECONCILE_CONFIRMATION_MESSAGE = [
  "Reconcile with upstream now?",
  "This starts an agent that merges upstream into the fork and publishes a release.",
].join("\n");
