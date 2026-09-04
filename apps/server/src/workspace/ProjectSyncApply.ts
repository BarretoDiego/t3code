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

/** Raised when an import body carries more than the signed URL authorized,
    either in content bytes or in record count. Never crosses the WebSocket
    contract — the HTTP import route turns it into a 413. */
export class ProjectSyncImportLimitError extends Schema.TaggedErrorClass<ProjectSyncImportLimitError>()(
  "ProjectSyncImportLimitError",
  {
    limit: Schema.Number,
    unit: Schema.Literals(["bytes", "records"]),
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
 *
 * The path is never rewritten, only accepted or refused. Trailing spaces and
 * backslashes are ordinary characters in a POSIX filename, and normalizing
 * either one would turn a real file into a path the origin cannot export —
 * a silent omission from a sync that reports itself complete. On Windows a
 * backslash *is* a separator, so a segment carrying one is refused there
 * rather than quietly split.
 */
export function resolveProjectSyncRelativePath(input: {
  readonly workspaceRoot: string;
  readonly relativePath: string;
}): ResolvedProjectSyncPath | null {
  const raw = input.relativePath;
  if (raw.length === 0 || raw.startsWith("/") || raw.includes("\0")) return null;

  const segments = raw.split("/");
  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment === "..") return null;
    if (NodePath.sep === "\\" && segment.includes("\\")) return null;
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
 * Absolute directories already proven, during one apply/delete/export pass, to
 * be real directories under the workspace root.
 *
 * A 20k-file sync shares a few thousand ancestors across its records, so
 * without this every record re-`lstat`s its whole chain and the pass spends
 * most of its syscalls re-answering the same question. Any directory removal
 * invalidates the whole set rather than trying to reason about which cached
 * descendants it took with it.
 */
export class ProjectSyncAncestorCache {
  private readonly verified = new Set<string>();

  has(absolutePath: string): boolean {
    return this.verified.has(absolutePath);
  }

  add(absolutePath: string): void {
    this.verified.add(absolutePath);
  }

  /** A directory just went away, so nothing proven below it can be trusted. */
  invalidate(): void {
    this.verified.clear();
  }
}

type AncestorWalkResult = "ok" | "symlink" | "missing";

/**
 * Walks the ancestors of `relativePath` from the workspace root down, refusing
 * to traverse a symlink and (optionally) materializing the directories that do
 * not exist yet. Checking before creating matters: `mkdir -p` would happily
 * follow a symlinked ancestor and create directories outside the root.
 */
async function walkAncestors(
  workspaceRoot: string,
  relativePath: string,
  options: { readonly create: boolean; readonly cache?: ProjectSyncAncestorCache | undefined },
): Promise<AncestorWalkResult> {
  const segments = relativePath.split("/");
  segments.pop();

  const mkdirIgnoringExisting = (path: string) =>
    NodeFSP.mkdir(path).catch((cause: unknown) => {
      if (errnoCode(cause) !== "EEXIST") throw cause;
    });

  const cache = options.cache;
  let current = workspaceRoot;
  for (const segment of segments) {
    current = NodePath.join(current, segment);
    if (cache?.has(current)) continue;

    const stats = await lstatOrNull(current);
    if (stats === null) {
      if (!options.create) return "missing";
      await mkdirIgnoringExisting(current);
      cache?.add(current);
      continue;
    }
    if (stats.isSymbolicLink()) {
      return "symlink";
    }
    if (!stats.isDirectory()) {
      // An ancestor that is a plain file cannot hold this entry. Writing means
      // the origin replaced that file with a directory, so it is cleared the
      // same way a target of the wrong kind is; deleting means the entry is
      // already gone, so the caller has nothing left to do.
      if (!options.create) return "missing";
      await NodeFSP.rm(current, { force: true });
      await mkdirIgnoringExisting(current);
      cache?.add(current);
      continue;
    }
    cache?.add(current);
  }
  return "ok";
}

async function prepareAncestors(
  workspaceRoot: string,
  relativePath: string,
  options: { readonly create: boolean; readonly cache?: ProjectSyncAncestorCache | undefined },
): Promise<void> {
  if ((await walkAncestors(workspaceRoot, relativePath, options)) === "symlink") {
    throw new ProjectSyncPathViolationError({ path: relativePath });
  }
}

/**
 * Read-only version of the ancestor check, for the export side.
 *
 * The apply pass refuses to *write* through a symlinked ancestor; without the
 * same check here a `link -> /Users/someone` planted inside a workspace would
 * let a signed export URL *read* `link/.ssh/id_rsa` straight out of the home
 * directory. Callers skip the entry the same way they skip one that vanished.
 */
export async function projectSyncAncestorsAreSafe(input: {
  readonly workspaceRoot: string;
  readonly relativePath: string;
  readonly cache?: ProjectSyncAncestorCache | undefined;
}): Promise<boolean> {
  const walked = await walkAncestors(input.workspaceRoot, input.relativePath, {
    create: false,
    cache: input.cache,
  });
  return walked !== "symlink";
}

/** Clears whatever currently occupies a target path so the incoming entry can
    take it, including a directory being replaced by a file. */
async function clearTarget(
  absolutePath: string,
  cache?: ProjectSyncAncestorCache | undefined,
): Promise<void> {
  const stats = await lstatOrNull(absolutePath);
  if (stats === null) return;
  if (stats.isDirectory()) cache?.invalidate();
  await NodeFSP.rm(absolutePath, { force: true, recursive: stats.isDirectory() });
}

async function writeFileRecord(
  absolutePath: string,
  content: AsyncIterable<Uint8Array>,
  mode: number | undefined,
  cache: ProjectSyncAncestorCache | undefined,
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
      cache?.invalidate();
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
  cache: ProjectSyncAncestorCache,
): Promise<void> {
  const { absolutePath, relativePath } = requireResolvedPath({
    workspaceRoot,
    relativePath: record.header.path,
  });
  await prepareAncestors(workspaceRoot, relativePath, { create: true, cache });

  if (record.header.kind === "dir") {
    const stats = await lstatOrNull(absolutePath);
    if (stats?.isDirectory()) return;
    if (stats !== null) await clearTarget(absolutePath, cache);
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
    await clearTarget(absolutePath, cache);
    await NodeFSP.symlink(linkTarget, absolutePath);
    return;
  }

  await writeFileRecord(absolutePath, record.content, record.header.mode, cache);
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
 * `maxContentBytes` and `maxRecordCount` mirror the two budgets the signed
 * import URL was issued for; exceeding either aborts mid-stream instead of
 * letting a token authorize unbounded work. The record cap matters on its own:
 * a body of a million zero-byte `"dir"` records costs no content bytes at all
 * and would still exhaust the destination's inodes.
 */
export const applyProjectSyncRecords = Effect.fn("ProjectSyncApply.applyRecords")(
  function* (input: {
    readonly workspaceRoot: string;
    readonly records: AsyncIterable<ProjectSyncFrameDecodedRecord>;
    readonly maxContentBytes?: number | undefined;
    readonly maxRecordCount?: number | undefined;
  }) {
    const workspaceRoot = NodePath.resolve(input.workspaceRoot);
    return yield* Effect.tryPromise({
      try: async (): Promise<ProjectSyncApplyResult> => {
        await NodeFSP.mkdir(workspaceRoot, { recursive: true });

        const cache = new ProjectSyncAncestorCache();
        let applied = 0;
        let bytes = 0;
        for await (const record of input.records) {
          if (input.maxRecordCount !== undefined && applied >= input.maxRecordCount) {
            throw new ProjectSyncImportLimitError({
              limit: input.maxRecordCount,
              unit: "records",
              message: `Import body carried more than the ${input.maxRecordCount} entries the URL was signed for.`,
            });
          }
          bytes += record.header.size;
          if (input.maxContentBytes !== undefined && bytes > input.maxContentBytes) {
            throw new ProjectSyncImportLimitError({
              limit: input.maxContentBytes,
              unit: "bytes",
              message: `Import body exceeded the ${input.maxContentBytes} byte budget the URL was signed for.`,
            });
          }
          await applyRecord(workspaceRoot, record, cache);
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
        const cache = new ProjectSyncAncestorCache();

        for (const relativePath of input.paths) {
          const resolved = requireResolvedPath({ workspaceRoot, relativePath });
          await prepareAncestors(workspaceRoot, resolved.relativePath, { create: false, cache });

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
            cache.invalidate();
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
