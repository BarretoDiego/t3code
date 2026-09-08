// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { SessionStore } from "@anthropic-ai/claude-agent-sdk";
import { ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import { afterEach, expect, test } from "vite-plus/test";
import { getNativeHandoffDriver } from "./NativeHandoffDrivers.ts";
import { openTransferredClaudeSession } from "./TransferredClaudeSession.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});
const sessionId = "11111111-1111-4111-8111-111111111111";
const entries = [
  { type: "user", uuid: "user-1", cwd: "/Users/diego/project", message: { content: "Scheduling" } },
  { type: "system", subtype: "compact_boundary", compactMetadata: { trigger: "auto" } },
];
async function fixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-native-drivers-"));
  roots.push(root);
  const input = {
    driver: ProviderDriverKind.make("claudeAgent"),
    stateDir: NodePath.join(root, "state"),
    threadId: ThreadId.make("thread"),
  };
  let exports = 0;
  const dependencies = {
    claudeExportSession: async (id: string, store: SessionStore) => {
      exports++;
      await store.append({ projectKey: "source", sessionId: id }, entries);
      await store.append(
        { projectKey: "source", sessionId: id, subpath: "subagents/original.jsonl" },
        [{ type: "assistant", uuid: "original" }],
      );
    },
  };
  const driver = getNativeHandoffDriver(input, dependencies)!;
  return {
    root,
    input,
    dependencies,
    driver,
    exports: () => exports,
    directory: NodePath.join(root, "incoming"),
  };
}

test("provider-neutral registry supports Claude and blocks unsupported providers", async () => {
  const f = await fixture();
  for (const driver of ["codex", "opencode", "unknown"])
    expect(
      getNativeHandoffDriver({ ...f.input, driver: ProviderDriverKind.make(driver) }),
    ).toBeUndefined();
  const source = {
    driver: f.input.driver,
    version: "2.1.260",
    authenticated: true,
    cwd: "/source",
  };
  expect(f.driver.preflight(source, { ...source, cwd: "/destination" }).mode).toBe("native");
  expect(f.driver.preflight(source, { ...source, authenticated: false }).mode).toBe("unsupported");
  expect(f.driver.preflight(source, { ...source, version: "2.1.261" }).mode).toBe("unsupported");
});

test("checkpoints, verifies and installs native data without copying arbitrary adjacent files", async () => {
  const f = await fixture();
  await f.driver.checkpoint({ sessionId, cwd: f.root, outputDirectory: f.directory });
  expect(f.exports()).toBe(1);
  await f.driver.verify({ sessionId, directory: f.directory });
  await NodeFSP.writeFile(NodePath.join(f.directory, "credentials.json"), "not provider history");
  await f.driver.install({ sessionId, directory: f.directory });
  await NodeFSP.rm(f.directory, { recursive: true });
  const store = await openTransferredClaudeSession({ ...f.input, sessionId });
  expect(await store!.load({ projectKey: "destination", sessionId })).toEqual(entries);
});

test("re-exports an evolving transferred store before SDK discovery, even with a custom source home", async () => {
  const f = await fixture();
  await f.driver.checkpoint({ sessionId, cwd: f.root, outputDirectory: f.directory });
  await f.driver.install({ sessionId, directory: f.directory });
  const store = await openTransferredClaudeSession({ ...f.input, sessionId });
  await store!.append({ projectKey: "destination", sessionId, subpath: "subagents/new.jsonl" }, [
    { type: "assistant", uuid: "new" },
  ]);
  const custom = getNativeHandoffDriver(
    { ...f.input, sourceHomePath: NodePath.join(f.root, "custom-home") },
    f.dependencies,
  )!;
  const directory = NodePath.join(f.root, "re-exported");
  await custom.checkpoint({ sessionId, cwd: "/home/diego/project", outputDirectory: directory });
  expect(f.exports()).toBe(1);
  await custom.verify({ sessionId, directory });
  const targetInput = { ...f.input, stateDir: NodePath.join(f.root, "target-state") };
  await getNativeHandoffDriver(targetInput)!.install({ sessionId, directory });
  const targetStore = await openTransferredClaudeSession({ ...targetInput, sessionId });
  expect(
    await targetStore!.load({ projectKey: "target", sessionId, subpath: "subagents/new.jsonl" }),
  ).toEqual([{ type: "assistant", uuid: "new" }]);
});

test("rejects a custom SDK source home without mutating global provider configuration", async () => {
  const f = await fixture();
  const original = process.env.CLAUDE_CONFIG_DIR;
  const driver = getNativeHandoffDriver(
    { ...f.input, sourceHomePath: NodePath.join(f.root, "custom-home") },
    f.dependencies,
  )!;
  await expect(
    driver.checkpoint({ sessionId, cwd: f.root, outputDirectory: f.directory }),
  ).rejects.toMatchObject({ code: "unsupported" });
  expect(f.exports()).toBe(0);
  expect(process.env.CLAUDE_CONFIG_DIR).toBe(original);
  await expect(NodeFSP.stat(f.directory)).rejects.toMatchObject({ code: "ENOENT" });
  const sameHome = getNativeHandoffDriver(
    { ...f.input, sourceHomePath: original || NodePath.join(NodeOS.homedir(), ".claude") },
    f.dependencies,
  )!;
  await sameHome.checkpoint({ sessionId, cwd: f.root, outputDirectory: f.directory });
  expect(f.exports()).toBe(1);
});

test("rejects foreign identities, malformed metadata and corrupted native content before install", async () => {
  const f = await fixture();
  await f.driver.checkpoint({ sessionId, cwd: f.root, outputDirectory: f.directory });
  await expect(
    f.driver.verify({ sessionId: "22222222-2222-4222-8222-222222222222", directory: f.directory }),
  ).rejects.toThrow("different session");
  const metadata = NodePath.join(f.directory, "snapshot.json");
  const original = await NodeFSP.readFile(metadata, "utf8");
  await NodeFSP.writeFile(metadata, original.replace('"bytes":', '"unexpected":true,"bytes":'));
  await expect(f.driver.install({ sessionId, directory: f.directory })).rejects.toThrow();
  await NodeFSP.writeFile(metadata, original);
  const transcript = (await NodeFSP.readdir(f.directory)).find((file) => file.endsWith(".jsonl"))!;
  await NodeFSP.appendFile(NodePath.join(f.directory, transcript), "corrupt");
  await expect(f.driver.install({ sessionId, directory: f.directory })).rejects.toThrow("checksum");
  expect(await openTransferredClaudeSession({ ...f.input, sessionId })).toBeUndefined();
});

test("resolves native UUID cursors with the same resume precedence as the Claude adapter", async () => {
  const f = await fixture();
  expect(f.driver.sessionIdFromCursor({ resume: sessionId, turnCount: 12 })).toBe(sessionId);
  expect(f.driver.sessionIdFromCursor({ sessionId })).toBe(sessionId);
  expect(f.driver.sessionIdFromCursor({ resume: null, sessionId })).toBe(sessionId);
  for (const cursor of [
    undefined,
    null,
    {},
    sessionId,
    { resume: "missing" },
    { sessionId: "../session" },
    { resume: "invalid", sessionId },
  ]) {
    expect(() => f.driver.sessionIdFromCursor(cursor)).toThrow("native resume session ID");
  }
});
