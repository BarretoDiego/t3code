import type {
  EnvironmentId,
  ProjectId,
  ProjectSyncApplyDeletionsResult,
  ProjectSyncCreateUrlResult,
  ProjectSyncManifestEntry,
  ProjectSyncManifestResult,
} from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  batchProjectSyncEntries,
  computeProjectSyncPlan,
  summarizeProjectSyncPlan,
  type ProjectSyncPlanSummary,
} from "../operations/projectSync.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/**
 * Per-environment RPC atoms for the four project-sync methods. Follows the
 * same factory shape as `createFilesystemEnvironmentAtoms` /
 * `createAssetEnvironmentAtoms`: the concrete atom runtime is owned by each
 * app (web/mobile/desktop), not by client-runtime.
 */
export function createProjectSyncEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    manifest: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:project-sync:manifest",
      tag: WS_METHODS.projectSyncManifest,
    }),
    createExportUrl: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:project-sync:create-export-url",
      tag: WS_METHODS.projectSyncCreateExportUrl,
    }),
    createImportUrl: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:project-sync:create-import-url",
      tag: WS_METHODS.projectSyncCreateImportUrl,
    }),
    applyDeletions: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:project-sync:apply-deletions",
      tag: WS_METHODS.projectSyncApplyDeletions,
    }),
  };
}

export type ProjectSyncMode = "send" | "sync";

export interface ProjectSyncTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

export type ProjectSyncStage = "manifest" | "planning" | "transferring" | "deleting" | "done";

export interface ProjectSyncProgress {
  readonly stage: ProjectSyncStage;
  readonly transferredBytes: number;
  readonly totalBytes: number;
  readonly transferredFiles: number;
  readonly totalFiles: number;
}

export interface RunProjectSyncParams {
  readonly source: ProjectSyncTarget;
  readonly dest: ProjectSyncTarget;
  readonly mode: ProjectSyncMode;
  readonly includeGit: boolean;
  readonly signal?: AbortSignal;
  readonly onProgress: (progress: ProjectSyncProgress) => void;
}

/**
 * Everything `runProjectSync` needs from the outside world, injected so the
 * controller can be exercised in tests without a socket, an `AtomRegistry`,
 * or a real `fetch`. A real caller (the web/desktop/mobile app) wires
 * `resolveUrl` the same way `resolveAssetUrl` is used today: look up the
 * environment's prepared connection, then resolve the RPC-returned relative
 * URL against its `httpBaseUrl`. The signed URL itself carries the auth
 * token, so no extra header is needed for the export/import fetches.
 */
export interface ProjectSyncDeps {
  readonly fetch: typeof fetch;
  readonly resolveUrl: (environmentId: EnvironmentId, relativeUrl: string) => string | null;
  readonly getManifest: (
    target: ProjectSyncTarget,
    includeGit: boolean,
  ) => Promise<ProjectSyncManifestResult>;
  readonly createExportUrl: (
    target: ProjectSyncTarget,
    paths: ReadonlyArray<string>,
  ) => Promise<ProjectSyncCreateUrlResult>;
  readonly createImportUrl: (
    target: ProjectSyncTarget,
    fileCount: number,
    totalBytes: number,
  ) => Promise<ProjectSyncCreateUrlResult>;
  readonly applyDeletions: (
    target: ProjectSyncTarget,
    paths: ReadonlyArray<string>,
  ) => Promise<ProjectSyncApplyDeletionsResult>;
  /** Overrides for `batchProjectSyncEntries`; mainly useful in tests. */
  readonly maxBytesPerBatch?: number;
  readonly maxFilesPerBatch?: number;
}

export class ProjectSyncAbortedError extends Error {
  readonly _tag = "ProjectSyncAbortedError";
  constructor() {
    super("Project sync was aborted.");
    this.name = "ProjectSyncAbortedError";
  }
}

export class ProjectSyncUrlResolutionError extends Error {
  readonly _tag = "ProjectSyncUrlResolutionError";
  readonly environmentId: EnvironmentId;
  constructor(environmentId: EnvironmentId) {
    super(`Could not resolve a signed project sync URL against environment '${environmentId}'.`);
    this.name = "ProjectSyncUrlResolutionError";
    this.environmentId = environmentId;
  }
}

export class ProjectSyncTransferError extends Error {
  readonly _tag = "ProjectSyncTransferError";
  override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "ProjectSyncTransferError";
    this.cause = cause;
  }
}

function checkProjectSyncAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new ProjectSyncAbortedError();
  }
}

async function transferProjectSyncBatch(
  deps: ProjectSyncDeps,
  source: ProjectSyncTarget,
  dest: ProjectSyncTarget,
  batch: ReadonlyArray<ProjectSyncManifestEntry>,
  signal: AbortSignal | undefined,
): Promise<void> {
  const paths = batch.map((entry) => entry.path);
  const totalBytes = batch.reduce((total, entry) => total + entry.size, 0);

  checkProjectSyncAborted(signal);
  const exportUrlResult = await deps.createExportUrl(source, paths);
  const exportUrl = deps.resolveUrl(source.environmentId, exportUrlResult.url);
  if (exportUrl === null) {
    throw new ProjectSyncUrlResolutionError(source.environmentId);
  }

  checkProjectSyncAborted(signal);
  let exportResponse: Response;
  try {
    exportResponse = await deps.fetch(exportUrl, {
      method: "GET",
      ...(signal ? { signal } : {}),
    });
  } catch (cause) {
    throw new ProjectSyncTransferError(
      `Could not reach environment '${source.environmentId}' to export project files.`,
      cause,
    );
  }
  if (!exportResponse.ok) {
    throw new ProjectSyncTransferError(
      `Export request to environment '${source.environmentId}' failed with status ${exportResponse.status}.`,
    );
  }
  const bytes = await exportResponse.arrayBuffer();

  checkProjectSyncAborted(signal);
  const importUrlResult = await deps.createImportUrl(dest, batch.length, totalBytes);
  const importUrl = deps.resolveUrl(dest.environmentId, importUrlResult.url);
  if (importUrl === null) {
    throw new ProjectSyncUrlResolutionError(dest.environmentId);
  }

  checkProjectSyncAborted(signal);
  let importResponse: Response;
  try {
    importResponse = await deps.fetch(importUrl, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: bytes,
      ...(signal ? { signal } : {}),
    });
  } catch (cause) {
    throw new ProjectSyncTransferError(
      `Could not reach environment '${dest.environmentId}' to import project files.`,
      cause,
    );
  }
  if (!importResponse.ok) {
    throw new ProjectSyncTransferError(
      `Import request to environment '${dest.environmentId}' failed with status ${importResponse.status}.`,
    );
  }
}

/**
 * Orchestrates a client-driven project sync between two environments: reads
 * both projects' manifests, diffs them, and streams changed files from the
 * source into the destination in bounded batches (never buffering the whole
 * project in memory at once), then applies deletions on the destination when
 * running in `"sync"` mode. `"send"` never deletes, even if the destination
 * (a project the caller just created) happens to report existing entries.
 *
 * A batch failure aborts the rest of the sync; the destination is left with
 * whatever batches completed before the failure, which is always a subset of
 * `toCopy` and never partially-written destination-only cruft.
 */
export async function runProjectSync(
  deps: ProjectSyncDeps,
  params: RunProjectSyncParams,
): Promise<ProjectSyncPlanSummary> {
  const { source, dest, mode, includeGit, signal, onProgress } = params;

  const idleProgress = (stage: ProjectSyncStage): ProjectSyncProgress => ({
    stage,
    transferredBytes: 0,
    totalBytes: 0,
    transferredFiles: 0,
    totalFiles: 0,
  });

  checkProjectSyncAborted(signal);
  onProgress(idleProgress("manifest"));
  const [sourceManifest, destManifest] = await Promise.all([
    deps.getManifest(source, includeGit),
    deps.getManifest(dest, includeGit),
  ]);

  checkProjectSyncAborted(signal);
  onProgress(idleProgress("planning"));
  const plan = computeProjectSyncPlan(sourceManifest.entries, destManifest.entries);
  const batches = batchProjectSyncEntries(plan.toCopy, {
    ...(deps.maxBytesPerBatch === undefined ? {} : { maxBytes: deps.maxBytesPerBatch }),
    ...(deps.maxFilesPerBatch === undefined ? {} : { maxFiles: deps.maxFilesPerBatch }),
  });

  const totalBytes = plan.copyBytes;
  const totalFiles = plan.toCopy.length;
  let transferredBytes = 0;
  let transferredFiles = 0;

  const reportTransferring = () =>
    onProgress({
      stage: "transferring",
      transferredBytes,
      totalBytes,
      transferredFiles,
      totalFiles,
    });

  reportTransferring();
  for (const batch of batches) {
    checkProjectSyncAborted(signal);
    await transferProjectSyncBatch(deps, source, dest, batch, signal);
    transferredBytes += batch.reduce((total, entry) => total + entry.size, 0);
    transferredFiles += batch.length;
    reportTransferring();
  }

  if (mode === "sync" && plan.toDelete.length > 0) {
    checkProjectSyncAborted(signal);
    onProgress({ stage: "deleting", transferredBytes, totalBytes, transferredFiles, totalFiles });
    await deps.applyDeletions(dest, plan.toDelete);
  }

  onProgress({ stage: "done", transferredBytes, totalBytes, transferredFiles, totalFiles });

  return summarizeProjectSyncPlan(plan);
}
