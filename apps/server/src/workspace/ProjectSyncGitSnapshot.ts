// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { ThreadHandoffError } from "@t3tools/contracts";

const execute = NodeUtil.promisify(NodeChildProcess.execFile);
const GENERATED = new Set([
  "node_modules",
  "vendor",
  "dist",
  ".next",
  ".cache",
  "tmp",
  "coverage",
  ".t3",
  ".idea",
]);
const SECRET = /^(?:\.env(?:\..*)?|credentials(?:\..*)?|id_(?:rsa|ed25519)|.*\.(?:pem|key))$/i;
const MAX_PATCH_BYTES = 64 * 1024 * 1024;

export async function runSnapshotGit(cwd: string, args: readonly string[]) {
  const { stdout } = await execute("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "buffer",
    maxBuffer: MAX_PATCH_BYTES,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
  });
  return stdout;
}

/** Generated/secret defaults apply only to untracked files. Tracked artifacts
 * remain part of Git state. Explicit secret policy can include individual paths. */
export function includeSyncUntrackedPath(
  relativePath: string,
  explicitlyIncluded: readonly string[] = [],
  extraIgnores: readonly string[] = [],
) {
  const segments = relativePath.split("/");
  if (
    segments.some(
      (segment) => GENERATED.has(segment) || extraIgnores.some((extra) => extra.trim() === segment),
    )
  )
    return false;
  return (
    explicitlyIncluded.includes(relativePath) || !segments.some((segment) => SECRET.test(segment))
  );
}

export interface ProjectSyncGitSnapshot {
  readonly head: string;
  readonly branch: string | null;
  readonly indexTree: string;
  readonly sourceWasWorktree: boolean;
  readonly checkpointRefs: readonly string[];
  readonly bundle: string | null;
  readonly stagedPatch: string;
  readonly workingPatch: string;
  readonly untracked: readonly {
    readonly path: string;
    readonly hash: string;
    readonly mode: number;
    readonly size: number;
  }[];
}

const digest = (content: Uint8Array) =>
  NodeCrypto.createHash("sha256").update(content).digest("hex");

/** Capture Git's object/index/worktree domains separately. Output is a private
 * transfer directory; no temporary commits or refs are left in the repository.
 * The caller owns the execution freeze and must keep the checkout quiescent. */
export async function captureProjectSyncGitSnapshot(input: {
  readonly cwd: string;
  readonly outputDirectory: string;
  readonly destinationHasHead?: string;
  readonly checkpointRefs?: readonly string[];
  readonly explicitlyIncludedUntracked?: readonly string[];
  readonly extraIgnores?: readonly string[];
}): Promise<ProjectSyncGitSnapshot> {
  const git = (...args: string[]) => runSnapshotGit(input.cwd, args);
  const checkpointRefs = [...new Set(input.checkpointRefs ?? [])];
  for (const ref of checkpointRefs) {
    if (!ref.startsWith("refs/t3/checkpoints/"))
      throw new ThreadHandoffError({
        code: "verificationFailed",
        message: "Invalid checkpoint ref namespace.",
      });
    await git("check-ref-format", ref);
    await git("rev-parse", "--verify", `${ref}^{commit}`);
  }
  const head = (await git("rev-parse", "--verify", "HEAD")).toString().trim();
  const branchName = (await git("rev-parse", "--abbrev-ref", "HEAD")).toString().trim();
  const indexTree = (await git("write-tree")).toString().trim();
  const gitDirectory = (await git("rev-parse", "--absolute-git-dir")).toString().trim();
  const commonDirectory = (await git("rev-parse", "--path-format=absolute", "--git-common-dir"))
    .toString()
    .trim();
  const sourceStatus = await git("status", "--porcelain=v1", "-z", "--untracked-files=all");
  if (
    (await git("ls-files", "--stage"))
      .toString()
      .split("\n")
      .some((line) => line.startsWith("160000 "))
  ) {
    throw new ThreadHandoffError({
      code: "unsupported",
      message: "Submodules require an explicit repository mapping before handoff.",
    });
  }
  const staged = await git(
    "diff",
    "--cached",
    "--binary",
    "--full-index",
    "--no-ext-diff",
    "--no-textconv",
    "HEAD",
    "--",
  );
  const working = await git(
    "diff",
    "--binary",
    "--full-index",
    "--no-ext-diff",
    "--no-textconv",
    "--",
  );
  await NodeFSP.mkdir(input.outputDirectory, { recursive: false, mode: 0o700 });
  const untracked: Array<ProjectSyncGitSnapshot["untracked"][number]> = [];
  try {
    await NodeFSP.writeFile(NodePath.join(input.outputDirectory, "staged.patch"), staged, {
      mode: 0o600,
    });
    await NodeFSP.writeFile(NodePath.join(input.outputDirectory, "working.patch"), working, {
      mode: 0o600,
    });
    await NodeFSP.mkdir(NodePath.join(input.outputDirectory, "files"));
    const names = (await git("ls-files", "--others", "--exclude-standard", "-z"))
      .toString()
      .split("\0")
      .filter(Boolean);
    for (const relative of names) {
      if (
        !includeSyncUntrackedPath(relative, input.explicitlyIncludedUntracked, input.extraIgnores)
      )
        continue;
      const filename = NodePath.join(input.cwd, relative);
      const stat = await NodeFSP.lstat(filename);
      // Symlinks need their own typed payload; never dereference a local secret.
      if (!stat.isFile())
        throw new ThreadHandoffError({
          code: "unsupported",
          message: `Untracked non-regular file requires an explicit sync strategy: ${relative}`,
        });
      if (stat.size > MAX_PATCH_BYTES)
        throw new ThreadHandoffError({
          code: "unsupported",
          message: `Untracked file exceeds snapshot limit: ${relative}`,
        });
      const content = await NodeFSP.readFile(filename);
      const hash = digest(content);
      await NodeFSP.writeFile(NodePath.join(input.outputDirectory, "files", hash), content, {
        mode: 0o600,
      });
      untracked.push({ path: relative, hash, mode: stat.mode & 0o777, size: content.length });
    }
    const bundle =
      input.destinationHasHead === head && checkpointRefs.length === 0 ? null : "history.bundle";
    if (bundle)
      await git(
        "bundle",
        "create",
        NodePath.join(input.outputDirectory, bundle),
        "HEAD",
        ...checkpointRefs,
      );
    if (
      !(await git("status", "--porcelain=v1", "-z", "--untracked-files=all")).equals(
        sourceStatus,
      ) ||
      (await git("rev-parse", "HEAD")).toString().trim() !== head ||
      !(
        await git(
          "diff",
          "--cached",
          "--binary",
          "--full-index",
          "--no-ext-diff",
          "--no-textconv",
          "HEAD",
          "--",
        )
      ).equals(staged) ||
      !(
        await git("diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "--")
      ).equals(working)
    ) {
      throw new ThreadHandoffError({
        code: "conflict",
        message: "Repository changed while creating the handoff snapshot.",
      });
    }
    for (const entry of untracked) {
      if (digest(await NodeFSP.readFile(NodePath.join(input.cwd, entry.path))) !== entry.hash) {
        throw new ThreadHandoffError({
          code: "conflict",
          message: "Untracked file changed during snapshot.",
        });
      }
    }
    return {
      head,
      branch: branchName === "HEAD" ? null : branchName,
      indexTree,
      sourceWasWorktree: gitDirectory !== commonDirectory,
      checkpointRefs,
      bundle,
      stagedPatch: "staged.patch",
      workingPatch: "working.patch",
      untracked,
    };
  } catch (error) {
    await NodeFSP.rm(input.outputDirectory, { recursive: true, force: true });
    throw error;
  }
}

/** Remove a handoff checkout after rollback, including linked Git administration.
 * Persist these inputs alongside the transaction so recovery can repeat cleanup. */
export async function cleanupProjectSyncGitSnapshot(input: {
  readonly destinationDirectory: string;
  readonly existingRepository?: string;
  readonly sourceWasWorktree: boolean;
}) {
  if (input.sourceWasWorktree && input.existingRepository) {
    const destination = NodePath.join(
      await NodeFSP.realpath(NodePath.dirname(input.destinationDirectory)),
      NodePath.basename(input.destinationDirectory),
    );
    const worktrees = (
      await runSnapshotGit(input.existingRepository, ["worktree", "list", "--porcelain", "-z"])
    )
      .toString()
      .split("\0\0");
    const record = worktrees.find((entry) => entry.split("\0").includes(`worktree ${destination}`));
    if (!record) {
      const exists = await NodeFSP.lstat(input.destinationDirectory).then(
        () => true,
        (error: unknown) => {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
          throw error;
        },
      );
      if (exists)
        throw new ThreadHandoffError({
          code: "conflict",
          message: "Destination is not a registered handoff worktree.",
        });
      return;
    }
    const fields = record.split("\0");
    const branch = fields.find((field) => field.startsWith("branch "))?.slice(7);
    const head = fields.find((field) => field.startsWith("HEAD "))?.slice(5);
    await runSnapshotGit(input.existingRepository, [
      "worktree",
      "remove",
      "--force",
      "--",
      input.destinationDirectory,
    ]);
    // Linked restores only create absent branches, so this branch belongs to
    // the prepared checkout. Keep it if another operation has advanced it.
    if (branch && head)
      await runSnapshotGit(input.existingRepository, ["update-ref", "-d", branch, head]);
    return;
  }
  await NodeFSP.rm(input.destinationDirectory, { recursive: true, force: true });
}

/** Apply only inside a new private checkout. Never overwrites a destination's
 * existing worktree. Activation belongs to the handoff transaction. */
export async function restoreProjectSyncGitSnapshot(input: {
  readonly snapshot: ProjectSyncGitSnapshot;
  readonly inputDirectory: string;
  readonly destinationDirectory: string;
  readonly existingRepository?: string;
}) {
  const { snapshot } = input;
  if (
    !NodePath.isAbsolute(input.destinationDirectory) ||
    input.destinationDirectory !== NodePath.resolve(input.destinationDirectory)
  ) {
    throw new ThreadHandoffError({
      code: "verificationFailed",
      message: "Destination must be a normalized absolute path.",
    });
  }
  if (!/^[a-f0-9]{40,64}$/.test(snapshot.head) || !/^[a-f0-9]{40,64}$/.test(snapshot.indexTree)) {
    throw new ThreadHandoffError({
      code: "verificationFailed",
      message: "Invalid Git object identity.",
    });
  }
  const source = snapshot.bundle
    ? NodePath.join(input.inputDirectory, "history.bundle")
    : input.existingRepository;
  if (!source)
    throw new ThreadHandoffError({ code: "verificationFailed", message: "Missing Git history." });
  // mkdir is the exclusive claim; cleanup below can only remove our own directory.
  await NodeFSP.mkdir(input.destinationDirectory, { recursive: false, mode: 0o700 });
  const linkedRepository = snapshot.sourceWasWorktree ? input.existingRepository : undefined;
  const createdRefs: Array<{ ref: string; object: string }> = [];
  let linkedWorktreeCreated = false;
  const rollback = async () => {
    if (linkedWorktreeCreated && linkedRepository) {
      await runSnapshotGit(linkedRepository, [
        "worktree",
        "remove",
        "--force",
        "--",
        input.destinationDirectory,
      ]);
      linkedWorktreeCreated = false;
    }
    await NodeFSP.rm(input.destinationDirectory, { recursive: true, force: true });
    if (linkedRepository) {
      for (const { ref, object } of createdRefs.toReversed()) {
        // Compare-and-delete never removes a ref another operation has advanced.
        await runSnapshotGit(linkedRepository, ["update-ref", "-d", ref, object]);
      }
      createdRefs.length = 0;
    }
  };
  try {
    const readRef = async (repository: string, ref: string) => {
      try {
        return (await runSnapshotGit(repository, ["rev-parse", "--verify", "--quiet", ref]))
          .toString()
          .trim();
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === 1) return null;
        throw error;
      }
    };
    if (snapshot.branch)
      await runSnapshotGit(linkedRepository ?? input.destinationDirectory, [
        "check-ref-format",
        `refs/heads/${snapshot.branch}`,
      ]);
    if (linkedRepository) {
      if (snapshot.bundle) {
        await runSnapshotGit(linkedRepository, [
          "fetch",
          "--no-write-fetch-head",
          "--no-tags",
          "--",
          source,
          "HEAD",
        ]);
      }
      if (snapshot.branch) {
        const ref = `refs/heads/${snapshot.branch}`;
        const existing = await readRef(linkedRepository, ref);
        if (existing !== null) {
          throw new ThreadHandoffError({
            code: "conflict",
            message: "Destination branch already exists; choose an unoccupied branch mapping.",
          });
        }
        if (existing === null) {
          await runSnapshotGit(linkedRepository, [
            "update-ref",
            ref,
            snapshot.head,
            "0".repeat(snapshot.head.length),
          ]);
          createdRefs.push({ ref, object: snapshot.head });
        }
      }
      // Git enforces branch occupancy. Never force or reset an existing branch.
      await runSnapshotGit(linkedRepository, [
        "worktree",
        "add",
        ...(snapshot.branch ? [] : ["--detach"]),
        "--",
        input.destinationDirectory,
        snapshot.branch ?? snapshot.head,
      ]);
      linkedWorktreeCreated = true;
    } else {
      await runSnapshotGit(input.destinationDirectory, [
        "clone",
        "--no-local",
        "--no-checkout",
        "--",
        source,
        ".",
      ]);
    }
    for (const ref of snapshot.checkpointRefs) {
      if (!ref.startsWith("refs/t3/checkpoints/"))
        throw new ThreadHandoffError({
          code: "verificationFailed",
          message: "Invalid checkpoint ref namespace.",
        });
      await runSnapshotGit(input.destinationDirectory, ["check-ref-format", ref]);
      if (linkedRepository) {
        const listed = (await runSnapshotGit(linkedRepository, ["ls-remote", "--", source, ref]))
          .toString()
          .trim();
        const object = listed.split(/\s/)[0];
        if (!object || !/^[a-f0-9]{40,64}$/.test(object))
          throw new ThreadHandoffError({
            code: "verificationFailed",
            message: "Checkpoint ref is missing from transferred history.",
          });
        const existing = await readRef(linkedRepository, ref);
        if (existing !== null && existing !== object)
          throw new ThreadHandoffError({
            code: "conflict",
            message: "Destination checkpoint ref conflicts with transferred history.",
          });
        if (existing === null) {
          await runSnapshotGit(linkedRepository, [
            "fetch",
            "--no-write-fetch-head",
            "--no-tags",
            "--",
            source,
            ref,
          ]);
          await runSnapshotGit(linkedRepository, [
            "update-ref",
            ref,
            object,
            "0".repeat(object.length),
          ]);
          createdRefs.push({ ref, object });
        }
      } else {
        await runSnapshotGit(input.destinationDirectory, ["fetch", "--", source, `${ref}:${ref}`]);
      }
    }
    if (!linkedRepository)
      await runSnapshotGit(
        input.destinationDirectory,
        snapshot.branch
          ? ["checkout", "-B", snapshot.branch, snapshot.head, "--"]
          : ["checkout", "--detach", snapshot.head, "--"],
      );
    for (const [filename, index] of [
      ["staged.patch", true],
      ["working.patch", false],
    ] as const) {
      const patchFile = NodePath.join(input.inputDirectory, filename);
      if ((await NodeFSP.stat(patchFile)).size === 0) continue;
      const flags = index ? ["--index"] : [];
      await runSnapshotGit(input.destinationDirectory, [
        "apply",
        "--check",
        ...flags,
        "--",
        patchFile,
      ]);
      await runSnapshotGit(input.destinationDirectory, ["apply", ...flags, "--", patchFile]);
    }
    for (const entry of snapshot.untracked) {
      if (
        !/^[a-f0-9]{64}$/.test(entry.hash) ||
        !entry.path ||
        entry.path.includes("\\") ||
        entry.path.split("/").some((part) => part === ".." || part === ".git" || part === "")
      ) {
        throw new ThreadHandoffError({
          code: "verificationFailed",
          message: "Unsafe untracked file path.",
        });
      }
      const target = NodePath.join(input.destinationDirectory, entry.path);
      let ancestor = NodePath.dirname(target);
      while (ancestor !== input.destinationDirectory) {
        const stat = await NodeFSP.lstat(ancestor).catch((error: unknown) => {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
          throw error;
        });
        if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
          throw new ThreadHandoffError({
            code: "verificationFailed",
            message: "Unsafe untracked file ancestor.",
          });
        ancestor = NodePath.dirname(ancestor);
      }
      const bytes = await NodeFSP.readFile(
        NodePath.join(input.inputDirectory, "files", entry.hash),
      );
      if (digest(bytes) !== entry.hash || bytes.length !== entry.size)
        throw new ThreadHandoffError({
          code: "verificationFailed",
          message: "Untracked file checksum mismatch.",
        });
      await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
      await NodeFSP.writeFile(target, bytes, { flag: "wx", mode: entry.mode & 0o777 });
    }
    if (
      (await runSnapshotGit(input.destinationDirectory, ["rev-parse", "HEAD"]))
        .toString()
        .trim() !== snapshot.head ||
      (await runSnapshotGit(input.destinationDirectory, ["write-tree"])).toString().trim() !==
        snapshot.indexTree
    ) {
      throw new ThreadHandoffError({
        code: "verificationFailed",
        message: "Restored staging area differs from the source.",
      });
    }
    return { rollback };
  } catch (error) {
    await rollback();
    throw error;
  }
}
