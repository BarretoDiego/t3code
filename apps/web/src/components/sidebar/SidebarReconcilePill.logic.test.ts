import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  type ScheduledTask,
} from "@t3tools/contracts";

import {
  getReconcileTooltip,
  isReconcileRunning,
  resolveReconcileTarget,
  UPSTREAM_RECONCILE_TASK_ID,
} from "./SidebarReconcilePill.logic";

const NOW = Date.parse("2026-11-06T12:00:00.000Z");

const makeTask = (overrides: Partial<ScheduledTask> = {}): ScheduledTask => ({
  id: ScheduledTaskId.make(UPSTREAM_RECONCILE_TASK_ID),
  title: "Reconcile",
  prompt: "Sync",
  enabled: true,
  schedule: { type: "interval", everyMs: 86_400_000 },
  projectId: ProjectId.make("project-1"),
  threadId: null,
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "opus" },
  fallbackModelSelections: [],
  runtimeMode: "full-access",
  interactionMode: "default",
  createdBy: "user",
  creationSource: "web",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  nextRunAt: null,
  lastRunAt: null,
  lastRunStatus: "never",
  lastRunError: null,
  runCount: 0,
  ...overrides,
});

const env = (id: string, tasks: ReadonlyArray<ScheduledTask> | null, canRun = true) => ({
  environmentId: EnvironmentId.make(id),
  label: id,
  tasks,
  canRun,
});

describe("resolveReconcileTarget", () => {
  it("finds the task by its exact id in any environment", () => {
    const other = makeTask({ id: ScheduledTaskId.make("upstream-reconcile-2") });
    const target = resolveReconcileTarget([
      env("laptop", [other]),
      env("homelab", [other, makeTask()]),
    ]);
    expect(target?.environmentId).toBe("homelab");
    expect(target?.task.id).toBe(UPSTREAM_RECONCILE_TASK_ID);
  });

  it("hides when no environment has the task or the task list has not loaded", () => {
    expect(resolveReconcileTarget([env("laptop", []), env("homelab", null)])).toBeNull();
  });

  it("skips environments the client may not run tasks on", () => {
    const target = resolveReconcileTarget([
      env("homelab", [makeTask()], false),
      env("backup", [makeTask()]),
    ]);
    expect(target?.environmentId).toBe("backup");
    expect(resolveReconcileTarget([env("homelab", [makeTask()], false)])).toBeNull();
  });
});

describe("isReconcileRunning", () => {
  it("is running while a run is recorded or the request is in flight", () => {
    expect(isReconcileRunning(makeTask({ lastRunStatus: "running" }), false)).toBe(true);
    expect(isReconcileRunning(makeTask(), true)).toBe(true);
    expect(isReconcileRunning(makeTask({ lastRunStatus: "failed" }), false)).toBe(false);
  });
});

describe("getReconcileTooltip", () => {
  const target = (task: ScheduledTask) => ({
    environmentId: EnvironmentId.make("homelab"),
    label: "Homelab",
    task,
  });

  it("names the environment, the last run, and the next run", () => {
    const task = makeTask({
      lastRunAt: "2026-11-06T09:00:00.000Z",
      lastRunStatus: "succeeded",
      nextRunAt: "2026-11-07T09:00:00.000Z",
    });
    expect(getReconcileTooltip(target(task), false, NOW)).toBe(
      "Reconcile fork with upstream on Homelab\nLast run succeeded 3h ago\nNext run in 21h",
    );
  });

  it("omits what is unknown, and a paused task's next run", () => {
    expect(getReconcileTooltip(target(makeTask()), false, NOW)).toBe(
      "Reconcile fork with upstream on Homelab",
    );
    const paused = makeTask({ enabled: false, nextRunAt: "2026-11-07T09:00:00.000Z" });
    expect(getReconcileTooltip(target(paused), false, NOW)).not.toContain("Next run");
  });

  it("says it is running instead of offering the action", () => {
    const task = makeTask({ lastRunStatus: "running", lastRunAt: "2026-11-06T11:59:00.000Z" });
    expect(getReconcileTooltip(target(task), false, NOW)).toBe(
      "Reconciling with upstream on Homelab…",
    );
  });
});
