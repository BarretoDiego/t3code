// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadHandoffId,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { afterEach, expect, test } from "vite-plus/test";
import {
  decodeConversationHandoffContextRef,
  encodeConversationHandoffContextRef,
  installConversationHandoffContext,
  prepareConversationHandoffInput,
  removeConversationHandoffContext,
} from "./ConversationHandoffContext.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});
const threadId = ThreadId.make("context-thread");
const providerInstanceId = ProviderInstanceId.make("opencode");
const createdAt = "2026-09-08T12:00:00.000Z";
function events(title = "Original complete conversation"): readonly OrchestrationEvent[] {
  return [
    {
      sequence: 1,
      eventId: EventId.make("original-create"),
      aggregateKind: "thread",
      aggregateId: threadId,
      occurredAt: createdAt,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "thread.created",
      payload: {
        threadId,
        projectId: ProjectId.make("project"),
        title,
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "source-model" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "feature/local",
        worktreePath: "/Users/source/project",
        createdAt,
        updatedAt: createdAt,
      },
    },
  ];
}
async function fixture() {
  const stateDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-context-handoff-"));
  roots.push(stateDir);
  const input = {
    stateDir,
    handoffId: ThreadHandoffId.make("transfer-1"),
    threadId,
    providerInstanceId,
    events: events(),
  };
  const file = NodePath.join(stateDir, "handoff-context", input.handoffId, "conversation.json");
  return { input, file };
}

test("preserves the complete source archive and enriches only the supplied real request", async () => {
  const { input, file } = await fixture();
  const context = await installConversationHandoffContext(input);
  expect(decodeConversationHandoffContextRef(encodeConversationHandoffContextRef(context))).toEqual(
    context,
  );
  const text = await NodeFSP.readFile(file, "utf8");
  expect(JSON.parse(text).events).toEqual(input.events);
  const prompt = await prepareConversationHandoffInput({
    ...input,
    context,
    input: "Run the tests",
    maxChars: 120_000,
  });
  expect(prompt).toContain(text);
  expect(prompt).toContain("new provider-native session");
  expect(prompt).toContain("historical data");
  expect(prompt.endsWith("Current user request:\nRun the tests")).toBe(true);
  expect((await NodeFSP.stat(file)).mode & 0o777).toBe(0o600);
});

test("oversized context references the complete canonical file without truncating it", async () => {
  const { input, file } = await fixture();
  const many = Array.from({ length: 100 }, (_, index): OrchestrationEvent => ({
    ...events()[0]!,
    sequence: index + 1,
    eventId: EventId.make(`event-${index}`),
  }));
  const context = await installConversationHandoffContext({ ...input, events: many });
  const prompt = await prepareConversationHandoffInput({
    ...input,
    context,
    input: "Continue testing",
    maxChars: 2000,
  });
  expect(prompt).toContain(await NodeFSP.realpath(file));
  expect(prompt).toContain("Read this file fully before acting");
  expect(prompt).toContain(context.sha256);
  expect(prompt.length).toBeLessThanOrEqual(2000);
  expect(JSON.parse(await NodeFSP.readFile(file, "utf8")).events).toEqual(many);
  await expect(
    prepareConversationHandoffInput({ ...input, context, input: "x".repeat(2000), maxChars: 2000 }),
  ).rejects.toThrow("insufficient room");
});

test("rejects corruption on read and refuses to remove corrupted evidence", async () => {
  const { input, file } = await fixture();
  const context = await installConversationHandoffContext(input);
  await NodeFSP.appendFile(file, " ");
  await expect(
    prepareConversationHandoffInput({ ...input, context, input: "Test", maxChars: 120_000 }),
  ).rejects.toThrow("checksum");
  await expect(removeConversationHandoffContext({ ...input, context })).rejects.toThrow("checksum");
  expect(await NodeFSP.readFile(file, "utf8")).toBeTruthy();
});

test("rejects foreign reference identity, path traversal, and unrelated or unordered events", async () => {
  const { input } = await fixture();
  const context = await installConversationHandoffContext(input);
  for (const foreign of [
    { ...context, threadId: ThreadId.make("other") },
    { ...context, providerInstanceId: ProviderInstanceId.make("other") },
    { ...context, handoffId: "../outside" },
  ]) {
    await expect(
      prepareConversationHandoffInput({ ...input, context: foreign, maxChars: 120_000 }),
    ).rejects.toThrow();
    await expect(
      removeConversationHandoffContext({ ...input, context: foreign }),
    ).rejects.toThrow();
  }
  await expect(
    installConversationHandoffContext({
      ...input,
      events: [{ ...input.events[0]!, aggregateId: ThreadId.make("other") }],
    }),
  ).rejects.toThrow("foreign or unordered");
  await expect(
    installConversationHandoffContext({ ...input, events: [...input.events, ...input.events] }),
  ).rejects.toThrow("foreign or unordered");
  await expect(installConversationHandoffContext({ ...input, events: [] })).rejects.toThrow(
    "creation",
  );
});

test("retries identical installation and cleanup while preserving conflicting archives", async () => {
  const { input, file } = await fixture();
  const [context, retry] = await Promise.all([
    installConversationHandoffContext(input),
    installConversationHandoffContext(input),
  ]);
  expect(context).toEqual(retry);
  await expect(
    installConversationHandoffContext({ ...input, events: events("Different history") }),
  ).rejects.toThrow("different conversation");
  await removeConversationHandoffContext({ ...input, context });
  await removeConversationHandoffContext({ ...input, context });
  await expect(NodeFSP.stat(file)).rejects.toThrow();
});

test("rejects a symlink archive and symlink parent without touching their targets", async () => {
  const { input, file } = await fixture();
  const context = await installConversationHandoffContext(input);
  const external = NodePath.join(input.stateDir, "external.json");
  await NodeFSP.rename(file, external);
  await NodeFSP.symlink(external, file);
  await expect(
    prepareConversationHandoffInput({ ...input, context, maxChars: 120_000 }),
  ).rejects.toThrow();
  await expect(removeConversationHandoffContext({ ...input, context })).rejects.toThrow();
  await NodeFSP.unlink(file);
  await NodeFSP.rmdir(NodePath.dirname(file));
  const externalDir = NodePath.join(input.stateDir, "external-dir");
  await NodeFSP.mkdir(externalDir);
  await NodeFSP.symlink(externalDir, NodePath.dirname(file));
  await expect(installConversationHandoffContext(input)).rejects.toThrow("owned directory");
  expect(await NodeFSP.readFile(external, "utf8")).toBeTruthy();
  expect(await NodeFSP.readdir(externalDir)).toEqual([]);
});
