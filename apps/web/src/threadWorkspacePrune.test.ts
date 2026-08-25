import type { EnvironmentId } from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { DraftId } from "./composerDraftStore";
import { createThreadWorkspaceRetain } from "./threadWorkspacePrune";
import { threadWorkspaceTargetKey, type ThreadWorkspaceTarget } from "./threadWorkspaceStore";

const ENV_A = "env-a" as EnvironmentId;
const ENV_B = "env-b" as EnvironmentId;

const serverTarget = (environmentId: EnvironmentId, id: string): ThreadWorkspaceTarget => ({
  routeKind: "server",
  environmentId,
  threadId: ThreadId.make(id),
});

const draftTarget = (draftId: string): ThreadWorkspaceTarget => ({
  routeKind: "draft",
  draftId: DraftId.make(draftId),
  environmentId: ENV_A,
  threadId: ThreadId.make(draftId),
});

const retain = (overrides: Partial<Parameters<typeof createThreadWorkspaceRetain>[0]> = {}) =>
  createThreadWorkspaceRetain({
    scope: { known: new Set([ENV_A, ENV_B]), loaded: new Set([ENV_A]) },
    knownThreadKeys: new Set([threadWorkspaceTargetKey(serverTarget(ENV_A, "alive"))]),
    retainedKeys: new Set(),
    hasDraft: () => true,
    ...overrides,
  });

describe("createThreadWorkspaceRetain", () => {
  it("keeps every tab until the environment catalog has resolved", () => {
    const keep = retain({ scope: null, knownThreadKeys: new Set() });

    expect(keep(serverTarget(ENV_A, "gone"))).toBe(true);
  });

  it("keeps tabs of an environment that is known but has not loaded yet", () => {
    const keep = retain();

    // ENV_B is configured but still syncing, so its threads cannot be judged.
    expect(keep(serverTarget(ENV_B, "unknown-so-far"))).toBe(true);
  });

  it("drops a thread a loaded environment did not report", () => {
    const keep = retain();

    expect(keep(serverTarget(ENV_A, "alive"))).toBe(true);
    expect(keep(serverTarget(ENV_A, "deleted"))).toBe(false);
  });

  it("drops tabs for an environment this device no longer has", () => {
    const keep = retain({ scope: { known: new Set([ENV_A]), loaded: new Set([ENV_A]) } });

    expect(keep(serverTarget(ENV_B, "orphan"))).toBe(false);
  });

  it("never drops a retained key even when the environment disowns it", () => {
    const routed = serverTarget(ENV_A, "deleted");
    const keep = retain({ retainedKeys: new Set([threadWorkspaceTargetKey(routed)]) });

    expect(keep(routed)).toBe(true);
  });

  it("keeps a draft tab only while its draft session exists", () => {
    const alive = draftTarget("draft-alive");
    const gone = draftTarget("draft-gone");
    const keep = retain({ hasDraft: (draftId) => String(draftId) === "draft-alive" });

    expect(keep(alive)).toBe(true);
    expect(keep(gone)).toBe(false);
  });
});
