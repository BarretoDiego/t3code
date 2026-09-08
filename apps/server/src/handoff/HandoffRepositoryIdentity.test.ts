// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { ProjectId } from "@t3tools/contracts";
import { expect, test } from "vite-plus/test";
import { runSnapshotGit } from "../workspace/ProjectSyncGitSnapshot.ts";
import {
  handoffRemoteId,
  inspectHandoffRepository,
  verifyHandoffRepository,
} from "./HandoffRepositoryIdentity.ts";

test("canonicalizes network remotes without exposing credentials or requiring origin", () => {
  const id = handoffRemoteId("git@github.com:owner/repository.git");
  expect(id).toMatch(/^[a-f0-9]{64}$/);
  expect(handoffRemoteId("https://user:secret@github.com/owner/repository.git")).toBe(id);
  expect(handoffRemoteId("ssh://git@github.com/owner/repository")).toBe(id);
  expect(handoffRemoteId("/Users/me/repository")).toBeUndefined();
  expect(handoffRemoteId("file:///home/me/repository")).toBeUndefined();
  expect(handoffRemoteId("https://github.com/other/repository")).not.toBe(id);
});

test("recognizes clone identity and only advertises Git objects actually available", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "handoff-identity-"));
  try {
    const source = NodePath.join(root, "source");
    const target = NodePath.join(root, "destination");
    await NodeFSP.mkdir(source);
    const git = (...args: string[]) => runSnapshotGit(source, args);
    await git("init", "-b", "private");
    await git("config", "user.name", "Test");
    await git("config", "user.email", "test@example.invalid");
    await NodeFSP.writeFile(NodePath.join(source, "file"), "one");
    await git("add", ".");
    await git("commit", "-m", "base");
    await git("clone", "--", source, target);
    const projectId = ProjectId.make("project");
    const facts = await inspectHandoffRepository(source, projectId);
    expect(await verifyHandoffRepository(target, facts)).toEqual({ availableHead: facts.head });
    await NodeFSP.writeFile(NodePath.join(source, "file"), "two");
    await git("commit", "-am", "private commit");
    expect(
      await verifyHandoffRepository(target, await inspectHandoffRepository(source, projectId)),
    ).toEqual({});
    await expect(
      verifyHandoffRepository(target, { ...facts, rootCommits: ["a".repeat(40)], remoteIds: [] }),
    ).rejects.toMatchObject({ code: "incompatible" });
    await git("remote", "add", "upstream", "https://example.invalid/owner/repository.git");
    const withRemote = await inspectHandoffRepository(source, projectId);
    expect(withRemote.remoteIds).toEqual([
      handoffRemoteId("git@example.invalid:owner/repository.git"),
    ]);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
