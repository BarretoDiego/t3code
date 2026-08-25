// @effect-diagnostics nodeBuiltinImport:off
/**
 * ProjectSyncApply - Writes and deletes workspace entries on behalf of a
 * project sync transfer.
 *
 * Every path that arrives here came off the wire, so nothing is trusted: paths
 * are validated segment by segment, and no ancestor of a write target is ever
 * allowed to be a symlink. A symlink *entry* is copied faithfully (its target
 * may legitimately point anywhere), but a symlink *ancestor* would let a
 * crafted manifest write outside the workspace root, so it is refused.
 *
 * @module ProjectSyncApply
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStreamPromises from "node:stream/promises";

import { ProjectSyncIoError, ProjectSyncPathViolationError } from "@t3tools/contracts";
import type { ProjectSyncFrameDecodedRecord } from "@t3tools/shared/projectSyncFraming";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { errnoCode } from "./projectSyncErrno.ts";

/** Raised when an import body carries more content than the signed URL
    authorized. Never crosses the WebSocket contract — the HTTP import route
    turns it into a 413. */
export class ProjectSyncImportLimitError extends Schema.TaggedErrorClass<ProjectSyncImportLimitError>()(
  "ProjectSyncImportLimitError",
  {
    limitBytes: Schema.Number,
    message: Schema.String,
  },
) {}

export interface ResolvedProjectSyncPath {
  readonly absolutePath: string;
  readonly relativePath: string;
}

/**
 * Validates a wire path and resolves it inside `workspaceRoot`, returning
 * `null` for anything that is absolute, empty, traversing, or otherwise not a
 * plain relative path. The root itself is compared unresolved, so a workspace
 * that lives behind a symlink (every macOS temp directory, for one) still
 * works.
 */
export function resolveProjectSyncRelativePath(input: {
  readonly workspaceRoot: string;
  readonly relativePath: string;
}): ResolvedProjectSyncPath | null {
  const raw = input.relativePath.trim().replaceAll("\\", "/");
  if (raw.length === 0 || raw.startsWith("/") || raw.includes("\0")) return null;

  const segments = raw.split("/");
  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment === "..") return null;
  }

  const workspaceRoot = NodePath.resolve(input.workspaceRoot);
  const absolutePath = NodePath.resolve(workspaceRoot, ...segments);
  if (!absolutePath.startsWith(`${workspaceRoot}${NodePath.sep}`)) return null;

  return { absolutePath, relativePath: segments.join("/") };
}

function requireResolvedPath(input: {
  readonly workspaceRoot: string;
  readonly relativePath: string;
}): ResolvedProjectSyncPath {
  const resolved = resolveProjectSyncRelativePath(input);
  if (resolved === null) {
    throw new ProjectSyncPathViolationError({ path: input.relativePath });
  }
  return resolved;
}

async function lstatOrNull(path: string) {
  try {
    return await NodeFSP.lstat(path);
  } catch (cause) {
    const code = errnoCode(cause);
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw cause;
  }
}

/**
 * Walks the ancestors of `relativePath` from the workspace root down, refusing
 * to traverse a symlink and (optionally) materializing the directories that do
 * not exist yet. Checking before creating matters: `mkdir -p` would happily
 * follow a symlinked ancestor and create directories outside the root.
 */
async function prepareAncestors(
  workspaceRoot: string,
  relativePath: string,
  options: { readonly create: boolean },
): Promise<void> {
  const segments = relativePath.split("/");
  segments.pop();

  let current = workspaceRoot;
  for (const segment of segments) {
    current = NodePath.join(current, segment);
    const stats = await lstatOrNull(current);
    if (stats === null) {
      if (!options.create) return;
      await NodeFSP.mkdir(current).catch((cause: unknown) => {
        if (errnoCode(cause) !== "EEXIST") throw cause;
      });
      continue;
    }
    if (stats.isSymbolicLink()) {
      throw new ProjectSyncPathViolationError({ path: relativePath });
    }
    if (!stats.isDirectory()) {
      throw new ProjectSyncIoError({
        message: `Cannot sync '${relativePath}': '${segment}' exists and is not a directory.`,
      });
    }
  }
}

/** Clears whatever currently occupies a target path so the incoming entry can
    take it, including a directory being replaced by a file. */
async function clearTarget(absolutePath: string): Promise<void> {
  const stats = await lstatOrNull(absolutePath);
  if (stats === null) return;
  await NodeFSP.rm(absolutePath, { force: true, recursive: stats.isDirectory() });
}

async function writeFileRecord(
  absolutePath: string,
  content: AsyncIterable<Uint8Array>,
  mode: number | undefined,
): Promise<void> {
  const directory = NodePath.dirname(absolutePath);
  const partPath = NodePath.join(
    directory,
    `.${NodePath.basename(absolutePath)}.${NodeCrypto.randomUUID()}.t3sync-part`,
  );

  try {
    await NodeStreamPromises.pipeline(content, NodeFS.createWriteStream(partPath));
    if (mode !== undefined) {
      await NodeFSP.chmod(partPath, mode & 0o777);
    }
    const existing = await lstatOrNull(absolutePath);
    if (existing?.isDirectory()) {
      await NodeFSP.rm(absolutePath, { force: true, recursive: true });
    }
    // Rename replaces the entry itself, so an existing symlink at the target is
    // swapped out rather than written through.
    await NodeFSP.rename(partPath, absolutePath);
  } catch (cause) {
    await NodeFSP.rm(partPath, { force: true }).catch(() => {});
    throw cause;
  }
}

async function applyRecord(
  workspaceRoot: string,
  record: ProjectSyncFrameDecodedRecord,
): Promise<void> {
  const { absolutePath, relativePath } = requireResolvedPath({
    workspaceRoot,
    relativePath: record.header.path,
  });
  await prepareAncestors(workspaceRoot, relativePath, { create: true });

  if (record.header.kind === "dir") {
    const stats = await lstatOrNull(absolutePath);
    if (stats?.isDirectory()) return;
    if (stats !== null) await clearTarget(absolutePath);
    await NodeFSP.mkdir(absolutePath, { recursive: true });
    return;
  }

  if (record.header.kind === "symlink") {
    const linkTarget = record.header.linkTarget;
    if (linkTarget === undefined || linkTarget.length === 0) {
      throw new ProjectSyncIoError({
        message: `Symlink record '${relativePath}' arrived without a link target.`,
      });
    }
    await clearTarget(absolutePath);
    await NodeFSP.symlink(linkTarget, absolutePath);
    return;
  }

  await writeFileRecord(absolutePath, record.content, record.header.mode);
}

const isPathViolationError = Schema.is(ProjectSyncPathViolationError);
const isIoError = Schema.is(ProjectSyncIoError);
const isImportLimitError = Schema.is(ProjectSyncImportLimitError);

function toFilesystemFailure(cause: unknown) {
  if (isPathViolationError(cause) || isIoError(cause)) {
    return cause;
  }
  return new ProjectSyncIoError({
    message: `Project sync failed to apply an entry${
      errnoCode(cause) ? ` (${errnoCode(cause)})` : ""
    }.`,
    cause,
  });
}

function toImportFailure(cause: unknown) {
  return isImportLimitError(cause) ? cause : toFilesystemFailure(cause);
}

export interface ProjectSyncApplyResult {
  readonly applied: number;
  readonly bytes: number;
}

/**
 * Applies a decoded frame stream into `workspaceRoot`, one record at a time.
 *
 * `maxContentBytes` mirrors the byte budget the signed import URL was issued
 * for; exceeding it aborts mid-stream instead of letting a token authorize an
 * unbounded write.
 */
export const applyProjectSyncRecords = Effect.fn("ProjectSyncApply.applyRecords")(
  function* (input: {
    readonly workspaceRoot: string;
    readonly records: AsyncIterable<ProjectSyncFrameDecodedRecord>;
    readonly maxContentBytes?: number | undefined;
  }) {
    const workspaceRoot = NodePath.resolve(input.workspaceRoot);
    return yield* Effect.tryPromise({
      try: async (): Promise<ProjectSyncApplyResult> => {
        await NodeFSP.mkdir(workspaceRoot, { recursive: true });

        let applied = 0;
        let bytes = 0;
        for await (const record of input.records) {
          bytes += record.header.size;
          if (input.maxContentBytes !== undefined && bytes > input.maxContentBytes) {
            throw new ProjectSyncImportLimitError({
              limitBytes: input.maxContentBytes,
              message: `Import body exceeded the ${input.maxContentBytes} byte budget the URL was signed for.`,
            });
          }
          await applyRecord(workspaceRoot, record);
          applied += 1;
        }
        return { applied, bytes };
      },
      catch: toImportFailure,
    });
  },
);

/**
 * Removes the given paths and then prunes the directories they emptied, up to
 * (but never including) the workspace root. A path that is already gone is not
 * an error — the destination simply agreed with the diff early.
 */
export const applyProjectSyncDeletions = Effect.fn("ProjectSyncApply.applyDeletions")(
  function* (input: { readonly workspaceRoot: string; readonly paths: ReadonlyArray<string> }) {
    const workspaceRoot = NodePath.resolve(input.workspaceRoot);
    return yield* Effect.tryPromise({
      try: async () => {
        let deleted = 0;
        const emptiedDirectories = new Set<string>();

        for (const relativePath of input.paths) {
          const resolved = requireResolvedPath({ workspaceRoot, relativePath });
          await prepareAncestors(workspaceRoot, resolved.relativePath, { create: false });

          const stats = await lstatOrNull(resolved.absolutePath);
          if (stats === null) continue;

          if (stats.isDirectory()) {
            // Only empty directories are ever published as their own entry, so a
            // non-empty one here still owns children the diff kept.
            const removed = await NodeFSP.rmdir(resolved.absolutePath).then(
              () => true,
              (cause: unknown) => {
                const code = errnoCode(cause);
                if (code === "ENOTEMPTY" || code === "EEXIST" || code === "ENOENT") return false;
                throw cause;
              },
            );
            if (!removed) continue;
          } else {
            await NodeFSP.rm(resolved.absolutePath, { force: true });
          }

          deleted += 1;
          emptiedDirectories.add(NodePath.dirname(resolved.absolutePath));
        }

        // Deepest first, so a chain of newly emptied directories collapses in one
        // pass instead of leaving the parents behind.
        for (const directory of [...emptiedDirectories].sort(
          (left, right) => right.length - left.length,
        )) {
          await pruneEmptyDirectories(workspaceRoot, directory);
        }

        return { deleted };
      },
      catch: toFilesystemFailure,
    });
  },
);

async function pruneEmptyDirectories(workspaceRoot: string, startDirectory: string): Promise<void> {
  let current = startDirectory;
  while (current.startsWith(`${workspaceRoot}${NodePath.sep}`)) {
    const removed = await NodeFSP.rmdir(current).then(
      () => true,
      () => false,
    );
    if (!removed) return;
    current = NodePath.dirname(current);
  }
}
