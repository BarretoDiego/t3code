import {
  EnvironmentId,
  PROJECT_SYNC_MAX_PATHS_PER_REQUEST,
  ProjectId,
  type ProjectSyncApplyDeletionsResult,
  type ProjectSyncCreateUrlResult,
  type ProjectSyncExportEntry,
  type ProjectSyncManifestEntry,
  type ProjectSyncManifestResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  detectProjectSyncStreamingUploadSupport,
  planProjectSync,
  ProjectSyncAbortedError,
  ProjectSyncTransferError,
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

function dir(path: string): ProjectSyncManifestEntry {
  return { path, kind: "dir", size: 0 };
}

function fakeResponse(
  status: number,
  body: ArrayBuffer = new ArrayBuffer(0),
  streamBody: ReadableStream<Uint8Array> | null = null,
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: streamBody,
    arrayBuffer: () => Promise.resolve(body),
  } as unknown as Response;
}

interface FakeDepsOptions {
  readonly sourceManifest: ProjectSyncManifestResult;
  readonly destManifest: ProjectSyncManifestResult;
  readonly maxFilesPerBatch?: number;
  readonly onFetch?: (url: string, init: RequestInit | undefined) => void;
  /** Body reported on the export response's `.body`, so tests can exercise
      the streaming-vs-buffered decision in `transferProjectSyncBatch`. */
  readonly exportResponseBody?: ReadableStream<Uint8Array> | null;
  readonly streamingUploadSupported?: boolean;
}

interface FakeDepsHandle {
  readonly deps: ProjectSyncDeps;
  readonly calls: {
    readonly getManifest: ProjectSyncTarget[];
    readonly createExportUrl: {
      target: ProjectSyncTarget;
      entries: ReadonlyArray<ProjectSyncExportEntry>;
    }[];
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
      if (url.includes("/projectSync/export/")) {
        return fakeResponse(200, new ArrayBuffer(0), options.exportResponseBody ?? null);
      }
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
    createExportUrl: (target, entries) => {
      calls.createExportUrl.push({ target, entries });
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
    ...(options.streamingUploadSupported === undefined
      ? {}
      : { streamingUploadSupported: options.streamingUploadSupported }),
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
    expect(calls.createExportUrl.map((call) => call.entries)).toEqual([
      [{ path: "a.txt", size: 10 }],
      [{ path: "b.txt", size: 10 }],
    ]);
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

  it("re-asserts the source's empty directories after a delete pass pruned them", async () => {
    // The destination has files under `logs/`, the source has `logs/` empty.
    // Copying happens first, so deleting `logs/app.log` prunes `logs/` right
    // back off the destination unless the dir entry is sent again afterwards.
    const sourceManifest = manifest([dir("logs"), file("keep.txt", 10)]);
    const destManifest = manifest([file("keep.txt", 10), file("logs/app.log", 5)]);
    const { deps, calls } = makeFakeDeps({ sourceManifest, destManifest });

    const summary = await runProjectSync(deps, {
      source: SOURCE,
      dest: DEST,
      mode: "sync",
      includeGit: true,
      onProgress: () => {},
    });

    expect(summary).toEqual({ copyCount: 1, deleteCount: 1, copyBytes: 0 });
    expect(calls.applyDeletions).toEqual([{ target: DEST, paths: ["logs/app.log"] }]);
    // The dir entry ships once with the copy pass and once after the deletions.
    expect(calls.createExportUrl.map((call) => call.entries)).toEqual([
      [{ path: "logs", size: 0 }],
      [{ path: "logs", size: 0 }],
    ]);
    expect(calls.fetchUrls.at(-1)).toBe("https://environment-dest/api/projectSync/import/token-2");
  });

  it("skips the empty-directory re-assert pass when the plan has no dir entries", async () => {
    const sourceManifest = manifest([file("keep.txt", 10)]);
    const destManifest = manifest([file("keep.txt", 10), file("stale.txt", 5)]);
    const { deps, calls } = makeFakeDeps({ sourceManifest, destManifest });

    await runProjectSync(deps, {
      source: SOURCE,
      dest: DEST,
      mode: "sync",
      includeGit: true,
      onProgress: () => {},
    });

    expect(calls.createExportUrl).toEqual([]);
  });

  it("chunks a deletion list that outgrows the per-request path cap", async () => {
    const stale = Array.from({ length: PROJECT_SYNC_MAX_PATHS_PER_REQUEST + 2 }, (_, index) =>
      file(`stale-${index}.txt`, 1),
    );
    const { deps, calls } = makeFakeDeps({
      sourceManifest: manifest([]),
      destManifest: manifest(stale),
    });

    const summary = await runProjectSync(deps, {
      source: SOURCE,
      dest: DEST,
      mode: "sync",
      includeGit: true,
      onProgress: () => {},
    });

    expect(summary.deleteCount).toBe(PROJECT_SYNC_MAX_PATHS_PER_REQUEST + 2);
    expect(calls.applyDeletions.map((call) => call.paths.length)).toEqual([
      PROJECT_SYNC_MAX_PATHS_PER_REQUEST,
      2,
    ]);
    // Chunking must not reshuffle: the plan's deepest-first order carries
    // across requests.
    expect(calls.applyDeletions.flatMap((call) => [...call.paths])).toEqual(
      stale.map((entry) => entry.path).sort(),
    );
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
