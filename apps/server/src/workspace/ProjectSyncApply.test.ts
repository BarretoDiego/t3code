// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  createProjectSyncFrameDecoder,
  encodeProjectSyncRecords,
  type ProjectSyncFrameRecord,
} from "@t3tools/shared/projectSyncFraming";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import {
  applyProjectSyncDeletions,
  applyProjectSyncRecords,
  resolveProjectSyncRelativePath,
} from "./ProjectSyncApply.ts";

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-project-sync-apply-" });
});

const encoder = new TextEncoder();

function fileRecord(path: string, contents: string, mode?: number): ProjectSyncFrameRecord {
  const content = encoder.encode(contents);
  return {
    header: { path, size: content.length, kind: "file", ...(mode === undefined ? {} : { mode }) },
    content,
  };
}

function dirRecord(path: string): ProjectSyncFrameRecord {
  return { header: { path, size: 0, kind: "dir" }, content: new Uint8Array(0) };
}

function symlinkRecord(path: string, linkTarget: string): ProjectSyncFrameRecord {
  return { header: { path, size: 0, kind: "symlink", linkTarget }, content: new Uint8Array(0) };
}

async function* iterate(records: ReadonlyArray<ProjectSyncFrameRecord>) {
  for (const record of records) yield record;
}

/** Runs the real wire path: encode to bytes, decode them back, then apply. */
const applyThroughFraming = (input: {
  readonly workspaceRoot: string;
  readonly records: ReadonlyArray<ProjectSyncFrameRecord>;
  readonly maxContentBytes?: number;
}) =>
  applyProjectSyncRecords({
    workspaceRoot: input.workspaceRoot,
    records: createProjectSyncFrameDecoder(encodeProjectSyncRecords(iterate(input.records))),
    ...(input.maxContentBytes === undefined ? {} : { maxContentBytes: input.maxContentBytes }),
  });

const readText = (root: string, relativePath: string) =>
  Effect.promise(() => NodeFSP.readFile(NodePath.join(root, relativePath), "utf8"));

const lstat = (root: string, relativePath: string) =>
  Effect.promise(() => NodeFSP.lstat(NodePath.join(root, relativePath)));

const exists = (root: string, relativePath: string) =>
  Effect.promise(() =>
    NodeFSP.lstat(NodePath.join(root, relativePath)).then(
      () => true,
      () => false,
    ),
  );

const writeFile = (root: string, relativePath: string, contents: string) =>
  Effect.promise(async () => {
    const absolutePath = NodePath.join(root, relativePath);
    await NodeFSP.mkdir(NodePath.dirname(absolutePath), { recursive: true });
    await NodeFSP.writeFile(absolutePath, contents);
  });

it.layer(NodeServices.layer, { excludeTestServices: true })("ProjectSyncApply", (it) => {
  describe("resolveProjectSyncRelativePath", () => {
    it.effect("rejects traversal, absolute, and empty paths", () =>
      Effect.gen(function* () {
        const workspaceRoot = yield* makeTempDir;
        for (const relativePath of [
          "../escape.txt",
          "a/../../escape.txt",
          "/etc/passwd",
          "",
          "   ",
          ".",
          "a/./b",
          "a//b",
          "a/\0b",
        ]) {
          expect(resolveProjectSyncRelativePath({ workspaceRoot, relativePath })).toBeNull();
        }

        expect(resolveProjectSyncRelativePath({ workspaceRoot, relativePath: "a/b.txt" })).toEqual({
          absolutePath: NodePath.join(workspaceRoot, "a", "b.txt"),
          relativePath: "a/b.txt",
        });
      }),
    );
  });

  describe("import", () => {
    it.effect("round-trips files, modes, symlinks, and empty directories", () =>
      Effect.gen(function* () {
        const workspaceRoot = yield* makeTempDir;

        const result = yield* applyThroughFraming({
          workspaceRoot,
          records: [
            fileRecord("README.md", "# hello\n"),
            fileRecord("bin/run.sh", "#!/bin/sh\necho hi\n", 0o755),
            fileRecord("src/nested/deep/index.ts", "export {};\n", 0o644),
            dirRecord("empty/dir"),
            symlinkRecord("link.md", "README.md"),
          ],
        });

        expect(result.applied).toBe(5);
        expect(yield* readText(workspaceRoot, "README.md")).toBe("# hello\n");
        expect(yield* readText(workspaceRoot, "src/nested/deep/index.ts")).toBe("export {};\n");
        expect((yield* lstat(workspaceRoot, "bin/run.sh")).mode & 0o777).toBe(0o755);
        expect((yield* lstat(workspaceRoot, "empty/dir")).isDirectory()).toBe(true);

        const link = yield* lstat(workspaceRoot, "link.md");
        expect(link.isSymbolicLink()).toBe(true);
        expect(
          yield* Effect.promise(() => NodeFSP.readlink(NodePath.join(workspaceRoot, "link.md"))),
        ).toBe("README.md");
      }),
    );

    it.effect("replaces an existing file without following a symlink at the target", () =>
      Effect.gen(function* () {
        const workspaceRoot = yield* makeTempDir;
        const outside = yield* makeTempDir;
        yield* writeFile(outside, "victim.txt", "original");
        yield* Effect.promise(() =>
          NodeFSP.symlink(
            NodePath.join(outside, "victim.txt"),
            NodePath.join(workspaceRoot, "victim.txt"),
          ),
        );

        yield* applyThroughFraming({
          workspaceRoot,
          records: [fileRecord("victim.txt", "replaced")],
        });

        expect(yield* readText(workspaceRoot, "victim.txt")).toBe("replaced");
        expect(yield* readText(outside, "victim.txt")).toBe("original");
      }),
    );

    it.effect("refuses a record whose path escapes the workspace root", () =>
      Effect.gen(function* () {
        const workspaceRoot = yield* makeTempDir;
        const error = yield* Effect.flip(
          applyThroughFraming({
            workspaceRoot,
            records: [fileRecord("../escape.txt", "nope")],
          }),
        );
        expect(error._tag).toBe("ProjectSyncPathViolationError");
        expect(yield* exists(workspaceRoot, "../escape.txt")).toBe(false);
      }),
    );

    it.effect("refuses a record whose ancestor directory is a symlink", () =>
      Effect.gen(function* () {
        const workspaceRoot = yield* makeTempDir;
        const outside = yield* makeTempDir;
        yield* Effect.promise(() =>
          NodeFSP.symlink(outside, NodePath.join(workspaceRoot, "linked")),
        );

        const error = yield* Effect.flip(
          applyThroughFraming({
            workspaceRoot,
            records: [fileRecord("linked/planted.txt", "nope")],
          }),
        );
        expect(error._tag).toBe("ProjectSyncPathViolationError");
        expect(yield* exists(outside, "planted.txt")).toBe(false);
      }),
    );

    it.effect("stops once the signed byte budget is exhausted", () =>
      Effect.gen(function* () {
        const workspaceRoot = yield* makeTempDir;
        const error = yield* Effect.flip(
          applyThroughFraming({
            workspaceRoot,
            records: [fileRecord("a.txt", "0123456789"), fileRecord("b.txt", "0123456789")],
            maxContentBytes: 10,
          }),
        );
        expect(error._tag).toBe("ProjectSyncImportLimitError");
        expect(yield* exists(workspaceRoot, "b.txt")).toBe(false);
      }),
    );
  });

  describe("deletions", () => {
    it.effect("removes entries and prunes the directories they emptied", () =>
      Effect.gen(function* () {
        const workspaceRoot = yield* makeTempDir;
        yield* writeFile(workspaceRoot, "a/b/c.txt", "gone");
        yield* writeFile(workspaceRoot, "a/keep.txt", "kept");

        const result = yield* applyProjectSyncDeletions({
          workspaceRoot,
          paths: ["a/b/c.txt"],
        });

        expect(result.deleted).toBe(1);
        expect(yield* exists(workspaceRoot, "a/b")).toBe(false);
        expect(yield* exists(workspaceRoot, "a/keep.txt")).toBe(true);
      }),
    );

    it.effect("prunes up to but never past the workspace root", () =>
      Effect.gen(function* () {
        const workspaceRoot = yield* makeTempDir;
        yield* writeFile(workspaceRoot, "only/one.txt", "gone");

        yield* applyProjectSyncDeletions({ workspaceRoot, paths: ["only/one.txt"] });

        expect(yield* exists(workspaceRoot, "only")).toBe(false);
        expect((yield* Effect.promise(() => NodeFSP.lstat(workspaceRoot))).isDirectory()).toBe(
          true,
        );
      }),
    );

    it.effect("is idempotent: an already-missing path is not an error", () =>
      Effect.gen(function* () {
        const workspaceRoot = yield* makeTempDir;
        yield* writeFile(workspaceRoot, "gone.txt", "x");

        expect(
          (yield* applyProjectSyncDeletions({ workspaceRoot, paths: ["gone.txt"] })).deleted,
        ).toBe(1);
        expect(
          (yield* applyProjectSyncDeletions({ workspaceRoot, paths: ["gone.txt"] })).deleted,
        ).toBe(0);
      }),
    );

    it.effect("refuses to delete through a symlinked ancestor", () =>
      Effect.gen(function* () {
        const workspaceRoot = yield* makeTempDir;
        const outside = yield* makeTempDir;
        yield* writeFile(outside, "victim.txt", "keep me");
        yield* Effect.promise(() =>
          NodeFSP.symlink(outside, NodePath.join(workspaceRoot, "linked")),
        );

        const error = yield* Effect.flip(
          applyProjectSyncDeletions({ workspaceRoot, paths: ["linked/victim.txt"] }),
        );
        expect(error._tag).toBe("ProjectSyncPathViolationError");
        expect(yield* exists(outside, "victim.txt")).toBe(true);
      }),
    );

    it.effect("removes an empty directory entry but leaves a populated one", () =>
      Effect.gen(function* () {
        const workspaceRoot = yield* makeTempDir;
        yield* Effect.promise(() =>
          NodeFSP.mkdir(NodePath.join(workspaceRoot, "empty"), { recursive: true }),
        );
        yield* writeFile(workspaceRoot, "full/child.txt", "x");

        const result = yield* applyProjectSyncDeletions({
          workspaceRoot,
          paths: ["empty", "full"],
        });

        expect(result.deleted).toBe(1);
        expect(yield* exists(workspaceRoot, "empty")).toBe(false);
        expect(yield* exists(workspaceRoot, "full/child.txt")).toBe(true);
      }),
    );
  });
});
