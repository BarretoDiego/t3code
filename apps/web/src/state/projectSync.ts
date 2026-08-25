import { createProjectSyncEnvironmentAtoms } from "@t3tools/client-runtime/state/project-sync";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import type {
  ProjectSyncDeps,
  ProjectSyncTarget,
} from "@t3tools/client-runtime/state/project-sync";
import { useCallback, useMemo } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { useAtomCommand } from "./use-atom-command";
import { useAtomQueryRunner } from "./use-atom-query-runner";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { readPreparedConnection } from "./session";

/** Per-environment RPC atoms for the four project-sync methods. Instantiated
    once against the shared connection runtime, same as every other
    environment-scoped atom family in `state/`. */
export const projectSyncEnvironment = createProjectSyncEnvironmentAtoms(connectionAtomRuntime);

/**
 * Builds the full `ProjectSyncDeps` the `runProjectSync` controller (from
 * `@t3tools/client-runtime/state/project-sync`) needs to drive a sync: the
 * four RPCs, wired through this environment's atom registry, plus `fetch`
 * and `resolveUrl` wired exactly the way attachment uploads resolve a signed
 * URL (`readPreparedConnection` + `resolveAssetUrl`) — see
 * `apps/web/src/lib/attachmentUploadQueue.ts`.
 */
export function useProjectSyncDeps(): ProjectSyncDeps {
  const getManifestRpc = useAtomQueryRunner(projectSyncEnvironment.manifest, {
    reportFailure: false,
  });
  const createExportUrlRpc = useAtomCommand(projectSyncEnvironment.createExportUrl, {
    reportFailure: false,
  });
  const createImportUrlRpc = useAtomCommand(projectSyncEnvironment.createImportUrl, {
    reportFailure: false,
  });
  const applyDeletionsRpc = useAtomCommand(projectSyncEnvironment.applyDeletions, {
    reportFailure: false,
  });

  const getManifest = useCallback(
    async (target: ProjectSyncTarget, includeGit: boolean) => {
      const result = await getManifestRpc({
        environmentId: target.environmentId,
        input: { projectId: target.projectId, includeGit },
      });
      if (result._tag !== "Success") {
        throw squashAtomCommandFailure(result);
      }
      return result.value;
    },
    [getManifestRpc],
  );

  const createExportUrl = useCallback(
    async (target: ProjectSyncTarget, paths: ReadonlyArray<string>) => {
      const result = await createExportUrlRpc({
        environmentId: target.environmentId,
        input: { projectId: target.projectId, paths },
      });
      if (result._tag !== "Success") {
        throw squashAtomCommandFailure(result);
      }
      return result.value;
    },
    [createExportUrlRpc],
  );

  const createImportUrl = useCallback(
    async (target: ProjectSyncTarget, fileCount: number, totalBytes: number) => {
      const result = await createImportUrlRpc({
        environmentId: target.environmentId,
        input: { projectId: target.projectId, fileCount, totalBytes },
      });
      if (result._tag !== "Success") {
        throw squashAtomCommandFailure(result);
      }
      return result.value;
    },
    [createImportUrlRpc],
  );

  const applyDeletions = useCallback(
    async (target: ProjectSyncTarget, paths: ReadonlyArray<string>) => {
      const result = await applyDeletionsRpc({
        environmentId: target.environmentId,
        input: { projectId: target.projectId, paths },
      });
      if (result._tag !== "Success") {
        throw squashAtomCommandFailure(result);
      }
      return result.value;
    },
    [applyDeletionsRpc],
  );

  const resolveUrl = useCallback(
    (environmentId: ProjectSyncTarget["environmentId"], relativeUrl: string) => {
      const connection = readPreparedConnection(environmentId);
      return connection ? resolveAssetUrl(connection.httpBaseUrl, relativeUrl) : null;
    },
    [],
  );

  // Memoized so callers can safely put the returned object in an effect's
  // dependency array without it changing identity every render.
  return useMemo<ProjectSyncDeps>(
    () => ({
      fetch: globalFetch,
      resolveUrl,
      getManifest,
      createExportUrl,
      createImportUrl,
      applyDeletions,
    }),
    [applyDeletions, createExportUrl, createImportUrl, getManifest, resolveUrl],
  );
}

// Stable reference so `deps.fetch` never changes identity across renders.
const globalFetch: typeof fetch = (...args) => fetch(...args);
