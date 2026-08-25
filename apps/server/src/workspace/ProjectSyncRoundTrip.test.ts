// @effect-diagnostics nodeBuiltinImport:off
/**
 * End-to-end project sync between two real directories.
 *
 * The three server pieces (manifest walk, export stream, import/delete apply)
 * are only correct together: the diff the client computes has to name paths
 * the export can serve, the framing has to survive the trip, and the delete
 * pass has to leave the destination mirroring the origin. These tests drive
 * the whole loop rather than any one piece.
 *
 * `computeProjectSyncPlan` is imported from its source file because the diff
 * lives on the client (client-runtime is not, and should not become, a server
 * dependency) while the thing under test here is that the client's plan and
 * the server's filesystem work agree.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  createProjectSyncFrameDecoder,
  encodeProjectSyncRecords,
} from "@t3tools/shared/projectSyncFraming";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { computeProjectSyncPlan } from "../../../../packages/client-runtime/src/operations/projectSync.ts";
import { applyProjectSyncDeletions, applyProjectSyncRecords } from "./ProjectSyncApply.ts";
import { buildProjectSyncManifest } from "./ProjectSyncManifest.ts";
import { projectSyncExportRecords } from "./ProjectSyncTransfer.ts";

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-project-sync-e2e-" });
});

const writeFile = (root: string, relativePath: string, contents: string) =>
  Effect.promise(async () => {
    const absolutePath = NodePath.join(root, relativePath);
    await NodeFSP.mkdir(NodePath.dirname(absolutePath), { recursive: true });
    await NodeFSP.writeFile(absolutePath, contents);
    return absolutePath;
  });

const makeDir = (root: string, relativePath: string) =>
  Effect.promise(() => NodeFSP.mkdir(NodePath.join(root, relativePath), { recursive: true }));

const makeSymlink = (root: string, relativePath: string, target: string) =>
  Effect.promise(async () => {
    const absolutePath = NodePath.join(root, relativePath);
    await NodeFSP.mkdir(NodePath.dirname(absolutePath), { recursive: true });
    await NodeFSP.symlink(target, absolutePath);
  });

const exists = (root: string, relativePath: string) =>
  Effect.promise(() =>
    NodeFSP.lstat(NodePath.join(root, relativePath)).then(
      () => true,
      () => false,
    ),
  );

const manifestOf = (workspaceRoot: string) =>
  buildProjectSyncManifest({ workspaceRoot, includeGit: true });

const copyEntries = (
  origin: string,
  destination: string,
  entries: ReadonlyArray<{ readonly path: string; readonly size: number }>,
) =>
  applyProjectSyncRecords({
    workspaceRoot: destination,
    records: createProjectSyncFrameDecoder(
      encodeProjectSyncRecords(
        projectSyncExportRecords({
          workspaceRoot: origin,
          entries: entries.map((entry) => ({ path: entry.path, size: entry.size })),
        }),
      ),
    ),
    maxRecordCount: entries.length,
  });

/**
 * Runs one sync exactly the way `runProjectSync` drives it from the client:
 * diff both manifests, copy what changed, delete what the origin no longer
 * has, then re-assert the origin's empty directories (the delete pass prunes
 * the directories it empties, which can take one of those with it).
 */
const syncOnce = (origin: string, destination: string) =>
  Effect.gen(function* () {
    const plan = computeProjectSyncPlan(yield* manifestOf(origin), yield* manifestOf(destination));

    yield* copyEntries(origin, destination, plan.toCopy);
    if (plan.toDelete.length > 0) {
      yield* applyProjectSyncDeletions({ workspaceRoot: destination, paths: plan.toDelete });
      yield* copyEntries(
        origin,
        destination,
        plan.toCopy.filter((entry) => entry.kind === "dir"),
      );
    }
    return plan;
  });

it.layer(NodeServices.layer, { excludeTestServices: true })("project sync round trip", (it) => {
  it.effect("mirrors an origin onto a populated destination in a single pass", () =>
    Effect.gen(function* () {
      const origin = yield* makeTempDir;
      const destination = yield* makeTempDir;

      yield* writeFile(origin, "README.md", "# origin\n");
      yield* writeFile(origin, "src/index.ts", "export const answer = 42;\n");
      yield* writeFile(origin, "src/added.ts", "export const added = true;\n");
      const script = yield* writeFile(origin, "bin/run.sh", "#!/bin/sh\necho hi\n");
      yield* Effect.promise(() => NodeFSP.chmod(script, 0o755));
      yield* makeDir(origin, "empty");
      yield* makeSymlink(origin, "link.md", "README.md");

      // The destination starts out stale in every way the diff has to notice:
      // an unchanged file, a changed file, a file the origin dropped, a whole
      // subtree the origin dropped, and a symlink pointing somewhere else.
      yield* writeFile(destination, "README.md", "# origin\n");
      yield* writeFile(destination, "src/index.ts", "export const answer = 0;\n");
      yield* writeFile(destination, "stale.txt", "remove me\n");
      yield* writeFile(destination, "old/deep/nested.txt", "remove me too\n");
      yield* makeSymlink(destination, "link.md", "elsewhere.md");

      const plan = yield* syncOnce(origin, destination);

      expect(plan.toCopy.map((entry) => entry.path)).toEqual([
        "bin/run.sh",
        "empty",
        "link.md",
        "src/added.ts",
        "src/index.ts",
      ]);
      // Deepest first, so a sequential delete never orphans a child.
      expect(plan.toDelete).toEqual(["old/deep/nested.txt", "stale.txt"]);

      expect(yield* manifestOf(destination)).toEqual(yield* manifestOf(origin));
      // Directories the deleted files lived in are pruned, not left behind as
      // empty husks the origin never had.
      expect(yield* exists(destination, "old")).toBe(false);
      expect(yield* exists(destination, "empty")).toBe(true);
      expect(
        (yield* Effect.promise(() =>
          NodeFSP.lstat(NodePath.join(destination, "link.md")),
        )).isSymbolicLink(),
      ).toBe(true);
      expect(
        yield* Effect.promise(() => NodeFSP.readlink(NodePath.join(destination, "link.md"))),
      ).toBe("README.md");
    }),
  );

  it.effect("keeps an origin's empty directory that the destination filled", () =>
    Effect.gen(function* () {
      const origin = yield* makeTempDir;
      const destination = yield* makeTempDir;

      yield* makeDir(origin, "logs");
      yield* writeFile(origin, "keep.txt", "keep\n");
      yield* writeFile(destination, "keep.txt", "keep\n");
      yield* writeFile(destination, "logs/app.log", "noise\n");

      yield* syncOnce(origin, destination);

      expect(yield* manifestOf(destination)).toEqual(yield* manifestOf(origin));
      expect(yield* exists(destination, "logs")).toBe(true);
      expect(yield* exists(destination, "logs/app.log")).toBe(false);
    }),
  );

  it.effect("converges: a second pass over a mirrored destination is a no-op", () =>
    Effect.gen(function* () {
      const origin = yield* makeTempDir;
      const destination = yield* makeTempDir;

      yield* writeFile(origin, "a/b/c.txt", "content\n");
      yield* makeDir(origin, "empty");
      yield* makeSymlink(origin, "a/link", "b/c.txt");
      yield* writeFile(destination, "gone.txt", "gone\n");

      yield* syncOnce(origin, destination);
      const secondPass = yield* syncOnce(origin, destination);

      expect(secondPass.toCopy).toEqual([]);
      expect(secondPass.toDelete).toEqual([]);
      expect(yield* manifestOf(destination)).toEqual(yield* manifestOf(origin));
    }),
  );

  it.effect("replaces a destination directory with the origin's file of the same name", () =>
    Effect.gen(function* () {
      const origin = yield* makeTempDir;
      const destination = yield* makeTempDir;

      yield* writeFile(origin, "thing", "now a file\n");
      yield* writeFile(destination, "thing/inner.txt", "was a directory\n");

      yield* syncOnce(origin, destination);

      expect(yield* manifestOf(destination)).toEqual(yield* manifestOf(origin));
      expect(
        yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(destination, "thing"), "utf8")),
      ).toBe("now a file\n");
    }),
  );

  it.effect("carries filenames with edge whitespace and backslashes through intact", () =>
    Effect.gen(function* () {
      // Every one of these is a legal POSIX filename that an earlier trimming
      // or `\`→`/` rewrite would have renamed on the wire: the export would
      // then miss the file, and the sync would report itself complete while
      // silently omitting it.
      const awkward =
        NodePath.sep === "\\"
          ? ["docs/notes .md", " leading.md"]
          : ["docs/notes .md", " leading.md", "draft v2\\final.md", "trailing space "];

      const origin = yield* makeTempDir;
      const destination = yield* makeTempDir;
      for (const [index, path] of awkward.entries()) {
        yield* writeFile(origin, path, `content ${index}\n`);
      }

      const plan = yield* syncOnce(origin, destination);

      expect(plan.toCopy.map((entry) => entry.path).sort()).toEqual([...awkward].sort());
      expect(yield* manifestOf(destination)).toEqual(yield* manifestOf(origin));
      for (const [index, path] of awkward.entries()) {
        expect(
          yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(destination, path), "utf8")),
        ).toBe(`content ${index}\n`);
      }

      // And the second pass sees nothing to do, which it could not if either
      // side had renamed anything.
      const secondPass = yield* syncOnce(origin, destination);
      expect(secondPass.toCopy).toEqual([]);
      expect(secondPass.toDelete).toEqual([]);
    }),
  );

  it.effect("replaces a destination file with the origin's directory of the same name", () =>
    Effect.gen(function* () {
      const origin = yield* makeTempDir;
      const destination = yield* makeTempDir;

      yield* writeFile(origin, "thing/inner.txt", "now a directory\n");
      yield* writeFile(destination, "thing", "was a file\n");

      yield* syncOnce(origin, destination);

      expect(yield* manifestOf(destination)).toEqual(yield* manifestOf(origin));
      expect(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(destination, "thing/inner.txt"), "utf8"),
        ),
      ).toBe("now a directory\n");
    }),
  );
});
