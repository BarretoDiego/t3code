import { ProviderInstanceId, RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { resolveSubthreadStatusLabel } from "./models.ts";

describe("persistent subthread status", () => {
  const now = "2026-10-09T00:00:00.000Z";
  const base = {
    runtime: null,
    latestRun: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingBackgroundTasks: [],
    archivedAt: null,
    settledOverride: null,
    snoozedAt: null,
    snoozedUntil: null,
  };
  const runtime = {
    status: "idle" as const,
    activeRunId: null,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: "Codex",
    lastError: null,
    updatedAt: now,
  };

  it.each([
    ["idle", "Idle"],
    ["preparing", "Preparing"],
    ["queued", "Queued"],
    ["starting", "Starting"],
    ["running", "Working"],
    ["waiting", "Waiting"],
    ["completed", "Completed"],
    ["interrupted", "Interrupted"],
    ["failed", "Failed"],
    ["cancelled", "Cancelled"],
    ["rolled_back", "Rolled back"],
  ] as const)("keeps %s visible even without unread activity", (status, label) => {
    expect(resolveSubthreadStatusLabel({ ...base, runtime: { ...runtime, status } }, now)).toBe(
      label,
    );
  });

  it.each(["completed", "failed", "interrupted", "cancelled", "rolled_back"] as const)(
    "retains a %s result when the runtime becomes idle or absent and the user reads it",
    (status) => {
      const latestRun = {
        runId: RunId.make("child-run"),
        status,
        requestedAt: null,
        startedAt: null,
        completedAt: null,
        assistantMessageId: null,
      };
      const finished = { ...base, latestRun, runtime: { ...runtime, status }, lastVisitedAt: now };
      const label = resolveSubthreadStatusLabel(finished, now);
      expect(resolveSubthreadStatusLabel({ ...finished, runtime }, now)).toBe(label);
      expect(resolveSubthreadStatusLabel({ ...finished, runtime: null }, now)).toBe(label);
    },
  );

  it("prioritizes requests for approval or input and clears them as execution resumes", () => {
    const working = { ...base, runtime: { ...runtime, status: "running" as const } };
    expect(
      resolveSubthreadStatusLabel(
        { ...working, hasPendingApprovals: true, hasPendingUserInput: true },
        now,
      ),
    ).toBe("Pending Approval");
    expect(resolveSubthreadStatusLabel({ ...working, hasPendingUserInput: true }, now)).toBe(
      "Awaiting Input",
    );
    expect(resolveSubthreadStatusLabel(working, now)).toBe("Working");
  });

  it("shows lifecycle and execution independently and removes lifecycle badges on restore", () => {
    const working = { ...base, runtime: { ...runtime, status: "running" as const } };
    expect(resolveSubthreadStatusLabel({ ...working, settledOverride: "settled" }, now)).toBe(
      "Working · Settled",
    );
    expect(
      resolveSubthreadStatusLabel({ ...working, settledOverride: "settled", archivedAt: now }, now),
    ).toBe("Working · Archived");
    expect(resolveSubthreadStatusLabel(working, now)).toBe("Working");
    expect(
      resolveSubthreadStatusLabel(
        { ...base, runtime: { ...runtime, status: "failed" }, archivedAt: now },
        now,
      ),
    ).toBe("Failed · Archived");
  });

  it("shows snooze until its boundary, while a request for input wakes the thread", () => {
    const snoozed = { ...base, runtime, snoozedAt: now, snoozedUntil: "2026-10-09T01:00:00.000Z" };
    expect(resolveSubthreadStatusLabel(snoozed, now)).toBe("Idle · Snoozed");
    expect(resolveSubthreadStatusLabel(snoozed, snoozed.snoozedUntil)).toBe("Idle");
    expect(resolveSubthreadStatusLabel({ ...snoozed, hasPendingUserInput: true }, now)).toBe(
      "Awaiting Input",
    );
  });

  it("does not resurrect stale running work when an idle runtime is authoritative", () => {
    const latestRun = {
      runId: RunId.make("stale-run"),
      status: "running" as const,
      requestedAt: now,
      startedAt: now,
      completedAt: null,
      assistantMessageId: null,
    };
    expect(resolveSubthreadStatusLabel({ ...base, latestRun, runtime }, now)).toBe("Idle");
    expect(resolveSubthreadStatusLabel({ ...base, latestRun, runtime: null }, now)).toBe("Working");
  });

  it("labels a child without a runtime or run as idle", () => {
    expect(resolveSubthreadStatusLabel({ ...base, runtime: null, latestRun: null }, now)).toBe(
      "Idle",
    );
  });
  it("keeps background work waiting without masking failed or cancelled results", () => {
    const pendingBackgroundTasks = [{ taskId: "monitor", kind: "monitor" as const }];
    const waiting = { ...base, pendingBackgroundTasks };
    expect(resolveSubthreadStatusLabel(waiting, now)).toBe("Waiting");
    expect(
      resolveSubthreadStatusLabel({ ...waiting, runtime: { ...runtime, status: "failed" } }, now),
    ).toBe("Failed");
    expect(
      resolveSubthreadStatusLabel(
        { ...waiting, runtime: { ...runtime, status: "cancelled" } },
        now,
      ),
    ).toBe("Cancelled");
  });
});
