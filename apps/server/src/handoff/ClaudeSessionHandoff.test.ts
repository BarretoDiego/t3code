// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";
import {
  makeClaudeSessionHandoffDriver,
  openTransferredClaudeSessionStore,
} from "./ClaudeSessionHandoff.ts";

const sessionId = "11111111-1111-4111-8111-111111111111";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});
const nativeEntries = [
  {
    type: "user",
    uuid: "user-1",
    message: { content: "Implement scheduling" },
    cwd: "/Users/diego/project",
  },
  {
    type: "system",
    subtype: "compact_boundary",
    compactMetadata: { trigger: "auto", preTokens: 30000 },
  },
  {
    type: "assistant",
    uuid: "assistant-1",
    message: {
      content: [
        {
          type: "tool_use",
          id: "tool-1",
          name: "Read",
          input: { file_path: "/Users/diego/project/file" },
        },
      ],
    },
  },
];

test("exports native compaction and subagents and resumes through a destination-scoped store without rewriting history", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-claude-handoff-"));
  roots.push(root);
  const directory = NodePath.join(root, "native");
  const driver = makeClaudeSessionHandoffDriver(async (id, store, options) => {
    expect(options?.includeSubagents).toBe(true);
    expect(options?.dir).toBe("/Users/diego/project");
    await store.append({ projectKey: "source-project", sessionId: id }, nativeEntries);
    await store.append(
      { projectKey: "source-project", sessionId: id, subpath: "subagents/agent-one.jsonl" },
      [{ type: "assistant", uuid: "agent-1", message: { content: "done" } }],
    );
  });
  const snapshot = await driver.checkpoint({
    sessionId,
    cwd: "/Users/diego/project",
    outputDirectory: directory,
  });
  await driver.verify({ snapshot, directory });
  const store = openTransferredClaudeSessionStore(snapshot, directory);
  const destinationKey = { projectKey: "-home-diego-project", sessionId };
  expect(await store.load(destinationKey)).toEqual(nativeEntries);
  expect(await store.listSubkeys!(destinationKey)).toEqual(["subagents/agent-one.jsonl"]);
  await store.append(destinationKey, [
    { type: "assistant", uuid: "destination-1", message: { content: "continued" } },
  ]);
  await store.append(destinationKey, [
    { type: "assistant", uuid: "destination-1", message: { content: "continued" } },
  ]);
  await store.append({ ...destinationKey, subpath: "subagents/new-agent.jsonl" }, [
    { type: "assistant", uuid: "new-agent" },
  ]);
  const reopened = openTransferredClaudeSessionStore(snapshot, directory);
  expect(await reopened.load(destinationKey)).toHaveLength(4);
  expect(await reopened.listSubkeys!(destinationKey)).toContain("subagents/new-agent.jsonl");
  expect(await reopened.load({ ...destinationKey, subpath: "subagents/new-agent.jsonl" })).toEqual([
    { type: "assistant", uuid: "new-agent" },
  ]);
  await expect(
    reopened.load({ ...destinationKey, sessionId: "different-session" }),
  ).rejects.toThrow("different session");
});

test("rejects corrupt native payload and cleans partial exports", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-claude-handoff-"));
  roots.push(root);
  const directory = NodePath.join(root, "native");
  const driver = makeClaudeSessionHandoffDriver(async (id, store) => {
    await store.append({ projectKey: "project", sessionId: id }, nativeEntries);
  });
  const snapshot = await driver.checkpoint({ sessionId, cwd: root, outputDirectory: directory });
  await NodeFSP.appendFile(NodePath.join(directory, snapshot.transcripts[0]!.file), "corrupt");
  await expect(driver.verify({ snapshot, directory })).rejects.toThrow("checksum");
  const failing = makeClaudeSessionHandoffDriver(async () => {
    throw new Error("Native session unavailable");
  });
  const failedDirectory = NodePath.join(root, "failed");
  await expect(
    failing.checkpoint({ sessionId, cwd: root, outputDirectory: failedDirectory }),
  ).rejects.toThrow("unavailable");
  await expect(NodeFSP.stat(failedDirectory)).rejects.toMatchObject({ code: "ENOENT" });
});

test("blocks missing authentication, different providers and unverified versions", () => {
  const driver = makeClaudeSessionHandoffDriver();
  const source = {
    driver: ProviderDriverKind.make("claudeAgent"),
    version: "2.1.260",
    authenticated: true,
    cwd: "/source",
  };
  expect(driver.preflight(source, { ...source, cwd: "/destination" }).mode).toBe("native");
  expect(driver.preflight(source, { ...source, authenticated: false }).mode).toBe("unsupported");
  expect(driver.preflight(source, { ...source, version: null }).mode).toBe("unsupported");
  expect(driver.preflight(source, { ...source, version: "2.1.261" }).mode).toBe("unsupported");
  expect(
    driver.preflight(source, { ...source, driver: ProviderDriverKind.make("codex") }).mode,
  ).toBe("unsupported");
});

test("retries failed subagent index publication without duplicating native UUID entries", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-claude-index-retry-"));
  roots.push(root);
  const directory = NodePath.join(root, "native");
  const key = { projectKey: "destination", sessionId };
  const driver = makeClaudeSessionHandoffDriver(async (id, store) => {
    await store.append({ ...key, sessionId: id }, nativeEntries);
  });
  const snapshot = await driver.checkpoint({ sessionId, cwd: root, outputDirectory: directory });
  const store = openTransferredClaudeSessionStore(snapshot, directory);
  await store.load(key);
  // A directory at the publication target makes the real atomic rename fail,
  // after the transcript append and temporary index write have succeeded.
  const indexFile = NodePath.join(directory, "store-index.json");
  await NodeFSP.mkdir(indexFile);
  const subagentKey = { ...key, subpath: "subagents/retry-agent.jsonl" };
  const entries = [
    { type: "assistant", uuid: "retry-agent", message: { content: "opaque native state" } },
  ];
  await expect(store.append(subagentKey, entries)).rejects.toThrow();
  expect(await store.load(subagentKey)).toEqual(entries);
  await NodeFSP.rm(indexFile, { recursive: true });
  await store.append(subagentKey, entries);
  const reopened = openTransferredClaudeSessionStore(snapshot, directory);
  expect(await reopened.listSubkeys!(key)).toEqual([subagentKey.subpath]);
  expect(await reopened.load(subagentKey)).toEqual(entries);
  expect(await reopened.load(key)).toEqual(nativeEntries);
});

test("parallel appends preserve per-session order and publish every new subagent key", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-claude-parallel-"));
  roots.push(root);
  const directory = NodePath.join(root, "native");
  const key = { projectKey: "destination", sessionId };
  const driver = makeClaudeSessionHandoffDriver(async (id, store) => {
    await store.append({ ...key, sessionId: id }, nativeEntries);
  });
  const snapshot = await driver.checkpoint({ sessionId, cwd: root, outputDirectory: directory });
  const store = openTransferredClaudeSessionStore(snapshot, directory);
  const agents = Array.from({ length: 12 }, (_, index) => ({
    key: { ...key, subpath: `subagents/agent-${index}.jsonl` },
    entries: [
      { type: "assistant", uuid: `agent-${index}-first`, message: { content: "first" } },
      { type: "assistant", uuid: `agent-${index}-second`, message: { content: "second" } },
    ],
  }));
  await Promise.all(
    agents.flatMap((agent) => [
      store.append(agent.key, [agent.entries[0]!]),
      store.append(agent.key, [agent.entries[1]!]),
      store.append(agent.key, [agent.entries[0]!]),
    ]),
  );
  const reopened = openTransferredClaudeSessionStore(snapshot, directory);
  expect((await reopened.listSubkeys!(key)).sort()).toEqual(
    agents.map((agent) => agent.key.subpath).sort(),
  );
  for (const agent of agents) expect(await reopened.load(agent.key)).toEqual(agent.entries);
  expect(await reopened.load(key)).toEqual(nativeEntries);
});
