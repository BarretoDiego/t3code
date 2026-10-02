import { describe, expect, it } from "vite-plus/test";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";

import { isThreadSettledForWait, resolveThreadStatus } from "./thread.ts";

const NOW = "2026-10-02T12:00:00.000Z";
const SENT_AT = "2026-10-02T11:59:58.000Z";

const makeThread = (
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell => ({
  id: ThreadId.make("thread-1"),
  projectId: ProjectId.make("project-1"),
  title: "Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  pullRequests: [],
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-10-02T11:00:00.000Z",
  updatedAt: "2026-10-02T11:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  ...overrides,
});

const session = (status: NonNullable<OrchestrationThreadShell["session"]>["status"]) => ({
  threadId: ThreadId.make("thread-1"),
  status,
  providerName: "codex",
  runtimeMode: "full-access" as const,
  activeTurnId: null,
  lastError: null,
  updatedAt: NOW,
});

const completedTurn = (at: string) => ({
  turnId: TurnId.make("turn-1"),
  state: "completed" as const,
  requestedAt: at,
  startedAt: at,
  completedAt: at,
  assistantMessageId: null,
});

describe("resolveThreadStatus", () => {
  it("reads a sent message the agent has not picked up as queued, not completed", () => {
    const thread = makeThread({
      session: session("ready"),
      latestTurn: completedTurn("2026-10-02T11:30:00.000Z"),
      latestUserMessageAt: SENT_AT,
    });
    expect(resolveThreadStatus(thread, NOW)).toBe("queued");
  });

  it("puts attention states ahead of activity", () => {
    const thread = makeThread({ session: session("running"), hasPendingApprovals: true });
    expect(resolveThreadStatus(thread, NOW)).toBe("waiting_for_approval");
  });

  it("reports an interrupted turn that never completed", () => {
    const thread = makeThread({
      session: session("interrupted"),
      latestTurn: { ...completedTurn(SENT_AT), state: "interrupted", completedAt: null },
    });
    expect(resolveThreadStatus(thread, NOW)).toBe("interrupted");
  });
});

describe("isThreadSettledForWait", () => {
  it("does not return on the previous turn before the sent message lands", () => {
    const thread = makeThread({
      session: session("ready"),
      latestTurn: completedTurn("2026-10-02T11:30:00.000Z"),
      latestUserMessageAt: "2026-10-02T11:30:00.000Z",
    });
    expect(isThreadSettledForWait(thread, NOW, SENT_AT)).toBe(false);
    expect(isThreadSettledForWait(thread, NOW)).toBe(true);
  });

  it("keeps waiting while the agent works on the sent message", () => {
    const thread = makeThread({ session: session("running"), latestUserMessageAt: SENT_AT });
    expect(isThreadSettledForWait(thread, NOW, SENT_AT)).toBe(false);
  });

  it("returns once the turn for the sent message completes", () => {
    const thread = makeThread({
      session: session("ready"),
      latestTurn: completedTurn("2026-10-02T11:59:59.000Z"),
      latestUserMessageAt: SENT_AT,
    });
    expect(isThreadSettledForWait(thread, NOW, SENT_AT)).toBe(true);
  });

  it("returns when the agent needs input even mid-turn", () => {
    const thread = makeThread({
      session: session("running"),
      latestUserMessageAt: SENT_AT,
      hasPendingUserInput: true,
    });
    expect(isThreadSettledForWait(thread, NOW, SENT_AT)).toBe(true);
  });

  it("returns when the session fails", () => {
    const thread = makeThread({ session: session("error"), latestUserMessageAt: SENT_AT });
    expect(isThreadSettledForWait(thread, NOW, SENT_AT)).toBe(true);
  });
});
