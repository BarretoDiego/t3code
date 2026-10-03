import { describe, expect, it } from "vite-plus/test";
import {
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { isThreadSettledForWait, resolveThreadStatus, type ThreadStatusInput } from "./thread.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);
const PREVIOUS_MESSAGE_AT = at("2026-10-02T11:30:00.000Z");
const SENT_MESSAGE_AT = at("2026-10-02T11:59:58.000Z");

const makeThread = (overrides: Partial<ThreadStatusInput> = {}): ThreadStatusInput => ({
  id: ThreadId.make("thread-1"),
  title: "Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  lineage: {
    parentThreadId: null,
    relationshipToParent: null,
    rootThreadId: ThreadId.make("thread-1"),
  },
  activityRunStatus: null,
  status: "idle",
  pendingRuntimeRequest: null,
  pendingBackgroundTasks: [],
  latestUserMessageAt: null,
  updatedAt: at("2026-10-02T11:00:00.000Z"),
  ...overrides,
});

const pendingRequest = (
  kind: NonNullable<OrchestrationV2ThreadShell["pendingRuntimeRequest"]>["kind"],
) => ({
  id: RuntimeRequestId.make("request-1"),
  kind,
  createdAt: SENT_MESSAGE_AT,
});

describe("resolveThreadStatus", () => {
  it("reads a message waiting behind the queue as queued, not completed", () => {
    const thread = makeThread({ status: "queued", latestUserMessageAt: SENT_MESSAGE_AT });
    expect(resolveThreadStatus(thread)).toBe("queued");
  });

  it("reports the active run while a later message is queued", () => {
    const thread = makeThread({ status: "queued", activityRunStatus: "running" });
    expect(resolveThreadStatus(thread)).toBe("running");
  });

  it("puts attention states ahead of activity", () => {
    const thread = makeThread({
      activityRunStatus: "running",
      status: "running",
      pendingRuntimeRequest: pendingRequest("command"),
    });
    expect(resolveThreadStatus(thread)).toBe("waiting_for_approval");
  });

  it("reports an interrupted turn", () => {
    expect(resolveThreadStatus(makeThread({ status: "interrupted" }))).toBe("interrupted");
  });
});

describe("isThreadSettledForWait", () => {
  it("does not return on the previous turn before the sent message lands", () => {
    const thread = makeThread({ status: "completed", latestUserMessageAt: PREVIOUS_MESSAGE_AT });
    expect(isThreadSettledForWait(thread, PREVIOUS_MESSAGE_AT)).toBe(false);
    expect(isThreadSettledForWait(thread)).toBe(true);
  });

  it("waits for the first message of a new thread", () => {
    expect(isThreadSettledForWait(makeThread(), null)).toBe(false);
  });

  it("keeps waiting while the agent works on the sent message", () => {
    const thread = makeThread({
      activityRunStatus: "running",
      status: "running",
      latestUserMessageAt: SENT_MESSAGE_AT,
    });
    expect(isThreadSettledForWait(thread, PREVIOUS_MESSAGE_AT)).toBe(false);
  });

  it("returns once the run for the sent message completes", () => {
    const thread = makeThread({ status: "completed", latestUserMessageAt: SENT_MESSAGE_AT });
    expect(isThreadSettledForWait(thread, PREVIOUS_MESSAGE_AT)).toBe(true);
  });

  it("returns when the agent needs input even mid-turn", () => {
    const thread = makeThread({
      activityRunStatus: "running",
      status: "running",
      latestUserMessageAt: SENT_MESSAGE_AT,
      pendingRuntimeRequest: pendingRequest("user_input"),
    });
    expect(isThreadSettledForWait(thread, PREVIOUS_MESSAGE_AT)).toBe(true);
  });

  it("returns when the run fails", () => {
    const thread = makeThread({ status: "failed", latestUserMessageAt: SENT_MESSAGE_AT });
    expect(isThreadSettledForWait(thread, PREVIOUS_MESSAGE_AT)).toBe(true);
  });
});
