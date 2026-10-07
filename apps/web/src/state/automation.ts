import { useAtomValue } from "@effect/atom-react";
import { createAutomationEnvironmentAtoms } from "@t3tools/client-runtime/state/automation";
import {
  automationThreadKey,
  environmentSupportsAutomation,
  type OrchestratorThreadMarker,
  type OrchestratorView,
  type ThreadResponsibilityMarker,
} from "@t3tools/client-runtime/state/automation-presentation";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "./server";

export const automationEnvironment = createAutomationEnvironmentAtoms(connectionAtomRuntime, {
  serverConfigsAtom: environmentServerConfigsAtom,
});

const NO_MARKER_ATOM = Atom.make<OrchestratorThreadMarker | null>(null).pipe(
  Atom.withLabel("web-automation:no-orchestrator-marker"),
);
const NO_VIEW_ATOM = Atom.make<OrchestratorView | null>(null).pipe(
  Atom.withLabel("web-automation:no-orchestrator-view"),
);
const NO_RESPONSIBILITY_ATOM = Atom.make<ThreadResponsibilityMarker | null>(null).pipe(
  Atom.withLabel("web-automation:no-thread-responsibility"),
);

function threadKey(ref: ScopedThreadRef | null): string | null {
  return ref === null ? null : automationThreadKey(ref.environmentId, ref.threadId);
}

/** Whether the environment's server speaks the automation RPCs. False on older servers. */
export function readEnvironmentSupportsAutomation(environmentId: EnvironmentId): boolean {
  return environmentSupportsAutomation(
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId),
  );
}

export function useAutomationEnvironmentIds(): ReadonlyArray<EnvironmentId> {
  return useAtomValue(automationEnvironment.automationEnvironmentIdsAtom);
}

/** The orchestrator marker for a thread row. Null for every ordinary thread. */
export function useOrchestratorThreadMarker(
  ref: ScopedThreadRef | null,
): OrchestratorThreadMarker | null {
  const key = threadKey(ref);
  return useAtomValue(
    key === null ? NO_MARKER_ATOM : automationEnvironment.orchestratorMarkerAtom(key),
  );
}

/** The full orchestrator whose main thread this is, for the details panel. */
export function useThreadOrchestrator(ref: ScopedThreadRef | null): OrchestratorView | null {
  const key = threadKey(ref);
  return useAtomValue(
    key === null ? NO_VIEW_ATOM : automationEnvironment.orchestratorViewAtom(key),
  );
}

/** Set when something other than the user is responsible for a request on the thread. */
export function useThreadResponsibilityMarker(
  ref: ScopedThreadRef | null,
): ThreadResponsibilityMarker | null {
  const key = threadKey(ref);
  return useAtomValue(
    key === null ? NO_RESPONSIBILITY_ATOM : automationEnvironment.threadResponsibilityAtom(key),
  );
}

export function readThreadOrchestrator(ref: ScopedThreadRef): OrchestratorView | null {
  return appAtomRegistry.get(
    automationEnvironment.orchestratorViewAtom(
      automationThreadKey(ref.environmentId, ref.threadId),
    ),
  );
}
