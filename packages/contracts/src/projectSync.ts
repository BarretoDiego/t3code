import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const PROJECT_SYNC_PATH_MAX_LENGTH = 1024;
const PROJECT_SYNC_URL_MAX_LENGTH = 4096;
const PROJECT_SYNC_MAX_PATHS_PER_REQUEST = 5000;

/** A lowercase-hex sha256 digest, or empty when the entry has no content
    (directories and symlinks). */
const SHA256_HEX_PATTERN = /^(?:[0-9a-f]{64})?$/i;

export const ProjectSyncEntryKind = Schema.Literals(["file", "dir", "symlink"]);
export type ProjectSyncEntryKind = typeof ProjectSyncEntryKind.Type;

/**
 * One entry in a project sync manifest. `path` is always relative to the
 * project's workspace root and always uses `/` as the separator, regardless
 * of the origin environment's OS, so destination environments on a different
 * platform can rebuild the tree without re-deriving path semantics.
 *
 * `kind: "dir"` entries only exist for otherwise-empty directories: a
 * directory that contains any file/symlink entry is implied by those
 * entries' paths and does not get its own "dir" entry.
 */
export const ProjectSyncManifestEntry = Schema.Struct({
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_SYNC_PATH_MAX_LENGTH)),
  kind: ProjectSyncEntryKind,
  size: NonNegativeInt,
  // POSIX permission bits. Absent when the origin platform has no concept of
  // file mode (or the caller chooses not to report it).
  mode: Schema.optional(NonNegativeInt),
  // Empty or absent for "dir" and "symlink" entries. A 64-character
  // lowercase-hex sha256 digest of the file contents for "file" entries.
  hash: Schema.optional(Schema.String.check(Schema.isPattern(SHA256_HEX_PATTERN))),
  // Only present for "symlink" entries: the raw link target, unresolved.
  linkTarget: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_SYNC_PATH_MAX_LENGTH)),
  ),
});
export type ProjectSyncManifestEntry = typeof ProjectSyncManifestEntry.Type;

/**
 * Requests a manifest (file tree + hashes) for a project so the client can
 * diff it against the destination environment's tree before deciding what to
 * copy or delete.
 *
 * The server always ignores `node_modules`, `.t3`, and `.DS_Store` regardless
 * of `extraIgnores` — those are noise/local-state paths that must never
 * round-trip between environments. `extraIgnores` layers additional
 * project-specific exclusions (e.g. build output) on top of that default
 * set; it never narrows it.
 */
export const ProjectSyncManifestInput = Schema.Struct({
  projectId: ProjectId,
  // Whether the manifest should include the project's `.git` directory.
  // Defaults to true so omitted/legacy payloads keep syncing history; callers
  // that only want the working tree can opt out explicitly.
  includeGit: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  extraIgnores: Schema.optional(
    Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_SYNC_PATH_MAX_LENGTH))),
  ),
});
export type ProjectSyncManifestInput = typeof ProjectSyncManifestInput.Type;

export const ProjectSyncManifestResult = Schema.Struct({
  workspaceRoot: TrimmedNonEmptyString,
  entries: Schema.Array(ProjectSyncManifestEntry),
  generatedAt: IsoDateTime,
});
export type ProjectSyncManifestResult = typeof ProjectSyncManifestResult.Type;

/** How long a signed project-sync export/import URL stays valid. Mirrors the
    attachment upload URL's TTL: long enough to cover a slow transfer, short
    enough that a leaked URL is not a standing liability. */
export const PROJECT_SYNC_URL_TTL_MS = 10 * 60 * 1000;

/** HTTP route prefix a client resolves a signed export URL against to stream
    project file contents out of the origin environment. */
export const PROJECT_SYNC_EXPORT_ROUTE_PREFIX = "/api/projectSync/export";

/** HTTP route prefix a client resolves a signed import URL against to stream
    project file contents into the destination environment. */
export const PROJECT_SYNC_IMPORT_ROUTE_PREFIX = "/api/projectSync/import";

export const ProjectSyncCreateExportUrlInput = Schema.Struct({
  projectId: ProjectId,
  paths: Schema.Array(
    TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_SYNC_PATH_MAX_LENGTH)),
  ).check(Schema.isMaxLength(PROJECT_SYNC_MAX_PATHS_PER_REQUEST)),
});
export type ProjectSyncCreateExportUrlInput = typeof ProjectSyncCreateExportUrlInput.Type;

export const ProjectSyncCreateImportUrlInput = Schema.Struct({
  projectId: ProjectId,
  fileCount: NonNegativeInt,
  totalBytes: NonNegativeInt,
});
export type ProjectSyncCreateImportUrlInput = typeof ProjectSyncCreateImportUrlInput.Type;

export const ProjectSyncCreateUrlResult = Schema.Struct({
  url: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_SYNC_URL_MAX_LENGTH)),
  expiresAt: Schema.Number,
});
export type ProjectSyncCreateUrlResult = typeof ProjectSyncCreateUrlResult.Type;

export const ProjectSyncApplyDeletionsInput = Schema.Struct({
  projectId: ProjectId,
  paths: Schema.Array(
    TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_SYNC_PATH_MAX_LENGTH)),
  ).check(Schema.isMaxLength(PROJECT_SYNC_MAX_PATHS_PER_REQUEST)),
});
export type ProjectSyncApplyDeletionsInput = typeof ProjectSyncApplyDeletionsInput.Type;

export const ProjectSyncApplyDeletionsResult = Schema.Struct({
  deleted: NonNegativeInt,
});
export type ProjectSyncApplyDeletionsResult = typeof ProjectSyncApplyDeletionsResult.Type;

type ProjectSyncErrorContext = {
  readonly message?: string;
  readonly cause?: unknown;
};

export class ProjectSyncProjectNotFoundError extends Schema.TaggedErrorClass<ProjectSyncProjectNotFoundError>()(
  "ProjectSyncProjectNotFoundError",
  {
    projectId: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // The structured field is optional on the wire so newer peers can decode legacy
  // message-only failures. New application code must provide it through this constructor.
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: ProjectSyncErrorContext & { readonly projectId: string }) {
    super({
      ...props,
      message: props.message ?? `Project '${props.projectId}' was not found.`,
    } as any);
  }
}

export class ProjectSyncPathViolationError extends Schema.TaggedErrorClass<ProjectSyncPathViolationError>()(
  "ProjectSyncPathViolationError",
  {
    path: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: ProjectSyncErrorContext & { readonly path: string }) {
    super({
      ...props,
      message: props.message ?? `Path '${props.path}' escapes the project workspace root.`,
    } as any);
  }
}

export class ProjectSyncIoError extends Schema.TaggedErrorClass<ProjectSyncIoError>()(
  "ProjectSyncIoError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const ProjectSyncError = Schema.Union([
  ProjectSyncProjectNotFoundError,
  ProjectSyncPathViolationError,
  ProjectSyncIoError,
]);
export type ProjectSyncError = typeof ProjectSyncError.Type;
