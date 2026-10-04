import type {
  GenerationJob,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ThreadShell,
  ResourceTelemetrySnapshot,
  ScheduledTask,
  ServerPendingWorkResult,
  TerminalSummary,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import { resolveThreadStatus, type ThreadStatusInput } from "./thread.ts";

export type StatusThread = ThreadStatusInput &
  Pick<
    OrchestrationV2ThreadShell,
    | "projectId"
    | "activeRunId"
    | "worktreePath"
    | "branch"
    | "archivedAt"
    | "deletedAt"
    | "latestVisibleMessage"
    | "activityRunStartedAt"
    | "titleRegeneration"
  >;

const activeThreadStatuses = new Set(["queued", "starting", "running"]);
const activeJobStatuses = new Set(["queued", "starting", "loading", "running", "postprocessing"]);
const infrastructureCategories = new Set([
  "server",
  "electron-main",
  "electron-renderer",
  "electron-gpu",
  "electron-utility",
  "resource-monitor",
]);

/** Builds shutdown readiness from observed work; failed reads never mean an empty environment. */
export function buildStatusReport(input: {
  readonly environment: string;
  readonly at: DateTime.Utc;
  readonly threads: ReadonlyArray<StatusThread>;
  readonly projects: OrchestrationV2ShellSnapshot["projects"];
  readonly terminals: ReadonlyArray<TerminalSummary>;
  readonly scheduledTasks: ReadonlyArray<ScheduledTask>;
  readonly jobs: ReadonlyArray<GenerationJob>;
  readonly pendingWork: ServerPendingWorkResult;
  readonly telemetry: Pick<
    ResourceTelemetrySnapshot,
    "processes" | "sampleIntervalMs" | "health"
  > | null;
  readonly errors: ReadonlyArray<{ readonly source: string; readonly detail: string }>;
  readonly includeStopped: boolean;
}) {
  const projects = new Map(input.projects.map((project) => [project.id, project]));
  const blockers: string[] = [];
  const unknowns = input.errors.map((error) => `${error.source}: ${error.detail}`);
  const threads = input.threads
    .filter((thread) => thread.deletedAt === null)
    .map((thread) => {
      const status = resolveThreadStatus(thread);
      const paused = status === "waiting_for_approval" || status === "waiting_for_input";
      // A failed/attention label can conceal an activity-owning run or background command.
      const executing =
        activeThreadStatuses.has(status) ||
        (!paused && (thread.activityRunStatus != null || thread.activeRunId !== null));
      const backgroundTasks = thread.pendingBackgroundTasks ?? [];
      const busy = executing || backgroundTasks.length > 0 || thread.titleRegeneration != null;
      if (busy)
        blockers.push(
          `Thread ${thread.id}: ${status}${backgroundTasks.length > 0 ? `, ${backgroundTasks.length} background task(s)` : ""}`,
        );
      const project = projects.get(thread.projectId);
      const request = thread.pendingRuntimeRequest;
      return {
        id: thread.id,
        title: thread.title,
        status,
        busy,
        paused,
        projectId: thread.projectId,
        project: project?.title ?? null,
        workspaceRoot: project?.workspaceRoot ?? null,
        worktreePath: thread.worktreePath,
        branch: thread.branch,
        provider: thread.modelSelection.instanceId,
        model: thread.modelSelection.model,
        activeRunId: thread.activeRunId,
        startedAt:
          thread.activityRunStartedAt == null
            ? null
            : DateTime.formatIso(thread.activityRunStartedAt),
        updatedAt: DateTime.formatIso(thread.updatedAt),
        archived: thread.archivedAt !== null,
        latestMessage:
          thread.latestVisibleMessage === null
            ? null
            : {
                ...thread.latestVisibleMessage,
                text: thread.latestVisibleMessage.text.slice(0, 500),
                updatedAt: DateTime.formatIso(thread.latestVisibleMessage.updatedAt),
              },
        pendingRequest:
          request === null
            ? null
            : {
                id: request.id,
                kind: request.kind,
                createdAt: DateTime.formatIso(request.createdAt),
              },
        backgroundTasks,
        titleRegenerationPending: thread.titleRegeneration != null,
      };
    });
  const terminals = input.terminals.map((terminal) => {
    const busy = terminal.status === "starting" || terminal.hasRunningSubprocess;
    if (busy)
      blockers.push(`Terminal ${terminal.terminalId} on ${terminal.threadId}: ${terminal.label}`);
    return { ...terminal, busy };
  });
  const scheduledTasks = input.scheduledTasks
    .filter((task) => task.lastRunStatus === "running")
    .map((task) => {
      blockers.push(`Scheduled task ${task.id}: ${task.title}`);
      return {
        id: task.id,
        title: task.title,
        projectId: task.projectId,
        threadId: task.threadId,
        startedAt: task.lastRunAt,
        status: task.lastRunStatus,
      };
    });
  const jobs = input.jobs
    .filter((job) => activeJobStatuses.has(job.status))
    .map((job) => {
      blockers.push(`Compute job ${job.id}: ${job.status}`);
      return {
        id: job.id,
        status: job.status,
        operation: job.request.operation,
        providerId: job.providerId,
        projectId: job.request.context?.projectId ?? null,
        threadId: job.request.context?.threadId ?? null,
        progress: job.progress ?? null,
        startedAt: job.startedAt ?? job.createdAt,
      };
    });
  for (const effect of input.pendingWork.effects)
    blockers.push(
      `Server work ${effect.id}: ${effect.type} (${effect.status}) on ${effect.threadId}`,
    );

  const terminalPids = new Set(
    terminals.filter((terminal) => !terminal.busy).map((terminal) => terminal.pid),
  );
  const processes = (input.telemetry?.processes ?? [])
    .filter((process) => !infrastructureCategories.has(process.category))
    .map((process) => {
      // An idle terminal's shell can be stopped. An unclassified child or provider
      // process needs inspection: OS sleeping/low CPU is not proof that work ended.
      const idleShell =
        process.category === "terminal-root" &&
        terminalPids.has(process.identity.pid) &&
        process.childPids.length === 0;
      if (!idleShell)
        unknowns.push(
          `Process ${process.identity.pid} (${process.category}): ${process.command || process.name}`,
        );
      return {
        pid: process.identity.pid,
        ppid: process.ppid,
        category: process.category,
        command: process.command || process.name,
        status: process.status,
        cpuPercent: process.cpuPercent,
        residentBytes: process.residentBytes,
        elapsedMs: process.runTimeMs,
        childPids: process.childPids,
        idleShell,
      };
    });
  if (input.telemetry !== null) {
    const health = input.telemetry.health;
    if (health.native.status !== "healthy" || health.inaccessibleProcessCount > 0)
      unknowns.push(
        `Process inventory is incomplete (${health.native.status}, ${health.inaccessibleProcessCount} inaccessible process(es)).`,
      );
    const lastSample = Option.getOrNull(health.native.lastSampleAt);
    if (
      lastSample === null ||
      DateTime.toEpochMillis(input.at) - DateTime.toEpochMillis(lastSample) >
        Math.max(10_000, input.telemetry.sampleIntervalMs * 3)
    )
      unknowns.push("Process inventory has no recent sample.");
  } else if (!input.errors.some((error) => error.source === "processes"))
    unknowns.push("Process inventory is unavailable.");

  const readiness = blockers.length > 0 ? "busy" : unknowns.length > 0 ? "unknown" : "ready";
  return {
    environment: input.environment,
    at: DateTime.formatIso(input.at),
    readiness,
    safeToClose: readiness === "ready",
    blockers,
    unknowns,
    summary: {
      busyThreads: threads.filter((thread) => thread.busy).length,
      pausedThreads: threads.filter((thread) => thread.paused).length,
      stoppedThreads: threads.filter((thread) => !thread.busy && !thread.paused).length,
      busyTerminals: terminals.filter((terminal) => terminal.busy).length,
      scheduledTasks: scheduledTasks.length,
      jobs: jobs.length,
      serverWork: input.pendingWork.effects.length,
    },
    threads: threads.filter((thread) => input.includeStopped || thread.busy || thread.paused),
    terminals: terminals.filter((terminal) => input.includeStopped || terminal.busy),
    scheduledTasks,
    jobs,
    serverWork: input.pendingWork.effects,
    processes,
  };
}

export type StatusReport = ReturnType<typeof buildStatusReport>;

export function formatStatusReport(report: StatusReport): string {
  const lines = [
    `${report.environment} — ${report.readiness.toUpperCase()} — ${report.at}`,
    report.safeToClose
      ? "No work observed. Ready to close at this snapshot."
      : "Do not close: work is active or readiness could not be confirmed.",
  ];
  const summary = report.summary;
  lines.push(
    `${summary.busyThreads} busy thread(s), ${summary.pausedThreads} awaiting input, ${summary.stoppedThreads} stopped; ${summary.busyTerminals} busy terminal(s), ${summary.serverWork} server operation(s).`,
  );
  for (const thread of report.threads) {
    lines.push(
      "",
      `Thread ${thread.id} — ${thread.status}${thread.archived ? " (archived)" : ""}`,
      `  ${thread.title}`,
      `  Project: ${thread.project ?? thread.projectId}`,
      `  Workspace: ${thread.worktreePath ?? thread.workspaceRoot ?? "unknown"}`,
      `  Provider/model: ${thread.provider}/${thread.model}`,
      `  Run: ${thread.activeRunId ?? "none"}; started: ${thread.startedAt ?? "unknown"}; updated: ${thread.updatedAt}`,
    );
    if (thread.latestMessage)
      lines.push(`  Latest ${thread.latestMessage.role}: ${thread.latestMessage.text}`);
    if (thread.pendingRequest)
      lines.push(
        `  Waiting: ${thread.pendingRequest.kind} ${thread.pendingRequest.id} since ${thread.pendingRequest.createdAt}`,
      );
    for (const task of thread.backgroundTasks)
      lines.push(
        `  Background ${task.kind} ${task.taskId}: ${task.description ?? "no description"}`,
      );
    if (thread.titleRegenerationPending) lines.push("  Title regeneration is pending.");
  }
  for (const terminal of report.terminals)
    lines.push(
      "",
      `Terminal ${terminal.terminalId} — ${terminal.busy ? "BUSY" : terminal.status} — PID ${terminal.pid ?? "none"}`,
      `  Thread: ${terminal.threadId}; command: ${terminal.label}`,
      `  Workspace: ${terminal.cwd}; updated: ${terminal.updatedAt}`,
    );
  for (const task of report.scheduledTasks)
    lines.push(
      "",
      `Scheduled task ${task.id}: ${task.title} — running since ${task.startedAt ?? "unknown"}; thread ${task.threadId ?? "new thread"}`,
    );
  for (const job of report.jobs)
    lines.push(
      "",
      `Job ${job.id}: ${job.operation} — ${job.status}; provider ${job.providerId}; progress ${job.progress ?? "unknown"}; thread ${job.threadId ?? "none"}`,
    );
  for (const work of report.serverWork)
    lines.push(
      "",
      `Server work ${work.id}: ${work.type} — ${work.status}; thread ${work.threadId}; updated ${work.updatedAt}${work.lastError ? `; last error: ${work.lastError}` : ""}`,
    );
  for (const process of report.processes)
    lines.push(
      "",
      `Process ${process.pid} (${process.category}, parent ${process.ppid}) — ${process.status}${process.idleShell ? ", idle shell" : ""}`,
      `  ${process.command}`,
      `  CPU ${process.cpuPercent.toFixed(1)}%; memory ${Math.round(process.residentBytes / 1024 / 1024)} MiB; elapsed ${Math.round(process.elapsedMs / 1000)}s; children ${process.childPids.join(", ") || "none"}`,
    );
  if (report.unknowns.length > 0)
    lines.push("", "Unconfirmed:", ...report.unknowns.map((detail) => `  ${detail}`));
  if (!report.safeToClose)
    lines.push(
      "",
      "Inspect with t3 thread show <id> or t3 terminal read <thread>. Stop work explicitly with t3 thread interrupt/stop or t3 terminal close, then run t3 status --check again.",
    );
  return lines.join("\n");
}
