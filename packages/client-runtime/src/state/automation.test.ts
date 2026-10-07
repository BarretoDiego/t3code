import {
  EnvironmentId,
  type Orchestrator,
  OrchestratorId,
  type PendingRequestSummary,
  ProjectId,
  ProviderInstanceId,
  RuntimeRequestId,
  type ServerConfig,
  ThreadId,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { createAutomationDerivedAtoms } from "./automation.ts";

const laptop = EnvironmentId.make("laptop");
const oldServer = EnvironmentId.make("old-server");
const buildBox = EnvironmentId.make("build-box");
const timestamp = "2026-10-07T12:00:00.000Z";

function config(automation: boolean | undefined): ServerConfig {
  return {
    environment: { capabilities: automation === undefined ? {} : { automation } },
  } as unknown as ServerConfig;
}

function orchestrator(overrides: Partial<Orchestrator> = {}): Orchestrator {
  return {
    id: OrchestratorId.make("main"),
    version: 1,
    revision: 1,
    name: "Release captain",
    scope: "local",
    projectId: ProjectId.make("project-1"),
    modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "sonnet" },
    runtimeMode: "approval-required",
    instructions: "",
    permissions: { actions: [] },
    budget: {
      maxTokens: null,
      maxTurnsPerTask: null,
      maxTurnsPerHour: null,
      maxConcurrentChildren: null,
      maxChildrenPerTask: null,
      maxTaskAttempts: null,
      maxTurnDurationMs: null,
    },
    responsibilityOrder: ["user"],
    batchWindowMs: 0,
    hostEnvironmentId: laptop,
    hostGeneration: 1,
    threadId: ThreadId.make("thread-main"),
    desiredState: "active",
    effectiveState: "idle",
    stateReason: null,
    inboxPending: 0,
    usage: {
      tokens: null,
      tokensComplete: false,
      turns: 0,
      turnsLastHour: 0,
      activeChildren: 0,
      since: timestamp,
    },
    lastTurnAt: null,
    lastCheckpointAt: null,
    observedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

function request(threadId: string, owner: "user" | "orchestrator"): PendingRequestSummary {
  return {
    environmentId: laptop,
    threadId: ThreadId.make(threadId),
    threadTitle: threadId,
    parentThreadId: null,
    requestId: RuntimeRequestId.make(`request-${threadId}`),
    kind: "user_input",
    reservedForUser: false,
    revision: 0,
    createdAt: timestamp,
    request: {},
    claim: {
      subject: {
        kind: "request",
        threadId: ThreadId.make(threadId),
        requestId: RuntimeRequestId.make(`request-${threadId}`),
      },
      owner:
        owner === "user"
          ? { kind: "user" }
          : {
              kind: "orchestrator",
              orchestratorId: OrchestratorId.make("main"),
              environmentId: laptop,
            },
      rule: "managing_parent",
      generation: 1,
      leaseExpiresAt: null,
      claimedAt: timestamp,
    },
  };
}

/** A registry with writable stand-ins for the per-environment lists, and a log of which were read. */
function harness(configs: ReadonlyArray<readonly [EnvironmentId, ServerConfig]>) {
  const read: Array<string> = [];
  const serverConfigsAtom = Atom.make<ReadonlyMap<EnvironmentId, ServerConfig>>(new Map(configs));
  const orchestratorLists = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make<AsyncResult.AsyncResult<{ readonly orchestrators: ReadonlyArray<Orchestrator> }>>(
      AsyncResult.initial(true),
    ),
  );
  const requestLists = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make<AsyncResult.AsyncResult<{ readonly requests: ReadonlyArray<PendingRequestSummary> }>>(
      AsyncResult.initial(true),
    ),
  );
  const atoms = createAutomationDerivedAtoms({
    serverConfigsAtom,
    orchestratorsAtom: (environmentId) => {
      read.push(`orchestrators:${environmentId}`);
      return orchestratorLists(environmentId);
    },
    pendingRequestsAtom: (environmentId) => {
      read.push(`requests:${environmentId}`);
      return requestLists(environmentId);
    },
  });
  const registry = AtomRegistry.make();
  return {
    atoms,
    registry,
    read,
    serverConfigsAtom,
    setOrchestrators: (environmentId: EnvironmentId, orchestrators: ReadonlyArray<Orchestrator>) =>
      registry.set(orchestratorLists(environmentId), AsyncResult.success({ orchestrators })),
    setRequests: (environmentId: EnvironmentId, requests: ReadonlyArray<PendingRequestSummary>) =>
      registry.set(requestLists(environmentId), AsyncResult.success({ requests })),
  };
}

describe("automation derived atoms", () => {
  it("lists only the environments whose server advertises automation", () => {
    const { atoms, registry } = harness([
      [laptop, config(true)],
      [oldServer, config(undefined)],
      [buildBox, config(false)],
    ]);
    expect(registry.get(atoms.automationEnvironmentIdsAtom)).toEqual([laptop]);
    registry.dispose();
  });

  it("never asks an environment without automation for its lists", () => {
    const { atoms, registry, read } = harness([
      [laptop, config(true)],
      [oldServer, config(undefined)],
    ]);
    registry.get(atoms.threadMarkersAtom("laptop:thread-main"));
    registry.get(atoms.threadMarkersAtom("old-server:thread-main"));
    expect(read.some((entry) => entry.endsWith(":old-server"))).toBe(false);
    expect(read).toContain("orchestrators:laptop");
    expect(read).toContain("requests:laptop");
    registry.dispose();
  });

  it("reads one orchestrator list per environment however many rows ask", () => {
    const { atoms, registry, read } = harness([[laptop, config(true)]]);
    const unmount = Array.from({ length: 50 }, (_, index) =>
      registry.mount(atoms.threadMarkersAtom(`laptop:thread-${index}`)),
    );
    expect(read.filter((entry) => entry === "orchestrators:laptop")).toHaveLength(1);
    expect(read.filter((entry) => entry === "requests:laptop")).toHaveLength(1);
    for (const release of unmount) release();
    registry.dispose();
  });

  it("marks nothing while the list is loading, then marks the orchestrator's thread", () => {
    const { atoms, registry, setOrchestrators } = harness([[laptop, config(true)]]);
    const markers = atoms.threadMarkersAtom("laptop:thread-main");
    const release = registry.mount(markers);
    expect(registry.get(markers)).toBeNull();

    setOrchestrators(laptop, [orchestrator({ effectiveState: "running" })]);
    expect(registry.get(markers)?.orchestrator).toMatchObject({
      name: "Release captain",
      hostedHere: true,
    });
    expect(registry.get(markers)?.orchestrator?.state.label).toBe("Running");
    expect(registry.get(markers)?.responsibility).toBeNull();
    expect(registry.get(atoms.orchestratorViewAtom("laptop:thread-main"))?.orchestrator.id).toBe(
      "main",
    );
    // An ordinary thread stays unmarked.
    expect(registry.get(atoms.threadMarkersAtom("laptop:other"))).toBeNull();
    release();
    registry.dispose();
  });

  it("keeps a row's markers identical when a new list changes nothing it draws", () => {
    const { atoms, registry, setOrchestrators } = harness([[laptop, config(true)]]);
    const markers = atoms.threadMarkersAtom("laptop:thread-main");
    let notifications = 0;
    const release = registry.subscribe(markers, () => {
      notifications += 1;
    });
    setOrchestrators(laptop, [orchestrator()]);
    const first = registry.get(markers);
    const afterFirst = notifications;

    // A fresh snapshot: new objects, a new timestamp, the same row.
    setOrchestrators(laptop, [orchestrator({ observedAt: "2026-10-07T12:00:05.000Z" })]);
    expect(registry.get(markers)).toBe(first);
    expect(notifications).toBe(afterFirst);

    setOrchestrators(laptop, [orchestrator({ effectiveState: "paused", desiredState: "paused" })]);
    expect(registry.get(markers)).not.toBe(first);
    expect(registry.get(markers)?.orchestrator?.state.label).toBe("Paused");
    expect(notifications).toBe(afterFirst + 1);

    setOrchestrators(laptop, []);
    expect(registry.get(markers)).toBeNull();
    release();
    registry.dispose();
  });

  it("marks a thread whose request something other than the user is responsible for", () => {
    const { atoms, registry, setOrchestrators, setRequests } = harness([[laptop, config(true)]]);
    const handled = atoms.threadMarkersAtom("laptop:child");
    const mine = atoms.threadMarkersAtom("laptop:mine");
    const releases = [registry.mount(handled), registry.mount(mine)];
    setOrchestrators(laptop, [orchestrator()]);
    setRequests(laptop, [request("child", "orchestrator"), request("mine", "user")]);

    expect(registry.get(handled)).toMatchObject({
      orchestrator: null,
      responsibility: { delegatedCount: 1, ownerLabel: "Orchestrator Release captain" },
    });
    // A request that is simply the user's needs no extra marker.
    expect(registry.get(mine)).toBeNull();

    setRequests(laptop, []);
    expect(registry.get(handled)).toBeNull();
    for (const release of releases) release();
    registry.dispose();
  });

  it("starts marking an environment once its server gains the capability", () => {
    const { atoms, registry, serverConfigsAtom, setOrchestrators, read } = harness([
      [laptop, config(undefined)],
    ]);
    const markers = atoms.threadMarkersAtom("laptop:thread-main");
    const release = registry.mount(markers);
    setOrchestrators(laptop, [orchestrator()]);
    expect(registry.get(markers)).toBeNull();
    expect(read).toEqual([]);

    registry.set(serverConfigsAtom, new Map([[laptop, config(true)]]));
    expect(registry.get(markers)?.orchestrator?.name).toBe("Release captain");
    release();
    registry.dispose();
  });
});
