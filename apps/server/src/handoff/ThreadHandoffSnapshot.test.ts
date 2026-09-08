// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadHandoffId,
  ThreadId,
  type OrchestrationEvent,
  type ThreadHandoffRecord,
  type ThreadHandoffManifest,
} from "@t3tools/contracts";
import {
  createProjectSyncFrameDecoder,
  encodeProjectSyncRecords,
} from "@t3tools/shared/projectSyncFraming";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { applyProjectSyncRecords } from "../workspace/ProjectSyncApply.ts";
import { buildProjectSyncManifest } from "../workspace/ProjectSyncManifest.ts";
import { projectSyncExportRecords } from "../workspace/ProjectSyncTransfer.ts";
import { runSnapshotGit } from "../workspace/ProjectSyncGitSnapshot.ts";
import {
  makeClaudeSessionHandoffDriver,
  openTransferredClaudeSessionStore,
  type ClaudeSessionSnapshot,
} from "./ClaudeSessionHandoff.ts";
import {
  captureThreadHandoffSnapshot,
  restoreThreadHandoffProjects,
  verifyThreadHandoffSnapshot,
} from "./ThreadHandoffSnapshot.ts";

const decodeNativeSnapshot = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      format: Schema.Literal("claude-session-store-v1"),
      sessionId: Schema.String,
      transcripts: Schema.Array(
        Schema.Struct({
          subpath: Schema.NullOr(Schema.String),
          file: Schema.String,
          sha256: Schema.String,
          bytes: Schema.Finite,
        }),
      ),
    }),
  ),
);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});
const sessionId = "11111111-1111-4111-8111-111111111111";
const createdAt = "2026-09-08T12:00:00.000Z";
const threadId = ThreadId.make("snapshot-thread");
const record: ThreadHandoffRecord = {
  handoffId: ThreadHandoffId.make("snapshot-handoff"),
  owner: { threadId, environmentId: EnvironmentId.make("source"), generation: 0 },
  destinationEnvironmentId: EnvironmentId.make("destination"),
  phase: "checkpointing",
  revision: 2,
  createdAt,
  updatedAt: createdAt,
  failure: null,
};
const events: OrchestrationEvent[] = [
  {
    sequence: 1,
    eventId: EventId.make("snapshot-created"),
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
      projectId: ProjectId.make("backend"),
      title: "Scheduling",
      modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "sonnet" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "feature/private",
      worktreePath: null,
      createdAt,
      updatedAt: createdAt,
    },
  },
];
const native = [
  { type: "user", uuid: "user-1", message: { content: "Implement scheduling" } },
  {
    type: "system",
    subtype: "compact_boundary",
    compactMetadata: { trigger: "auto", preTokens: 30000 },
  },
];
const subagent = [
  { type: "assistant", uuid: "agent-1", message: { content: "Native subagent state" } },
];
async function fixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-handoff-snapshot-"));
  roots.push(root);
  const sources = [];
  for (const name of ["backend", "frontend"]) {
    const cwd = NodePath.join(root, name);
    await NodeFSP.mkdir(cwd);
    await runSnapshotGit(cwd, ["init", "-b", "feature/private"]);
    await runSnapshotGit(cwd, ["config", "user.name", "Handoff test"]);
    await runSnapshotGit(cwd, ["config", "user.email", "test@example.invalid"]);
    for (const file of ["tracked.txt", "deleted.txt", "renamed.txt"])
      await NodeFSP.writeFile(NodePath.join(cwd, file), `${name} base\n`);
    await NodeFSP.writeFile(NodePath.join(cwd, ".gitignore"), "node_modules/\ndist/\n.cache/\n");
    await runSnapshotGit(cwd, ["add", "."]);
    await runSnapshotGit(cwd, ["commit", "-m", "Private commit"]);
    sources.push({ projectId: ProjectId.make(name), cwd });
  }
  const dirty = sources[0]!.cwd;
  await NodeFSP.writeFile(NodePath.join(dirty, "tracked.txt"), "staged\n");
  await runSnapshotGit(dirty, ["add", "tracked.txt"]);
  await NodeFSP.writeFile(NodePath.join(dirty, "tracked.txt"), "staged\nunstaged\n");
  await NodeFSP.rm(NodePath.join(dirty, "deleted.txt"));
  await runSnapshotGit(dirty, ["mv", "renamed.txt", "renamed-new.txt"]);
  await NodeFSP.writeFile(NodePath.join(dirty, "notes.md"), "Relevant untracked\n");
  for (const ignored of ["node_modules", "dist", ".cache"]) {
    await NodeFSP.mkdir(NodePath.join(dirty, ignored));
    await NodeFSP.writeFile(NodePath.join(dirty, ignored, "generated"), "reproducible");
  }
  const driver = makeClaudeSessionHandoffDriver(async (id, store) => {
    await store.append({ projectKey: "source", sessionId: id }, native);
    await store.append(
      { projectKey: "source", sessionId: id, subpath: "subagents/agent.jsonl" },
      subagent,
    );
  });
  const archive = NodePath.join(root, "archive");
  const manifest = await captureThreadHandoffSnapshot({
    record,
    outputDirectory: archive,
    projects: sources,
    events,
    driver,
    sessionId,
    providerCwd: dirty,
  });
  return { root, sources, archive, manifest, driver, received: NodePath.join(root, "received") };
}
function transfer(archive: string, destination: string, entries: ThreadHandoffManifest["files"]) {
  return applyProjectSyncRecords({
    workspaceRoot: destination,
    records: createProjectSyncFrameDecoder(
      encodeProjectSyncRecords(
        projectSyncExportRecords({
          workspaceRoot: archive,
          entries: entries.map(({ path, size }) => ({ path, size })),
        }),
      ),
    ),
  });
}

it.effect(
  "round-trips two repositories and native compaction/subagent history through Project Sync framing",
  () =>
    Effect.gen(function* () {
      const f = yield* Effect.promise(fixture);
      expect(f.manifest.projects).toHaveLength(2);
      expect(f.manifest.projects.every((project) => project.git.bundle === "history.bundle")).toBe(
        true,
      );
      yield* transfer(f.archive, f.received, f.manifest.files);
      yield* Effect.promise(async () => {
        expect(
          await verifyThreadHandoffSnapshot({ manifest: f.manifest, directory: f.received }),
        ).toEqual(events);
        const providerDirectory = NodePath.join(f.received, "provider");
        const nativeSnapshot: ClaudeSessionSnapshot = decodeNativeSnapshot(
          await NodeFSP.readFile(NodePath.join(providerDirectory, "snapshot.json"), "utf8"),
        );
        await f.driver.verify({ snapshot: nativeSnapshot, directory: providerDirectory });
        const store = openTransferredClaudeSessionStore(nativeSnapshot, providerDirectory);
        expect(await store.load({ projectKey: "destination", sessionId })).toEqual(native);
        expect(
          await store.load({
            projectKey: "destination",
            sessionId,
            subpath: "subagents/agent.jsonl",
          }),
        ).toEqual(subagent);
        const destinations = f.sources.map((source) => ({
          projectId: source.projectId,
          destinationDirectory: NodePath.join(f.root, `linux-${source.projectId}`),
        }));
        await restoreThreadHandoffProjects({
          manifest: f.manifest,
          directory: f.received,
          destinations,
        });
        for (const [index, destination] of destinations.entries()) {
          const source = f.sources[index]!;
          for (const args of [
            ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
            ["diff", "--binary"],
            ["diff", "--cached", "--binary"],
            ["rev-parse", "HEAD"],
            ["branch", "--show-current"],
          ])
            expect(await runSnapshotGit(destination.destinationDirectory, args)).toEqual(
              await runSnapshotGit(source.cwd, args),
            );
          for (const ignored of ["node_modules", "dist", ".cache"])
            await expect(
              NodeFSP.stat(NodePath.join(destination.destinationDirectory, ignored)),
            ).rejects.toMatchObject({ code: "ENOENT" });
        }
        expect(
          await NodeFSP.readFile(
            NodePath.join(destinations[0]!.destinationDirectory, "notes.md"),
            "utf8",
          ),
        ).toBe("Relevant untracked\n");
      });
    }),
);

it.effect(
  "retries interrupted framing with only missing manifest entries and detects corrupted content",
  () =>
    Effect.gen(function* () {
      const f = yield* Effect.promise(fixture);
      const frames = createProjectSyncFrameDecoder(
        encodeProjectSyncRecords(
          projectSyncExportRecords({
            workspaceRoot: f.archive,
            entries: f.manifest.files.map(({ path, size }) => ({ path, size })),
          }),
        ),
      );
      async function* interrupted() {
        let completed = 0;
        for await (const frame of frames) {
          if (completed === 3) throw new Error("Connection lost");
          yield frame;
          completed++;
        }
      }
      const failure = yield* Effect.flip(
        applyProjectSyncRecords({ workspaceRoot: f.received, records: interrupted() }),
      );
      expect(failure.message).toContain("Project sync failed");
      yield* Effect.promise(async () => {
        await expect(
          verifyThreadHandoffSnapshot({ manifest: f.manifest, directory: f.received }),
        ).rejects.toThrow();
      });
      const received = yield* buildProjectSyncManifest({
        workspaceRoot: f.received,
        includeGit: false,
      });
      const byPath = new Map(received.map((entry) => [entry.path, entry]));
      const missing = f.manifest.files.filter((entry) => {
        const actual = byPath.get(entry.path);
        return (
          !actual ||
          actual.kind !== entry.kind ||
          actual.hash !== entry.hash ||
          actual.size !== entry.size
        );
      });
      expect(missing.length).toBe(f.manifest.files.length - 3);
      expect((yield* transfer(f.archive, f.received, missing)).applied).toBe(missing.length);
      yield* Effect.promise(async () => {
        expect(
          await verifyThreadHandoffSnapshot({ manifest: f.manifest, directory: f.received }),
        ).toEqual(events);
        await NodeFSP.appendFile(NodePath.join(f.received, "thread.json"), "corrupt");
        await expect(
          verifyThreadHandoffSnapshot({ manifest: f.manifest, directory: f.received }),
        ).rejects.toThrow("checksum");
      });
    }),
);

it.effect(
  "a second repository restore failure removes the first checkout and preserves existing destination data",
  () =>
    Effect.gen(function* () {
      const f = yield* Effect.promise(fixture);
      yield* transfer(f.archive, f.received, f.manifest.files);
      yield* Effect.promise(async () => {
        const first = NodePath.join(f.root, "first-restored");
        const second = NodePath.join(f.root, "already-existing");
        await NodeFSP.mkdir(second);
        await NodeFSP.writeFile(NodePath.join(second, "keep.txt"), "Preexisting destination data");
        await expect(
          restoreThreadHandoffProjects({
            manifest: f.manifest,
            directory: f.received,
            destinations: [
              { projectId: f.sources[0]!.projectId, destinationDirectory: first },
              { projectId: f.sources[1]!.projectId, destinationDirectory: second },
            ],
          }),
        ).rejects.toMatchObject({ code: "EEXIST" });
        await expect(NodeFSP.stat(first)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await NodeFSP.readFile(NodePath.join(second, "keep.txt"), "utf8")).toBe(
          "Preexisting destination data",
        );
        expect(await NodeFSP.readdir(second)).toEqual(["keep.txt"]);
        expect(
          (await runSnapshotGit(f.sources[0]!.cwd, ["status", "--porcelain"])).toString(),
        ).toContain("tracked.txt");
      });
    }),
);
