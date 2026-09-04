// @effect-diagnostics nodeBuiltinImport:off
/**
 * ProjectSyncTransfer - Issues and validates the signed URLs a project sync
 * transfer runs over, and streams the origin side of an export.
 *
 * Signing follows the asset/attachment precedent exactly: HMAC-SHA256 over a
 * base64url claims blob, keyed by the shared `asset-access-signing-key`
 * secret, with the claim `kind` keeping the token families apart.
 *
 * Two things differ from an attachment upload, both forced by scale:
 *
 * - The set of paths an export covers can run to thousands of entries, which
 *   would blow far past the 4096-character URL the contract allows. The token
 *   therefore carries a random request id and the path list stays in a
 *   short-lived in-process registry, expiring with the URL itself.
 * - The claims carry the resolved `workspaceRoot`, so the HTTP routes never
 *   need the projection read model. That mirrors how workspace-file asset
 *   claims already work.
 *
 * @module ProjectSyncTransfer
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";

import {
  PROJECT_SYNC_EXPORT_ROUTE_PREFIX,
  PROJECT_SYNC_IMPORT_ROUTE_PREFIX,
  PROJECT_SYNC_URL_TTL_MS,
  type ProjectSyncExportEntry,
  ProjectSyncIoError,
  ProjectSyncPathViolationError,
} from "@t3tools/contracts";
import type { ProjectSyncFrameRecord } from "@t3tools/shared/projectSyncFraming";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { base64UrlEncode, signPayload, verifySignedClaims } from "../auth/utils.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { isMissingOrUnreadable } from "./projectSyncErrno.ts";
import {
  ProjectSyncAncestorCache,
  projectSyncAncestorsAreSafe,
  resolveProjectSyncRelativePath,
} from "./ProjectSyncApply.ts";

/** Shared with asset download and attachment upload tokens; the signed `kind`
    is what keeps a token from being replayed against another route. */
const SIGNING_SECRET_NAME = "asset-access-signing-key";

/**
 * Backstop on the pending-export registry.
 *
 * A registration is normally short-lived: it is released the moment its export
 * finishes streaming, and otherwise expires with its URL. The cap only exists
 * so a peer that issues URLs it never fetches cannot grow the map without
 * bound, and it is set high enough that legitimate concurrent syncs never
 * evict each other's in-flight token.
 */
const MAX_PENDING_EXPORTS = 1024;

const ProjectSyncExportClaims = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("project-sync-export"),
  requestId: Schema.String,
  projectId: Schema.String,
  workspaceRoot: Schema.String,
  expiresAt: Schema.Number,
});
type ProjectSyncExportClaims = typeof ProjectSyncExportClaims.Type;

const ProjectSyncImportClaims = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("project-sync-import"),
  projectId: Schema.String,
  workspaceRoot: Schema.String,
  fileCount: Schema.Number,
  totalBytes: Schema.Number,
  expiresAt: Schema.Number,
});
export type ProjectSyncImportClaims = typeof ProjectSyncImportClaims.Type;

const exportClaimsJson = Schema.fromJsonString(ProjectSyncExportClaims);
const decodeExportClaims = Schema.decodeUnknownOption(exportClaimsJson);
const encodeExportClaims = Schema.encodeSync(exportClaimsJson);

const importClaimsJson = Schema.fromJsonString(ProjectSyncImportClaims);
const decodeImportClaims = Schema.decodeUnknownOption(importClaimsJson);
const encodeImportClaims = Schema.encodeSync(importClaimsJson);

interface PendingExport {
  readonly entries: ReadonlyArray<ProjectSyncExportEntry>;
  readonly expiresAt: number;
}

const pendingExports = new Map<string, PendingExport>();

function sweepPendingExports(nowMs: number): void {
  for (const [requestId, pending] of pendingExports) {
    if (pending.expiresAt <= nowMs) pendingExports.delete(requestId);
  }
  // Only reached if expiry alone did not bring the map back under the cap.
  while (pendingExports.size >= MAX_PENDING_EXPORTS) {
    const oldest = pendingExports.keys().next();
    if (oldest.done) break;
    pendingExports.delete(oldest.value);
  }
}

const loadSigningSecret = Effect.gen(function* () {
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  return yield* secretStore.getOrCreateRandom(SIGNING_SECRET_NAME, 32);
}).pipe(
  Effect.mapError(
    (cause) =>
      new ProjectSyncIoError({ message: "Failed to load the project sync signing key.", cause }),
  ),
);

/** The signing key, or `null` when it cannot be loaded — in which case no
    token can be considered valid. */
const loadSigningSecretOrNull = loadSigningSecret.pipe(
  Effect.tapError((cause) =>
    Effect.logError("Failed to load the project sync signing key.", { cause }),
  ),
  Effect.orElseSucceed(() => null),
);

export const issueProjectSyncExportUrl = Effect.fn("ProjectSyncTransfer.issueExportUrl")(
  function* (input: {
    readonly projectId: string;
    readonly workspaceRoot: string;
    readonly entries: ReadonlyArray<ProjectSyncExportEntry>;
  }) {
    const secret = yield* loadSigningSecret;
    const nowMs = yield* Clock.currentTimeMillis;

    const entries: Array<ProjectSyncExportEntry> = [];
    for (const entry of input.entries) {
      const resolved = resolveProjectSyncRelativePath({
        workspaceRoot: input.workspaceRoot,
        relativePath: entry.path,
      });
      if (resolved === null) {
        return yield* new ProjectSyncPathViolationError({ path: entry.path });
      }
      entries.push({ path: resolved.relativePath, size: entry.size });
    }

    sweepPendingExports(nowMs);
    const requestId = NodeCrypto.randomUUID();
    const expiresAt = nowMs + PROJECT_SYNC_URL_TTL_MS;
    pendingExports.set(requestId, { entries, expiresAt });

    const payload = base64UrlEncode(
      encodeExportClaims({
        version: 1,
        kind: "project-sync-export",
        requestId,
        projectId: input.projectId,
        workspaceRoot: input.workspaceRoot,
        expiresAt,
      }),
    );

    return {
      url: `${PROJECT_SYNC_EXPORT_ROUTE_PREFIX}/${payload}.${signPayload(payload, secret)}`,
      expiresAt,
    };
  },
);

export interface ResolvedProjectSyncExport {
  readonly claims: ProjectSyncExportClaims;
  readonly entries: ReadonlyArray<ProjectSyncExportEntry>;
}

export const resolveProjectSyncExportToken = Effect.fn("ProjectSyncTransfer.resolveExportToken")(
  function* (token: string) {
    const nowMs = yield* Clock.currentTimeMillis;
    const claims = verifySignedClaims({
      token,
      secret: yield* loadSigningSecretOrNull,
      nowMs,
      decode: decodeExportClaims,
    });
    if (!claims) return null;

    const pending = pendingExports.get(claims.requestId);
    if (!pending || pending.expiresAt <= nowMs) {
      pendingExports.delete(claims.requestId);
      return null;
    }

    return { claims, entries: pending.entries } satisfies ResolvedProjectSyncExport;
  },
);

export const issueProjectSyncImportUrl = Effect.fn("ProjectSyncTransfer.issueImportUrl")(
  function* (input: {
    readonly projectId: string;
    readonly workspaceRoot: string;
    readonly fileCount: number;
    readonly totalBytes: number;
  }) {
    const secret = yield* loadSigningSecret;
    const nowMs = yield* Clock.currentTimeMillis;
    const expiresAt = nowMs + PROJECT_SYNC_URL_TTL_MS;

    const payload = base64UrlEncode(
      encodeImportClaims({
        version: 1,
        kind: "project-sync-import",
        projectId: input.projectId,
        workspaceRoot: input.workspaceRoot,
        fileCount: input.fileCount,
        totalBytes: input.totalBytes,
        expiresAt,
      }),
    );

    return {
      url: `${PROJECT_SYNC_IMPORT_ROUTE_PREFIX}/${payload}.${signPayload(payload, secret)}`,
      expiresAt,
    };
  },
);

export const resolveProjectSyncImportToken = Effect.fn("ProjectSyncTransfer.resolveImportToken")(
  function* (token: string) {
    return verifySignedClaims({
      token,
      secret: yield* loadSigningSecretOrNull,
      nowMs: yield* Clock.currentTimeMillis,
      decode: decodeImportClaims,
    });
  },
);

const EMPTY_CONTENT = new Uint8Array(0);

/**
 * Streams the requested entries as framing records.
 *
 * The manifest the client diffed is a snapshot; by the time it asks for these
 * bytes an agent may have deleted or replaced any of them. Three things can
 * therefore make an entry drop out here, all of them silent because the next
 * sync reconciles them:
 *
 * - it vanished;
 * - one of its ancestors is a symlink, which would read outside the root;
 * - its size no longer matches the size the client signed a budget for.
 *
 * That last one is what keeps a growing file from failing the whole transfer:
 * the destination's token authorizes exactly the manifest's bytes, so emitting
 * the file's *current* larger size would blow the budget and 413 the batch.
 */
export async function* projectSyncExportRecords(input: {
  readonly workspaceRoot: string;
  readonly entries: ReadonlyArray<ProjectSyncExportEntry>;
  /** When set, the pending registration is released once the stream finishes,
      making the signed URL single-use. */
  readonly requestId?: string | undefined;
}): AsyncGenerator<ProjectSyncFrameRecord> {
  const { workspaceRoot, entries } = input;
  const ancestorCache = new ProjectSyncAncestorCache();

  for (const entry of entries) {
    const resolved = resolveProjectSyncRelativePath({ workspaceRoot, relativePath: entry.path });
    if (resolved === null) continue;

    if (
      !(await projectSyncAncestorsAreSafe({
        workspaceRoot,
        relativePath: resolved.relativePath,
        cache: ancestorCache,
      }))
    ) {
      continue;
    }

    let stats;
    try {
      stats = await NodeFSP.lstat(resolved.absolutePath);
    } catch (cause) {
      if (isMissingOrUnreadable(cause)) continue;
      throw cause;
    }

    if (stats.isSymbolicLink()) {
      const linkTarget = await NodeFSP.readlink(resolved.absolutePath).catch((cause: unknown) => {
        if (isMissingOrUnreadable(cause)) return null;
        throw cause;
      });
      if (linkTarget === null || linkTarget.length === 0) continue;
      yield {
        header: { path: resolved.relativePath, size: 0, kind: "symlink", linkTarget },
        content: EMPTY_CONTENT,
      };
      continue;
    }

    if (stats.isDirectory()) {
      yield {
        header: { path: resolved.relativePath, size: 0, kind: "dir" },
        content: EMPTY_CONTENT,
      };
      continue;
    }

    if (!stats.isFile()) continue;

    let handle;
    try {
      handle = await NodeFSP.open(resolved.absolutePath, "r");
    } catch (cause) {
      if (isMissingOrUnreadable(cause)) continue;
      throw cause;
    }

    try {
      const fileStats = await handle.stat();
      const size = fileStats.size;
      // The client signed a byte budget built from `entry.size`; a file that
      // changed size since then is a different file than the one this transfer
      // was authorized for, so it waits for the next sync.
      if (size !== entry.size) continue;
      yield {
        header: {
          path: resolved.relativePath,
          size,
          kind: "file",
          mode: fileStats.mode & 0o777,
        },
        content: size === 0 ? EMPTY_CONTENT : readHandle(handle, size),
      };
    } finally {
      await handle.close().catch(() => {});
    }
  }

  // Reached only when every entry has been streamed: the URL is single-use, and
  // an aborted transfer leaves the registration to expire so a retry of the
  // same token still works.
  if (input.requestId !== undefined) {
    pendingExports.delete(input.requestId);
  }
}

/** Reads at most `size` bytes so a file that grew since it was stat'd cannot
    desynchronize the frame it is being written into. */
async function* readHandle(handle: NodeFSP.FileHandle, size: number): AsyncGenerator<Uint8Array> {
  for await (const chunk of handle.createReadStream({
    autoClose: false,
    start: 0,
    end: size - 1,
  })) {
    yield chunk as Uint8Array;
  }
}
