// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import { makeClaudeSessionHandoffDriver } from "./ClaudeSessionHandoff.ts";
import {
  installTransferredClaudeSession,
  invalidateTransferredClaudeSession,
  openTransferredClaudeSession,
  exportTransferredClaudeSession,
  removeTransferredClaudeSession,
} from "./TransferredClaudeSession.ts";

const roots: string[] = [];
const sessionId = "11111111-1111-4111-8111-111111111111";
const threadId = "thread-a";
const key = { projectKey: "linux-destination", sessionId };
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-transferred-claude-"));
  roots.push(root);
  const stateDir = NodePath.join(root, "state");
  const inputDirectory = NodePath.join(root, "incoming");
  const driver = makeClaudeSessionHandoffDriver(async (id, store) => {
    await store.append({ projectKey: "mac-source", sessionId: id }, [
      { type: "user", uuid: "original", cwd: "/Users/diego/project" },
    ]);
    await store.append(
      { projectKey: "mac-source", sessionId: id, subpath: "subagents/original.jsonl" },
      [{ type: "assistant", uuid: "subagent-original" }],
    );
  });
  const snapshot = await driver.checkpoint({
    sessionId,
    cwd: root,
    outputDirectory: inputDirectory,
  });
  const registeredDirectory = NodePath.join(
    stateDir,
    "handoff-sessions",
    NodeCrypto.createHash("sha256").update(threadId).digest("hex"),
  );
  return { root, stateDir, inputDirectory, snapshot, threadId, registeredDirectory };
}

test("installs a private independent copy and reopens after the incoming bundle is removed", async () => {
  const f = await fixture();
  await NodeFSP.writeFile(
    NodePath.join(f.inputDirectory, "credentials.json"),
    "not native session state",
  );
  await installTransferredClaudeSession(f);
  await NodeFSP.rm(f.inputDirectory, { recursive: true });
  const reopened = await openTransferredClaudeSession({ ...f, sessionId });
  expect(await reopened!.load(key)).toEqual([
    { type: "user", uuid: "original", cwd: "/Users/diego/project" },
  ]);
  expect((await NodeFSP.lstat(f.registeredDirectory)).isSymbolicLink()).toBe(false);
  expect((await NodeFSP.stat(f.registeredDirectory)).mode & 0o777).toBe(0o700);
  expect(await NodeFSP.readdir(f.registeredDirectory)).not.toContain("credentials.json");
});

test("append, reopen and export preserve the same evolving main transcript and new subagents", async () => {
  const f = await fixture();
  const store = await installTransferredClaudeSession(f);
  await store.append(key, [{ type: "assistant", uuid: "continued" }]);
  await store.append({ ...key, subpath: "subagents/new.jsonl" }, [
    { type: "assistant", uuid: "new-subagent" },
  ]);
  const reopened = await openTransferredClaudeSession({ ...f, sessionId });
  expect(await reopened!.load(key)).toHaveLength(2);
  expect(await reopened!.listSubkeys!(key)).toContain("subagents/new.jsonl");
  const outputDirectory = NodePath.join(f.root, "onward-transfer");
  const snapshot = await exportTransferredClaudeSession({ ...f, sessionId, outputDirectory });
  expect(snapshot?.sessionId).toBe(sessionId);
  expect(snapshot?.transcripts).toHaveLength(3);
  await makeClaudeSessionHandoffDriver().verify({
    snapshot: snapshot!,
    directory: outputDirectory,
  });
  const second = await installTransferredClaudeSession({
    stateDir: NodePath.join(f.root, "third-environment"),
    threadId,
    snapshot: snapshot!,
    inputDirectory: outputDirectory,
  });
  expect(await second.load(key)).toEqual(await reopened!.load(key));
  expect(await second.load({ ...key, subpath: "subagents/new.jsonl" })).toEqual([
    { type: "assistant", uuid: "new-subagent" },
  ]);
});

test("corrupt incoming transcript never registers a destination store", async () => {
  const f = await fixture();
  await NodeFSP.writeFile(
    NodePath.join(f.inputDirectory, f.snapshot.transcripts[0]!.file),
    "corrupt",
  );
  await expect(installTransferredClaudeSession(f)).rejects.toThrow("checksum");
  expect(await openTransferredClaudeSession({ ...f, sessionId })).toBeUndefined();
  await expect(NodeFSP.stat(f.registeredDirectory)).rejects.toMatchObject({ code: "ENOENT" });
});

test("rejects wrong session identity and duplicate installation without overwriting continuing history", async () => {
  const f = await fixture();
  const store = await installTransferredClaudeSession(f);
  await store.append(key, [{ type: "assistant", uuid: "do-not-overwrite" }]);
  await expect(
    openTransferredClaudeSession({ ...f, sessionId: "22222222-2222-4222-8222-222222222222" }),
  ).rejects.toThrow("identity");
  await expect(installTransferredClaudeSession(f)).rejects.toMatchObject({ code: "EEXIST" });
  expect(await store.load(key)).toHaveLength(2);
  expect(
    await openTransferredClaudeSession({ ...f, threadId: "unregistered-thread", sessionId }),
  ).toBeUndefined();
  expect(
    await exportTransferredClaudeSession({
      ...f,
      threadId: "unregistered-thread",
      sessionId,
      outputDirectory: NodePath.join(f.root, "unused"),
    }),
  ).toBeUndefined();
});

test("fails closed on altered installed history and symlinked registered stores", async () => {
  const f = await fixture();
  await installTransferredClaudeSession(f);
  await NodeFSP.writeFile(
    NodePath.join(f.registeredDirectory, f.snapshot.transcripts[0]!.file),
    "tampered",
  );
  await expect(openTransferredClaudeSession({ ...f, sessionId })).rejects.toThrow("checksum");
  await NodeFSP.rm(f.registeredDirectory, { recursive: true });
  await NodeFSP.symlink(f.inputDirectory, f.registeredDirectory);
  await expect(openTransferredClaudeSession({ ...f, sessionId })).rejects.toThrow("symlink");
});

test("removes only the matching stopped session registration and supports cleanup retries", async () => {
  const f = await fixture();
  const store = await installTransferredClaudeSession(f);
  await store.append(key, [{ type: "assistant", uuid: "continuation-before-rollback" }]);
  await store.append({ ...key, subpath: "subagents/destination.jsonl" }, [
    { type: "assistant", uuid: "destination-agent" },
  ]);
  await removeTransferredClaudeSession({ ...f, sessionId });
  await expect(NodeFSP.stat(f.registeredDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  await removeTransferredClaudeSession({ ...f, sessionId });
  expect(
    await NodeFSP.readFile(
      NodePath.join(f.inputDirectory, f.snapshot.transcripts[0]!.file),
      "utf8",
    ),
  ).toContain("original");
});

test("refuses cleanup with a mismatched identity or a symlinked registration", async () => {
  const f = await fixture();
  await installTransferredClaudeSession(f);
  await expect(
    removeTransferredClaudeSession({ ...f, sessionId: "22222222-2222-4222-8222-222222222222" }),
  ).rejects.toThrow("identity");
  expect(await openTransferredClaudeSession({ ...f, sessionId })).toBeDefined();
  await NodeFSP.rm(f.registeredDirectory, { recursive: true });
  await NodeFSP.symlink(f.inputDirectory, f.registeredDirectory);
  await expect(removeTransferredClaudeSession({ ...f, sessionId })).rejects.toThrow("symlink");
  expect((await NodeFSP.lstat(f.registeredDirectory)).isSymbolicLink()).toBe(true);
});

test("requires recovery for missing or partially written markers without deleting session files", async () => {
  const f = await fixture();
  await NodeFSP.mkdir(f.registeredDirectory, { recursive: true });
  const contentFile = NodePath.join(f.registeredDirectory, "native-history.jsonl");
  await NodeFSP.writeFile(contentFile, "keep partial native history");
  await expect(removeTransferredClaudeSession({ ...f, sessionId })).rejects.toMatchObject({
    code: "recoveryRequired",
  });
  await NodeFSP.writeFile(NodePath.join(f.registeredDirectory, "registration.json"), "{");
  await expect(removeTransferredClaudeSession({ ...f, sessionId })).rejects.toMatchObject({
    code: "recoveryRequired",
  });
  expect(await NodeFSP.readFile(contentFile, "utf8")).toBe("keep partial native history");
});

test("missing marker in an existing store blocks resume and re-export instead of falling back", async () => {
  const f = await fixture();
  await NodeFSP.mkdir(f.registeredDirectory, { recursive: true });
  const contentFile = NodePath.join(f.registeredDirectory, "partial-history.jsonl");
  await NodeFSP.writeFile(contentFile, "preserve native history");
  await expect(openTransferredClaudeSession({ ...f, sessionId })).rejects.toMatchObject({
    code: "recoveryRequired",
  });
  const outputDirectory = NodePath.join(f.root, "must-not-export");
  await expect(
    exportTransferredClaudeSession({ ...f, sessionId, outputDirectory }),
  ).rejects.toMatchObject({
    code: "recoveryRequired",
  });
  await expect(NodeFSP.stat(outputDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await NodeFSP.readFile(contentFile, "utf8")).toBe("preserve native history");
});

test("native mirror invalidation persists and blocks reopening or exporting the store", async () => {
  const f = await fixture();
  await installTransferredClaudeSession(f);
  await invalidateTransferredClaudeSession({ ...f, sessionId, reason: "mirrorError" });
  await invalidateTransferredClaudeSession({ ...f, sessionId, reason: "sessionMismatch" });
  expect(
    JSON.parse(
      await NodeFSP.readFile(NodePath.join(f.registeredDirectory, "invalid.json"), "utf8"),
    ),
  ).toEqual({ version: 1, reason: "mirrorError" });
  await expect(openTransferredClaudeSession({ ...f, sessionId })).rejects.toMatchObject({
    code: "recoveryRequired",
  });
  await expect(
    exportTransferredClaudeSession({
      ...f,
      sessionId,
      outputDirectory: NodePath.join(f.root, "invalid-export"),
    }),
  ).rejects.toMatchObject({ code: "recoveryRequired" });
  await removeTransferredClaudeSession({ ...f, sessionId });
  await expect(NodeFSP.stat(f.registeredDirectory)).rejects.toMatchObject({ code: "ENOENT" });
});

test("invalidation cannot create a missing store or mark a different native identity", async () => {
  const f = await fixture();
  await expect(
    invalidateTransferredClaudeSession({ ...f, sessionId, reason: "mirrorError" }),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await expect(NodeFSP.stat(f.registeredDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  await installTransferredClaudeSession(f);
  await expect(
    invalidateTransferredClaudeSession({
      ...f,
      sessionId: "22222222-2222-4222-8222-222222222222",
      reason: "sessionMismatch",
    }),
  ).rejects.toThrow("identity");
  await expect(
    NodeFSP.stat(NodePath.join(f.registeredDirectory, "invalid.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(await openTransferredClaudeSession({ ...f, sessionId })).toBeDefined();
});

test("append failure durably quarantines the store even without consuming SDK mirror_error", async () => {
  const f = await fixture();
  await installTransferredClaudeSession(f);
  const store = await openTransferredClaudeSession({ ...f, sessionId });
  expect(store).toBeDefined();
  const transcript = NodePath.join(f.registeredDirectory, f.snapshot.transcripts[0]!.file);
  const original = await NodeFSP.readFile(transcript);
  await NodeFSP.rm(transcript);
  await NodeFSP.mkdir(transcript);
  await expect(
    store!.append(key, [{ type: "assistant", uuid: "must-not-lose-silently" }]),
  ).rejects.toBeDefined();
  await NodeFSP.rmdir(transcript);
  await NodeFSP.writeFile(transcript, original);
  await expect(openTransferredClaudeSession({ ...f, sessionId })).rejects.toMatchObject({
    code: "recoveryRequired",
  });
  await expect(
    exportTransferredClaudeSession({
      ...f,
      sessionId,
      outputDirectory: NodePath.join(f.root, "stale-export"),
    }),
  ).rejects.toMatchObject({ code: "recoveryRequired" });
});
