import {
  EnvironmentId,
  ProjectId,
  type ProjectSyncApplyDeletionsResult,
  type ProjectSyncCreateUrlResult,
  type ProjectSyncManifestEntry,
  type ProjectSyncManifestResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  ProjectSyncAbortedError,
  runProjectSync,
  type ProjectSyncDeps,
  type ProjectSyncProgress,
  type ProjectSyncTarget,
} from "./projectSync.ts";

const SOURCE: ProjectSyncTarget = {
  environmentId: EnvironmentId.make("environment-source"),
  projectId: ProjectId.make("project-source"),
};
const DEST: ProjectSyncTarget = {
  environmentId: EnvironmentId.make("environment-dest"),
  projectId: ProjectId.make("project-dest"),
};

function manifest(entries: ProjectSyncManifestEntry[]): ProjectSyncManifestResult {
  return { workspaceRoot: "/workspace/project", entries, generatedAt: "2026-01-01T00:00:00.000Z" };
}

function file(path: string, size = 10): ProjectSyncManifestEntry {
  return { path, kind: "file", size, hash: "a".repeat(64) };
}

function fakeResponse(status: number, body: ArrayBuffer = new ArrayBuffer(0)): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: () => Promise.resolve(body),
  } as unknown as Response;
}

interface FakeDepsOptions {
  readonly sourceManifest: ProjectSyncManifestResult;
  readonly destManifest: ProjectSyncManifestResult;
  readonly maxFilesPerBatch?: number;
  readonly onFetch?: (url: string, init: RequestInit | undefined) => void;
}

interface FakeDepsHandle {
  readonly deps: ProjectSyncDeps;
  readonly calls: {
    readonly getManifest: ProjectSyncTarget[];
    readonly createExportUrl: { target: ProjectSyncTarget; paths: ReadonlyArray<string> }[];
    readonly createImportUrl: {
      target: ProjectSyncTarget;
      fileCount: number;
      totalBytes: number;
    }[];
    readonly applyDeletions: { target: ProjectSyncTarget; paths: ReadonlyArray<string> }[];
    readonly fetchUrls: string[];
  };
}

function makeFakeDeps(options: FakeDepsOptions): FakeDepsHandle {
  const calls: FakeDepsHandle["calls"] = {
    getManifest: [],
    createExportUrl: [],
    createImportUrl: [],
    applyDeletions: [],
    fetchUrls: [],
  };

  const deps: ProjectSyncDeps = {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.fetchUrls.push(url);
      options.onFetch?.(url, init);
      return fakeResponse(200);
    }) as unknown as typeof fetch,
    resolveUrl: (environmentId, relativeUrl) => `https://${environmentId}${relativeUrl}`,
    getManifest: (target) => {
      calls.getManifest.push(target);
      return Promise.resolve(
        target.environmentId === SOURCE.environmentId
          ? options.sourceManifest
          : options.destManifest,
      );
    },
    createExportUrl: (target, paths) => {
      calls.createExportUrl.push({ target, paths });
      const result: ProjectSyncCreateUrlResult = {
        url: `/api/projectSync/export/token-${calls.createExportUrl.length}`,
        expiresAt: 1_700_000_000_000,
      };
      return Promise.resolve(result);
    },
    createImportUrl: (target, fileCount, totalBytes) => {
      calls.createImportUrl.push({ target, fileCount, totalBytes });
      const result: ProjectSyncCreateUrlResult = {
        url: `/api/projectSync/import/token-${calls.createImportUrl.length}`,
        expiresAt: 1_700_000_000_000,
      };
      return Promise.resolve(result);
    },
    applyDeletions: (target, paths) => {
      calls.applyDeletions.push({ target, paths });
      const result: ProjectSyncApplyDeletionsResult = { deleted: paths.length };
      return Promise.resolve(result);
    },
    ...(options.maxFilesPerBatch === undefined
      ? {}
      : { maxFilesPerBatch: options.maxFilesPerBatch }),
  };

  return { deps, calls };
}

function expectMonotonicProgress(progress: ProjectSyncProgress[]): void {
  let lastBytes = -1;
  let lastFiles = -1;
  for (const entry of progress) {
    expect(entry.transferredBytes).toBeGreaterThanOrEqual(lastBytes);
    expect(entry.transferredFiles).toBeGreaterThanOrEqual(lastFiles);
    lastBytes = entry.transferredBytes;
    lastFiles = entry.transferredFiles;
  }
}

describe("runProjectSync", () => {
  it("sends every changed file in 'send' mode and never deletes", async () => {
    const sourceManifest = manifest([file("a.txt", 10), file("b.txt", 10)]);
    // The destination happens to report a stray file too; "send" must leave
    // it alone since deletions are a "sync"-only behavior.
    const destManifest = manifest([file("stale.txt", 5)]);
    const { deps, calls } = makeFakeDeps({ sourceManifest, destManifest, maxFilesPerBatch: 1 });

    const progress: ProjectSyncProgress[] = [];
    const summary = await runProjectSync(deps, {
      source: SOURCE,
      dest: DEST,
      mode: "send",
      includeGit: false,
      onProgress: (p) => progress.push(p),
    });

    expect(summary).toEqual({ copyCount: 2, deleteCount: 1, copyBytes: 20 });
    expect(calls.getManifest).toEqual([SOURCE, DEST]);
    // maxFilesPerBatch: 1 forces two batches, one export/import round-trip each.
    expect(calls.createExportUrl.map((call) => call.paths)).toEqual([["a.txt"], ["b.txt"]]);
    expect(calls.createImportUrl.map((call) => call.fileCount)).toEqual([1, 1]);
    expect(calls.applyDeletions).toEqual([]);
    expect(calls.fetchUrls).toEqual([
      "https://environment-source/api/projectSync/export/token-1",
      "https://environment-dest/api/projectSync/import/token-1",
      "https://environment-source/api/projectSync/export/token-2",
      "https://environment-dest/api/projectSync/import/token-2",
    ]);

    expect(progress.map((entry) => entry.stage)).toEqual([
      "manifest",
      "planning",
      "transferring",
      "transferring",
      "transferring",
      "done",
    ]);
    expectMonotonicProgress(progress);
    expect(progress.at(-1)).toEqual({
      stage: "done",
      transferredBytes: 20,
      totalBytes: 20,
      transferredFiles: 2,
      totalFiles: 2,
    });
  });

  it("applies destination deletions in 'sync' mode", async () => {
    const sourceManifest = manifest([file("keep.txt", 10)]);
    const destManifest = manifest([file("keep.txt", 10), file("stale.txt", 5)]);
    const { deps, calls } = makeFakeDeps({ sourceManifest, destManifest });

    const progress: ProjectSyncProgress[] = [];
    const summary = await runProjectSync(deps, {
      source: SOURCE,
      dest: DEST,
      mode: "sync",
      includeGit: true,
      onProgress: (p) => progress.push(p),
    });

    expect(summary).toEqual({ copyCount: 0, deleteCount: 1, copyBytes: 0 });
    expect(calls.createExportUrl).toEqual([]);
    expect(calls.applyDeletions).toEqual([{ target: DEST, paths: ["stale.txt"] }]);
    expect(progress.map((entry) => entry.stage)).toEqual([
      "manifest",
      "planning",
      "transferring",
      "deleting",
      "done",
    ]);
  });

  it("does not delete in 'sync' mode when nothing is stale", async () => {
    const sourceManifest = manifest([file("keep.txt", 10)]);
    const destManifest = manifest([file("keep.txt", 10)]);
    const { deps, calls } = makeFakeDeps({ sourceManifest, destManifest });

    await runProjectSync(deps, {
      source: SOURCE,
      dest: DEST,
      mode: "sync",
      includeGit: true,
      onProgress: () => {},
    });

    expect(calls.applyDeletions).toEqual([]);
  });

  it("aborts between batches without starting the next one", async () => {
    const sourceManifest = manifest([file("a.txt", 10), file("b.txt", 10)]);
    const destManifest = manifest([]);
    const { deps, calls } = makeFakeDeps({ sourceManifest, destManifest, maxFilesPerBatch: 1 });

    const controller = new AbortController();
    let batchesSeen = 0;
    const progress: ProjectSyncProgress[] = [];

    await expect(
      runProjectSync(deps, {
        source: SOURCE,
        dest: DEST,
        mode: "sync",
        includeGit: false,
        signal: controller.signal,
        onProgress: (p) => {
          progress.push(p);
          if (p.stage === "transferring" && p.transferredFiles > 0) {
            batchesSeen += 1;
            // Abort right after the first batch reports progress, before the
            // loop moves on to the second batch.
            if (batchesSeen === 1) {
              controller.abort();
            }
          }
        },
      }),
    ).rejects.toBeInstanceOf(ProjectSyncAbortedError);

    // Only the first batch's export/import pair ran.
    expect(calls.createExportUrl).toHaveLength(1);
    expect(calls.createImportUrl).toHaveLength(1);
    expect(calls.applyDeletions).toEqual([]);
    expectMonotonicProgress(progress);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const sourceManifest = manifest([file("a.txt", 10)]);
    const destManifest = manifest([]);
    const { deps, calls } = makeFakeDeps({ sourceManifest, destManifest });
    const controller = new AbortController();
    controller.abort();

    await expect(
      runProjectSync(deps, {
        source: SOURCE,
        dest: DEST,
        mode: "send",
        includeGit: false,
        signal: controller.signal,
        onProgress: () => {},
      }),
    ).rejects.toBeInstanceOf(ProjectSyncAbortedError);

    expect(calls.getManifest).toEqual([]);
  });
});
