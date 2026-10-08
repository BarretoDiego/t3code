import {
  AutomationErrorCode,
  DelegatedTaskStatus,
  type DelegatedTask,
  DelegatedTaskId,
  EnvironmentId,
  EventId,
  HookDeliveryStatus,
  type InboxEntry,
  InboxEntryId,
  InboxEntryStatus,
  JobStatus,
  type Orchestrator,
  OrchestratorEffectiveState,
  OrchestratorId,
  PeerConnectionStatus,
  type PendingRequestSummary,
  ProjectId,
  ProviderInstanceId,
  type ResponsibilityClaim,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  applyAutomationChange,
  AUTOMATION_STALE_AFTER_MS,
  automationChangeKinds,
  automationEventLabel,
  buildOrchestratorThreadIndex,
  buildOrchestratorViews,
  buildThreadResponsibilityIndex,
  EMPTY_AUTOMATION_CHANGE_COUNTERS,
  environmentSupportsAutomation,
  formatAutomationAge,
  hookSuppressedReasonLabel,
  joinOrchestratorsToThreads,
  orchestratorStateActions,
  presentAutomationActivity,
  presentAutomationError,
  presentDelegatedTasks,
  presentDelegatedTaskStatus,
  presentHookDeliveryStatus,
  presentInboxEntryStatus,
  presentJobStatus,
  presentNodeAvailability,
  presentObservation,
  presentOrchestratorBudget,
  presentOrchestratorState,
  presentPeerConnectionStatus,
  presentResponsibility,
  resolveEnvironmentReachability,
  resolveOrchestratorView,
  type ResponsibilityLookup,
  summarizeOrchestratorInbox,
} from "./automationPresentation.ts";

const laptop = EnvironmentId.make("laptop");
const buildBox = EnvironmentId.make("build-box");
const NOW = Date.parse("2026-10-07T12:00:00.000Z");
const at = (offsetMs: number) => DateTime.formatIso(DateTime.makeUnsafe(NOW + offsetMs));

function orchestrator(overrides: Partial<Orchestrator> = {}): Orchestrator {
  return {
    id: OrchestratorId.make("main"),
    version: 1,
    revision: 3,
    name: "Release captain",
    scope: "local",
    projectId: ProjectId.make("project-1"),
    modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "sonnet" },
    runtimeMode: "approval-required",
    instructions: "",
    permissions: { actions: ["thread.read"] },
    budget: {
      maxTokens: 1_000,
      maxTurnsPerTask: 12,
      maxTurnsPerHour: 30,
      maxConcurrentChildren: 3,
      maxChildrenPerTask: null,
      maxTaskAttempts: 2,
      maxTurnDurationMs: 900_000,
    },
    responsibilityOrder: ["user"],
    batchWindowMs: 15_000,
    hostEnvironmentId: laptop,
    hostGeneration: 1,
    threadId: ThreadId.make("thread-main"),
    desiredState: "active",
    effectiveState: "idle",
    stateReason: null,
    inboxPending: 0,
    usage: {
      tokens: 400,
      tokensComplete: true,
      turns: 9,
      turnsLastHour: 2,
      activeChildren: 1,
      since: at(-3_600_000),
    },
    lastTurnAt: null,
    lastCheckpointAt: null,
    observedAt: at(0),
    createdAt: at(-86_400_000),
    updatedAt: at(0),
    ...overrides,
  };
}

describe("status presentation", () => {
  const cases = [
    ["orchestrator state", OrchestratorEffectiveState.literals, presentOrchestratorState],
    ["delegated task status", DelegatedTaskStatus.literals, presentDelegatedTaskStatus],
    ["job status", JobStatus.literals, presentJobStatus],
    ["hook delivery status", HookDeliveryStatus.literals, presentHookDeliveryStatus],
    ["peer connection status", PeerConnectionStatus.literals, presentPeerConnectionStatus],
    ["inbox entry status", InboxEntryStatus.literals, presentInboxEntryStatus],
    ["node availability", ["available", "unavailable", "unknown"], presentNodeAvailability],
  ] as const;

  it.each(cases)("knows every %s the contract defines", (name, literals, present) => {
    for (const literal of literals) {
      const presentation = present(literal);
      expect(presentation.known, `${name} ${literal}`).toBe(true);
      expect(presentation.key).toBe(literal);
      expect(presentation.label.length).toBeGreaterThan(0);
      expect(presentation.icon).not.toBe("generic");
    }
  });

  it.each(cases)(
    "shows a %s from a newer server as a generic label",
    (_name, _literals, present) => {
      expect(present("quarantined_by_policy")).toEqual({
        key: "quarantined_by_policy",
        label: "Quarantined by policy",
        icon: "generic",
        severity: "neutral",
        description: null,
        known: false,
      });
      expect(present("").label).toBe("Unknown");
    },
  );

  it("keeps an unknown outcome apart from failed and from done", () => {
    for (const present of [presentDelegatedTaskStatus, presentJobStatus, presentInboxEntryStatus]) {
      const unknown = present("unknown");
      expect(unknown.severity).toBe("unknown");
      expect(unknown.icon).toBe("unknown");
      expect(unknown.label).toBe("Outcome unknown");
    }
    expect(presentJobStatus("failed").severity).toBe("error");
    expect(presentJobStatus("succeeded").severity).toBe("success");
    expect(
      new Set(["unknown", "failed", "succeeded"].map((s) => presentJobStatus(s).icon)).size,
    ).toBe(3);
  });

  it("keeps reported apart from validated", () => {
    const reported = presentDelegatedTaskStatus("reported");
    const validated = presentDelegatedTaskStatus("validated");
    expect(reported.label).toBe("Reported");
    expect(validated.label).toBe("Validated");
    expect(reported.icon).not.toBe(validated.icon);
    expect(reported.severity).not.toBe("success");
    expect(validated.severity).toBe("success");
  });

  it("never signals a state by severity alone", () => {
    const labels = OrchestratorEffectiveState.literals.map(
      (state) => presentOrchestratorState(state).label,
    );
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("labels why a delivery was suppressed, including reasons it has not seen", () => {
    expect(hookSuppressedReasonLabel(null)).toBeNull();
    expect(hookSuppressedReasonLabel("hop_limit")).toBe("it would loop");
    expect(hookSuppressedReasonLabel("rate_shaped")).toBe("rate shaped");
  });
});

describe("environmentSupportsAutomation", () => {
  it("is true only when the descriptor says so", () => {
    expect(environmentSupportsAutomation(null)).toBe(false);
    expect(environmentSupportsAutomation(undefined)).toBe(false);
    expect(environmentSupportsAutomation({ environment: { capabilities: {} } })).toBe(false);
    expect(
      environmentSupportsAutomation({ environment: { capabilities: { automation: false } } }),
    ).toBe(false);
    expect(
      environmentSupportsAutomation({ environment: { capabilities: { automation: true } } }),
    ).toBe(true);
  });
});

describe("orchestrators joined to threads", () => {
  it("marks the main thread of an orchestrator in the environment that reported it", () => {
    const index = buildOrchestratorThreadIndex([
      { environmentId: laptop, orchestrators: [orchestrator({ effectiveState: "running" })] },
    ]);
    const marker = index.markerByThreadKey.get("laptop:thread-main");
    expect(marker).toMatchObject({
      environmentId: laptop,
      orchestratorId: "main",
      name: "Release captain",
      scopeLabel: "Local",
      hostedHere: true,
      hostEnvironmentId: laptop,
      model: "sonnet",
      accessibleLabel: "Local orchestrator Release captain: Running",
    });
    expect(marker?.state.label).toBe("Running");
    expect(index.viewByThreadKey.get("laptop:thread-main")?.orchestrator.id).toBe("main");
    // The same thread id in another environment is a different thread.
    expect(index.markerByThreadKey.has("build-box:thread-main")).toBe(false);
  });

  it("marks nothing for a projection that has no thread here", () => {
    const projected = orchestrator({
      hostEnvironmentId: buildBox,
      threadId: null,
      effectiveState: "not_hosted_here",
    });
    const index = buildOrchestratorThreadIndex([
      { environmentId: laptop, orchestrators: [projected] },
    ]);
    expect(index.markerByThreadKey.size).toBe(0);
    const [view] = buildOrchestratorViews([{ environmentId: laptop, orchestrators: [projected] }]);
    expect(view).toMatchObject({ hostedHere: false, threadKey: null, key: "laptop:main" });
  });

  it("keeps a projection that does carry a thread, flagged as not hosted here", () => {
    const index = buildOrchestratorThreadIndex([
      {
        environmentId: laptop,
        orchestrators: [
          orchestrator({ hostEnvironmentId: buildBox, effectiveState: "not_hosted_here" }),
        ],
      },
    ]);
    expect(index.markerByThreadKey.get("laptop:thread-main")).toMatchObject({
      hostedHere: false,
      hostEnvironmentId: buildBox,
    });
  });

  it("keeps the newest copy when a list repeats an orchestrator", () => {
    const views = buildOrchestratorViews([
      {
        environmentId: laptop,
        orchestrators: [
          orchestrator({ revision: 5, name: "New" }),
          orchestrator({ revision: 4, name: "Old" }),
        ],
      },
    ]);
    expect(views).toHaveLength(1);
    expect(views[0]?.orchestrator.name).toBe("New");
  });

  it("gives a thread claimed twice to the orchestrator hosted there, whatever the order", () => {
    const hosted = orchestrator({ id: OrchestratorId.make("hosted"), revision: 1 });
    const projected = orchestrator({
      id: OrchestratorId.make("projected"),
      revision: 9,
      hostEnvironmentId: buildBox,
    });
    for (const orchestrators of [
      [hosted, projected],
      [projected, hosted],
    ]) {
      const index = buildOrchestratorThreadIndex([{ environmentId: laptop, orchestrators }]);
      expect(index.markerByThreadKey.get("laptop:thread-main")?.orchestratorId).toBe("hosted");
    }
  });

  it("reuses markers that did not change so their rows do not re-render", () => {
    const first = buildOrchestratorThreadIndex([
      { environmentId: laptop, orchestrators: [orchestrator()] },
    ]);
    // A fresh snapshot with a new timestamp and usage but nothing a row draws.
    const second = buildOrchestratorThreadIndex(
      [
        {
          environmentId: laptop,
          orchestrators: [orchestrator({ observedAt: at(5_000), updatedAt: at(5_000) })],
        },
      ],
      first,
    );
    expect(second.markerByThreadKey).toBe(first.markerByThreadKey);
    expect(second.viewByThreadKey.get("laptop:thread-main")?.orchestrator.observedAt).toBe(
      at(5_000),
    );

    const third = buildOrchestratorThreadIndex(
      [{ environmentId: laptop, orchestrators: [orchestrator({ effectiveState: "paused" })] }],
      second,
    );
    expect(third.markerByThreadKey).not.toBe(second.markerByThreadKey);
    expect(third.markerByThreadKey.get("laptop:thread-main")?.state.label).toBe("Paused");

    const removed = buildOrchestratorThreadIndex(
      [{ environmentId: laptop, orchestrators: [] }],
      third,
    );
    expect(removed.markerByThreadKey.size).toBe(0);
  });

  it("lists an environment's orchestrators beside their threads", () => {
    const rows = joinOrchestratorsToThreads({
      snapshot: {
        environmentId: laptop,
        orchestrators: [
          orchestrator({ id: OrchestratorId.make("b"), name: "beta" }),
          orchestrator({
            id: OrchestratorId.make("a"),
            name: "Alpha",
            threadId: ThreadId.make("gone"),
          }),
          orchestrator({
            id: OrchestratorId.make("c"),
            name: "gamma",
            threadId: null,
            hostEnvironmentId: buildBox,
          }),
        ],
      },
      threads: [
        { environmentId: laptop, id: "thread-main", title: "Main" },
        // Same id, other environment: must not be picked up.
        { environmentId: buildBox, id: "gone", title: "Elsewhere" },
      ],
    });
    expect(
      rows.map((row) => [row.view.orchestrator.name, row.threadLink, row.thread?.title]),
    ).toEqual([
      ["Alpha", "missing", undefined],
      ["beta", "linked", "Main"],
      ["gamma", "none", undefined],
    ]);
  });

  it("resolves an orchestrator named from elsewhere to its host's copy", () => {
    const views = buildOrchestratorViews([
      {
        environmentId: laptop,
        orchestrators: [orchestrator({ hostEnvironmentId: buildBox, name: "stale", revision: 9 })],
      },
      {
        environmentId: buildBox,
        orchestrators: [orchestrator({ hostEnvironmentId: buildBox, name: "host", revision: 2 })],
      },
    ]);
    expect(resolveOrchestratorView(views, "main", buildBox)?.orchestrator.name).toBe("host");
    expect(resolveOrchestratorView(views, "main")?.orchestrator.name).toBe("host");
    expect(resolveOrchestratorView(views, "missing", buildBox)).toBeNull();
    // Only a projection is loaded: use it rather than nothing.
    expect(resolveOrchestratorView(views.slice(0, 1), "main", buildBox)?.orchestrator.name).toBe(
      "stale",
    );
  });

  it("offers state changes only where the orchestrator is hosted", () => {
    const [hosted] = buildOrchestratorViews([
      { environmentId: laptop, orchestrators: [orchestrator({ effectiveState: "running" })] },
    ]);
    expect(orchestratorStateActions(hosted!)).toEqual({
      canPause: true,
      canResume: false,
      canDisable: true,
      canInterruptTurn: true,
    });
    const [paused] = buildOrchestratorViews([
      {
        environmentId: laptop,
        orchestrators: [orchestrator({ desiredState: "paused", effectiveState: "paused" })],
      },
    ]);
    expect(orchestratorStateActions(paused!)).toEqual({
      canPause: false,
      canResume: true,
      canDisable: true,
      canInterruptTurn: false,
    });
    const [projection] = buildOrchestratorViews([
      { environmentId: laptop, orchestrators: [orchestrator({ hostEnvironmentId: buildBox })] },
    ]);
    expect(Object.values(orchestratorStateActions(projection!))).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });
});

describe("presentOrchestratorBudget", () => {
  const line = (lines: ReturnType<typeof presentOrchestratorBudget>, key: string) =>
    lines.find((entry) => entry.key === key)!;

  it("shows usage beside its limit", () => {
    const base = orchestrator();
    const lines = presentOrchestratorBudget(base.budget, base.usage);
    expect(line(lines, "tokens")).toMatchObject({
      usedLabel: "400",
      limitLabel: "1,000",
      exceeded: false,
      note: null,
    });
    expect(line(lines, "maxChildrenPerTask").limitLabel).toBe("No limit");
    expect(line(lines, "maxTurnDurationMs").limitLabel).toBe("15 min");
  });

  it("shows unknown usage as unknown, never as zero", () => {
    const base = orchestrator();
    const tokens = line(
      presentOrchestratorBudget(base.budget, {
        ...base.usage,
        tokens: null,
        tokensComplete: false,
      }),
      "tokens",
    );
    expect(tokens.used).toBeNull();
    expect(tokens.usedLabel).toBe("Unknown");
    // With a limit and no usage, exceeding it cannot be told.
    expect(tokens.exceeded).toBeNull();
    expect(tokens.note).toMatch(/does not report/);
  });

  it("says a partial token total is a lower bound", () => {
    const base = orchestrator();
    const tokens = line(
      presentOrchestratorBudget(base.budget, { ...base.usage, tokensComplete: false }),
      "tokens",
    );
    expect(tokens.usedLabel).toBe("At least 400");
    expect(tokens.note).toMatch(/higher/);
  });

  it("flags a limit as reached at the boundary, and none when there is no limit", () => {
    const base = orchestrator();
    const reached = presentOrchestratorBudget(base.budget, { ...base.usage, tokens: 1_000 });
    expect(line(reached, "tokens").exceeded).toBe(true);
    const under = presentOrchestratorBudget(base.budget, { ...base.usage, tokens: 999 });
    expect(line(under, "tokens").exceeded).toBe(false);
    const unlimited = presentOrchestratorBudget(
      { ...base.budget, maxTokens: null },
      { ...base.usage, tokens: null },
    );
    expect(line(unlimited, "tokens")).toMatchObject({ exceeded: false, limitLabel: "No limit" });
  });
});

describe("summarizeOrchestratorInbox", () => {
  const entry = (id: string, status: InboxEntry["status"]): InboxEntry => ({
    id: InboxEntryId.make(id),
    orchestratorId: OrchestratorId.make("main"),
    kind: "user_message",
    dedupKey: id,
    status,
    relevance: "actionable",
    entries: [],
    text: "hello",
    from: null,
    reservedByRunId: null,
    receivedAt: at(0),
    updatedAt: at(0),
  });

  it("counts reserved and unknown entries and keeps the server's pending count", () => {
    const summary = summarizeOrchestratorInbox({
      inboxPending: 7,
      entries: [entry("a", "pending"), entry("b", "reserved"), entry("c", "unknown")],
      limit: 50,
    });
    expect(summary).toMatchObject({ pending: 7, reserved: 1, unknown: 1, partial: false });
    expect(summary.unknownEntries.map((item) => item.id)).toEqual(["c"]);
  });

  it("is partial before the entries load and when the page is full", () => {
    expect(summarizeOrchestratorInbox({ inboxPending: 2, entries: null, limit: 50 })).toMatchObject(
      {
        pending: 2,
        reserved: 0,
        unknown: 0,
        partial: true,
      },
    );
    expect(
      summarizeOrchestratorInbox({ inboxPending: 0, entries: [entry("a", "unknown")], limit: 1 })
        .partial,
    ).toBe(true);
  });
});

describe("staleness", () => {
  it("is fresh up to the threshold and stale from it", () => {
    expect(presentObservation({ observedAt: at(-1_000), nowMs: NOW })).toMatchObject({
      freshness: "fresh",
      label: "Observed just now",
    });
    expect(
      presentObservation({ observedAt: at(-(AUTOMATION_STALE_AFTER_MS - 1)), nowMs: NOW })
        .freshness,
    ).toBe("fresh");
    expect(
      presentObservation({ observedAt: at(-AUTOMATION_STALE_AFTER_MS), nowMs: NOW }),
    ).toMatchObject({ freshness: "stale", label: "Observed 2m ago" });
  });

  it("says never for a missing or unreadable timestamp", () => {
    for (const observedAt of [null, undefined, "not a date"]) {
      expect(presentObservation({ observedAt, nowMs: NOW, verb: "Seen" })).toMatchObject({
        freshness: "never",
        ageMs: null,
        label: "Never seen",
      });
    }
  });

  it("treats a timestamp ahead of this clock as just observed", () => {
    expect(presentObservation({ observedAt: at(60_000), nowMs: NOW })).toMatchObject({
      freshness: "fresh",
      ageMs: 0,
    });
  });

  it("reports reachability only when something knows it", () => {
    expect(presentObservation({ observedAt: at(0), nowMs: NOW }).reachabilityLabel).toBeNull();
    expect(presentObservation({ observedAt: at(0), nowMs: NOW, reachable: false })).toMatchObject({
      reachable: false,
      reachabilityLabel: "Not reachable now",
    });
    expect(resolveEnvironmentReachability({})).toBeNull();
    expect(resolveEnvironmentReachability({ peerStatus: "offline" })).toBe(false);
    // The host's own link outranks whether this client happens to be connected.
    expect(
      resolveEnvironmentReachability({ peerStatus: "offline", clientConnectionPhase: "connected" }),
    ).toBe(false);
    expect(resolveEnvironmentReachability({ clientConnectionPhase: "connected" })).toBe(true);
    expect(resolveEnvironmentReachability({ clientConnectionPhase: "backoff" })).toBe(false);
  });

  it("formats ages", () => {
    expect(formatAutomationAge(0)).toBe("just now");
    expect(formatAutomationAge(59 * 60_000)).toBe("59m ago");
    expect(formatAutomationAge(3 * 3_600_000)).toBe("3h ago");
    expect(formatAutomationAge(3 * 86_400_000)).toBe("3d ago");
  });
});

describe("responsibility", () => {
  const lookup: ResponsibilityLookup = {
    orchestratorName: (orchestratorId) => (orchestratorId === "main" ? "Release captain" : null),
    threadTitle: (threadId) => (threadId === "parent" ? "Fix the build" : null),
  };
  const claim = (
    owner: ResponsibilityClaim["owner"],
    rule: ResponsibilityClaim["rule"],
    leaseExpiresAt: string | null = null,
  ): ResponsibilityClaim => ({
    subject: {
      kind: "request",
      threadId: ThreadId.make("child"),
      requestId: RuntimeRequestId.make("request-1"),
    },
    owner,
    rule,
    generation: 1,
    leaseExpiresAt,
    claimedAt: at(-1_000),
  });
  const orchestratorOwner = {
    kind: "orchestrator",
    orchestratorId: OrchestratorId.make("main"),
    environmentId: laptop,
  } as const;

  it("says a request is the user's without a note", () => {
    expect(
      presentResponsibility(
        { claim: claim({ kind: "user" }, "user"), reservedForUser: false },
        lookup,
      ),
    ).toMatchObject({ ownerKind: "user", ownerLabel: "You", delegated: false, note: null });
  });

  it("names the orchestrator and the rule, and does not imply the viewer may answer", () => {
    const presentation = presentResponsibility(
      { claim: claim(orchestratorOwner, "managing_parent"), reservedForUser: false },
      lookup,
    );
    expect(presentation).toMatchObject({
      ownerKind: "orchestrator",
      ownerLabel: "Orchestrator Release captain",
      ruleLabel: "it manages this thread",
      delegated: true,
      summary: "Orchestrator Release captain is responsible",
    });
    expect(presentation.note).toMatch(/does not make it yours to answer/);
  });

  it("names a parent thread owner, or a generic one when the thread is not loaded", () => {
    expect(
      presentResponsibility(
        {
          claim: claim({ kind: "thread", threadId: ThreadId.make("parent") }, "explicit_owner"),
          reservedForUser: false,
        },
        lookup,
      ).ownerLabel,
    ).toBe("Thread Fix the build");
    expect(
      presentResponsibility(
        {
          claim: claim({ kind: "thread", threadId: ThreadId.make("unloaded") }, "managing_parent"),
          reservedForUser: false,
        },
        lookup,
      ).ownerLabel,
    ).toBe("A parent thread");
    expect(
      presentResponsibility(
        {
          claim: claim(
            { ...orchestratorOwner, orchestratorId: OrchestratorId.make("other") },
            "user",
          ),
          reservedForUser: false,
        },
        lookup,
      ).ownerLabel,
    ).toBe("An orchestrator");
  });

  it("keeps an approval reserved for the user even when an orchestrator tracks it", () => {
    const presentation = presentResponsibility(
      { claim: claim(orchestratorOwner, "local_orchestrator"), reservedForUser: true },
      lookup,
    );
    expect(presentation.reservedForUser).toBe(true);
    expect(presentation.summary).toBe(
      "Reserved for you · Orchestrator Release captain is tracking it",
    );
    expect(presentation.note).toMatch(/only you/);
    expect(presentResponsibility({ claim: null, reservedForUser: true }, lookup).summary).toBe(
      "Reserved for you",
    );
  });

  it("reports an unclaimed request as not assigned", () => {
    expect(presentResponsibility({ claim: null, reservedForUser: false }, lookup)).toMatchObject({
      ownerKind: "unassigned",
      delegated: false,
      summary: "Not assigned yet",
    });
  });

  it("flags an expired lease only from the lease time on", () => {
    const leased = { claim: claim(orchestratorOwner, "user", at(0)), reservedForUser: false };
    expect(presentResponsibility(leased, lookup, NOW - 1).leaseExpired).toBe(false);
    expect(presentResponsibility(leased, lookup, NOW).leaseExpired).toBe(true);
    expect(presentResponsibility(leased, lookup).leaseExpired).toBe(false);
  });

  it("degrades for a rule this client has not seen", () => {
    const presentation = presentResponsibility(
      {
        claim: claim(orchestratorOwner, "delegated_by_policy" as ResponsibilityClaim["rule"]),
        reservedForUser: false,
      },
      lookup,
    );
    expect(presentation.ruleLabel).toBe("delegated by policy");
  });

  const request = (
    threadId: string,
    requestId: string,
    owner: ResponsibilityClaim["owner"] | null,
    reservedForUser = false,
  ): PendingRequestSummary => ({
    environmentId: laptop,
    threadId: ThreadId.make(threadId),
    threadTitle: threadId,
    parentThreadId: null,
    requestId: RuntimeRequestId.make(requestId),
    kind: reservedForUser ? "approval" : "user_input",
    reservedForUser,
    revision: 0,
    createdAt: at(0),
    request: {},
    claim: owner === null ? null : claim(owner, "managing_parent"),
  });

  it("marks only threads with a request that is not simply the user's", () => {
    const index = buildThreadResponsibilityIndex(
      [
        request("mine", "r1", { kind: "user" }),
        request("unclaimed", "r2", null),
        request("handled", "r3", orchestratorOwner),
        request("handled", "r4", { kind: "user" }, true),
        request("mixed", "r5", orchestratorOwner),
        request("mixed", "r6", { kind: "thread", threadId: ThreadId.make("parent") }),
      ],
      lookup,
    );
    expect([...index.keys()].toSorted()).toEqual(["laptop:handled", "laptop:mixed"]);
    expect(index.get("laptop:handled")).toMatchObject({
      delegatedCount: 1,
      reservedForUserCount: 1,
      total: 2,
      ownerLabel: "Orchestrator Release captain",
    });
    expect(index.get("laptop:handled")?.accessibleLabel).toMatch(/1 reserved for you/);
    expect(index.get("laptop:mixed")).toMatchObject({ delegatedCount: 2, ownerLabel: null });
    expect(index.get("laptop:mixed")?.accessibleLabel).toMatch(/^Several owners/);
  });

  it("returns the previous index when nothing a row draws changed", () => {
    const requests = [request("handled", "r3", orchestratorOwner)];
    const first = buildThreadResponsibilityIndex(requests, lookup);
    expect(buildThreadResponsibilityIndex([...requests], lookup, first)).toBe(first);
    expect(buildThreadResponsibilityIndex([], lookup, first).size).toBe(0);
  });
});

describe("presentDelegatedTasks", () => {
  const task = (id: string, overrides: Partial<DelegatedTask> = {}): DelegatedTask => ({
    id: DelegatedTaskId.make(id),
    version: 1,
    revision: 1,
    originEnvironmentId: laptop,
    executionEnvironmentId: laptop,
    nodeId: null,
    orchestratorId: OrchestratorId.make("main"),
    parentTaskId: null,
    parentThreadId: ThreadId.make("thread-main"),
    threadId: ThreadId.make(`thread-${id}`),
    kind: "managed_thread",
    capabilities: { send: true, answer: true, cancel: true, read: true },
    target: { projectId: ProjectId.make("project-1") },
    contract: { title: id, objective: "do it", deliverables: [], acceptanceCriteria: ["works"] },
    status: "running",
    statusReason: null,
    attemptCount: 1,
    claim: null,
    result: null,
    usage: { tokens: null, turns: 0 },
    observedAt: at(0),
    createdAt: at(-10_000),
    updatedAt: at(-10_000),
    ...overrides,
  });

  it("puts open work first, then the most recently changed", () => {
    const rows = presentDelegatedTasks({
      environmentId: laptop,
      tasks: [
        task("done", { status: "validated", updatedAt: at(0) }),
        task("old", { updatedAt: at(-60_000) }),
        task("reported", { status: "reported", updatedAt: at(-1_000) }),
      ],
    });
    expect(rows.map((row) => row.task.id)).toEqual(["reported", "old", "done"]);
  });

  it("distinguishes reported from validated and counts checked criteria", () => {
    const [reported, validated] = presentDelegatedTasks({
      environmentId: laptop,
      tasks: [
        task("a", { status: "reported", updatedAt: at(0) }),
        task("b", {
          status: "validated",
          result: {
            summary: "ok",
            criteria: [
              { text: "one", met: true, evidence: null },
              { text: "two", met: false, evidence: null },
              { text: "three", met: null, evidence: null },
            ],
            validatedBy: { kind: "user" },
            refs: [],
          },
        }),
      ],
    });
    expect(reported).toMatchObject({
      awaitingValidation: true,
      validated: false,
      criteriaLabel: null,
    });
    expect(validated).toMatchObject({
      awaitingValidation: false,
      validated: true,
      criteriaLabel: "1 of 3 criteria met, 1 not checked",
    });
  });

  it("points at the thread in the environment that runs the task", () => {
    const [remote, pending] = presentDelegatedTasks({
      environmentId: laptop,
      tasks: [
        task("remote", { executionEnvironmentId: buildBox, updatedAt: at(0) }),
        task("pending", { status: "pending_delivery", threadId: null, updatedAt: at(-1) }),
      ],
    });
    expect(remote).toMatchObject({
      remote: true,
      threadRef: { environmentId: buildBox, threadId: "thread-remote" },
    });
    expect(pending).toMatchObject({ remote: false, threadRef: null });
  });

  it("keeps the newest revision when a task is listed twice", () => {
    const rows = presentDelegatedTasks({
      environmentId: laptop,
      tasks: [task("a", { revision: 2, status: "reported" }), task("a", { revision: 1 })],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status.label).toBe("Reported");
  });
});

describe("activity and live changes", () => {
  it("labels event types and passes unknown ones through", () => {
    expect(automationEventLabel("task.reported")).toBe("Task reported");
    expect(automationEventLabel("custom.ci.build-finished")).toBe("custom.ci.build-finished");
  });

  it("shows the newest entries first and keeps unknown apart from failed", () => {
    const entry = (cursor: number, type: string) =>
      ({
        cursor,
        event: { eventId: EventId.make(`event-${cursor}`), type, occurredAt: at(cursor) },
      }) as Parameters<typeof presentAutomationActivity>[0][number];
    const rows = presentAutomationActivity(
      [entry(1, "task.delegated"), entry(3, "task.unknown"), entry(2, "task.failed")],
      2,
    );
    expect(rows.map((row) => [row.label, row.severity])).toEqual([
      ["Task outcome unknown", "unknown"],
      ["Task failed", "error"],
    ]);
    expect(presentAutomationActivity([entry(1, "task.delegated")], 0)).toEqual([]);
  });

  it("maps an event to the lists it makes stale", () => {
    expect(automationChangeKinds("hook.changed")).toEqual(["hooks"]);
    expect(automationChangeKinds("hook.delivery.failed")).toEqual(["deliveries"]);
    expect(automationChangeKinds("peer.availability")).toEqual(["peers"]);
    expect(automationChangeKinds("node.availability")).toEqual(["nodes"]);
    expect(automationChangeKinds("job.finished")).toContain("jobs");
    expect(automationChangeKinds("task.reported")).toEqual(["tasks", "requests", "activity"]);
    expect(automationChangeKinds("claim.changed")).toContain("requests");
    expect(automationChangeKinds("orchestrator.message.received")).toContain("inbox");
    expect(automationChangeKinds("custom.ci.build-finished")).toEqual([]);
  });

  it("bumps only the counters an event touches and keeps identity otherwise", () => {
    const afterJob = applyAutomationChange(EMPTY_AUTOMATION_CHANGE_COUNTERS, "job.started");
    expect(afterJob).toMatchObject({ jobs: 1, activity: 1, hooks: 0, peers: 0 });
    expect(EMPTY_AUTOMATION_CHANGE_COUNTERS.jobs).toBe(0);
    expect(applyAutomationChange(afterJob, "thread.created")).toBe(afterJob);
    expect(applyAutomationChange(afterJob, "job.finished").jobs).toBe(2);
  });
});

describe("presentAutomationError", () => {
  const error = (code: string, message = "detail from the server") => ({
    _tag: "AutomationError",
    code,
    message,
  });

  it("has a message for every code the contract defines", () => {
    for (const code of AutomationErrorCode.literals) {
      const presentation = presentAutomationError(error(code));
      expect(presentation.code).toBe(code);
      expect(presentation.message.length).toBeGreaterThan(10);
    }
  });

  it("tells a stale edit to reload", () => {
    expect(presentAutomationError(error("REVISION_MISMATCH"))).toMatchObject({
      stale: true,
      outcomeUnknown: false,
      message: "It was changed elsewhere. Reload it, then make your change again.",
    });
  });

  it("keeps an unknown outcome apart from a failure", () => {
    expect(presentAutomationError(error("RESULT_UNKNOWN")).outcomeUnknown).toBe(true);
    expect(presentAutomationError(error("INTERNAL")).outcomeUnknown).toBe(false);
  });

  it("adds the server's detail to the stable message", () => {
    expect(
      presentAutomationError(error("PERMISSION_DENIED", "needs automation:write")).message,
    ).toBe("This session is not allowed to do that. (needs automation:write)");
  });

  it("falls back for a new code and for errors that are not automation errors", () => {
    expect(presentAutomationError(error("QUOTA_HELD", "held for review")).message).toBe(
      "held for review",
    );
    expect(presentAutomationError(error("QUOTA_HELD", " ")).message).toBe("Quota held");
    expect(presentAutomationError(new Error("socket closed"))).toMatchObject({
      code: null,
      message: "socket closed",
    });
    expect(
      presentAutomationError({ code: "NOT_FOUND", message: "other error type" }).code,
    ).toBeNull();
    expect(presentAutomationError(undefined).message).toBe("The request failed.");
  });
});
