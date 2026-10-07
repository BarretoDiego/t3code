import {
  EnvironmentId,
  EventConsumerId,
  type ExecutionNode,
  ExecutionNodeId,
  type Hook,
  HookId,
  type Orchestrator,
  OrchestratorId,
  type Peer,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_ORCHESTRATOR_POLICY,
  emptyExecutionNodeDraft,
  emptyHookDraft,
  emptyOrchestratorDraft,
  emptyPeerAddDraft,
  executionNodeDraftToInput,
  executionNodeToDraft,
  hookDraftToInput,
  hookToDraft,
  isHookEventTypePattern,
  makeAutomationIdempotencyKey,
  orchestratorDraftToInput,
  orchestratorToDraft,
  parseAutomationTokenList,
  peerAddDraftToInput,
  peerEditDraftToInput,
  peerToEditDraft,
  summarizeHookFilter,
  summarizeHookTarget,
} from "./automationDrafts.ts";

const key = makeAutomationIdempotencyKey("test", "nonce-1");
const timestamp = "2026-10-07T12:00:00.000Z";

function expectOk<Input>(
  result: { readonly ok: true; readonly input: Input } | { readonly ok: false; errors: unknown },
): Input {
  if (!result.ok) throw new Error(`expected a valid draft: ${JSON.stringify(result.errors)}`);
  return result.input;
}

function expectErrors(result: {
  readonly ok: boolean;
  readonly errors?: ReadonlyArray<string>;
}): ReadonlyArray<string> {
  expect(result.ok).toBe(false);
  return result.errors ?? [];
}

describe("shared draft helpers", () => {
  it("splits token lists on commas and lines, dropping blanks and repeats", () => {
    expect(parseAutomationTokenList(" a, b\n\nb ,, c\n")).toEqual(["a", "b", "c"]);
    expect(parseAutomationTokenList("  \n ")).toEqual([]);
  });

  it("builds an idempotency key the contract accepts, however long the scope", () => {
    expect(key).toBe("test:nonce-1");
    expect(makeAutomationIdempotencyKey("x".repeat(400), "nonce").length).toBe(200);
  });
});

describe("orchestrator drafts", () => {
  const orchestrator: Orchestrator = {
    id: OrchestratorId.make("main"),
    version: 1,
    revision: 7,
    name: "Release captain",
    scope: "global",
    projectId: ProjectId.make("project-1"),
    modelSelection: {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "sonnet",
      options: [{ id: "reasoning", value: "high" }],
    } as Orchestrator["modelSelection"],
    profile: "reviewer",
    runtimeMode: "auto",
    instructions: "Keep the branch green.\n",
    permissions: {
      actions: ["thread.read", "request.approve"],
      projectIds: [ProjectId.make("project-1")],
      preAuthorizedApprovals: [{ requestKind: "command", decisions: ["accept"] }],
    },
    budget: {
      maxTokens: null,
      maxTurnsPerTask: 4,
      maxTurnsPerHour: null,
      maxConcurrentChildren: 2,
      maxChildrenPerTask: null,
      maxTaskAttempts: 1,
      maxTurnDurationMs: 60_000,
    },
    responsibilityOrder: ["managing_parent", "user"],
    batchWindowMs: 2_500,
    hostEnvironmentId: EnvironmentId.make("laptop"),
    hostGeneration: 1,
    threadId: ThreadId.make("thread-main"),
    desiredState: "paused",
    effectiveState: "paused",
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
  };

  it("round-trips an orchestrator through the form without losing a field", () => {
    const input = expectOk(
      orchestratorDraftToInput(orchestratorToDraft(orchestrator), { idempotencyKey: key }),
    );
    expect(input).toEqual({
      id: "main",
      expectedRevision: 7,
      idempotencyKey: key,
      name: "Release captain",
      scope: "global",
      projectId: "project-1",
      modelSelection: orchestrator.modelSelection,
      profile: "reviewer",
      runtimeMode: "auto",
      instructions: "Keep the branch green.\n",
      permissions: orchestrator.permissions,
      budget: orchestrator.budget,
      responsibilityOrder: ["managing_parent", "user"],
      batchWindowMs: 2_500,
    });
    // The operator's state is not the form's to change.
    expect(input).not.toHaveProperty("desiredState");
    expect(input).not.toHaveProperty("threadId");
  });

  it("keeps provider options only while the model is unchanged", () => {
    const draft = orchestratorToDraft(orchestrator);
    const changed = expectOk(
      orchestratorDraftToInput({ ...draft, modelKey: "claudeAgent:opus" }, { idempotencyKey: key }),
    );
    expect(changed.modelSelection).toEqual({ instanceId: "claudeAgent", model: "opus" });
  });

  it("creates a new orchestrator from the defaults once the required fields are filled", () => {
    const draft = {
      ...emptyOrchestratorDraft({
        projectId: "project-1",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      }),
      name: "  Night shift  ",
    };
    const input = expectOk(orchestratorDraftToInput(draft, { idempotencyKey: key }));
    expect(input).toMatchObject({
      name: "Night shift",
      scope: "local",
      runtimeMode: "approval-required",
      batchWindowMs: 15_000,
      permissions: DEFAULT_ORCHESTRATOR_POLICY.permissions,
      budget: DEFAULT_ORCHESTRATOR_POLICY.budget,
    });
    expect(input).not.toHaveProperty("id");
    expect(input).not.toHaveProperty("expectedRevision");
    expect(input).not.toHaveProperty("profile");
    // A new orchestrator never decides approvals unless the user writes it in.
    expect(input.permissions.actions).not.toContain("request.approve");
  });

  it("reports every missing required field of an empty draft at once", () => {
    const errors = expectErrors(
      orchestratorDraftToInput(emptyOrchestratorDraft({}), { idempotencyKey: key }),
    );
    expect(errors).toEqual([
      "Give the orchestrator a name.",
      "Choose a project.",
      "Choose a model.",
    ]);
  });

  it("accepts a zero batch window and rejects a negative or blank one", () => {
    const draft = orchestratorToDraft(orchestrator);
    expect(
      expectOk(
        orchestratorDraftToInput({ ...draft, batchWindowSeconds: "0" }, { idempotencyKey: key }),
      ).batchWindowMs,
    ).toBe(0);
    for (const batchWindowSeconds of ["-1", "", "soon"]) {
      expect(
        expectErrors(
          orchestratorDraftToInput({ ...draft, batchWindowSeconds }, { idempotencyKey: key }),
        ),
      ).toEqual(["Batch window must be zero or more seconds."]);
    }
  });

  it("rejects policy JSON that is malformed, not an object, or has a stray key", () => {
    const draft = orchestratorToDraft(orchestrator);
    const errorsFor = (policyJson: string) =>
      expectErrors(orchestratorDraftToInput({ ...draft, policyJson }, { idempotencyKey: key }));
    expect(errorsFor("{ nope")[0]).toMatch(/^Permissions and limits is not valid JSON/);
    expect(errorsFor("[]")).toEqual(["Permissions and limits must be a JSON object."]);
    expect(errorsFor("")).toEqual(["Permissions and limits is empty."]);
    expect(errorsFor(JSON.stringify({ ...DEFAULT_ORCHESTRATOR_POLICY, model: "opus" }))[0]).toMatch(
      /unknown key "model"/,
    );
  });

  it("validates policy values against the contract", () => {
    const draft = orchestratorToDraft(orchestrator);
    const errorsFor = (policy: unknown) =>
      expectErrors(
        orchestratorDraftToInput(
          { ...draft, policyJson: JSON.stringify(policy) },
          { idempotencyKey: key },
        ),
      );
    // An action the contract does not define.
    expect(
      errorsFor({ ...DEFAULT_ORCHESTRATOR_POLICY, permissions: { actions: ["root.everything"] } }),
    ).toHaveLength(1);
    // Limits are positive or null: zero is not "no limit".
    expect(
      errorsFor({
        ...DEFAULT_ORCHESTRATOR_POLICY,
        budget: { ...DEFAULT_ORCHESTRATOR_POLICY.budget, maxTokens: 0 },
      }),
    ).toHaveLength(1);
    // A missing section is an error, not a silent default.
    expect(errorsFor({ permissions: DEFAULT_ORCHESTRATOR_POLICY.permissions })).toHaveLength(1);
  });

  it("refuses to save an edit that has no revision to replace", () => {
    const errors = expectErrors(
      orchestratorDraftToInput(
        { ...orchestratorToDraft(orchestrator), expectedRevision: null },
        { idempotencyKey: key },
      ),
    );
    expect(errors).toEqual(["This record has no known revision. Reload it before saving."]);
  });
});

describe("hook drafts", () => {
  const baseHook = {
    id: HookId.make("hook-1"),
    version: 1,
    revision: 4,
    name: "Tell the orchestrator",
    enabled: false,
    filter: {
      types: ["task.reported", "task.*"],
      projectIds: [ProjectId.make("project-1")],
      // Not shown by the form: must survive an edit.
      rootThreadIds: [ThreadId.make("root")],
      originEnvironmentIds: [EnvironmentId.make("build-box")],
    },
    target: { type: "orchestrator_inbox", orchestratorId: OrchestratorId.make("main") },
    deliveryMode: "batch",
    batchWindowMs: 3_000,
    retry: { maxAttempts: 3, initialDelayMs: 500, maxDelayMs: 60_000 },
    timeoutMs: 5_000,
    priority: -2,
    cooldownMs: 0,
    maxDeliveriesPerTask: 9,
    cursor: 120,
    createdBy: "cli",
    createdAt: timestamp,
    updatedAt: timestamp,
  } satisfies Hook;

  it("round-trips a hook, including filter keys the form does not show", () => {
    const input = expectOk(hookDraftToInput(hookToDraft(baseHook), { idempotencyKey: key }));
    expect(input).toEqual({
      id: "hook-1",
      expectedRevision: 4,
      idempotencyKey: key,
      name: "Tell the orchestrator",
      enabled: false,
      filter: baseHook.filter,
      target: baseHook.target,
      deliveryMode: "batch",
      batchWindowMs: 3_000,
      retry: baseHook.retry,
      timeoutMs: 5_000,
      priority: -2,
      cooldownMs: 0,
      maxDeliveriesPerTask: 9,
    });
    // startAt only applies to a new hook.
    expect(input).not.toHaveProperty("startAt");
  });

  it("removes a filter key when its field is emptied and keeps the hidden ones", () => {
    const input = expectOk(
      hookDraftToInput(
        { ...hookToDraft(baseHook), eventTypes: "", projectIds: " " },
        { idempotencyKey: key },
      ),
    );
    expect(input.filter).toEqual({
      rootThreadIds: ["root"],
      originEnvironmentIds: ["build-box"],
    });
  });

  it("round-trips every destination type", () => {
    const targets: ReadonlyArray<Hook["target"]> = [
      { type: "cli_consumer", consumerId: EventConsumerId.make("my-script") },
      { type: "webhook", url: "https://example.com/hook", secretRef: "hook-secret" },
      {
        type: "command",
        executable: "/usr/local/bin/notify",
        args: ["--title", "two words", ""],
        cwd: "/srv",
        envAllowlist: ["HOME", "PATH"],
      },
      { type: "command", executable: "/bin/true", args: [] },
    ];
    for (const target of targets) {
      const input = expectOk(
        hookDraftToInput(hookToDraft({ ...baseHook, target }), { idempotencyKey: key }),
      );
      expect(input.target).toEqual(target);
    }
  });

  it("splits edited command arguments by line and ignores one trailing line break", () => {
    const draft = hookToDraft({
      ...baseHook,
      target: { type: "command", executable: "/bin/echo", args: ["old", ""] },
    });
    const argsFor = (commandArgs: string) =>
      (
        expectOk(hookDraftToInput({ ...draft, commandArgs }, { idempotencyKey: key })).target as {
          args: ReadonlyArray<string>;
        }
      ).args;
    expect(argsFor("--flag\ntwo words\n")).toEqual(["--flag", "two words"]);
    expect(argsFor("a\n\nb")).toEqual(["a", "", "b"]);
    expect(argsFor("")).toEqual([]);
  });

  it("starts a new hook at the head and omits the batch window for each-delivery", () => {
    const input = expectOk(
      hookDraftToInput(
        {
          ...emptyHookDraft({ orchestratorId: "main" }),
          name: "New hook",
          deliveryMode: "each",
        },
        { idempotencyKey: key },
      ),
    );
    expect(input).toMatchObject({ startAt: "head", deliveryMode: "each", enabled: true });
    expect(input).not.toHaveProperty("batchWindowMs");
    expect(input).not.toHaveProperty("id");
    expect(input.retry).toEqual({ maxAttempts: 6, initialDelayMs: 1_000, maxDelayMs: 300_000 });
  });

  it("reports the missing fields of an empty draft", () => {
    expect(expectErrors(hookDraftToInput(emptyHookDraft({}), { idempotencyKey: key }))).toEqual([
      "Give the hook a name.",
      "Choose an orchestrator.",
    ]);
  });

  it("accepts exact types and prefixes, and rejects anything that is not a type", () => {
    for (const valid of [
      "task.reported",
      "task.*",
      "custom.ci.build-finished",
      "custom.*",
      "turn",
    ]) {
      expect(isHookEventTypePattern(valid), valid).toBe(true);
    }
    for (const invalid of [
      "Task.Reported",
      "task..x",
      "*",
      "task.*.x",
      "a b",
      "payload.status == 1",
    ]) {
      expect(isHookEventTypePattern(invalid), invalid).toBe(false);
    }
    const errors = expectErrors(
      hookDraftToInput(
        { ...hookToDraft(baseHook), eventTypes: "task.reported\nevent.payload.ok === true" },
        { idempotencyKey: key },
      ),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/is not an event type/);
  });

  it("validates each destination's own fields", () => {
    const draft = hookToDraft(baseHook);
    const errorsFor = (overrides: Partial<typeof draft>) =>
      expectErrors(hookDraftToInput({ ...draft, ...overrides }, { idempotencyKey: key }));
    expect(
      errorsFor({ targetType: "webhook", webhookUrl: "ftp://x", webhookSecretRef: "" }),
    ).toEqual([
      "The webhook URL must start with http:// or https://.",
      "Name the server secret that signs the webhook body.",
    ]);
    expect(errorsFor({ targetType: "command", commandExecutable: " " })).toEqual([
      "Enter the absolute path of the executable.",
    ]);
    expect(errorsFor({ targetType: "cli_consumer", consumerId: "" })).toEqual([
      "Name the CLI consumer.",
    ]);
    expect(errorsFor({ targetType: "carrier_pigeon" })[0]).toMatch(/not a destination/);
  });

  it("checks the batch window and the delivery policy at their boundaries", () => {
    const draft = hookToDraft(baseHook);
    const errorsFor = (overrides: Partial<typeof draft>) =>
      expectErrors(hookDraftToInput({ ...draft, ...overrides }, { idempotencyKey: key }));
    expect(errorsFor({ batchWindowSeconds: "0" })).toEqual([
      "Batch window must be more than zero seconds.",
    ]);
    expect(
      expectOk(hookDraftToInput({ ...draft, batchWindowSeconds: "0.001" }, { idempotencyKey: key }))
        .batchWindowMs,
    ).toBe(1);
    // maxAttempts is capped at 20 by the contract.
    const policy = (maxAttempts: number) =>
      JSON.stringify({
        retry: { maxAttempts, initialDelayMs: 1, maxDelayMs: 1 },
        timeoutMs: 1,
        priority: 0,
      });
    expect(
      expectOk(hookDraftToInput({ ...draft, policyJson: policy(20) }, { idempotencyKey: key }))
        .retry.maxAttempts,
    ).toBe(20);
    expect(errorsFor({ policyJson: policy(21) })).toHaveLength(1);
    expect(errorsFor({ policyJson: JSON.stringify({ retry: baseHook.retry }) })).toHaveLength(1);
    expect(errorsFor({ policyJson: '{"filter": {}}' })[0]).toMatch(/unknown key "filter"/);
  });

  it("summarizes a filter and a destination for the list", () => {
    expect(summarizeHookFilter({})).toBe("Every event");
    expect(summarizeHookFilter(baseHook.filter)).toBe(
      "task.reported, task.* · 1 project · 1 thread tree · 1 origin environment",
    );
    expect(summarizeHookFilter({ types: ["a", "b", "c", "d", "e"] })).toBe("a, b, c +2");
    const name = (id: string) => (id === "main" ? "Release captain" : null);
    expect(summarizeHookTarget(baseHook.target, name)).toEqual({
      label: "Inbox of Release captain",
      needsOperatorAllowlist: false,
    });
    expect(
      summarizeHookTarget({ type: "webhook", url: "https://example.com", secretRef: "s" }, name),
    ).toEqual({ label: "Webhook https://example.com", needsOperatorAllowlist: true });
    expect(
      summarizeHookTarget({ type: "command", executable: "/bin/true", args: [] }, name)
        .needsOperatorAllowlist,
    ).toBe(true);
    expect(
      summarizeHookTarget({ type: "sms", number: "1" } as unknown as Hook["target"], name).label,
    ).toBe("sms");
  });
});

describe("peer drafts", () => {
  const peer: Peer = {
    environmentId: EnvironmentId.make("build-box"),
    name: "Build box",
    httpBaseUrl: "https://build.example",
    enabled: true,
    permissions: {
      inbound: ["message.send", "task.delegate"],
      projectIds: [ProjectId.make("project-1")],
      forwardEventTypes: ["task.*"],
    },
    status: "connected",
    statusReason: null,
    negotiatedProtocolVersion: 1,
    capabilities: null,
    inboundCursor: 0,
    outboxPending: 0,
    lastConnectedAt: timestamp,
    lastObservedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  it("adds a peer from a pairing link with no permissions by default", () => {
    const input = expectOk(
      peerAddDraftToInput({
        ...emptyPeerAddDraft(),
        name: "Build box",
        pairingUrl: " t3://pair/abc ",
      }),
    );
    expect(input).toEqual({
      name: "Build box",
      pairingUrl: "t3://pair/abc",
      permissions: { inbound: [], forwardEventTypes: [] },
    });
  });

  it("adds a peer from a URL and token, sending only that mode's fields", () => {
    const input = expectOk(
      peerAddDraftToInput({
        ...emptyPeerAddDraft(),
        name: "Build box",
        mode: "token",
        pairingUrl: "ignored",
        httpBaseUrl: "https://build.example",
        token: "secret",
      }),
    );
    expect(input).toMatchObject({ httpBaseUrl: "https://build.example", token: "secret" });
    expect(input).not.toHaveProperty("pairingUrl");
  });

  it("reports what an empty add draft is missing, per mode", () => {
    expect(expectErrors(peerAddDraftToInput(emptyPeerAddDraft()))).toEqual([
      "Give the peer a name.",
      "Paste the link the peer printed.",
    ]);
    expect(expectErrors(peerAddDraftToInput({ ...emptyPeerAddDraft(), mode: "token" }))).toEqual([
      "Give the peer a name.",
      "The peer URL must start with http:// or https://.",
      "Enter the token the peer printed.",
    ]);
  });

  it("rejects a permission the contract does not define", () => {
    const errors = expectErrors(
      peerAddDraftToInput({
        ...emptyPeerAddDraft(),
        name: "x",
        pairingUrl: "link",
        permissionsJson: JSON.stringify({ inbound: ["everything"], forwardEventTypes: [] }),
      }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^Permissions: /);
    expect(
      expectErrors(
        peerAddDraftToInput({
          ...emptyPeerAddDraft(),
          name: "x",
          pairingUrl: "link",
          permissionsJson: '{"inbound": []}',
        }),
      )[0],
    ).toMatch(/^Permissions: /);
  });

  it("sends nothing but the id when an edit changes nothing", () => {
    const result = peerEditDraftToInput(peerToEditDraft(peer), peer);
    expect(result).toMatchObject({
      ok: true,
      changed: false,
      input: { environmentId: "build-box" },
    });
  });

  it("sends only the field an edit changed", () => {
    const renamed = peerEditDraftToInput({ ...peerToEditDraft(peer), name: "Builder" }, peer);
    expect(renamed).toMatchObject({ ok: true, changed: true });
    expect(expectOk(renamed)).toEqual({ environmentId: "build-box", name: "Builder" });

    const narrowed = peerEditDraftToInput(
      {
        ...peerToEditDraft(peer),
        permissionsJson: JSON.stringify({ inbound: [], forwardEventTypes: [] }),
      },
      peer,
    );
    expect(expectOk(narrowed)).toEqual({
      environmentId: "build-box",
      permissions: { inbound: [], forwardEventTypes: [] },
    });
  });

  it("rejects an edit with a blank name or a URL that is not http", () => {
    expect(
      expectErrors(
        peerEditDraftToInput({ ...peerToEditDraft(peer), name: "", httpBaseUrl: "build" }, peer),
      ),
    ).toEqual(["Give the peer a name.", "The peer URL must start with http:// or https://."]);
  });
});

describe("execution node drafts", () => {
  const node: ExecutionNode = {
    id: ExecutionNodeId.make("build-box"),
    environmentId: EnvironmentId.make("laptop"),
    label: "Build box",
    transport: { type: "ssh", target: "dev@build", port: 2222, identityFile: "~/.ssh/build" },
    enabled: false,
    workspaceRoots: ["/srv/build", "/srv/with, comma"],
    allowShell: true,
    availability: {
      status: "unknown",
      os: null,
      arch: null,
      tools: [],
      error: null,
      observedAt: null,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  it("round-trips an SSH node, keeping a root that contains a comma whole", () => {
    expect(expectOk(executionNodeDraftToInput(executionNodeToDraft(node)))).toEqual({
      id: "build-box",
      label: "Build box",
      transport: node.transport,
      enabled: false,
      workspaceRoots: ["/srv/build", "/srv/with, comma"],
      allowShell: true,
    });
  });

  it("round-trips the local node and drops SSH fields left in the form", () => {
    const local = { ...node, transport: { type: "local" } as const };
    const input = expectOk(
      executionNodeDraftToInput({ ...executionNodeToDraft(local), sshTarget: "leftover@host" }),
    );
    expect(input.transport).toEqual({ type: "local" });
  });

  it("creates a node that cannot run a shell until the user allows it", () => {
    const input = expectOk(
      executionNodeDraftToInput({
        ...emptyExecutionNodeDraft(),
        label: "New box",
        sshTarget: "me@host",
        workspaceRoots: " /a \n\n/a\n/b",
      }),
    );
    expect(input).toEqual({
      label: "New box",
      transport: { type: "ssh", target: "me@host" },
      enabled: true,
      workspaceRoots: ["/a", "/b"],
      allowShell: false,
    });
  });

  it("allows a node with no workspace root, which runs nothing", () => {
    const input = expectOk(
      executionNodeDraftToInput({ ...emptyExecutionNodeDraft(), label: "Idle", sshTarget: "h" }),
    );
    expect(input.workspaceRoots).toEqual([]);
  });

  it("reports the missing fields of an empty draft", () => {
    expect(expectErrors(executionNodeDraftToInput(emptyExecutionNodeDraft()))).toEqual([
      "Give the node a name.",
      "Enter the SSH target, such as dev@build.",
    ]);
  });

  it("checks the SSH port at its boundaries", () => {
    const draft = executionNodeToDraft(node);
    expect(
      (
        expectOk(executionNodeDraftToInput({ ...draft, sshPort: "65535" })).transport as {
          port: number;
        }
      ).port,
    ).toBe(65_535);
    for (const sshPort of ["0", "65536", "22.5", "-1", "ssh"]) {
      expect(expectErrors(executionNodeDraftToInput({ ...draft, sshPort })), sshPort).toHaveLength(
        1,
      );
    }
  });

  it("refuses a connection type it cannot edit", () => {
    expect(
      expectErrors(
        executionNodeDraftToInput({ ...executionNodeToDraft(node), transportType: "wsl" }),
      )[0],
    ).toMatch(/not a connection/);
  });
});
