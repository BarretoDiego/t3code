import { useCallback, useMemo } from "react";
import {
  createEnvironmentRpcCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ThreadHandoffDeps } from "@t3tools/client-runtime/operations/thread-handoff";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readThreadShell } from "./entities";
import { environmentServerConfigsAtom } from "./server";
import { connectionAtomRuntime } from "../connection/runtime";
import { useAtomCommand } from "./use-atom-command";
import { useProjectSyncDeps } from "./projectSync";

const requestHandoff = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "thread-handoff-request",
  tag: "threadHandoff.request",
});

export function useThreadHandoffDeps(): ThreadHandoffDeps {
  const command = useAtomCommand(requestHandoff, { reportFailure: false });
  const projectSync = useProjectSyncDeps();
  const request: ThreadHandoffDeps["request"] = useCallback(
    async (environmentId, input) => {
      const result = await command({ environmentId, input });
      if (result._tag !== "Success") throw squashAtomCommandFailure(result);
      return result.value;
    },
    [command],
  );
  return useMemo(
    () => ({ request, fetch: projectSync.fetch, resolveUrl: projectSync.resolveUrl }),
    [request, projectSync.fetch, projectSync.resolveUrl],
  );
}

export const THREAD_HANDOFF_EVENT = "t3:thread-handoff";
export function openThreadHandoff(threadRef: ScopedThreadRef): void {
  window.dispatchEvent(new CustomEvent(THREAD_HANDOFF_EVENT, { detail: threadRef }));
}

export function canHandoffThread(threadRef: ScopedThreadRef): boolean {
  const config = appAtomRegistry.get(environmentServerConfigsAtom).get(threadRef.environmentId);
  const thread = readThreadShell(threadRef);
  if (!thread || config?.environment.capabilities.threadHandoff !== true) return false;
  const instanceId = thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
  return config.providers.some(
    (provider) =>
      provider.instanceId === instanceId &&
      provider.enabled &&
      provider.supportsSessionHandoff === true,
  );
}
