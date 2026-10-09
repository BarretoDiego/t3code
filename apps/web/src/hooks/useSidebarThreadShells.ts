import {
  presentThreadShell,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { mergeThreadNestingShells } from "@t3tools/client-runtime/state/thread-relationships";
import type {
  EnvironmentId,
  OrchestrationV2ThreadShell,
  ScopedProjectRef,
} from "@t3tools/contracts";
import { useMemo } from "react";
import { useClientSettings } from "./useSettings";
import { useEnvironments } from "../state/environments";
import { useThreadShells, useThreadShellsForProjectRefs } from "../state/entities";
import { useSidebarArchivedThreadSnapshots } from "../lib/archivedThreadsState";

const NO_PROJECT_REFS: ReadonlyArray<ScopedProjectRef> = [];
const archivedPresentations = new WeakMap<
  OrchestrationV2ThreadShell,
  Map<EnvironmentId, EnvironmentThreadShell>
>();

export function useSidebarArchives() {
  const enabled = useClientSettings((settings) => settings.sidebarShowAllSubthreads);
  const { environments } = useEnvironments();
  const ids = useMemo(
    () =>
      enabled
        ? environments
            .filter((environment) => environment.entry.enabled)
            .map((environment) => environment.environmentId)
        : [],
    [enabled, environments],
  );
  return useSidebarArchivedThreadSnapshots(ids);
}

/** The optional archive subscription belongs to the sidebar, not the active navigation cache. */
export function useSidebarThreadShells(refs?: ReadonlyArray<ScopedProjectRef>) {
  const live = useThreadShells(refs === undefined);
  const scopedLive = useThreadShellsForProjectRefs(refs ?? NO_PROJECT_REFS);
  const archives = useSidebarArchives();
  return useMemo(() => {
    const threads = refs === undefined ? live : scopedLive;
    const archived = archives.snapshots.flatMap(({ environmentId, snapshot }) =>
      snapshot.threads.map((shell) => {
        let byEnvironment = archivedPresentations.get(shell);
        if (byEnvironment === undefined) {
          byEnvironment = new Map();
          archivedPresentations.set(shell, byEnvironment);
        }
        let presented = byEnvironment.get(environmentId);
        if (presented === undefined) {
          presented = presentThreadShell(environmentId, shell);
          byEnvironment.set(environmentId, presented);
        }
        return presented;
      }),
    );
    if (archived.length === 0) return threads;
    const merged = mergeThreadNestingShells(threads, archived);
    return refs === undefined
      ? merged
      : merged.filter((thread) =>
          refs.some(
            (ref) =>
              ref.environmentId === thread.environmentId && ref.projectId === thread.projectId,
          ),
        );
  }, [live, scopedLive, refs, archives.snapshots]);
}
