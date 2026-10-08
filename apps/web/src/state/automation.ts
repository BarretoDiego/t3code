import { useAtomValue } from "@effect/atom-react";
import {
  createAutomationEnvironmentAtoms,
  type ThreadAutomationMarkers,
} from "@t3tools/client-runtime/state/automation";
import {
  automationThreadKey,
  type OrchestratorView,
  presentResponsibility,
  resolveOrchestratorView,
  type ResponsibilityLookup,
  type ResponsibilityPresentation,
} from "@t3tools/client-runtime/state/automation-presentation";
import type {
  EnvironmentId,
  PendingRequestSummary,
  RuntimeRequestId,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useMemo } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "./server";
import { environmentThreadShells } from "./threads";

export const automationEnvironment = createAutomationEnvironmentAtoms(connectionAtomRuntime, {
  serverConfigsAtom: environmentServerConfigsAtom,
});

const NO_MARKERS_ATOM = Atom.make<ThreadAutomationMarkers | null>(null).pipe(
  Atom.withLabel("web-automation:no-thread-markers"),
);
const NO_VIEW_ATOM = Atom.make<OrchestratorView | null>(null).pipe(
  Atom.withLabel("web-automation:no-orchestrator-view"),
);

const NO_INPUT = {};
const NO_REQUESTS_ATOM = Atom.make(
  AsyncResult.initial<{ readonly requests: ReadonlyArray<PendingRequestSummary> }, never>(false),
).pipe(Atom.withLabel("web-automation:no-pending-requests"));

function threadKey(ref: ScopedThreadRef | null): string | null {
  return ref === null ? null : automationThreadKey(ref.environmentId, ref.threadId);
}

export function useAutomationEnvironmentIds(): ReadonlyArray<EnvironmentId> {
  return useAtomValue(automationEnvironment.automationEnvironmentIdsAtom);
}

/**
 * What a thread row marks: its orchestrator, and requests something other than
 * the user is responsible for. Null for every ordinary thread.
 */
export function useThreadAutomationMarkers(
  ref: ScopedThreadRef | null,
): ThreadAutomationMarkers | null {
  const key = threadKey(ref);
  return useAtomValue(
    key === null ? NO_MARKERS_ATOM : automationEnvironment.threadMarkersAtom(key),
  );
}

/** The full orchestrator whose main thread this is, for the details panel. */
export function useThreadOrchestrator(ref: ScopedThreadRef | null): OrchestratorView | null {
  const key = threadKey(ref);
  return useAtomValue(
    key === null ? NO_VIEW_ATOM : automationEnvironment.orchestratorViewAtom(key),
  );
}

/**
 * Names for the owner of a claim. Thread titles are read once, not followed:
 * a note under a request does not need to re-render when any thread changes.
 */
export function useResponsibilityLookup(environmentId: EnvironmentId): ResponsibilityLookup {
  const views = useAtomValue(automationEnvironment.orchestratorViewsAtom);
  return useMemo(
    () => ({
      orchestratorName: (orchestratorId, hostEnvironmentId) =>
        resolveOrchestratorView(views, orchestratorId, hostEnvironmentId)?.orchestrator.name ??
        null,
      threadTitle: (threadId) =>
        appAtomRegistry.get(environmentThreadShells.threadShellAtom({ environmentId, threadId }))
          ?.title ?? null,
    }),
    [environmentId, views],
  );
}

/**
 * Who is responsible for one pending request, from the environment's shared
 * pending-request list. Null when the server has no automation, the list has
 * not loaded, or the request is not in it.
 */
export function usePendingRequestResponsibility(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  requestId: RuntimeRequestId,
): ResponsibilityPresentation | null {
  const supported = useAtomValue(automationEnvironment.automationEnvironmentIdsAtom).includes(
    environmentId,
  );
  const result = useAtomValue(
    supported
      ? automationEnvironment.pendingRequests({ environmentId, input: NO_INPUT })
      : NO_REQUESTS_ATOM,
  );
  const lookup = useResponsibilityLookup(environmentId);
  const request = Option.getOrNull(AsyncResult.value(result))?.requests.find(
    (entry) => entry.threadId === threadId && entry.requestId === requestId,
  );
  return useMemo(
    () => (request === undefined ? null : presentResponsibility(request, lookup)),
    [lookup, request],
  );
}
