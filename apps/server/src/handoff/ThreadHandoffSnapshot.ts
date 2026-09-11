// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  OrchestrationEvent,
  ThreadHandoffError,
  ThreadHandoffManifest,
  type ProjectId,
  type ProviderDriverKind,
  type ThreadHandoffRecord,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { buildProjectSyncManifest } from "../workspace/ProjectSyncManifest.ts";
import {
  captureProjectSyncGitSnapshot,
  cleanupProjectSyncGitSnapshot,
  restoreProjectSyncGitSnapshot,
} from "../workspace/ProjectSyncGitSnapshot.ts";
import type { ProviderSessionHandoffDriver } from "./ProviderSessionHandoff.ts";

const decodeEvents = Schema.decodeUnknownSync(Schema.Array(OrchestrationEvent));
const decodeManifest = Schema.decodeUnknownSync(ThreadHandoffManifest);
const failure = (message: string) =>
  new ThreadHandoffError({ code: "verificationFailed", message });

export interface HandoffProjectSource {
  readonly projectId: ProjectId;
  readonly cwd: string;
  readonly destinationHasHead?: string;
  readonly checkpointRefs?: readonly string[];
  readonly explicitlyIncludedUntracked?: readonly string[];
  readonly extraIgnores?: readonly string[];
}

/** The caller holds a durable execution fence and a causally drained safe point.
 * One private snapshot contains all repositories, native state and history.
 * Project Sync supplies the existing manifest, delta and streaming transport. */
export async function captureThreadHandoffSnapshot<NativeSnapshot>(input: {
  readonly record: ThreadHandoffRecord;
  readonly outputDirectory: string;
  readonly projects: readonly HandoffProjectSource[];
  readonly events: readonly OrchestrationEvent[];
  readonly driver?: Pick<ProviderSessionHandoffDriver<NativeSnapshot>, "driver" | "checkpoint">;
  readonly transferMode?: "native" | "context";
  readonly sourceDriver?: ProviderDriverKind;
  readonly sessionId?: string;
  readonly providerCwd: string;
}): Promise<ThreadHandoffManifest> {
  if (input.record.phase !== "checkpointing")
    throw failure("Capture requires the checkpointing fence.");
  if (
    input.projects.length === 0 ||
    new Set(input.projects.map((project) => project.projectId)).size !== input.projects.length
  )
    throw failure("A handoff must map each project exactly once.");
  const events = decodeEvents(input.events);
  if (
    events.length === 0 ||
    events.some(
      (event) =>
        event.aggregateKind !== "thread" || event.aggregateId !== input.record.owner.threadId,
    )
  )
    throw failure("Thread history does not belong to the execution owner.");
  await NodeFSP.mkdir(input.outputDirectory, { recursive: false, mode: 0o700 });
  try {
    await NodeFSP.mkdir(NodePath.join(input.outputDirectory, "projects"), { mode: 0o700 });
    const projects: Array<ThreadHandoffManifest["projects"][number]> = [];
    for (const [index, project] of input.projects.entries()) {
      const directory = `projects/${index}`;
      const git = await captureProjectSyncGitSnapshot({
        ...project,
        outputDirectory: NodePath.join(input.outputDirectory, directory),
      });
      projects.push({ projectId: project.projectId, directory, git });
    }
    const mode = input.transferMode ?? "native";
    const sourceDriver = input.sourceDriver ?? input.driver?.driver;
    if (!sourceDriver) throw failure("Source provider identity is missing.");
    if (mode === "native") {
      if (!input.driver || !input.sessionId)
        throw failure("Native handoff requires a driver and session identity.");
      await input.driver.checkpoint({
        sessionId: input.sessionId,
        cwd: input.providerCwd,
        outputDirectory: NodePath.join(input.outputDirectory, "provider"),
      });
    } else {
      await NodeFSP.mkdir(NodePath.join(input.outputDirectory, "provider"), { mode: 0o700 });
      await NodeFSP.writeFile(
        NodePath.join(input.outputDirectory, "provider", "context.json"),
        JSON.stringify({
          format: "t3-conversation-context-v1",
          sourceDriver,
          historyFile: "thread.json",
        }),
        { mode: 0o600 },
      );
    }
    await NodeFSP.writeFile(
      NodePath.join(input.outputDirectory, "thread.json"),
      JSON.stringify(events),
      { mode: 0o600 },
    );
    const files = await Effect.runPromise(
      buildProjectSyncManifest({ workspaceRoot: input.outputDirectory, includeGit: false }),
    );
    return decodeManifest({
      version: 1,
      handoffId: input.record.handoffId,
      owner: input.record.owner,
      destinationEnvironmentId: input.record.destinationEnvironmentId,
      createdAt: input.record.updatedAt,
      projects,
      provider: {
        driver: sourceDriver,
        mode,
        ...(mode === "native" ? { sessionId: input.sessionId } : {}),
        directory: "provider",
      },
      threadFile: "thread.json",
      files,
    });
  } catch (error) {
    await NodeFSP.rm(input.outputDirectory, { recursive: true, force: true });
    throw error;
  }
}

/** Validation precedes any Git activation. An interrupted Project Sync batch
 * leaves a private staging directory; its next manifest requests only missing
 * or mismatching content. No partial thread becomes executable. */
export async function verifyThreadHandoffSnapshot(input: {
  readonly manifest: ThreadHandoffManifest;
  readonly directory: string;
}) {
  const manifest = decodeManifest(input.manifest);
  if (
    manifest.projects.length === 0 ||
    new Set(manifest.projects.map((project) => project.projectId)).size !== manifest.projects.length
  )
    throw failure("Invalid project mapping.");
  for (const [index, project] of manifest.projects.entries()) {
    if (
      project.directory !== `projects/${index}` ||
      project.git.stagedPatch !== "staged.patch" ||
      project.git.workingPatch !== "working.patch" ||
      (project.git.bundle !== null && project.git.bundle !== "history.bundle")
    )
      throw failure("Invalid project snapshot paths.");
  }
  const actual = await Effect.runPromise(
    buildProjectSyncManifest({ workspaceRoot: input.directory, includeGit: false }),
  );
  const byPath = new Map(actual.map((file) => [file.path, file]));
  if (
    new Set(manifest.files.map((file) => file.path)).size !== manifest.files.length ||
    actual.length !== manifest.files.length
  )
    throw failure("Transferred file manifest does not match.");
  for (const file of manifest.files) {
    const received = byPath.get(file.path);
    if (file.kind === "dir" && received?.kind === "dir") continue;
    if (
      file.kind !== "file" ||
      !file.hash ||
      received?.kind !== "file" ||
      received.hash !== file.hash ||
      received.size !== file.size
    )
      throw failure(`Transferred file checksum mismatch: ${file.path}`);
  }
  const events = decodeEvents(
    JSON.parse(await NodeFSP.readFile(NodePath.join(input.directory, manifest.threadFile), "utf8")),
  );
  if (
    events.length === 0 ||
    events.some(
      (event) => event.aggregateKind !== "thread" || event.aggregateId !== manifest.owner.threadId,
    )
  )
    throw failure("Transferred history belongs to another thread.");
  return events;
}

export interface HandoffProjectDestination {
  readonly projectId: ProjectId;
  readonly destinationDirectory: string;
  readonly existingRepository?: string;
}

/** Restore all repositories as one preparation. Existing checkouts are never
 * overwritten. A failure removes only successfully created private checkouts;
 * failed cleanup remains an explicit recovery error. Activation is separate. */
export async function restoreThreadHandoffProjects(input: {
  readonly manifest: ThreadHandoffManifest;
  readonly directory: string;
  readonly destinations: readonly HandoffProjectDestination[];
}) {
  await verifyThreadHandoffSnapshot(input);
  const destinations = new Map(
    input.destinations.map((destination) => [destination.projectId, destination]),
  );
  if (
    destinations.size !== input.manifest.projects.length ||
    destinations.size !== input.destinations.length ||
    new Set(
      input.destinations.map((destination) => NodePath.resolve(destination.destinationDirectory)),
    ).size !== destinations.size
  )
    throw failure("Every repository requires a distinct destination mapping.");
  const restored: Array<{ destination: HandoffProjectDestination; sourceWasWorktree: boolean }> =
    [];
  try {
    for (const project of input.manifest.projects) {
      const destination = destinations.get(project.projectId);
      if (!destination) throw failure("Missing destination repository mapping.");
      await restoreProjectSyncGitSnapshot({
        snapshot: project.git,
        inputDirectory: NodePath.join(input.directory, project.directory),
        ...destination,
      });
      restored.push({ destination, sourceWasWorktree: project.git.sourceWasWorktree });
    }
  } catch (cause) {
    const cleanups = await Promise.allSettled(
      restored.map(({ destination, sourceWasWorktree }) =>
        cleanupProjectSyncGitSnapshot({ ...destination, sourceWasWorktree }),
      ),
    );
    if (cleanups.some((result) => result.status === "rejected"))
      throw new ThreadHandoffError({
        code: "recoveryRequired",
        message:
          "Repository preparation failed and cleanup needs recovery. Keep source execution fenced.",
      });
    throw cause;
  }
}
