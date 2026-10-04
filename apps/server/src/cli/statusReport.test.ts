import { describe, expect, it } from "vite-plus/test";
import {
  MessageId,
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
const base = {
  environment: "Local",
  at,
  threads: [],
  projects: [],
  terminals: [],
  scheduledTasks: [],
  jobs: [],
  pendingWork: { effects: [] },
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
