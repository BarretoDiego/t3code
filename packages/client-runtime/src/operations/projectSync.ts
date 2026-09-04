import type { ProjectSyncManifestEntry } from "@t3tools/contracts";

/** Bytes-per-batch ceiling used when the caller does not override it. Bounds
    peak memory for a single transfer to a small, predictable amount, since a
    project can otherwise be arbitrarily large. */
export const DEFAULT_PROJECT_SYNC_BATCH_MAX_BYTES = 32 * 1024 * 1024;

/** Files-per-batch ceiling used when the caller does not override it. Keeps
    the export/import URL request payload (one path per file) small even for
    projects with many tiny files. */
export const DEFAULT_PROJECT_SYNC_BATCH_MAX_FILES = 500;

export interface ProjectSyncPlan {
  /** Manifest entries present in the source that are missing, or changed,
      relative to the destination. Order follows the source manifest. */
  readonly toCopy: ReadonlyArray<ProjectSyncManifestEntry>;
  /** Destination paths absent from the source, ordered deepest-first so a
      sequential delete never removes a directory before its contents. */
  readonly toDelete: ReadonlyArray<string>;
  /** Sum of `size` across every entry in `toCopy`. */
  readonly copyBytes: number;
}

export interface ProjectSyncPlanSummary {
  readonly copyCount: number;
  readonly deleteCount: number;
  readonly copyBytes: number;
}

export interface ProjectSyncBatchOptions {
  readonly maxBytes?: number;
  readonly maxFiles?: number;
}

function pathDepth(path: string): number {
  return path.split("/").length;
}

function projectSyncEntryNeedsCopy(
  source: ProjectSyncManifestEntry,
  dest: ProjectSyncManifestEntry,
): boolean {
  if (source.kind !== dest.kind) {
    return true;
  }
  if (source.kind === "file") {
    return source.hash !== dest.hash || source.size !== dest.size || source.mode !== dest.mode;
  }
  if (source.kind === "symlink") {
    return source.linkTarget !== dest.linkTarget;
  }
  // "dir" entries only mark otherwise-empty directories: same path + same
  // kind means the destination already has that (empty) directory, and a
  // directory carries no further content to diff.
  return false;
}

/**
 * Diffs a source manifest against a destination manifest to decide what a
 * client-orchestrated sync needs to copy and delete. Pure and side-effect
 * free: the caller is responsible for fetching both manifests first and for
 * executing the resulting plan.
 */
export function computeProjectSyncPlan(
  source: ReadonlyArray<ProjectSyncManifestEntry>,
  dest: ReadonlyArray<ProjectSyncManifestEntry>,
): ProjectSyncPlan {
  const destByPath = new Map(dest.map((entry) => [entry.path, entry] as const));
  const sourcePaths = new Set(source.map((entry) => entry.path));

  const toCopy: ProjectSyncManifestEntry[] = [];
  for (const entry of source) {
    const existing = destByPath.get(entry.path);
    if (existing === undefined || projectSyncEntryNeedsCopy(entry, existing)) {
      toCopy.push(entry);
    }
  }

  const toDelete = dest
    .filter((entry) => !sourcePaths.has(entry.path))
    .map((entry) => entry.path)
    .sort((a, b) => pathDepth(b) - pathDepth(a) || (a < b ? -1 : a > b ? 1 : 0));

  const copyBytes = toCopy.reduce((total, entry) => total + entry.size, 0);

  return { toCopy, toDelete, copyBytes };
}

/**
 * Groups manifest entries to copy into batches bounded by both total bytes
 * and file count, so a single request/response pair never has to hold an
 * entire (potentially huge) project in memory. A single entry larger than
 * `maxBytes` still gets its own one-entry batch rather than being split or
 * dropped.
 */
export function batchProjectSyncEntries(
  entries: ReadonlyArray<ProjectSyncManifestEntry>,
  options: ProjectSyncBatchOptions = {},
): ProjectSyncManifestEntry[][] {
  const maxBytes = options.maxBytes ?? DEFAULT_PROJECT_SYNC_BATCH_MAX_BYTES;
  const maxFiles = options.maxFiles ?? DEFAULT_PROJECT_SYNC_BATCH_MAX_FILES;

  const batches: ProjectSyncManifestEntry[][] = [];
  let current: ProjectSyncManifestEntry[] = [];
  let currentBytes = 0;

  const flush = () => {
    if (current.length > 0) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
  };

  for (const entry of entries) {
    if (entry.size > maxBytes) {
      flush();
      batches.push([entry]);
      continue;
    }
    if (
      current.length > 0 &&
      (current.length + 1 > maxFiles || currentBytes + entry.size > maxBytes)
    ) {
      flush();
    }
    current.push(entry);
    currentBytes += entry.size;
  }
  flush();

  return batches;
}

export function summarizeProjectSyncPlan(plan: ProjectSyncPlan): ProjectSyncPlanSummary {
  return {
    copyCount: plan.toCopy.length,
    deleteCount: plan.toDelete.length,
    copyBytes: plan.copyBytes,
  };
}
