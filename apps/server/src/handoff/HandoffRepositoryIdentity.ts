// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import type { ProjectId, ThreadHandoffRepository } from "@t3tools/contracts";
import { ThreadHandoffError } from "@t3tools/contracts";
import { runSnapshotGit } from "../workspace/ProjectSyncGitSnapshot.ts";

/** Remote names and credentials do not identify a repository. Hash canonical
 * network locations so manifests never carry embedded credentials or local paths. */
export function handoffRemoteId(value: string): string | undefined {
  const scp = /^(?:[^/@:]+@)?([^/:]+):(.+)$/.exec(value);
  let host: string;
  let path: string;
  try {
    if (!value.includes("://") && scp) {
      host = scp[1]!.toLowerCase();
      path = scp[2]!;
    } else {
      const url = new URL(value);
      if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol)) return;
      host = url.hostname.toLowerCase();
      path = url.pathname;
    }
  } catch {
    return;
  }
  path = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  if (!host || !path) return;
  return NodeCrypto.createHash("sha256").update(`${host}/${path}`).digest("hex");
}

export async function inspectHandoffRepository(
  cwd: string,
  projectId: ProjectId,
): Promise<ThreadHandoffRepository> {
  const [head, roots, remotes] = await Promise.all([
    runSnapshotGit(cwd, ["rev-parse", "--verify", "HEAD"]),
    runSnapshotGit(cwd, ["rev-list", "--max-parents=0", "HEAD"]),
    runSnapshotGit(cwd, ["remote", "-v"]),
  ]);
  const remoteIds = [
    ...new Set(
      remotes
        .toString()
        .split("\n")
        .flatMap((line) => {
          const remote = line.split(/\s+/)[1];
          const id = remote ? handoffRemoteId(remote) : undefined;
          return id ? [id] : [];
        }),
    ),
  ];
  return {
    projectId,
    head: head.toString().trim(),
    rootCommits: roots.toString().trim().split("\n").filter(Boolean),
    remoteIds,
  };
}

export async function verifyHandoffRepository(
  cwd: string,
  source: ThreadHandoffRepository,
): Promise<{ readonly availableHead?: string }> {
  const target = await inspectHandoffRepository(cwd, source.projectId);
  if (
    !source.rootCommits.some((id) => target.rootCommits.includes(id)) &&
    !source.remoteIds.some((id) => target.remoteIds.includes(id))
  )
    throw new ThreadHandoffError({
      code: "incompatible",
      message: "Destination project is a different Git repository. Choose its matching clone.",
    });
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(source.head))
    throw new ThreadHandoffError({
      code: "verificationFailed",
      message: "Invalid source Git commit.",
    });
  try {
    await runSnapshotGit(cwd, ["cat-file", "-e", `${source.head}^{commit}`]);
    return { availableHead: source.head };
  } catch {
    return {};
  }
}
