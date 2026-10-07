import { describe, expect, it } from "vite-plus/test";
import {
  type AutomationPendingWork,
  ExecutionNodeId,
  JobId,
  MessageId,
  OrchestratorId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type ResourceTelemetryProcess,
  type TerminalSummary,
  ScheduledTaskId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { buildStatusReport, formatStatusReport, type StatusThread } from "./statusReport.ts";

const at = DateTime.makeUnsafe("2026-10-03T22:00:00.000Z");
const thread = (overrides: Partial<StatusThread> = {}): StatusThread => ({
  id: ThreadId.make("thread-1"),
  projectId: ProjectId.make("project-1"),
  title: "Ship changes",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  lineage: {
    parentThreadId: null,
    relationshipToParent: null,
    rootThreadId: ThreadId.make("thread-1"),
  },
  status: "completed",
  activityRunStatus: null,
  activeRunId: null,
  activityRunStartedAt: null,
  pendingRuntimeRequest: null,
  pendingBackgroundTasks: [],
  latestUserMessageAt: null,
  updatedAt: at,
  archivedAt: null,
  deletedAt: null,
  worktreePath: "/work/feature",
  branch: "feature",
  latestVisibleMessage: null,
  ...overrides,
});
const health = {
  native: { status: "healthy", lastSampleAt: Option.some(at), lastError: Option.none() },
  desktop: { status: "unavailable", lastSampleAt: Option.none(), lastError: Option.none() },
  sidecarVersion: Option.none(),
  sidecarPid: Option.none(),
  restartCount: 0,
  collectionDurationMicros: 0,
  scannedProcessCount: 0,
  retainedProcessCount: 0,
  inaccessibleProcessCount: 0,
} as const;
const idleAutomation: AutomationPendingWork = {
  hookDeliveries: { pending: 0, retrying: 0, failed: 0 },
  orchestrators: [],
  activeTasks: 0,
  unknownTasks: 0,
  activeJobs: [],
  peerOutboxPending: 0,
};
const base = {
  environment: "Local",
  at,
  threads: [],
  projects: [],
  terminals: [],
  scheduledTasks: [],
  jobs: [],
  pendingWork: { effects: [] },
  automation: idleAutomation,
  telemetry: { processes: [], sampleIntervalMs: 1000, health },
  errors: [],
  includeStopped: false,
} satisfies Parameters<typeof buildStatusReport>[0];
const report = (overrides: Partial<Parameters<typeof buildStatusReport>[0]> = {}) =>
  buildStatusReport({ ...base, ...overrides });
const terminal = (overrides: Partial<TerminalSummary> = {}): TerminalSummary => ({
  threadId: "thread-1",
  terminalId: "terminal-1",
  cwd: "/work",
  worktreePath: null,
  status: "running",
  pid: 123,
  exitCode: null,
  exitSignal: null,
  hasRunningSubprocess: false,
  label: "zsh",
  updatedAt: DateTime.formatIso(at),
  ...overrides,
});
const process = (overrides: Partial<ResourceTelemetryProcess> = {}): ResourceTelemetryProcess => ({
  identity: { pid: 123, startTimeMs: 0 },
  ppid: 1,
  childPids: [],
  depth: 0,
  name: "codex",
  command: "codex exec",
  status: "sleeping",
  category: "provider-root",
  cpuPercent: 0,
  cpuTimeMs: 0,
  residentBytes: 0,
  peakResidentBytes: 0,
  virtualBytes: 0,
  ioReadBytes: 0,
  ioWriteBytes: 0,
  ioReadBytesPerSecond: 0,
  ioWriteBytesPerSecond: 0,
  ioSemantics: "unavailable",
  runTimeMs: 1000,
  firstSeenAt: at,
  lastSeenAt: at,
  ...overrides,
});

describe("shutdown readiness", () => {
  it("reports completed threads as stopped and allows a fully observed idle environment", () => {
    const result = report({ threads: [thread()] });
    expect(result.safeToClose).toBe(true);
    expect(result.summary.stoppedThreads).toBe(1);
    expect(result.threads).toEqual([]);
    expect(report({ threads: [thread()], includeStopped: true }).threads).toHaveLength(1);
  });
  it("keeps archived and failed threads busy while they still own work", () => {
    const result = report({
      threads: [
        thread({
          status: "failed",
          activityRunStatus: "running",
          activeRunId: RunId.make("run-1"),
          archivedAt: at,
        }),
      ],
    });
    expect(result.readiness).toBe("busy");
    expect(result.threads[0]).toMatchObject({
      archived: true,
      activeRunId: "run-1",
      worktreePath: "/work/feature",
      provider: "codex",
      model: "gpt-5",
    });
  });
  it("does not treat a completed label as safe while background work is running", () => {
    const result = report({
      threads: [
        thread({
          pendingBackgroundTasks: [
            { taskId: "test-suite", kind: "command", description: "Run tests" },
          ],
        }),
      ],
    });
    expect(result.safeToClose).toBe(false);
    expect(formatStatusReport(result)).toContain("Run tests");
  });
  it("recognizes an agent waiting for input, while still blocking its background tasks", () => {
    const waiting = thread({
      status: "running",
      activityRunStatus: "running",
      activeRunId: RunId.make("run-1"),
      pendingRuntimeRequest: {
        id: RuntimeRequestId.make("request-1"),
        kind: "user_input",
        createdAt: at,
      },
    });
    expect(report({ threads: [waiting] })).toMatchObject({
      readiness: "ready",
      summary: { pausedThreads: 1 },
    });
    expect(
      report({
        threads: [{ ...waiting, pendingBackgroundTasks: [{ taskId: "child", kind: "subagent" }] }],
      }).readiness,
    ).toBe("busy");
  });
  it("includes the last visible message and serializes timestamps", () => {
    const result = report({
      threads: [
        thread({
          status: "running",
          latestVisibleMessage: {
            id: MessageId.make("message-1"),
            role: "assistant",
            text: "Applying migration",
            updatedAt: at,
          },
        }),
      ],
    });
    expect(formatStatusReport(result)).toContain("Applying migration");
    expect(result.threads[0]?.latestMessage?.updatedAt).toBe(DateTime.formatIso(at));
  });
  it("blocks subprocesses and terminals still starting", () => {
    expect(
      report({ terminals: [terminal({ hasRunningSubprocess: true, label: "vp test" })] }).readiness,
    ).toBe("busy");
    expect(report({ terminals: [terminal({ status: "starting" })] }).readiness).toBe("busy");
  });
  it("never infers completion from a sleeping provider or low CPU", () => {
    expect(report({ telemetry: { ...base.telemetry, processes: [process()] } })).toMatchObject({
      safeToClose: false,
      readiness: "unknown",
    });
  });
  it("allows a known idle shell, but not an unobserved shell or child process", () => {
    const shell = process({ category: "terminal-root", name: "zsh", command: "zsh" });
    expect(
      report({ terminals: [terminal()], telemetry: { ...base.telemetry, processes: [shell] } })
        .safeToClose,
    ).toBe(true);
    expect(report({ telemetry: { ...base.telemetry, processes: [shell] } }).readiness).toBe(
      "unknown",
    );
    expect(
      report({
        terminals: [terminal()],
        telemetry: { ...base.telemetry, processes: [{ ...shell, childPids: [124] }] },
      }).readiness,
    ).toBe("unknown");
  });
  it("retains read failures, incomplete telemetry and stale samples as unconfirmed", () => {
    expect(report({ errors: [{ source: "server work", detail: "unsupported" }] }).readiness).toBe(
      "unknown",
    );
    expect(report({ telemetry: null }).safeToClose).toBe(false);
    expect(
      report({
        telemetry: { ...base.telemetry, health: { ...health, inaccessibleProcessCount: 1 } },
      }).readiness,
    ).toBe("unknown");
    expect(report({ at: DateTime.makeUnsafe("2026-10-03T22:01:00.000Z") }).readiness).toBe(
      "unknown",
    );
  });
  it("blocks an in-flight scheduled task even if future executions were disabled", () => {
    const result = report({
      scheduledTasks: [
        {
          id: ScheduledTaskId.make("schedule-1"),
          title: "Review",
          prompt: "Review changes",
          enabled: false,
          schedule: { type: "interval", everyMs: 60_000 },
          projectId: ProjectId.make("project-1"),
          threadId: ThreadId.make("thread-1"),
          workspaceStrategy: { type: "root" },
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdBy: "user",
          creationSource: "server",
          createdAt: DateTime.formatIso(at),
          updatedAt: DateTime.formatIso(at),
          nextRunAt: null,
          lastRunAt: DateTime.formatIso(at),
          lastRunStatus: "running",
          lastRunError: null,
          runCount: 1,
        },
      ],
    });
    expect(result.readiness).toBe("busy");
    expect(result.scheduledTasks[0]?.id).toBe("schedule-1");
  });
  it("blocks a checkpoint even after the visible agent turn completed", () => {
    const result = report({
      threads: [thread()],
      pendingWork: {
        effects: [
          {
            id: "checkpoint-1",
            threadId: "thread-1",
            type: "checkpoint.capture",
            status: "pending",
            attemptCount: 1,
            createdAt: DateTime.formatIso(at),
            updatedAt: DateTime.formatIso(at),
            availableAt: DateTime.formatIso(at),
            lastError: "retrying",
          },
        ],
      },
    });
    expect(result.readiness).toBe("busy");
    expect(formatStatusReport(result)).toContain("checkpoint.capture");
  });
});

describe("automation work in the status report", () => {
  const orchestrator = (
    overrides: Partial<AutomationPendingWork["orchestrators"][number]> = {},
  ): AutomationPendingWork["orchestrators"][number] => ({
    orchestratorId: OrchestratorId.make("orch-1"),
    name: "Release captain",
    effectiveState: "idle",
    inboxPending: 0,
    activeChildren: 0,
    ...overrides,
  });

  it("is ready when automation has nothing in flight", () => {
    const result = report();
    expect(result.safeToClose).toBe(true);
    expect(result.blockers).toEqual([]);
  });

  it("is ready with an idle orchestrator that has no children and an empty inbox", () => {
    const result = report({
      automation: { ...idleAutomation, orchestrators: [orchestrator()] },
    });
    expect(result.safeToClose).toBe(true);
  });

  it("blocks on an idle orchestrator whose children are still working", () => {
    const result = report({
      automation: { ...idleAutomation, orchestrators: [orchestrator({ activeChildren: 2 })] },
    });
    expect(result.safeToClose).toBe(false);
    expect(result.blockers).toEqual([
      "Orchestrator orch-1: Release captain (2 active child task(s))",
    ]);
  });

  it("blocks on an idle orchestrator with unread inbox entries", () => {
    const result = report({
      automation: { ...idleAutomation, orchestrators: [orchestrator({ inboxPending: 1 })] },
    });
    expect(result.readiness).toBe("busy");
  });

  it("does not block on a paused orchestrator that only holds a backlog", () => {
    const result = report({
      automation: {
        ...idleAutomation,
        orchestrators: [orchestrator({ effectiveState: "paused", inboxPending: 3 })],
      },
    });
    expect(result.safeToClose).toBe(true);
  });

  it("blocks on a running orchestrator turn, running jobs, tasks and hook deliveries", () => {
    const result = report({
      automation: {
        ...idleAutomation,
        hookDeliveries: { pending: 1, retrying: 1, failed: 4 },
        orchestrators: [orchestrator({ effectiveState: "running" })],
        activeTasks: 2,
        activeJobs: [
          { jobId: JobId.make("job-1"), nodeId: ExecutionNodeId.make("local"), status: "started" },
        ],
      },
    });
    expect(result.blockers).toEqual([
      "2 hook delivery(ies) in flight",
      "Orchestrator orch-1: Release captain (running)",
      "2 delegated task(s) in progress",
      "Job job-1 on local: started",
    ]);
  });

  it("reports unknown outcomes as unknown readiness, never as ready", () => {
    const result = report({
      automation: {
        ...idleAutomation,
        unknownTasks: 1,
        activeJobs: [
          { jobId: JobId.make("job-2"), nodeId: ExecutionNodeId.make("local"), status: "unknown" },
        ],
      },
    });
    expect(result.readiness).toBe("unknown");
    expect(result.safeToClose).toBe(false);
    expect(result.blockers).toEqual([]);
    expect(result.unknowns).toHaveLength(2);
  });

  it("is not ready when the automation backlog could not be read", () => {
    const result = report({
      automation: null,
      errors: [{ source: "automation", detail: "timeout" }],
    });
    expect(result.safeToClose).toBe(false);
    expect(result.unknowns).toEqual(["automation: timeout"]);
  });

  it("does not block on peer messages waiting for an offline peer", () => {
    const result = report({ automation: { ...idleAutomation, peerOutboxPending: 5 } });
    expect(result.safeToClose).toBe(true);
    expect(result.summary.peerOutboxPending).toBe(5);
  });
});
