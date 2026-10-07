import { DelegatedTaskId, EnvironmentId, type DelegatedTask } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveTaskState,
  renderTaskPrompt,
  taskIdFor,
  taskThreadId,
  type TaskThreadFacts,
} from "./TaskModel.ts";

const facts = (overrides: Partial<TaskThreadFacts> = {}): TaskThreadFacts => ({
  exists: true,
  latestRunStatus: "running",
  runCount: 1,
  pendingRequests: 0,
  liveSession: true,
  reply: "",
  lastError: null,
  ...overrides,
});

const task = (
  status: DelegatedTask["status"],
  overrides: Partial<Pick<DelegatedTask, "statusReason" | "result">> = {},
) => ({ status, statusReason: null, result: null, ...overrides });

describe("deriveTaskState", () => {
  it("is accepted until the first run starts, then running", () => {
    expect(
      deriveTaskState(task("pending_delivery"), facts({ latestRunStatus: null }), "live"),
    ).toEqual({ status: "accepted", statusReason: null });
    expect(
      deriveTaskState(task("accepted"), facts({ latestRunStatus: "queued" }), "live"),
    ).toBeNull();
    expect(deriveTaskState(task("accepted"), facts(), "live")?.status).toBe("running");
    // A later queued run (a follow-up, a rejection) does not send it back to accepted.
    expect(
      deriveTaskState(task("reported"), facts({ latestRunStatus: "queued" }), "live")?.status,
    ).toBe("running");
  });

  it("is blocked while the child waits on a request", () => {
    expect(deriveTaskState(task("running"), facts({ pendingRequests: 2 }), "live")).toEqual({
      status: "blocked",
      statusReason: "Waiting on 2 pending requests.",
    });
  });

  it("a completed turn is a report, never a validation", () => {
    const change = deriveTaskState(
      task("running"),
      facts({ latestRunStatus: "completed", reply: "Done." }),
      "live",
    );
    expect(change).toEqual({ status: "reported", statusReason: null, summary: "Done." });
    for (const mode of ["live", "reconcile"] as const) {
      expect(
        deriveTaskState(task("reported"), facts({ latestRunStatus: "completed" }), mode)?.status,
      ).not.toBe("validated");
    }
  });

  it("only an explicit action leaves a finished task", () => {
    for (const status of ["validated", "failed", "cancelled", "expired"] as const) {
      expect(deriveTaskState(task(status), facts(), "live")).toBeNull();
      expect(
        deriveTaskState(task(status), facts({ latestRunStatus: "completed" }), "reconcile"),
      ).toBeNull();
    }
  });

  it("a cancel is only confirmed once nothing is running", () => {
    const requested = task("cancel_requested", { statusReason: "No longer needed" });
    expect(deriveTaskState(requested, facts(), "live")).toBeNull();
    expect(
      deriveTaskState(requested, facts({ latestRunStatus: "waiting" }), "reconcile"),
    ).toBeNull();
    for (const latestRunStatus of ["interrupted", "cancelled", "completed", "failed"] as const) {
      expect(deriveTaskState(requested, facts({ latestRunStatus }), "live")).toEqual({
        status: "cancelled",
        statusReason: "No longer needed",
      });
    }
  });

  it("an interrupted run leaves the task blocked, not cancelled", () => {
    expect(
      deriveTaskState(task("running"), facts({ latestRunStatus: "interrupted" }), "live")?.status,
    ).toBe("blocked");
  });

  it("only a deliberate re-read concludes that an outcome is unknown", () => {
    const orphaned = facts({ liveSession: false });
    // The session attaches a moment after the run starts, so a live event proves nothing.
    expect(deriveTaskState(task("accepted"), orphaned, "live")?.status).toBe("running");
    expect(deriveTaskState(task("running"), orphaned, "reconcile")?.status).toBe("unknown");
    // Unknown stays unknown until the thread shows otherwise.
    expect(deriveTaskState(task("unknown", { statusReason: "x" }), orphaned, "live")?.status).toBe(
      "unknown",
    );
    expect(deriveTaskState(task("unknown"), facts(), "live")?.status).toBe("running");
    expect(
      deriveTaskState(
        task("unknown"),
        facts({ latestRunStatus: "completed", reply: "ok" }),
        "reconcile",
      )?.status,
    ).toBe("reported");
  });

  it("a deleted thread ends the task", () => {
    expect(deriveTaskState(task("running"), facts({ exists: false }), "live")?.status).toBe(
      "failed",
    );
    expect(
      deriveTaskState(task("cancel_requested"), facts({ exists: false }), "live")?.status,
    ).toBe("cancelled");
  });
});

describe("task ids", () => {
  it("follow from the origin environment and the key", () => {
    const here = EnvironmentId.make("env-a");
    expect(taskIdFor(here, "k")).toBe(taskIdFor(here, "k"));
    expect(taskIdFor(here, "k")).not.toBe(taskIdFor(here, "k2"));
    expect(taskIdFor(here, "k")).not.toBe(taskIdFor(EnvironmentId.make("env-b"), "k"));
    expect(taskThreadId(taskIdFor(here, "k"))).toBe(taskThreadId(taskIdFor(here, "k")));
  });
});

describe("renderTaskPrompt", () => {
  it("leaves out sections the contract does not have", () => {
    const prompt = renderTaskPrompt({
      taskId: DelegatedTaskId.make("task-1"),
      contract: { title: "T", objective: "O", deliverables: [], acceptanceCriteria: [] },
    });
    expect(prompt).toContain("## Objective\nO");
    expect(prompt).toContain("## How to report");
    for (const absent of [
      "## Context",
      "## Deliverables",
      "## Acceptance criteria",
      "## Deadline",
    ]) {
      expect(prompt).not.toContain(absent);
    }
  });
});
