import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadHandoffId,
  ThreadId,
  type ThreadHandoffRecord,
  type ThreadHandoffManifest,
  type ThreadHandoffResponse,
  type ThreadHandoffRequest,
  type ThreadHandoffSource,
} from "@t3tools/contracts";
import { expect, test } from "vite-plus/test";
import {
  recoverThreadHandoff,
  runThreadHandoff,
  type RunThreadHandoffInput,
  type ThreadHandoffDeps,
  type ThreadHandoffProgress,
} from "./threadHandoff.ts";

const sourceEnvironmentId = EnvironmentId.make("source");
const destinationEnvironmentId = EnvironmentId.make("destination");
const handoffId = ThreadHandoffId.make("client-transfer");
const threadId = ThreadId.make("thread");
const source: ThreadHandoffSource = {
  owner: { threadId, environmentId: sourceEnvironmentId, generation: 0 },
  projectId: ProjectId.make("project"),
  providerInstanceId: ProviderInstanceId.make("claude"),
  driver: ProviderDriverKind.make("claudeAgent"),
  version: "2.1.260",
  sessionId: "11111111-1111-4111-8111-111111111111",
};
const input: RunThreadHandoffInput = {
  handoffId,
  sourceEnvironmentId,
  threadId,
  mode: "idle",
  destination: {
    environmentId: destinationEnvironmentId,
    providerInstanceId: ProviderInstanceId.make("destination-claude"),
    projects: [
      {
        sourceProjectId: source.projectId,
        destinationProjectId: ProjectId.make("destination-project"),
      },
    ],
  },
};
const createdAt = "2026-09-08T12:00:00.000Z";
const initial: ThreadHandoffRecord = {
  handoffId,
  owner: source.owner,
  destinationEnvironmentId,
  phase: "preflighting",
  revision: 0,
  failure: null,
  createdAt,
  updatedAt: createdAt,
};
const manifest: ThreadHandoffManifest = {
  version: 1,
  handoffId,
  owner: source.owner,
  destinationEnvironmentId,
  createdAt,
  projects: [],
  provider: {
    driver: source.driver,
    mode: "native",
    sessionId: source.sessionId,
    directory: "provider",
  },
  threadFile: "thread.json",
  files: [{ path: "thread.json", kind: "file", size: 7, hash: "a".repeat(64) }],
};
function fixture(
  options: {
    fail?: string;
    loseCommitResponse?: boolean;
    commitLands?: boolean;
    failStatus?: boolean;
    after?: (operation: string) => void;
  } = {},
) {
  const calls: string[] = [];
  const progress: ThreadHandoffProgress[] = [];
  let record = initial;
  let activated = false;
  let activations = 0;
  const respond = (
    environmentId: EnvironmentId,
    request: ThreadHandoffRequest,
  ): ThreadHandoffResponse => {
    switch (request.operation) {
      case "inspect":
        return { source };
      case "preflight":
        return { destination: request.destination };
      case "prepareSource":
        record = { ...record, phase: "checkpointing", revision: 2 };
        return { record, manifest };
      case "prepareDestination":
        return {};
      case "manifest":
        return { files: [] };
      case "export":
        return { url: "/export", expiresAt: 1234 };
      case "import":
        return { url: "/import", expiresAt: 1234 };
      case "verify":
        return {
          ready: {
            handoffId,
            environmentId,
            sessionId: source.sessionId,
            manifestHash: "manifest-hash",
          },
        };
      case "commit":
        if (options.commitLands !== false) record = { ...record, phase: "committed", revision: 7 };
        if (options.loseCommitResponse) throw new Error("Commit response lost");
        return { record };
      case "activate":
        if (!activated) {
          activated = true;
          activations++;
        }
        return { record: { ...request.record, localEnvironmentId: environmentId } };
      case "complete":
        record = { ...record, phase: "completed", revision: 8 };
        return { record };
      case "status":
        return { record };
      case "reject":
        return {};
      case "beginRollback":
        if (
          record.phase !== "committed" &&
          record.phase !== "completed" &&
          record.phase !== "failed"
        )
          record = { ...record, phase: "rollingBack", revision: record.revision + 1 };
        return { record };
      case "rollback":
        record = {
          ...record,
          phase: "failed",
          revision: record.revision + 1,
          failure: "Rolled back",
        };
        return { record };
    }
  };
  const deps: ThreadHandoffDeps = {
    request: async (environmentId, request) => {
      const operation = `${environmentId}:${request.operation}`;
      calls.push(operation);
      if (operation === options.fail || (request.operation === "status" && options.failStatus))
        throw new Error(`Unavailable ${operation}`);
      const response = respond(environmentId, request);
      options.after?.(operation);
      return response;
    },
    resolveUrl: (environmentId, url) => `https://${environmentId}${url}`,
    fetch: async (_url, init) => {
      calls.push(`fetch:${init?.method}`);
      return new Response(init?.method === "GET" ? "archive" : null, { status: 200 });
    },
    streamingUploadSupported: false,
  };
  return {
    deps,
    calls,
    progress,
    input: { ...input, onProgress: (event: ThreadHandoffProgress) => progress.push(event) },
    record: () => record,
    activations: () => activations,
  };
}
const recoveryInput = { handoffId, threadId, sourceEnvironmentId, destinationEnvironmentId };

test("orders native transfer through Project Sync then commits and activates exactly one destination", async () => {
  const f = fixture();
  expect((await runThreadHandoff(f.deps, f.input)).phase).toBe("completed");
  expect(f.calls).toEqual([
    "source:inspect",
    "destination:preflight",
    "source:prepareSource",
    "destination:prepareDestination",
    "destination:manifest",
    "source:export",
    "fetch:GET",
    "destination:import",
    "fetch:POST",
    "destination:verify",
    "source:commit",
    "destination:activate",
    "source:complete",
  ]);
  expect(f.progress.some((event) => event.transfer?.transferredBytes === 7)).toBe(true);
  expect(f.progress.at(-1)?.phase).toBe("completed");
  expect(f.activations()).toBe(1);
});

test("offline destination fails preflight before freezing source", async () => {
  const f = fixture({ fail: "destination:preflight" });
  await expect(runThreadHandoff(f.deps, f.input)).rejects.toThrow("Unavailable");
  expect(f.calls).toEqual(["source:inspect", "destination:preflight"]);
  expect(f.record().phase).toBe("preflighting");
});

test("cancellation after source preparation revokes destination before rolling source back", async () => {
  const controller = new AbortController();
  const f = fixture({
    after: (operation) => {
      if (operation === "source:prepareSource") controller.abort();
    },
  });
  await expect(runThreadHandoff(f.deps, { ...f.input, signal: controller.signal })).rejects.toThrow(
    "cancelled",
  );
  expect(f.calls.slice(-3)).toEqual([
    "source:beginRollback",
    "destination:reject",
    "source:rollback",
  ]);
  expect(f.calls).not.toContain("source:commit");
  expect(f.record().phase).toBe("failed");
});

test("verification failure rolls back only after destination revocation acknowledges", async () => {
  const f = fixture({ fail: "destination:verify" });
  await expect(runThreadHandoff(f.deps, f.input)).rejects.toThrow("Unavailable");
  expect(f.calls.slice(-3)).toEqual([
    "source:beginRollback",
    "destination:reject",
    "source:rollback",
  ]);
  expect(f.calls).not.toContain("destination:activate");
});

test("failed revocation preserves the source fence for explicit recovery", async () => {
  const controller = new AbortController();
  const f = fixture({
    fail: "destination:reject",
    after: (operation) => {
      if (operation === "destination:prepareDestination") controller.abort();
    },
  });
  await expect(
    runThreadHandoff(f.deps, { ...f.input, signal: controller.signal }),
  ).rejects.toMatchObject({ code: "recoveryRequired" });
  expect(f.calls.at(-1)).toBe("destination:reject");
  expect(f.calls).not.toContain("source:rollback");
  expect(f.record().phase).toBe("rollingBack");
});

test("lost commit response reads durable source ownership and finishes destination without rollback", async () => {
  const f = fixture({ loseCommitResponse: true });
  expect((await runThreadHandoff(f.deps, f.input)).phase).toBe("completed");
  expect(f.calls.slice(-4)).toEqual([
    "source:commit",
    "source:status",
    "destination:activate",
    "source:complete",
  ]);
  expect(f.calls).not.toContain("source:rollback");
  expect(f.calls).not.toContain("destination:reject");
});

test("unreadable ownership after lost commit acknowledgement leaves both rollback paths untouched", async () => {
  const f = fixture({ loseCommitResponse: true, failStatus: true });
  await expect(runThreadHandoff(f.deps, f.input)).rejects.toMatchObject({
    code: "recoveryRequired",
  });
  expect(f.calls.at(-1)).toBe("source:status");
  expect(f.calls).not.toContain("destination:reject");
  expect(f.calls).not.toContain("source:rollback");
  expect(f.calls).not.toContain("destination:activate");
});

test("a commit confirmed not to have landed can be revoked and rolled back", async () => {
  const f = fixture({ loseCommitResponse: true, commitLands: false });
  await expect(runThreadHandoff(f.deps, f.input)).rejects.toThrow("Commit response lost");
  expect(f.calls.slice(-4)).toEqual([
    "source:status",
    "source:beginRollback",
    "destination:reject",
    "source:rollback",
  ]);
});

test("postcommit activation failure recovers at destination without releasing source", async () => {
  const options = { fail: "destination:activate" };
  const f = fixture(options);
  await expect(runThreadHandoff(f.deps, f.input)).rejects.toMatchObject({
    code: "recoveryRequired",
  });
  expect(f.record().phase).toBe("committed");
  expect(f.calls).not.toContain("source:rollback");
  options.fail = "";
  expect((await recoverThreadHandoff(f.deps, recoveryInput)).phase).toBe("completed");
  expect(f.activations()).toBe(1);
});

test("lost completion response can recover without starting native execution again", async () => {
  const options = { fail: "source:complete" };
  const f = fixture(options);
  await expect(runThreadHandoff(f.deps, f.input)).rejects.toMatchObject({
    code: "recoveryRequired",
  });
  options.fail = "";
  expect((await recoverThreadHandoff(f.deps, recoveryInput)).phase).toBe("completed");
  expect(f.activations()).toBe(1);
  expect(f.calls).not.toContain("source:rollback");
});

test("explicit recovery of precommit work acknowledges revocation before source rollback", async () => {
  const f = fixture();
  await f.deps.request(sourceEnvironmentId, {
    operation: "prepareSource",
    handoffId,
    destination: { ...input.destination, source },
    mode: "idle",
  });
  expect((await recoverThreadHandoff(f.deps, recoveryInput)).phase).toBe("failed");
  expect(f.calls.slice(-4)).toEqual([
    "source:status",
    "source:beginRollback",
    "destination:reject",
    "source:rollback",
  ]);
});

test("already synchronized staging takes the metadata-only path", async () => {
  const f = fixture();
  const request = f.deps.request;
  const deps = {
    ...f.deps,
    request: async (environmentId: EnvironmentId, input: ThreadHandoffRequest) => {
      const response = await request(environmentId, input);
      return input.operation === "manifest" ? { files: manifest.files } : response;
    },
  };
  expect((await runThreadHandoff(deps, f.input)).phase).toBe("completed");
  expect(f.calls).not.toContain("source:export");
  expect(f.calls).not.toContain("destination:import");
  expect(f.calls.some((call) => call.startsWith("fetch:"))).toBe(false);
});

test("cancellation after the commit point does not revoke committed ownership", async () => {
  const controller = new AbortController();
  const f = fixture({
    after: (operation) => {
      if (operation === "source:commit") controller.abort();
    },
  });
  expect((await runThreadHandoff(f.deps, { ...f.input, signal: controller.signal })).phase).toBe(
    "completed",
  );
  expect(f.calls).not.toContain("destination:reject");
  expect(f.calls).not.toContain("source:rollback");
});

test("recovering completed ownership retries source cleanup without reactivating destination", async () => {
  const f = fixture();
  await runThreadHandoff(f.deps, f.input);
  const previous = f.calls.length;
  expect((await recoverThreadHandoff(f.deps, recoveryInput)).phase).toBe("completed");
  expect(f.calls.slice(previous)).toEqual(["source:status", "source:complete"]);
  expect(f.activations()).toBe(1);
});

test("cancel while waiting for a turn durably fences source without waiting for prepare acknowledgement", async () => {
  const f = fixture();
  const controller = new AbortController();
  const request = f.deps.request;
  const deps: ThreadHandoffDeps = {
    ...f.deps,
    request: async (environmentId, command) => {
      if (command.operation === "prepareSource") {
        controller.abort();
        return new Promise<ThreadHandoffResponse>(() => {});
      }
      return request(environmentId, command);
    },
  };
  await expect(
    runThreadHandoff(deps, { ...f.input, mode: "afterTurn", signal: controller.signal }),
  ).rejects.toThrow("cancelled");
  expect(f.calls.slice(-3)).toEqual([
    "source:beginRollback",
    "destination:reject",
    "source:rollback",
  ]);
  expect(f.record().phase).toBe("failed");
});

test("source preparation rejected before a journal exists preserves its diagnostic after recording cancellation", async () => {
  const f = fixture({ fail: "source:prepareSource" });
  await expect(runThreadHandoff(f.deps, f.input)).rejects.toThrow(
    "Unavailable source:prepareSource",
  );
  expect(f.calls.slice(-3)).toEqual([
    "source:beginRollback",
    "destination:reject",
    "source:rollback",
  ]);
  expect(f.record().phase).toBe("failed");
});

test("concurrent commit winning the rollback decision activates instead of revoking destination", async () => {
  const f = fixture();
  const request = f.deps.request;
  const deps: ThreadHandoffDeps = {
    ...f.deps,
    request: async (environmentId, command) => {
      if (command.operation === "beginRollback") {
        await request(sourceEnvironmentId, {
          operation: "commit",
          receipt: {
            handoffId,
            environmentId: destinationEnvironmentId,
            sessionId: source.sessionId,
            manifestHash: "manifest-hash",
          },
        });
      }
      return request(environmentId, command);
    },
  };
  expect((await recoverThreadHandoff(deps, recoveryInput)).phase).toBe("completed");
  expect(f.calls).not.toContain("destination:reject");
  expect(f.calls).not.toContain("source:rollback");
  expect(f.activations()).toBe(1);
});

test("preflight cannot replace the requested provider or repository mapping", async () => {
  const f = fixture();
  const request = f.deps.request;
  const deps: ThreadHandoffDeps = {
    ...f.deps,
    request: async (environmentId, command) =>
      command.operation === "preflight"
        ? {
            destination: {
              ...command.destination,
              providerInstanceId: ProviderInstanceId.make("unexpected-provider"),
            },
          }
        : request(environmentId, command),
  };
  await expect(runThreadHandoff(deps, f.input)).rejects.toMatchObject({
    code: "verificationFailed",
  });
  expect(f.calls).not.toContain("source:prepareSource");
});

test("verified destination Git objects reach both prepare requests without replacing source facts", async () => {
  const f = fixture();
  const request = f.deps.request;
  const head = "a".repeat(40);
  const inspectedSource = {
    ...source,
    repositories: [{ projectId: source.projectId, head, rootCommits: [head], remoteIds: [] }],
  };
  const preparations: ThreadHandoffRequest[] = [];
  const deps: ThreadHandoffDeps = {
    ...f.deps,
    request: async (environmentId, command) => {
      if (command.operation === "inspect") {
        expect(command.projectIds).toEqual([source.projectId]);
        return { source: inspectedSource };
      }
      if (command.operation === "preflight")
        return {
          destination: {
            ...command.destination,
            projects: command.destination.projects.map((project) => ({
              ...project,
              availableHead: head,
            })),
          },
        };
      if (command.operation === "prepareSource" || command.operation === "prepareDestination") {
        preparations.push(command);
        expect(command.destination.projects[0]?.availableHead).toBe(head);
        expect(command.destination.source).toEqual(inspectedSource);
      }
      return request(environmentId, command);
    },
  };
  expect((await runThreadHandoff(deps, f.input)).phase).toBe("completed");
  expect(preparations).toHaveLength(2);
});

for (const invalid of ["missing", "identity", "generation", "phase", "environment"] as const) {
  test(`invalid activation ${invalid} acknowledgement retains committed source recovery`, async () => {
    const f = fixture();
    const request = f.deps.request;
    const deps: ThreadHandoffDeps = {
      ...f.deps,
      request: async (environmentId, command) => {
        const response = await request(environmentId, command);
        if (command.operation !== "activate") return response;
        if (invalid === "missing") return {};
        const record = response.record!;
        return {
          record: {
            ...record,
            ...(invalid === "identity"
              ? { handoffId: ThreadHandoffId.make("another-transfer") }
              : {}),
            ...(invalid === "generation"
              ? { owner: { ...record.owner, generation: record.owner.generation + 1 } }
              : {}),
            ...(invalid === "phase" ? { phase: "preflighting" as const } : {}),
            ...(invalid === "environment" ? { localEnvironmentId: sourceEnvironmentId } : {}),
          },
        };
      },
    };
    await expect(runThreadHandoff(deps, f.input)).rejects.toMatchObject({
      code: "recoveryRequired",
    });
    expect(f.record().phase).toBe("committed");
    expect(f.calls).not.toContain("source:complete");
    expect(f.calls).not.toContain("destination:reject");
    expect((await recoverThreadHandoff(f.deps, recoveryInput)).phase).toBe("completed");
    expect(f.activations()).toBe(1);
  });
}

test("moves Codex context to an explicitly selected OpenCode model without a native resume identity", async () => {
  const f = fixture();
  const original = f.deps.request;
  const contextSource = {
    ...source,
    driver: ProviderDriverKind.make("codex"),
    sessionId: "codex-native-session",
  };
  const contextManifest = {
    ...manifest,
    provider: {
      driver: contextSource.driver,
      mode: "context" as const,
      directory: "provider" as const,
    },
  };
  const selected = {
    instanceId: ProviderInstanceId.make("opencode-destination"),
    model: "local/k3",
  };
  const observed: ThreadHandoffRequest[] = [];
  const deps: ThreadHandoffDeps = {
    ...f.deps,
    request: async (environment, request) => {
      observed.push(request);
      const result = await original(environment, request);
      if (request.operation === "inspect") return { source: contextSource };
      if (request.operation === "prepareSource") return { ...result, manifest: contextManifest };
      if (request.operation === "verify")
        return { ...result, ready: { ...result.ready!, sessionId: undefined } };
      return result;
    },
  };
  const result = await runThreadHandoff(deps, {
    ...input,
    destination: {
      ...input.destination,
      transferMode: "context",
      providerInstanceId: selected.instanceId,
      modelSelection: selected,
    },
  });
  expect(result.phase).toBe("completed");
  const preparation = observed.find((request) => request.operation === "prepareDestination");
  expect(
    preparation?.operation === "prepareDestination" && preparation.destination.modelSelection,
  ).toEqual(selected);
  expect(
    preparation?.operation === "prepareDestination" && preparation.manifest.provider.sessionId,
  ).toBeUndefined();
});

for (const change of ["mode", "model"] as const) {
  test(`rejects preflight changing the requested ${change}`, async () => {
    const f = fixture();
    const original = f.deps.request;
    const deps: ThreadHandoffDeps = {
      ...f.deps,
      request: async (environment, request) => {
        if (request.operation === "preflight")
          return {
            destination: {
              ...request.destination,
              ...(change === "mode"
                ? { transferMode: "native" as const }
                : {
                    modelSelection: {
                      instanceId: request.destination.providerInstanceId,
                      model: "unrequested",
                    },
                  }),
            },
          };
        return original(environment, request);
      },
    };
    await expect(
      runThreadHandoff(deps, {
        ...input,
        destination: {
          ...input.destination,
          transferMode: "context",
          modelSelection: {
            instanceId: input.destination.providerInstanceId,
            model: "chosen-model",
          },
        },
      }),
    ).rejects.toMatchObject({ code: "verificationFailed" });
    expect(f.calls).not.toContain("source:prepareSource");
  });
}
