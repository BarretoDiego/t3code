// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { buildProjectSyncManifest } from "./ProjectSyncManifest.ts";

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-project-sync-manifest-" });
});

const writeFile = (root: string, relativePath: string, contents: string) =>
  Effect.promise(async () => {
    const absolutePath = NodePath.join(root, relativePath);
    await NodeFSP.mkdir(NodePath.dirname(absolutePath), { recursive: true });
    await NodeFSP.writeFile(absolutePath, contents);
    return absolutePath;
  });

const makeDirectory = (root: string, relativePath: string) =>
  Effect.promise(async () => {
    const absolutePath = NodePath.join(root, relativePath);
    await NodeFSP.mkdir(absolutePath, { recursive: true });
    return absolutePath;
  });

const makeSymlink = (root: string, relativePath: string, target: string) =>
  Effect.promise(async () => {
    const absolutePath = NodePath.join(root, relativePath);
    await NodeFSP.mkdir(NodePath.dirname(absolutePath), { recursive: true });
    await NodeFSP.symlink(target, absolutePath);
  });

const paths = (entries: ReadonlyArray<{ readonly path: string }>) =>
  entries.map((entry) => entry.path);

it.layer(NodeServices.layer, { excludeTestServices: true })("buildProjectSyncManifest", (it) => {
  describe("ignores", () => {
    it.effect("always drops node_modules, .t3, and .DS_Store", () =>
      Effect.gen(function* () {
        const workspaceRoot = yield* makeTempDir;
        yield* writeFile(workspaceRoot, "src/index.ts", "export {};\n");
        yield* writeFile(workspaceRoot, "node_modules/pkg/index.js", "module.exports = 1;");
        yield* writeFile(workspaceRoot, ".t3/state.json", "{}");
        yield* writeFile(workspaceRoot, ".DS_Store", "junk");
        yield* writeFile(workspaceRoot, "src/.DS_Store", "junk");

        const entries = yield* buildProjectSyncManifest({ workspaceRoot, includeGit: true });
        expect(paths(entries)).toEqual(["src/index.ts"]);
      }),
    );

    it.effect("layers extraIgnores on top of the defaults", () =>
      Effect.gen(function* () {
        const workspaceRoot = yield* makeTempDir;
        yield* writeFile(workspaceRoot, "src/index.ts", "export {};\n");
        yield* writeFile(workspaceRoot, "dist/bundle.js", "1");
        yield* writeFile(workspaceRoot, "packages/app/dist/bundle.js", "1");

        const entries = yield* buildProjectSyncManifest({
          workspaceRoot,
          includeGit: true,
          extraIgnores: ["dist"],
        });
        // `packages/app` survives as an empty-directory entry: everything
        // inside it was ignored, so the destination still rebuilds the shape.
        expect(paths(entries)).toEqual(["packages/app", "src/index.ts"]);
      }),
    );

    it.effect("keeps .git when includeGit is true and drops it when false", () =>
      Effect.gen(function* () {
        const workspaceRoot = yield* makeTempDir;
        yield* writeFile(workspaceRoot, ".git/HEAD", "ref: refs/heads/main\n");
        yield* writeFile(workspaceRoot, "README.md", "# hi\n");

        const withGit = yield* buildProjectSyncManifest({ workspaceRoot, includeGit: true });
        expect(paths(withGit)).toEqual([".git/HEAD", "README.md"]);

        const withoutGit = yield* buildProjectSyncManifest({ workspaceRoot, includeGit: false });
        expect(paths(withoutGit)).toEqual(["README.md"]);
      }),
    );
  });

  describe("entry kinds", () => {
    it.effect("records symlinks by target without following them", () =>
      Effect.gen(function* () {
        const workspaceRoot = yield* makeTempDir;
        const outside = yield* makeTempDir;
        yield* writeFile(outside, "secret.txt", "nope");
        yield* writeFile(workspaceRoot, "target.txt", "hi");
        yield* makeSymlink(workspaceRoot, "link.txt", "target.txt");
        yield* makeSymlink(workspaceRoot, "outside", outside);

        const entries = yield* buildProjectSyncManifest({ workspaceRoot, includeGit: true });
        expect(paths(entries)).toEqual(["link.txt", "outside", "target.txt"]);
        expect(entries.find((entry) => entry.path === "link.txt")).toEqual({
          path: "link.txt",
          kind: "symlink",
          size: 0,
          linkTarget: "target.txt",
        });
        expect(entries.find((entry) => entry.path === "outside")?.kind).toBe("symlink");
      }),
    );

    it.effect("emits a dir entry only for directories that contribute nothing else", () =>
      Effect.gen(function* () {
        const workspaceRoot = yield* makeTempDir;
        yield* makeDirectory(workspaceRoot, "empty");
        yield* makeDirectory(workspaceRoot, "nested/deep");
        yield* writeFile(workspaceRoot, "kept/file.txt", "x");
        yield* writeFile(workspaceRoot, "only-ignored/node_modules/pkg.js", "x");

        const entries = yield* buildProjectSyncManifest({ workspaceRoot, includeGit: true });
        expect(paths(entries)).toEqual(["empty", "kept/file.txt", "nested/deep", "only-ignored"]);
        expect(entries.find((entry) => entry.path === "nested/deep")).toEqual({
          path: "nested/deep",
          kind: "dir",
          size: 0,
        });
      }),
    );

    it.effect("hashes file contents with sha256 and reports size and mode", () =>
      Effect.gen(function* () {
        const workspaceRoot = yield* makeTempDir;
        const absolutePath = yield* writeFile(workspaceRoot, "bin/run.sh", "hello world");
        yield* Effect.promise(() => NodeFSP.chmod(absolutePath, 0o755));
        yield* writeFile(workspaceRoot, "empty.txt", "");

        const entries = yield* buildProjectSyncManifest({ workspaceRoot, includeGit: true });
        expect(entries.find((entry) => entry.path === "bin/run.sh")).toEqual({
          path: "bin/run.sh",
          kind: "file",
          size: 11,
          mode: 0o755,
          hash: "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
        });
        expect(entries.find((entry) => entry.path === "empty.txt")?.hash).toBe(
          "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        );
      }),
    );
  });

  it.effect("returns path-sorted entries and repeats itself exactly", () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* makeTempDir;
      yield* writeFile(workspaceRoot, "b.txt", "b");
      yield* writeFile(workspaceRoot, "a/z.txt", "z");
      yield* writeFile(workspaceRoot, "a/a.txt", "a");
      yield* writeFile(workspaceRoot, "a.txt", "a");
      yield* makeDirectory(workspaceRoot, "c");

      const first = yield* buildProjectSyncManifest({ workspaceRoot, includeGit: true });
      const second = yield* buildProjectSyncManifest({ workspaceRoot, includeGit: true });

      expect(paths(first)).toEqual(["a.txt", "a/a.txt", "a/z.txt", "b.txt", "c"]);
      expect(second).toEqual(first);
    }),
  );
});
