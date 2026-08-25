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
  ProjectSyncIoError,
  ProjectSyncPathViolationError,
} from "@t3tools/contracts";
import type { ProjectSyncFrameRecord } from "@t3tools/shared/projectSyncFraming";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
} from "../auth/utils.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { isMissingOrUnreadable } from "./projectSyncErrno.ts";
import { resolveProjectSyncRelativePath } from "./ProjectSyncApply.ts";

/** Shared with asset download and attachment upload tokens; the signed `kind`
    is what keeps a token from being replayed against another route. */
const SIGNING_SECRET_NAME = "asset-access-signing-key";

/** A pending export holds its whole path list in memory, so the registry is
    bounded on both ends: entries expire with their URL, and the oldest is
    evicted once too many pile up. */
const MAX_PENDING_EXPORTS = 64;

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
  readonly paths: ReadonlyArray<string>;
  readonly expiresAt: number;
}

const pendingExports = new Map<string, PendingExport>();

function sweepPendingExports(nowMs: number): void {
  for (const [requestId, pending] of pendingExports) {
    if (pending.expiresAt <= nowMs) pendingExports.delete(requestId);
  }
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

function splitToken(token: string): { payload: string; signature: string } | null {
  const [payload, signature, unexpected] = token.split(".");
  if (!payload || !signature || unexpected) return null;
  return { payload, signature };
}

const verifyToken = Effect.fn("ProjectSyncTransfer.verifyToken")(function* (token: string) {
  const parts = splitToken(token);
  if (!parts) return null;

  const secret = yield* loadSigningSecret.pipe(
    Effect.tapError((cause) =>
      Effect.logError("Failed to load the project sync signing key.", { cause }),
    ),
    Effect.orElseSucceed(() => null),
  );
  if (!secret || !timingSafeEqualBase64Url(parts.signature, signPayload(parts.payload, secret))) {
    return null;
  }
  return parts.payload;
});

function decodeClaimsPayload<A>(
  payload: string,
  decode: (input: unknown) => Option.Option<A>,
): A | null {
  try {
    return Option.getOrNull(decode(base64UrlDecodeUtf8(payload)));
  } catch {
    return null;
  }
}

export const issueProjectSyncExportUrl = Effect.fn("ProjectSyncTransfer.issueExportUrl")(
  function* (input: {
    readonly projectId: string;
    readonly workspaceRoot: string;
    readonly paths: ReadonlyArray<string>;
  }) {
    const secret = yield* loadSigningSecret;
    const nowMs = yield* Clock.currentTimeMillis;

    const paths: Array<string> = [];
    for (const relativePath of input.paths) {
      const resolved = resolveProjectSyncRelativePath({
        workspaceRoot: input.workspaceRoot,
        relativePath,
      });
      if (resolved === null) {
        return yield* new ProjectSyncPathViolationError({ path: relativePath });
      }
      paths.push(resolved.relativePath);
    }

    sweepPendingExports(nowMs);
    const requestId = NodeCrypto.randomUUID();
    const expiresAt = nowMs + PROJECT_SYNC_URL_TTL_MS;
    pendingExports.set(requestId, { paths, expiresAt });

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
  readonly paths: ReadonlyArray<string>;
}

export const resolveProjectSyncExportToken = Effect.fn("ProjectSyncTransfer.resolveExportToken")(
  function* (token: string) {
    const payload = yield* verifyToken(token);
    if (!payload) return null;

    const claims = decodeClaimsPayload(payload, decodeExportClaims);
    const nowMs = yield* Clock.currentTimeMillis;
    if (!claims || claims.expiresAt <= nowMs) return null;

    const pending = pendingExports.get(claims.requestId);
    if (!pending || pending.expiresAt <= nowMs) {
      pendingExports.delete(claims.requestId);
      return null;
    }

    return { claims, paths: pending.paths } satisfies ResolvedProjectSyncExport;
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
    const payload = yield* verifyToken(token);
    if (!payload) return null;

    const claims = decodeClaimsPayload(payload, decodeImportClaims);
    if (!claims || claims.expiresAt <= (yield* Clock.currentTimeMillis)) return null;
    return claims;
  },
);

const EMPTY_CONTENT = new Uint8Array(0);

/**
 * Streams the requested entries as framing records.
 *
 * The manifest the client diffed is a snapshot; by the time it asks for these
 * bytes an agent may have deleted or replaced any of them. A vanished entry is
 * skipped rather than failing the transfer — the next sync reconciles it — but
 * a file's size is taken from the handle we are about to read so the declared
 * frame length and the bytes we emit come from the same open file.
 */
export async function* projectSyncExportRecords(
  workspaceRoot: string,
  paths: ReadonlyArray<string>,
): AsyncGenerator<ProjectSyncFrameRecord> {
  for (const relativePath of paths) {
    const resolved = resolveProjectSyncRelativePath({ workspaceRoot, relativePath });
    if (resolved === null) continue;

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
