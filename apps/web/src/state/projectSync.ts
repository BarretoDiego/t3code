import { createProjectSyncEnvironmentAtoms } from "@t3tools/client-runtime/state/project-sync";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import type {
  ProjectSyncDeps,
  ProjectSyncTarget,
} from "@t3tools/client-runtime/state/project-sync";
import type { ProjectSyncExportEntry } from "@t3tools/contracts";

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
 * Builds the `ProjectSyncDeps` for `runProjectSync` (client-runtime project-sync): the four RPCs
 * via this environment's atom registry, plus `fetch`/`resolveUrl` wired like attachment uploads
 * (`readPreparedConnection` + `resolveAssetUrl`, see `lib/attachmentUploadQueue.ts`).
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

  const getManifest = async (target: ProjectSyncTarget, includeGit: boolean) => {
    const result = await getManifestRpc({
      environmentId: target.environmentId,
      input: { projectId: target.projectId, includeGit },
    });
    if (result._tag !== "Success") {
      throw squashAtomCommandFailure(result);
    }
    return result.value;
  };

  const createExportUrl = async (
    target: ProjectSyncTarget,
    entries: ReadonlyArray<ProjectSyncExportEntry>,
  ) => {
    const result = await createExportUrlRpc({
      environmentId: target.environmentId,
      input: { projectId: target.projectId, entries },
    });
    if (result._tag !== "Success") {
      throw squashAtomCommandFailure(result);
    }
    return result.value;
  };

  const createImportUrl = async (
    target: ProjectSyncTarget,
    fileCount: number,
    totalBytes: number,
  ) => {
    const result = await createImportUrlRpc({
      environmentId: target.environmentId,
      input: { projectId: target.projectId, fileCount, totalBytes },
    });
    if (result._tag !== "Success") {
      throw squashAtomCommandFailure(result);
    }
    return result.value;
  };

  const applyDeletions = async (target: ProjectSyncTarget, paths: ReadonlyArray<string>) => {
    const result = await applyDeletionsRpc({
      environmentId: target.environmentId,
      input: { projectId: target.projectId, paths },
    });
    if (result._tag !== "Success") {
      throw squashAtomCommandFailure(result);
    }
    return result.value;
  };

  const resolveUrl = (environmentId: ProjectSyncTarget["environmentId"], relativeUrl: string) => {
    const connection = readPreparedConnection(environmentId);
    return connection ? resolveAssetUrl(connection.httpBaseUrl, relativeUrl) : null;
  };

  // The React Compiler keeps this object's identity stable across renders while
  // the RPC commands are unchanged, so callers can use it as an effect dependency.
  const deps: ProjectSyncDeps = {
    fetch: globalFetch,
    resolveUrl,
    getManifest,
    createExportUrl,
    createImportUrl,
    applyDeletions,
  };
  return deps;
}

// Stable reference so `deps.fetch` never changes identity across renders.
const globalFetch: typeof fetch = (...args) => fetch(...args);
