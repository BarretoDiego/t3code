import type { EnvironmentId } from "@t3tools/contracts";

import type { DraftId } from "./composerDraftStore";
import { threadWorkspaceTargetKey, type ThreadWorkspaceTarget } from "./threadWorkspaceStore";

export interface ThreadWorkspacePruneScope {
  /** Every environment this device is configured for. */
  readonly known: ReadonlySet<EnvironmentId>;
  /** The subset that has delivered a snapshot and can be trusted to be complete. */
  readonly loaded: ReadonlySet<EnvironmentId>;
}

/**
 * Decides which restored tabs are still real.
 *
 * A persisted workspace outlives the threads in it, so reopening the app can
 * surface tabs for threads that were deleted meanwhile. The dangerous mistake
 * is the opposite one: dropping a tab because its environment is offline, or
 * simply has not finished loading, would quietly erase a workspace every time
 * the network is slow. So the default is always to keep, and a tab is only
 * dropped when this device can prove the thread is gone:
 *
 * - the catalog has not resolved yet (`scope === null`) — keep everything
 * - the environment is unknown to this device — drop, it is not coming back here
 * - the environment is known but not loaded — keep, it may still arrive
 * - the environment is loaded — keep only threads it actually reported
 *
 * `retainedKeys` covers targets the caller must not lose regardless, in
 * practice the routed one: the router always needs a tab to represent.
 */
export function createThreadWorkspaceRetain(input: {
  readonly scope: ThreadWorkspacePruneScope | null;
  readonly knownThreadKeys: ReadonlySet<string>;
  readonly retainedKeys: ReadonlySet<string>;
  readonly hasDraft: (draftId: DraftId) => boolean;
}): (target: ThreadWorkspaceTarget) => boolean {
  return (target) => {
    const key = threadWorkspaceTargetKey(target);
    if (input.retainedKeys.has(key)) return true;
    if (target.routeKind === "draft") return input.hasDraft(target.draftId);
    if (input.scope === null) return true;
    if (!input.scope.known.has(target.environmentId)) return false;
    if (!input.scope.loaded.has(target.environmentId)) return true;
    return input.knownThreadKeys.has(key);
  };
}
