import { describe, expect, it } from "vite-plus/test";
import {
  MessageId,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  conversationMessages,
  isThreadSettledForWait,
  resolveThreadStatus,
  type ThreadStatusInput,
} from "./thread.ts";

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
  settledOverride: null,
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

describe("conversationMessages", () => {
  const message = (
    id: number,
    role: OrchestrationV2ConversationMessage["role"],
  ): OrchestrationV2ConversationMessage => ({
    id: MessageId.make(`message-${id}`),
    threadId: ThreadId.make("thread-1"),
    runId: null,
    nodeId: null,
    createdBy: "user",
    creationSource: "server",
    role,
    text: `Text ${id}`,
    attachments: [],
    streaming: false,
    createdAt: SENT_MESSAGE_AT,
    updatedAt: SENT_MESSAGE_AT,
  });

  it("counts messages independently of turns and excludes system messages", () => {
    const projection = {
      messages: [
        message(0, "user"),
        message(1, "assistant"),
        message(2, "user"),
        message(3, "assistant"),
        message(4, "assistant"),
        message(5, "system"),
      ],
      turnItems: [],
    };
    expect(conversationMessages(projection, 1).map((entry) => entry.id)).toEqual([
      "message-2",
      "message-3",
      "message-4",
    ]);
    expect(conversationMessages(projection, 1, 2).map((entry) => entry.id)).toEqual([
      "message-3",
      "message-4",
    ]);
    expect(conversationMessages(projection, 1, 10)).toHaveLength(5);
    expect(conversationMessages(projection, 1, 0)).toEqual([]);
    expect(conversationMessages({ messages: [], turnItems: [] }, 1, 10)).toEqual([]);
  });

  it("handles a message count larger than one call can spread", () => {
    const messages = Array.from({ length: 200_000 }, (_, index) => message(index, "assistant"));
    const result = conversationMessages({ messages, turnItems: [] }, 1, 200_000);
    expect(result).toHaveLength(200_000);
    expect(result[0]?.id).toBe("message-0");
    expect(result.at(-1)?.id).toBe("message-199999");
  });
});
