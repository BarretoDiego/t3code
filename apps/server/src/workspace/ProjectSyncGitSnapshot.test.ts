// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import {
  captureProjectSyncGitSnapshot,
  restoreProjectSyncGitSnapshot,
  runSnapshotGit,
  includeSyncUntrackedPath,
  cleanupProjectSyncGitSnapshot,
} from "./ProjectSyncGitSnapshot.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-handoff-"));
  roots.push(root);
  const source = NodePath.join(root, "source");
  await NodeFSP.mkdir(source);
  const git = (...args: string[]) => runSnapshotGit(source, args);
  await git("init", "-b", "feature/private");
  await git("config", "user.email", "test@example.invalid");
  await git("config", "user.name", "Handoff test");
  await NodeFSP.writeFile(NodePath.join(source, "tracked.txt"), "base\n");
  await NodeFSP.writeFile(NodePath.join(source, "deleted.txt"), "delete\n");
  await NodeFSP.writeFile(NodePath.join(source, "renamed.txt"), "rename\n");
  await NodeFSP.writeFile(NodePath.join(source, ".gitignore"), "ignored/\n");
  await git("add", ".");
  await git("commit", "-m", "base");
  return {
    root,
    source,
    git,
    outputDirectory: NodePath.join(root, "transfer"),
    destinationDirectory: NodePath.join(root, "linux-destination"),
  };
}

test("restores a clean private branch without a remote or artificial commits", async () => {
  const f = await fixture();
  const snapshot = await captureProjectSyncGitSnapshot({
    cwd: f.source,
    outputDirectory: f.outputDirectory,
  });
  await restoreProjectSyncGitSnapshot({
    snapshot,
    inputDirectory: f.outputDirectory,
    destinationDirectory: f.destinationDirectory,
  });
  expect((await runSnapshotGit(f.destinationDirectory, ["status", "--porcelain"])).toString()).toBe(
    "",
  );
  expect(
    (await runSnapshotGit(f.destinationDirectory, ["rev-parse", "HEAD"])).toString().trim(),
  ).toBe(snapshot.head);
  expect(
    (await runSnapshotGit(f.destinationDirectory, ["branch", "--show-current"])).toString().trim(),
  ).toBe("feature/private");
  expect((await f.git("log", "--oneline")).toString().trim().split("\n")).toHaveLength(1);
});

test("round-trips partial staging, deletion, rename, binary files and relevant untracked files", async () => {
  const f = await fixture();
  await NodeFSP.writeFile(NodePath.join(f.source, "tracked.txt"), "staged\n");
  await NodeFSP.writeFile(NodePath.join(f.source, "binary.bin"), Buffer.from([0, 255, 1, 2]));
  await f.git("add", "tracked.txt", "binary.bin");
  await NodeFSP.writeFile(NodePath.join(f.source, "tracked.txt"), "staged\nunstaged\n");
  await NodeFSP.rm(NodePath.join(f.source, "deleted.txt"));
  await f.git("mv", "renamed.txt", "new-name.txt");
  await NodeFSP.writeFile(NodePath.join(f.source, "notes .md"), "keep me\n");
  const snapshot = await captureProjectSyncGitSnapshot({
    cwd: f.source,
    outputDirectory: f.outputDirectory,
  });
  await restoreProjectSyncGitSnapshot({
    snapshot,
    inputDirectory: f.outputDirectory,
    destinationDirectory: f.destinationDirectory,
  });
  const statusArgs = ["status", "--porcelain=v1", "-z", "--untracked-files=all"];
  expect(await runSnapshotGit(f.destinationDirectory, statusArgs)).toEqual(
    await f.git(...statusArgs),
  );
  for (const flags of [[], ["--cached"]]) {
    expect(await runSnapshotGit(f.destinationDirectory, ["diff", ...flags, "--binary"])).toEqual(
      await f.git("diff", ...flags, "--binary"),
    );
  }
  expect(await NodeFSP.readFile(NodePath.join(f.destinationDirectory, "notes .md"), "utf8")).toBe(
    "keep me\n",
  );
});

test("uses existing Git objects without a bundle and handles linked worktrees at different paths", async () => {
  const f = await fixture();
  const worktree = NodePath.join(f.root, "mac-worktree");
  await f.git("worktree", "add", "-b", "feature/worktree", worktree);
  await NodeFSP.writeFile(NodePath.join(worktree, "tracked.txt"), "worktree change\n");
  await runSnapshotGit(worktree, ["add", "tracked.txt"]);
  await NodeFSP.writeFile(NodePath.join(worktree, "tracked.txt"), "worktree change\nunstaged\n");
  const existingRepository = NodePath.join(f.root, "destination-repository");
  await f.git("clone", "--no-local", f.source, existingRepository);
  const existingStatus = await runSnapshotGit(existingRepository, ["status", "--porcelain"]);
  const head = (await f.git("rev-parse", "HEAD")).toString().trim();
  const snapshot = await captureProjectSyncGitSnapshot({
    cwd: worktree,
    outputDirectory: f.outputDirectory,
    destinationHasHead: head,
  });
  expect(snapshot.bundle).toBeNull();
  expect(snapshot.sourceWasWorktree).toBe(true);
  await restoreProjectSyncGitSnapshot({
    snapshot,
    inputDirectory: f.outputDirectory,
    destinationDirectory: f.destinationDirectory,
    existingRepository,
  });
  expect(await runSnapshotGit(f.destinationDirectory, ["diff"])).toEqual(
    await runSnapshotGit(worktree, ["diff"]),
  );
  expect(await runSnapshotGit(f.destinationDirectory, ["diff", "--cached"])).toEqual(
    await runSnapshotGit(worktree, ["diff", "--cached"]),
  );
  expect((await NodeFSP.lstat(NodePath.join(f.destinationDirectory, ".git"))).isFile()).toBe(true);
  expect(
    (
      await runSnapshotGit(f.destinationDirectory, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ])
    )
      .toString()
      .trim(),
  ).toBe(await NodeFSP.realpath(NodePath.join(existingRepository, ".git")));
  expect(await runSnapshotGit(existingRepository, ["status", "--porcelain"])).toEqual(
    existingStatus,
  );
  await cleanupProjectSyncGitSnapshot({
    destinationDirectory: f.destinationDirectory,
    existingRepository,
    sourceWasWorktree: true,
  });
  expect(
    (await runSnapshotGit(existingRepository, ["worktree", "list", "--porcelain"])).toString(),
  ).not.toContain(f.destinationDirectory);
  await expect(
    runSnapshotGit(existingRepository, ["rev-parse", "--verify", "refs/heads/feature/worktree"]),
  ).rejects.toThrow();
  await cleanupProjectSyncGitSnapshot({
    destinationDirectory: f.destinationDirectory,
    existingRepository,
    sourceWasWorktree: true,
  });
});

test("rejects an occupied destination branch without touching its checkout or index", async () => {
  const f = await fixture();
  const worktree = NodePath.join(f.root, "occupied-worktree");
  await f.git("worktree", "add", "-b", "feature/occupied", worktree);
  await NodeFSP.writeFile(NodePath.join(worktree, "tracked.txt"), "keep staged\n");
  await runSnapshotGit(worktree, ["add", "tracked.txt"]);
  const snapshot = await captureProjectSyncGitSnapshot({
    cwd: worktree,
    outputDirectory: f.outputDirectory,
  });
  const worktrees = await f.git("worktree", "list", "--porcelain");
  await expect(
    restoreProjectSyncGitSnapshot({
      snapshot,
      inputDirectory: f.outputDirectory,
      destinationDirectory: f.destinationDirectory,
      existingRepository: f.source,
    }),
  ).rejects.toThrow("branch already exists");
  expect(await f.git("worktree", "list", "--porcelain")).toEqual(worktrees);
  expect((await runSnapshotGit(worktree, ["write-tree"])).toString().trim()).toBe(
    snapshot.indexTree,
  );
  expect(await NodeFSP.readFile(NodePath.join(worktree, "tracked.txt"), "utf8")).toBe(
    "keep staged\n",
  );
  await expect(NodeFSP.stat(f.destinationDirectory)).rejects.toMatchObject({ code: "ENOENT" });
});

test("rolls back linked worktree registration and newly created branch after corrupt transfer", async () => {
  const f = await fixture();
  const worktree = NodePath.join(f.root, "source-worktree");
  await f.git("worktree", "add", "-b", "feature/rollback", worktree);
  await NodeFSP.writeFile(NodePath.join(worktree, "notes.txt"), "original\n");
  const existingRepository = NodePath.join(f.root, "destination-repository");
  await f.git("clone", "--no-local", f.source, existingRepository);
  const snapshot = await captureProjectSyncGitSnapshot({
    cwd: worktree,
    outputDirectory: f.outputDirectory,
  });
  await NodeFSP.writeFile(
    NodePath.join(f.outputDirectory, "files", snapshot.untracked[0]!.hash),
    "tampered",
  );
  const worktrees = await runSnapshotGit(existingRepository, ["worktree", "list", "--porcelain"]);
  await expect(
    restoreProjectSyncGitSnapshot({
      snapshot,
      inputDirectory: f.outputDirectory,
      destinationDirectory: f.destinationDirectory,
      existingRepository,
    }),
  ).rejects.toThrow("checksum");
  expect(await runSnapshotGit(existingRepository, ["worktree", "list", "--porcelain"])).toEqual(
    worktrees,
  );
  await expect(
    runSnapshotGit(existingRepository, ["rev-parse", "--verify", "refs/heads/feature/rollback"]),
  ).rejects.toThrow();
  await expect(NodeFSP.stat(f.destinationDirectory)).rejects.toMatchObject({ code: "ENOENT" });
});

test("bundles checkpoint objects outside HEAD ancestry even when destination already has HEAD", async () => {
  const f = await fixture();
  const head = (await f.git("rev-parse", "HEAD")).toString().trim();
  await NodeFSP.writeFile(NodePath.join(f.source, "checkpoint-only.txt"), "checkpoint content\n");
  await f.git("add", ".");
  await f.git("commit", "-m", "checkpoint-only");
  const checkpoint = (await f.git("rev-parse", "HEAD")).toString().trim();
  const ref = "refs/t3/checkpoints/thread-123/turn-1";
  await f.git("update-ref", ref, checkpoint);
  await f.git("reset", "--hard", head);
  const snapshot = await captureProjectSyncGitSnapshot({
    cwd: f.source,
    outputDirectory: f.outputDirectory,
    destinationHasHead: head,
    checkpointRefs: [ref, ref],
  });
  expect(snapshot.bundle).toBe("history.bundle");
  expect(snapshot.checkpointRefs).toEqual([ref]);
  await restoreProjectSyncGitSnapshot({
    snapshot,
    inputDirectory: f.outputDirectory,
    destinationDirectory: f.destinationDirectory,
  });
  expect((await runSnapshotGit(f.destinationDirectory, ["rev-parse", ref])).toString().trim()).toBe(
    checkpoint,
  );
  expect(
    (
      await runSnapshotGit(f.destinationDirectory, ["show", `${ref}:checkpoint-only.txt`])
    ).toString(),
  ).toBe("checkpoint content\n");
  expect(
    (await runSnapshotGit(f.destinationDirectory, ["rev-parse", "HEAD"])).toString().trim(),
  ).toBe(head);
});

test("rejects checkpoint refs outside the checkpoint namespace", async () => {
  const f = await fixture();
  await expect(
    captureProjectSyncGitSnapshot({
      cwd: f.source,
      outputDirectory: f.outputDirectory,
      checkpointRefs: ["refs/heads/feature/private"],
    }),
  ).rejects.toThrow("namespace");
  await expect(NodeFSP.stat(f.outputDirectory)).rejects.toMatchObject({ code: "ENOENT" });
});

test("restores unpushed worktree commits and checkpoint refs into the shared repository", async () => {
  const f = await fixture();
  const existingRepository = NodePath.join(f.root, "destination-repository");
  await f.git("clone", "--no-local", f.source, existingRepository);
  const initialBranch = await runSnapshotGit(existingRepository, ["branch", "--show-current"]);
  const initialHead = await runSnapshotGit(existingRepository, ["rev-parse", "HEAD"]);
  const worktree = NodePath.join(f.root, "source-worktree");
  await f.git("worktree", "add", "-b", "feature/unpushed", worktree);
  await NodeFSP.writeFile(NodePath.join(worktree, "unpushed.txt"), "private commit\n");
  await runSnapshotGit(worktree, ["add", "."]);
  await runSnapshotGit(worktree, ["commit", "-m", "private"]);
  const ref = "refs/t3/checkpoints/thread-123/turn-1";
  await runSnapshotGit(worktree, ["update-ref", ref, "HEAD"]);
  const snapshot = await captureProjectSyncGitSnapshot({
    cwd: worktree,
    outputDirectory: f.outputDirectory,
    checkpointRefs: [ref],
  });
  await restoreProjectSyncGitSnapshot({
    snapshot,
    inputDirectory: f.outputDirectory,
    destinationDirectory: f.destinationDirectory,
    existingRepository,
  });
  expect((await runSnapshotGit(existingRepository, ["rev-parse", ref])).toString().trim()).toBe(
    snapshot.head,
  );
  expect(await runSnapshotGit(existingRepository, ["branch", "--show-current"])).toEqual(
    initialBranch,
  );
  expect(await runSnapshotGit(existingRepository, ["rev-parse", "HEAD"])).toEqual(initialHead);
  expect(
    await NodeFSP.readFile(NodePath.join(f.destinationDirectory, "unpushed.txt"), "utf8"),
  ).toBe("private commit\n");
});

test("extra ignores use Project Sync segment semantics only for untracked files", async () => {
  const f = await fixture();
  await NodeFSP.mkdir(NodePath.join(f.source, "custom-cache"));
  await NodeFSP.writeFile(NodePath.join(f.source, "custom-cache", "tracked.txt"), "keep tracked\n");
  await f.git("add", "custom-cache/tracked.txt");
  await NodeFSP.writeFile(NodePath.join(f.source, "custom-cache", "untracked.txt"), "omit\n");
  await NodeFSP.writeFile(NodePath.join(f.source, "keep.txt"), "keep\n");
  const snapshot = await captureProjectSyncGitSnapshot({
    cwd: f.source,
    outputDirectory: f.outputDirectory,
    extraIgnores: [" custom-cache ", ""],
    explicitlyIncludedUntracked: ["custom-cache/untracked.txt"],
  });
  expect(snapshot.untracked.map((entry) => entry.path)).toEqual(["keep.txt"]);
  await restoreProjectSyncGitSnapshot({
    snapshot,
    inputDirectory: f.outputDirectory,
    destinationDirectory: f.destinationDirectory,
  });
  expect(
    await NodeFSP.readFile(
      NodePath.join(f.destinationDirectory, "custom-cache", "tracked.txt"),
      "utf8",
    ),
  ).toBe("keep tracked\n");
  expect(includeSyncUntrackedPath("nested/custom-cache/file", [], ["custom-cache"])).toBe(false);
});

test("excludes reproducible untracked artifacts and secrets while preserving tracked artifacts", async () => {
  const f = await fixture();
  await NodeFSP.mkdir(NodePath.join(f.source, "dist"));
  await NodeFSP.writeFile(NodePath.join(f.source, "dist", "versioned.txt"), "tracked artifact");
  await f.git("add", "dist/versioned.txt");
  for (const name of ["node_modules", ".cache", "coverage", "ignored"]) {
    await NodeFSP.mkdir(NodePath.join(f.source, name));
    await NodeFSP.writeFile(NodePath.join(f.source, name, "generated"), "skip");
  }
  await NodeFSP.writeFile(NodePath.join(f.source, "dist", "generated.txt"), "skip");
  await NodeFSP.writeFile(NodePath.join(f.source, ".env"), "do not transfer");
  await NodeFSP.writeFile(NodePath.join(f.source, "README.local.md"), "keep");
  const snapshot = await captureProjectSyncGitSnapshot({
    cwd: f.source,
    outputDirectory: f.outputDirectory,
  });
  expect(snapshot.untracked.map((entry) => entry.path)).toEqual(["README.local.md"]);
  await restoreProjectSyncGitSnapshot({
    snapshot,
    inputDirectory: f.outputDirectory,
    destinationDirectory: f.destinationDirectory,
  });
  expect(
    await NodeFSP.readFile(NodePath.join(f.destinationDirectory, "dist", "versioned.txt"), "utf8"),
  ).toBe("tracked artifact");
  expect(includeSyncUntrackedPath(".env", [".env"])).toBe(true);
  expect(includeSyncUntrackedPath("node_modules/a", ["node_modules/a"])).toBe(false);
});

test("checksum failure removes only the private destination and leaves source resumable", async () => {
  const f = await fixture();
  await NodeFSP.writeFile(NodePath.join(f.source, "notes.txt"), "original");
  const snapshot = await captureProjectSyncGitSnapshot({
    cwd: f.source,
    outputDirectory: f.outputDirectory,
  });
  await NodeFSP.writeFile(
    NodePath.join(f.outputDirectory, "files", snapshot.untracked[0]!.hash),
    "tampered",
  );
  await expect(
    restoreProjectSyncGitSnapshot({
      snapshot,
      inputDirectory: f.outputDirectory,
      destinationDirectory: f.destinationDirectory,
    }),
  ).rejects.toThrow("checksum");
  await expect(NodeFSP.stat(f.destinationDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await NodeFSP.readFile(NodePath.join(f.source, "notes.txt"), "utf8")).toBe("original");
  await NodeFSP.mkdir(f.destinationDirectory);
  await NodeFSP.writeFile(NodePath.join(f.destinationDirectory, "existing"), "keep");
  await expect(
    restoreProjectSyncGitSnapshot({
      snapshot,
      inputDirectory: f.outputDirectory,
      destinationDirectory: f.destinationDirectory,
    }),
  ).rejects.toMatchObject({ code: "EEXIST" });
  expect(await NodeFSP.readFile(NodePath.join(f.destinationDirectory, "existing"), "utf8")).toBe(
    "keep",
  );
});
