import { useAtomValue } from "@effect/atom-react";
import { createAutomationEnvironmentAtoms } from "@t3tools/client-runtime/state/automation";
import {
  automationThreadKey,
  type OrchestratorThreadMarker,
  type OrchestratorView,
} from "@t3tools/client-runtime/state/automation-presentation";
import type { EnvironmentId, OrchestratorId, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useMemo } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentServerConfigsAtom } from "./server";

export const automationEnvironment = createAutomationEnvironmentAtoms(connectionAtomRuntime, {
  serverConfigsAtom: environmentServerConfigsAtom,
});

const NO_MARKER_ATOM = Atom.make<OrchestratorThreadMarker | null>(null).pipe(
  Atom.withLabel("mobile-automation:no-orchestrator-marker"),
);

/** Environments whose server speaks the automation RPCs. Empty against older servers. */
export function useAutomationEnvironmentIds(): ReadonlyArray<EnvironmentId> {
  return useAtomValue(automationEnvironment.automationEnvironmentIdsAtom);
}

/** The orchestrator marker for a thread row or header. Null for every ordinary thread. */
export function useOrchestratorThreadMarker(
  environmentId: EnvironmentId | null | undefined,
  threadId: ThreadId | null | undefined,
): OrchestratorThreadMarker | null {
  return useAtomValue(
    environmentId == null || threadId == null
      ? NO_MARKER_ATOM
      : automationEnvironment.orchestratorMarkerAtom(automationThreadKey(environmentId, threadId)),
  );
}

/** One orchestrator as its environment reports it, for the orchestrator screen. */
export function useOrchestratorView(
  environmentId: EnvironmentId,
  orchestratorId: OrchestratorId,
): OrchestratorView | null {
  const views = useAtomValue(automationEnvironment.orchestratorViewsAtom);
  return useMemo(
    () =>
      views.find(
        (view) => view.environmentId === environmentId && view.orchestrator.id === orchestratorId,
      ) ?? null,
    [environmentId, orchestratorId, views],
  );
}
