// @effect-diagnostics nodeBuiltinImport:off
/**
 * ProjectSyncManifest - Walks a project's workspace root and describes it as a
 * flat, hash-addressed manifest.
 *
 * The manifest is the input to the client-orchestrated diff between two
 * environments: the client asks both sides for one, compares them, and then
 * only exports/imports/deletes what actually differs. Nothing here touches the
 * event store — it is a read-only filesystem walk.
 *
 * @module ProjectSyncManifest
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { ProjectSyncIoError, type ProjectSyncManifestEntry } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { errnoCode, isMissingOrUnreadable } from "./projectSyncErrno.ts";

/**
 * Segments that never round-trip between environments: installable state, T3's
 * own runtime directory, and macOS folder metadata. Mirrors the guarantee the
 * `ProjectSyncManifestInput` contract makes to clients.
 */
export const PROJECT_SYNC_ALWAYS_IGNORED_SEGMENTS = ["node_modules", ".t3", ".DS_Store"] as const;

/** Bounded so a manifest of a large repository does not saturate the disk
    queue and starve every other request the server is serving. */
const MANIFEST_FILE_CONCURRENCY = 8;

type ManifestDraft =
  | { readonly kind: "dir"; readonly path: string }
  | { readonly kind: "symlink"; readonly path: string; readonly linkTarget: string }
  | { readonly kind: "file"; readonly path: string; readonly absolutePath: string };

export interface ProjectSyncManifestInputs {
  readonly workspaceRoot: string;
  readonly includeGit: boolean;
  readonly extraIgnores?: ReadonlyArray<string> | undefined;
}

function compareByPath(left: { readonly path: string }, right: { readonly path: string }): number {
  if (left.path === right.path) return 0;
  return left.path < right.path ? -1 : 1;
}

function resolveIgnoredSegments(input: ProjectSyncManifestInputs): ReadonlySet<string> {
  const ignored = new Set<string>(PROJECT_SYNC_ALWAYS_IGNORED_SEGMENTS);
  if (!input.includeGit) {
    ignored.add(".git");
  }
  for (const extra of input.extraIgnores ?? []) {
    const trimmed = extra.trim();
    if (trimmed.length > 0) {
      ignored.add(trimmed);
    }
  }
  return ignored;
}

/**
 * Depth-first walk producing one draft per entry we intend to publish.
 *
 * A directory only earns its own `"dir"` draft when it contributes nothing
 * else to the manifest — either because it is genuinely empty or because
 * everything inside it was ignored. Destinations rebuild every other directory
 * implicitly from the paths of the entries inside it.
 */
async function collectDrafts(
  absoluteDir: string,
  relativeDir: string,
  ignoredSegments: ReadonlySet<string>,
): Promise<Array<ManifestDraft>> {
  let dirents;
  try {
    dirents = await NodeFSP.readdir(absoluteDir, { withFileTypes: true });
  } catch (cause) {
    if (isMissingOrUnreadable(cause)) return [];
    throw cause;
  }

  const drafts: Array<ManifestDraft> = [];
  for (const dirent of dirents.sort((left, right) => (left.name < right.name ? -1 : 1))) {
    if (ignoredSegments.has(dirent.name)) continue;

    const path = relativeDir === "" ? dirent.name : `${relativeDir}/${dirent.name}`;
    const absolutePath = NodePath.join(absoluteDir, dirent.name);

    if (dirent.isSymbolicLink()) {
      // Never followed: a symlink is copied as a link, so its target stays
      // whatever it means on the destination machine.
      const linkTarget = await NodeFSP.readlink(absolutePath).catch((cause: unknown) => {
        if (isMissingOrUnreadable(cause)) return null;
        throw cause;
      });
      if (linkTarget !== null && linkTarget.length > 0) {
        drafts.push({ kind: "symlink", path, linkTarget });
      }
      continue;
    }

    if (dirent.isDirectory()) {
      const nested = await collectDrafts(absolutePath, path, ignoredSegments);
      if (nested.length === 0) drafts.push({ kind: "dir", path });
      else drafts.push(...nested);
      continue;
    }

    if (dirent.isFile()) {
      drafts.push({ kind: "file", path, absolutePath });
    }
  }

  return drafts;
}

/** Streams the file through sha256 so a multi-gigabyte artifact costs one
    buffer, not its own size in resident memory. */
async function describeFile(draft: {
  readonly path: string;
  readonly absolutePath: string;
}): Promise<ProjectSyncManifestEntry | null> {
  let stats;
  try {
    stats = await NodeFSP.lstat(draft.absolutePath);
  } catch (cause) {
    if (isMissingOrUnreadable(cause)) return null;
    throw cause;
  }
  if (!stats.isFile()) return null;

  const hash = NodeCrypto.createHash("sha256");
  let size = 0;
  try {
    for await (const chunk of NodeFS.createReadStream(draft.absolutePath)) {
      hash.update(chunk as Uint8Array);
      size += (chunk as Uint8Array).length;
    }
  } catch (cause) {
    if (isMissingOrUnreadable(cause)) return null;
    throw cause;
  }

  return {
    path: draft.path,
    kind: "file",
    size,
    mode: stats.mode & 0o777,
    hash: hash.digest("hex"),
  };
}

export const buildProjectSyncManifest = Effect.fn("ProjectSyncManifest.build")(function* (
  input: ProjectSyncManifestInputs,
) {
  const workspaceRoot = NodePath.resolve(input.workspaceRoot);
  const ignoredSegments = resolveIgnoredSegments(input);

  const drafts = yield* Effect.tryPromise({
    try: () => collectDrafts(workspaceRoot, "", ignoredSegments),
    catch: (cause) =>
      new ProjectSyncIoError({
        message: `Failed to walk '${workspaceRoot}' for a project sync manifest${
          errnoCode(cause) ? ` (${errnoCode(cause)})` : ""
        }.`,
        cause,
      }),
  });

  const entries = yield* Effect.forEach(
    drafts,
    (draft) =>
      draft.kind === "file"
        ? Effect.tryPromise({
            try: () => describeFile(draft),
            catch: (cause) =>
              new ProjectSyncIoError({
                message: `Failed to hash '${draft.path}' for a project sync manifest.`,
                cause,
              }),
          })
        : Effect.succeed<ProjectSyncManifestEntry>(
            draft.kind === "symlink"
              ? { path: draft.path, kind: "symlink", size: 0, linkTarget: draft.linkTarget }
              : { path: draft.path, kind: "dir", size: 0 },
          ),
    { concurrency: MANIFEST_FILE_CONCURRENCY },
  );

  // Globally sorted by path so two manifests can be diffed with a linear
  // merge-join instead of building a map of every entry on the client.
  return entries.filter((entry) => entry !== null).sort(compareByPath);
});
