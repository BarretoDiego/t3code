import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  type DomainEventMappingContext,
  JOURNAL_TOOL_CALLED_EVENTS,
  mapDomainEvents,
} from "./domainEventMapping.ts";
import {
  makeChildThread,
  makeRequest,
  makeRun,
  makeThread,
  PROJECT_ID,
  requestEvent,
  runEvent,
  threadEvent,
} from "./domainEvents.testkit.ts";

const emptyContext: DomainEventMappingContext = {
  threads: new Map(),
  runStatuses: new Map(),
  requestStatuses: new Map(),
};

const parent = makeThread("thread-parent");
const child = makeChildThread("thread-child", parent);
const childScope = {
  projectId: PROJECT_ID,
  parentThreadId: parent.id,
  rootThreadId: parent.id,
};
const withChild: DomainEventMappingContext = {
  ...emptyContext,
  threads: new Map([[child.id, childScope]]),
};

const typesOf = (events: ReadonlyArray<OrchestrationV2DomainEvent>, context = emptyContext) =>
  mapDomainEvents(events, context).map((event) => event.type);

describe("mapDomainEvents", () => {
  it("maps thread creation with its lineage and project in the scope", () => {
    const [created] = mapDomainEvents([threadEvent("thread.created", child)], emptyContext);
    assert.strictEqual(created?.type, "thread.created");
    assert.deepStrictEqual(created?.scope, { threadId: child.id, ...childScope });
    assert.deepStrictEqual(created?.aggregate, { kind: "thread", id: child.id });
    assert.strictEqual(created?.payload.relationshipToParent, "subagent");
    assert.strictEqual(created?.occurredAt, "2026-01-01T00:00:00.000Z");

    // A root thread has no parent to name.
    const [root] = mapDomainEvents([threadEvent("thread.created", parent)], emptyContext);
    assert.deepStrictEqual(root?.scope, {
      threadId: parent.id,
      projectId: PROJECT_ID,
      rootThreadId: parent.id,
    });
  });

  it("names each organization change and maps deletion separately", () => {
    const changes = (
      [
        "thread.settled",
        "thread.unsettled",
        "thread.snoozed",
        "thread.unsnoozed",
        "thread.pinned",
        "thread.unpinned",
        "thread.archived",
        "thread.unarchived",
      ] as const
    ).map((type) => {
      const [mapped] = mapDomainEvents([threadEvent(type, parent)], emptyContext);
      return [mapped?.type, mapped?.payload.change];
    });
    assert.deepStrictEqual(
      changes,
      [
        "settled",
        "unsettled",
        "snoozed",
        "unsnoozed",
        "pinned",
        "unpinned",
        "archived",
        "unarchived",
      ].map((change) => ["thread.organized", change]),
    );

    const snoozedUntil = DateTime.makeUnsafe("2026-02-01T00:00:00.000Z");
    const [snoozed] = mapDomainEvents(
      [threadEvent("thread.snoozed", { ...parent, snoozedUntil })],
      emptyContext,
    );
    assert.strictEqual(snoozed?.payload.snoozedUntil, "2026-02-01T00:00:00.000Z");

    assert.deepStrictEqual(typesOf([threadEvent("thread.deleted", parent)]), ["thread.deleted"]);
  });

  it("ignores thread changes nothing can act on", () => {
    assert.deepStrictEqual(
      typesOf([
        threadEvent("thread.visited", parent),
        threadEvent("thread.metadata-updated", parent),
        threadEvent("thread.pin-reordered", parent),
        threadEvent("thread.model-selection-updated", parent),
      ]),
      [],
    );
  });

  it("emits one turn event per phase change, however often the run is restated", () => {
    const events = [
      runEvent("run.created", makeRun("run-1", child, "queued")),
      runEvent("run.updated", makeRun("run-1", child, "starting")),
      runEvent("run.updated", makeRun("run-1", child, "running")),
      runEvent("run.updated", makeRun("run-1", child, "running")),
      runEvent("run.updated", makeRun("run-1", child, "waiting")),
      runEvent("run.updated", makeRun("run-1", child, "running")),
      runEvent("run.updated", makeRun("run-1", child, "completed")),
      runEvent("run.updated", makeRun("run-1", child, "completed")),
      runEvent("run.updated", makeRun("run-1", child, "rolled_back")),
    ];
    const mapped = mapDomainEvents(events, withChild);
    assert.deepStrictEqual(
      mapped.map((event) => [event.type, event.payload.status, event.payload.previousStatus]),
      [
        ["turn.started", "running", "starting"],
        ["turn.completed", "completed", "running"],
      ],
    );
    assert.deepStrictEqual(mapped[1]?.scope, {
      threadId: child.id,
      ...childScope,
      runId: makeRun("run-1", child, "completed").id,
    });
    assert.deepStrictEqual(mapped[1]?.aggregate, { kind: "thread", id: child.id });
  });

  it("compares a run with the status the projection held before the batch", () => {
    const running = makeRun("run-1", child, "running");
    const known: DomainEventMappingContext = {
      ...withChild,
      runStatuses: new Map([[running.id, "running"]]),
    };
    // Restating a status already recorded is not a transition.
    assert.deepStrictEqual(typesOf([runEvent("run.updated", running)], known), []);
    assert.deepStrictEqual(
      typesOf([runEvent("run.updated", makeRun("run-1", child, "failed"))], known),
      ["turn.failed"],
    );
    // Interrupting and cancelling both end the turn without a result.
    assert.deepStrictEqual(
      typesOf([runEvent("run.updated", makeRun("run-1", child, "interrupted"))], known),
      ["turn.interrupted"],
    );
    assert.deepStrictEqual(
      typesOf([runEvent("run.updated", makeRun("run-1", child, "cancelled"))], known),
      ["turn.interrupted"],
    );
    // A run that ends without ever being seen running still reports its end.
    assert.deepStrictEqual(
      typesOf([runEvent("run.created", makeRun("run-2", child, "completed"))], withChild),
      ["turn.completed"],
    );
    // A run requeued after starting starts again.
    assert.deepStrictEqual(
      typesOf(
        [
          runEvent("run.updated", makeRun("run-1", child, "queued")),
          runEvent("run.updated", makeRun("run-1", child, "running")),
        ],
        known,
      ),
      ["turn.started"],
    );
  });

  it("keeps runs of different threads apart", () => {
    assert.deepStrictEqual(
      mapDomainEvents(
        [
          runEvent("run.created", makeRun("run-a", parent, "running")),
          runEvent("run.created", makeRun("run-b", child, "running")),
          runEvent("run.updated", makeRun("run-a", parent, "completed")),
        ],
        withChild,
      ).map((event) => [event.type, event.scope.threadId]),
      [
        ["turn.started", parent.id],
        ["turn.started", child.id],
        ["turn.completed", parent.id],
      ],
    );
  });

  it("reports a request opening once and its resolution once, with what settled it", () => {
    const mapped = mapDomainEvents(
      [
        requestEvent(child, makeRequest("request-1", "pending", { kind: "command" }), "run-1"),
        requestEvent(child, makeRequest("request-1", "pending", { kind: "command" })),
        requestEvent(
          child,
          makeRequest("request-1", "resolved", { kind: "command", decision: "accept" }),
        ),
        requestEvent(
          child,
          makeRequest("request-1", "resolved", { kind: "command", decision: "accept" }),
        ),
      ],
      withChild,
    );
    assert.deepStrictEqual(
      mapped.map((event) => event.type),
      ["request.opened", "request.resolved"],
    );
    const [opened, resolved] = mapped;
    assert.deepStrictEqual(opened?.payload, {
      kind: "command",
      status: "pending",
      responseCapability: "message",
    });
    assert.deepStrictEqual(opened?.scope, {
      threadId: child.id,
      ...childScope,
      requestId: makeRequest("request-1", "pending").id,
      runId: makeRun("run-1", child, "running").id,
    });
    assert.deepStrictEqual(opened?.aggregate, { kind: "request", id: "request-1" });
    assert.deepStrictEqual(resolved?.payload, {
      kind: "command",
      status: "resolved",
      responseCapability: "message",
      resolvedAt: "2026-01-01T00:00:00.000Z",
      decision: "accept",
      answered: false,
    });
  });

  it("reports expiry and cancellation as resolutions, and never the answers", () => {
    const pending = makeRequest("request-1", "pending");
    const known: DomainEventMappingContext = {
      ...withChild,
      requestStatuses: new Map([[pending.id, "pending"]]),
    };
    for (const status of ["expired", "cancelled"] as const) {
      const [mapped] = mapDomainEvents(
        [requestEvent(child, makeRequest("request-1", status))],
        known,
      );
      assert.deepStrictEqual([mapped?.type, mapped?.payload.status], ["request.resolved", status]);
    }
    const [answered] = mapDomainEvents(
      [
        requestEvent(
          child,
          makeRequest("request-1", "resolved", { answers: { question: "a secret" } }),
        ),
      ],
      known,
    );
    assert.strictEqual(answered?.payload.answered, true);
    assert.notInclude(JSON.stringify(answered), "a secret");

    // Restating a request that was already closed says nothing new.
    const closed: DomainEventMappingContext = {
      ...withChild,
      requestStatuses: new Map([[pending.id, "resolved"]]),
    };
    assert.deepStrictEqual(
      typesOf([requestEvent(child, makeRequest("request-1", "cancelled"))], closed),
      [],
    );
  });

  it("does not journal message, node or turn-item deltas, and tool calls only on request", () => {
    const at = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
    const item: OrchestrationV2TurnItem = {
      id: TurnItemId.make("item-1"),
      threadId: child.id,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed",
      title: "ls",
      startedAt: at,
      completedAt: at,
      updatedAt: at,
      type: "command_execution",
      input: "ls",
    };
    const events: ReadonlyArray<OrchestrationV2DomainEvent> = [
      {
        id: EventId.make("message-event"),
        type: "message.updated",
        threadId: child.id,
        occurredAt: at,
        payload: {
          createdBy: "agent",
          creationSource: "provider",
          id: MessageId.make("message-1"),
          threadId: child.id,
          runId: null,
          nodeId: null,
          role: "assistant",
          text: "hello",
          attachments: [],
          streaming: true,
          createdAt: at,
          updatedAt: at,
        },
      },
      {
        id: EventId.make("item-event"),
        type: "turn-item.updated",
        threadId: child.id,
        occurredAt: at,
        payload: item,
      },
    ];
    assert.isFalse(JOURNAL_TOOL_CALLED_EVENTS);
    assert.deepStrictEqual(typesOf(events, withChild), []);

    const opted = mapDomainEvents(events, withChild, { toolCalled: true });
    assert.deepStrictEqual(
      opted.map((event) => [event.type, event.dedupKey]),
      [["tool.called", "tool.called:item-1"]],
    );
  });
});
