import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  PROJECT_SYNC_MAX_PATHS_PER_REQUEST,
  ProjectSyncApplyDeletionsInput,
  ProjectSyncCreateExportUrlInput,
  ProjectSyncManifestEntry,
  ProjectSyncManifestInput,
} from "./projectSync.ts";

const isManifestEntry = Schema.is(ProjectSyncManifestEntry);
const decodeManifestEntry = Schema.decodeUnknownSync(ProjectSyncManifestEntry);
const decodeManifestInput = Schema.decodeUnknownSync(ProjectSyncManifestInput);
const isExportInput = Schema.is(ProjectSyncCreateExportUrlInput);
const decodeExportInput = Schema.decodeUnknownSync(ProjectSyncCreateExportUrlInput);
const decodeDeletionsInput = Schema.decodeUnknownSync(ProjectSyncApplyDeletionsInput);
const isDeletionsInput = Schema.is(ProjectSyncApplyDeletionsInput);

const paths = (count: number) => Array.from({ length: count }, (_, index) => `file-${index}.txt`);
const entries = (count: number) => paths(count).map((path) => ({ path, size: 0 }));

/** Legal POSIX filenames that a trimming or separator-rewriting schema would
    silently turn into a different (or non-existent) file. */
const AWKWARD_PATHS = ["docs/notes .md", " leading.md", "draft v2\\final.md", "tab\there.md"];

describe("ProjectSyncManifestEntry", () => {
  it("accepts the three entry shapes the server emits", () => {
    expect(
      isManifestEntry({ path: "a.txt", kind: "file", size: 3, mode: 0o644, hash: "a".repeat(64) }),
    ).toBe(true);
    expect(isManifestEntry({ path: "empty", kind: "dir", size: 0 })).toBe(true);
    expect(
      isManifestEntry({ path: "link", kind: "symlink", size: 0, linkTarget: "../target" }),
    ).toBe(true);
  });

  it("rejects a hash that is not a full sha256 digest", () => {
    expect(isManifestEntry({ path: "a.txt", kind: "file", size: 3, hash: "abc" })).toBe(false);
    expect(isManifestEntry({ path: "a.txt", kind: "file", size: 3, hash: "z".repeat(64) })).toBe(
      false,
    );
  });

  it("rejects an empty path and a negative size", () => {
    expect(isManifestEntry({ path: "", kind: "file", size: 0 })).toBe(false);
    expect(isManifestEntry({ path: "a.txt", kind: "file", size: -1 })).toBe(false);
  });

  it("rejects a path carrying a NUL byte", () => {
    expect(isManifestEntry({ path: "a\0b.txt", kind: "file", size: 0 })).toBe(false);
  });

  it("preserves paths a trimming schema would rewrite", () => {
    // Trailing spaces and backslashes are legal POSIX filename characters. A
    // schema that trimmed them would name a file the origin cannot export,
    // and the entry would be skipped forever while the sync reported success.
    for (const path of AWKWARD_PATHS) {
      expect(decodeManifestEntry({ path, kind: "file", size: 1 }).path).toBe(path);
    }
    expect(
      decodeManifestEntry({ path: "link", kind: "symlink", size: 0, linkTarget: "target .txt" })
        .linkTarget,
    ).toBe("target .txt");
  });
});

describe("ProjectSyncManifestInput", () => {
  it("defaults includeGit to true so an omitted flag still syncs history", () => {
    expect(decodeManifestInput({ projectId: "project-1" }).includeGit).toBe(true);
  });

  it("keeps an explicit includeGit: false", () => {
    expect(decodeManifestInput({ projectId: "project-1", includeGit: false }).includeGit).toBe(
      false,
    );
  });
});

describe("per-request path caps", () => {
  it("accepts exactly the cap and rejects one path more", () => {
    const atCap = paths(PROJECT_SYNC_MAX_PATHS_PER_REQUEST);
    const overCap = paths(PROJECT_SYNC_MAX_PATHS_PER_REQUEST + 1);

    expect(isExportInput({ projectId: "project-1", entries: entries(atCap.length) })).toBe(true);
    expect(isExportInput({ projectId: "project-1", entries: entries(overCap.length) })).toBe(false);
    expect(isDeletionsInput({ projectId: "project-1", paths: atCap })).toBe(true);
    expect(isDeletionsInput({ projectId: "project-1", paths: overCap })).toBe(false);
  });
});

describe("ProjectSyncCreateExportUrlInput", () => {
  it("carries the size the client signed a budget for, alongside each path", () => {
    const decoded = decodeExportInput({
      projectId: "project-1",
      entries: [{ path: "a.txt", size: 12 }],
    });
    expect(decoded.entries).toEqual([{ path: "a.txt", size: 12 }]);
  });

  it("rejects an entry without a size, or with a negative one", () => {
    expect(isExportInput({ projectId: "project-1", entries: [{ path: "a.txt" }] })).toBe(false);
    expect(isExportInput({ projectId: "project-1", entries: [{ path: "a.txt", size: -1 }] })).toBe(
      false,
    );
  });

  it("passes awkward-but-legal paths through untouched, on both path inputs", () => {
    expect(
      decodeExportInput({
        projectId: "project-1",
        entries: AWKWARD_PATHS.map((path) => ({ path, size: 0 })),
      }).entries.map((entry) => entry.path),
    ).toEqual(AWKWARD_PATHS);
    expect(decodeDeletionsInput({ projectId: "project-1", paths: AWKWARD_PATHS }).paths).toEqual(
      AWKWARD_PATHS,
    );
  });
});
