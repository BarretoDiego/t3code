import type {
  EnvironmentId,
  ProjectId,
  ProjectSyncApplyDeletionsResult,
  ProjectSyncCreateUrlResult,
  ProjectSyncExportEntry,
  ProjectSyncManifestEntry,
  ProjectSyncManifestResult,
} from "@t3tools/contracts";
import { PROJECT_SYNC_MAX_PATHS_PER_REQUEST, WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  batchProjectSyncEntries,
  computeProjectSyncPlan,
  summarizeProjectSyncPlan,
  type ProjectSyncPlan,
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

/** Everything a plan preview needs plus the manifests it was computed from,
    so a caller that already fetched both can hand the exact same plan back
    to `runProjectSync` instead of it re-fetching and re-diffing. */
export interface ProjectSyncPlanResult {
  readonly sourceManifest: ProjectSyncManifestResult;
  readonly destManifest: ProjectSyncManifestResult;
  readonly plan: ProjectSyncPlan;
  readonly summary: ProjectSyncPlanSummary;
}

export interface RunProjectSyncParams {
  readonly source: ProjectSyncTarget;
  readonly dest: ProjectSyncTarget;
  readonly mode: ProjectSyncMode;
  readonly includeGit: boolean;
  readonly signal?: AbortSignal;
  readonly onProgress: (progress: ProjectSyncProgress) => void;
  /**
   * A plan the user already confirmed (typically from a preview step that
   * called `planProjectSync` directly). When present, `runProjectSync` trusts
   * it byte-for-byte: it does not re-fetch either manifest or recompute the
   * diff, so what gets copied/deleted is exactly what the user saw and
   * confirmed, not a second, possibly different plan recomputed against
   * whatever the destination looks like by the time execution starts. When
   * absent, `runProjectSync` calls `planProjectSync` itself, preserving the
   * original fetch-then-plan-then-execute behavior.
   */
  readonly precomputedPlan?: ProjectSyncPlanResult;
}

/**
 * Fetches both projects' manifests and diffs them into a plan, without
 * executing it. Split out from `runProjectSync` so a preview/confirmation UI
 * can compute the plan once, show the user exactly what will be copied and
 * deleted, and then hand that same plan back via `precomputedPlan` — instead
 * of `runProjectSync` silently recomputing a second, potentially different
 * plan against whatever the destination looks like by the time the user
 * confirms.
 */
export async function planProjectSync(
  deps: ProjectSyncDeps,
  params: {
    readonly source: ProjectSyncTarget;
    readonly dest: ProjectSyncTarget;
    readonly includeGit: boolean;
    readonly signal?: AbortSignal;
  },
): Promise<ProjectSyncPlanResult> {
  const { source, dest, includeGit, signal } = params;

  checkProjectSyncAborted(signal);
  const [sourceManifest, destManifest] = await Promise.all([
    deps.getManifest(source, includeGit),
    deps.getManifest(dest, includeGit),
  ]);

  checkProjectSyncAborted(signal);
  const plan = computeProjectSyncPlan(sourceManifest.entries, destManifest.entries);

  return { sourceManifest, destManifest, plan, summary: summarizeProjectSyncPlan(plan) };
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
    entries: ReadonlyArray<ProjectSyncExportEntry>,
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
  /** Overrides `detectProjectSyncStreamingUploadSupport`'s runtime feature
      detection; mainly useful in tests to force either the streaming or the
      buffered fallback path deterministically. */
  readonly streamingUploadSupported?: boolean;
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
  /** The HTTP status of the export/import response that failed, when the
      failure was a non-ok response rather than a network error (`fetch`
      rejecting). Lets callers branch on the status directly instead of
      scraping it back out of `message`. */
  readonly status?: number;
  constructor(message: string, cause?: unknown, status?: number) {
    super(message);
    this.name = "ProjectSyncTransferError";
    this.cause = cause;
    if (status !== undefined) {
      this.status = status;
    }
  }
}

function checkProjectSyncAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new ProjectSyncAbortedError();
  }
}

/** `RequestInit` plus the `duplex` option Chromium/Node require on a
    streaming-body `Request`, which the DOM lib this repo's TypeScript
    targets does not yet declare. */
type StreamingRequestInit = RequestInit & { readonly duplex?: "half" };

/**
 * Feature-detects whether the current environment's `fetch`/`Request` can
 * stream a `ReadableStream` request body end to end, rather than buffering it
 * into memory first. Safari and React Native's `fetch` either throw when
 * given a stream body or silently ignore `duplex` and buffer it anyway, so a
 * capability probe is the only reliable signal (there is no separate feature
 * flag to read).
 *
 * This is the check Chrome's own fetch-upload-streaming guidance recommends:
 * constructing a `Request` with a stream body and a `duplex` *getter* is
 * side-effect-free, so a runtime that understands duplex streaming reads the
 * getter (proving it looked at the option) and does not fall back to forcing
 * a `Content-Type` header the way non-streaming runtimes do when they end up
 * buffering the stream through a different code path. Constructors that
 * don't support streaming bodies at all can also throw outright, which the
 * try/catch treats the same as "unsupported".
 *
 * `RequestCtor`/`ReadableStreamCtor` are parameterized (defaulting to the
 * globals) purely so tests can substitute fakes that simulate an unsupported
 * runtime without needing an actual old browser.
 */
export function detectProjectSyncStreamingUploadSupport(
  RequestCtor: typeof Request = Request,
  ReadableStreamCtor: typeof ReadableStream = ReadableStream,
): boolean {
  if (typeof RequestCtor === "undefined" || typeof ReadableStreamCtor === "undefined") {
    return false;
  }
  try {
    let duplexAccessed = false;
    const probe = new RequestCtor("https://project-sync.invalid/", {
      method: "POST",
      body: new ReadableStreamCtor(),
      get duplex() {
        duplexAccessed = true;
        return "half";
      },
    } as StreamingRequestInit);
    const hasContentType = probe.headers.has("content-type");
    return duplexAccessed && !hasContentType;
  } catch {
    return false;
  }
}

async function transferProjectSyncBatch(
  deps: ProjectSyncDeps,
  source: ProjectSyncTarget,
  dest: ProjectSyncTarget,
  batch: ReadonlyArray<ProjectSyncManifestEntry>,
  signal: AbortSignal | undefined,
): Promise<void> {
  const entries: ProjectSyncExportEntry[] = batch.map((entry) => ({
    path: entry.path,
    size: entry.size,
  }));
  const totalBytes = batch.reduce((total, entry) => total + entry.size, 0);

  checkProjectSyncAborted(signal);
  const exportUrlResult = await deps.createExportUrl(source, entries);
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
      undefined,
      exportResponse.status,
    );
  }

  checkProjectSyncAborted(signal);
  const importUrlResult = await deps.createImportUrl(dest, batch.length, totalBytes);
  const importUrl = deps.resolveUrl(dest.environmentId, importUrlResult.url);
  if (importUrl === null) {
    throw new ProjectSyncUrlResolutionError(dest.environmentId);
  }

  // Buffering the whole export response into an ArrayBuffer defeats the
  // streaming both server-side endpoints already do: a single large file (a
  // batch is sized by count/bytes budgets, not a hard per-file cap) would sit
  // fully in memory in the tab/app process. Stream the body straight through
  // when the runtime can actually deliver a streaming request; only fall
  // back to buffering where that is not possible at all.
  const streamingSupported =
    deps.streamingUploadSupported ?? detectProjectSyncStreamingUploadSupport();
  const canStreamImportBody = streamingSupported && exportResponse.body !== null;

  checkProjectSyncAborted(signal);
  let importResponse: Response;
  try {
    const importInit: StreamingRequestInit = canStreamImportBody
      ? {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: exportResponse.body,
          duplex: "half",
          ...(signal ? { signal } : {}),
        }
      : {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: await exportResponse.arrayBuffer(),
          ...(signal ? { signal } : {}),
        };
    importResponse = await deps.fetch(importUrl, importInit);
  } catch (cause) {
    throw new ProjectSyncTransferError(
      `Could not reach environment '${dest.environmentId}' to import project files.`,
      cause,
    );
  }
  if (!importResponse.ok) {
    throw new ProjectSyncTransferError(
      `Import request to environment '${dest.environmentId}' failed with status ${importResponse.status}.`,
      undefined,
      importResponse.status,
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
  const { source, dest, mode, includeGit, signal, onProgress, precomputedPlan } = params;

  const idleProgress = (stage: ProjectSyncStage): ProjectSyncProgress => ({
    stage,
    transferredBytes: 0,
    totalBytes: 0,
    transferredFiles: 0,
    totalFiles: 0,
  });

  checkProjectSyncAborted(signal);

  let plan: ProjectSyncPlan;
  if (precomputedPlan !== undefined) {
    plan = precomputedPlan.plan;
  } else {
    onProgress(idleProgress("manifest"));
    const planResult = await planProjectSync(deps, {
      source,
      dest,
      includeGit,
      ...(signal ? { signal } : {}),
    });
    onProgress(idleProgress("planning"));
    plan = planResult.plan;
  }

  checkProjectSyncAborted(signal);
  const batchOptions = {
    ...(deps.maxBytesPerBatch === undefined ? {} : { maxBytes: deps.maxBytesPerBatch }),
    ...(deps.maxFilesPerBatch === undefined ? {} : { maxFiles: deps.maxFilesPerBatch }),
  };
  const batches = batchProjectSyncEntries(plan.toCopy, batchOptions);

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
    // One request cannot name more paths than the contract allows, and the
    // list stays deepest-first across chunks so a directory is never removed
    // before what was inside it.
    for (
      let offset = 0;
      offset < plan.toDelete.length;
      offset += PROJECT_SYNC_MAX_PATHS_PER_REQUEST
    ) {
      checkProjectSyncAborted(signal);
      await deps.applyDeletions(
        dest,
        plan.toDelete.slice(offset, offset + PROJECT_SYNC_MAX_PATHS_PER_REQUEST),
      );
    }

    // Removing the last entry inside a destination directory also prunes that
    // now-empty directory, which can collapse a directory the source publishes
    // as a `"dir"` entry (manifests only name directories that are empty). The
    // copy pass ran before the deletions, so re-assert those zero-byte entries
    // afterwards or the destination would silently end up short a directory.
    for (const batch of batchProjectSyncEntries(
      plan.toCopy.filter((entry) => entry.kind === "dir"),
      batchOptions,
    )) {
      checkProjectSyncAborted(signal);
      await transferProjectSyncBatch(deps, source, dest, batch, signal);
    }
  }

  onProgress({ stage: "done", transferredBytes, totalBytes, transferredFiles, totalFiles });

  return summarizeProjectSyncPlan(plan);
}
