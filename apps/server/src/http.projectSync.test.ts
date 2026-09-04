// @effect-diagnostics nodeBuiltinImport:off
/**
 * Route-level tests for the project sync export/import HTTP pair.
 *
 * The transfer only works if the bytes one route writes are exactly the bytes
 * the other route reads, so these drive the real handlers over a real HTTP
 * server rather than calling the underlying functions directly.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  PROJECT_SYNC_EXPORT_ROUTE_PREFIX,
  PROJECT_SYNC_IMPORT_ROUTE_PREFIX,
} from "@t3tools/contracts";
import {
  encodeProjectSyncRecords,
  type ProjectSyncFrameRecord,
} from "@t3tools/shared/projectSyncFraming";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { HttpBody, HttpClient, HttpRouter } from "effect/unstable/http";

import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfig from "./config.ts";
import { projectSyncExportRouteLayer, projectSyncImportRouteLayer } from "./http.ts";
import { buildProjectSyncManifest } from "./workspace/ProjectSyncManifest.ts";
import {
  issueProjectSyncExportUrl,
  issueProjectSyncImportUrl,
} from "./workspace/ProjectSyncTransfer.ts";

const testLayer = ServerSecretStore.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-http-project-sync-" })),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeHttpServer.layerTest),
);

const serveProjectSyncRoutes = HttpRouter.serve(
  Layer.mergeAll(projectSyncExportRouteLayer, projectSyncImportRouteLayer),
  { disableListenLog: true, disableLogger: true },
).pipe(Layer.build, Effect.asVoid);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-http-project-sync-" });
});

const writeFile = (root: string, relativePath: string, contents: string) =>
  Effect.promise(async () => {
    const absolutePath = NodePath.join(root, relativePath);
    await NodeFSP.mkdir(NodePath.dirname(absolutePath), { recursive: true });
    await NodeFSP.writeFile(absolutePath, contents);
    return absolutePath;
  });

const encoder = new TextEncoder();

function fileRecord(path: string, contents: string): ProjectSyncFrameRecord {
  const content = encoder.encode(contents);
  return { header: { path, size: content.length, kind: "file" }, content };
}

async function encodeRecords(records: ReadonlyArray<ProjectSyncFrameRecord>): Promise<Uint8Array> {
  async function* iterate() {
    for (const record of records) yield record;
  }
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of encodeProjectSyncRecords(iterate())) {
    parts.push(chunk);
    total += chunk.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const exists = (root: string, relativePath: string) =>
  Effect.promise(() =>
    NodeFSP.lstat(NodePath.join(root, relativePath)).then(
      () => true,
      () => false,
    ),
  );

describe("project sync HTTP routes", () => {
  it.effect("streams an export and applies the identical bytes back through the import", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* serveProjectSyncRoutes;
        const client = yield* HttpClient.HttpClient;

        const origin = yield* makeTempDir;
        const destination = yield* makeTempDir;
        yield* writeFile(origin, "README.md", "# hello\n");
        yield* writeFile(origin, "src/nested/index.ts", "export const answer = 42;\n");
        const script = yield* writeFile(origin, "bin/run.sh", "#!/bin/sh\n");
        yield* Effect.promise(() => NodeFSP.chmod(script, 0o755));
        yield* Effect.promise(() => NodeFSP.mkdir(NodePath.join(origin, "empty")));
        yield* Effect.promise(() => NodeFSP.symlink("README.md", NodePath.join(origin, "link.md")));

        const manifest = yield* buildProjectSyncManifest({
          workspaceRoot: origin,
          includeGit: true,
        });
        const exportUrl = yield* issueProjectSyncExportUrl({
          projectId: "project-http-1",
          workspaceRoot: origin,
          entries: manifest.map((entry) => ({ path: entry.path, size: entry.size })),
        });

        const exportResponse = yield* client.get(exportUrl.url);
        expect(exportResponse.status).toBe(200);
        const body = new Uint8Array(yield* exportResponse.arrayBuffer);
        expect(body.length).toBeGreaterThan(0);

        // Exactly what the client signs for: file content bytes only, no framing.
        const totalBytes = manifest.reduce((total, entry) => total + entry.size, 0);
        const importUrl = yield* issueProjectSyncImportUrl({
          projectId: "project-http-2",
          workspaceRoot: destination,
          fileCount: manifest.length,
          totalBytes,
        });

        const importResponse = yield* client.post(importUrl.url, {
          body: HttpBody.uint8Array(body),
        });
        expect(importResponse.status).toBe(200);
        expect(yield* importResponse.json).toEqual({
          applied: manifest.length,
          bytes: totalBytes,
        });

        const destinationManifest = yield* buildProjectSyncManifest({
          workspaceRoot: destination,
          includeGit: true,
        });
        expect(destinationManifest).toEqual(manifest);
        expect(
          (yield* Effect.promise(() =>
            NodeFSP.lstat(NodePath.join(destination, "link.md")),
          )).isSymbolicLink(),
        ).toBe(true);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("404s an export URL that was already fetched", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // The registration is released the moment the stream completes, so a
        // leaked URL is worth one fetch rather than ten minutes of them. A
        // client that needs the bytes again just asks for a new URL.
        yield* serveProjectSyncRoutes;
        const client = yield* HttpClient.HttpClient;

        const origin = yield* makeTempDir;
        yield* writeFile(origin, "once.txt", "once\n");
        const exportUrl = yield* issueProjectSyncExportUrl({
          projectId: "project-http-single-use",
          workspaceRoot: origin,
          entries: [{ path: "once.txt", size: 5 }],
        });

        const first = yield* client.get(exportUrl.url);
        expect(first.status).toBe(200);
        expect(new Uint8Array(yield* first.arrayBuffer).length).toBeGreaterThan(0);

        expect((yield* client.get(exportUrl.url)).status).toBe(404);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("404s an export token that was never issued", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* serveProjectSyncRoutes;
        const client = yield* HttpClient.HttpClient;

        expect((yield* client.get(`${PROJECT_SYNC_EXPORT_ROUTE_PREFIX}/not-a-token`)).status).toBe(
          404,
        );
        expect(
          (yield* client.post(`${PROJECT_SYNC_IMPORT_ROUTE_PREFIX}/not-a-token`, {
            body: HttpBody.uint8Array(new Uint8Array(0)),
          })).status,
        ).toBe(404);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("400s an import whose record escapes the workspace mid-stream", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* serveProjectSyncRoutes;
        const client = yield* HttpClient.HttpClient;

        const destination = yield* makeTempDir;
        const outside = yield* makeTempDir;
        const body = yield* Effect.promise(() =>
          encodeRecords([
            fileRecord("safe.txt", "safe"),
            fileRecord("../planted.txt", "planted"),
            fileRecord("never.txt", "never"),
          ]),
        );

        const importUrl = yield* issueProjectSyncImportUrl({
          projectId: "project-http-3",
          workspaceRoot: destination,
          fileCount: 3,
          totalBytes: 1024,
        });
        const response = yield* client.post(importUrl.url, { body: HttpBody.uint8Array(body) });

        expect(response.status).toBe(400);
        // The valid record before the violation is allowed to land; what must
        // never happen is a write outside the workspace root, or the stream
        // continuing past the violation.
        expect(yield* exists(destination, "safe.txt")).toBe(true);
        expect(yield* exists(destination, "never.txt")).toBe(false);
        expect(yield* exists(outside, "planted.txt")).toBe(false);
        expect(
          yield* Effect.promise(() =>
            NodeFSP.lstat(NodePath.join(destination, "..", "planted.txt")).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("413s an import body that outgrows the budget its URL was signed for", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* serveProjectSyncRoutes;
        const client = yield* HttpClient.HttpClient;

        const destination = yield* makeTempDir;
        const body = yield* Effect.promise(() =>
          encodeRecords([
            fileRecord("first.txt", "0123456789"),
            fileRecord("second.txt", "0123456789"),
          ]),
        );

        const importUrl = yield* issueProjectSyncImportUrl({
          projectId: "project-http-4",
          workspaceRoot: destination,
          fileCount: 2,
          totalBytes: 10,
        });
        const response = yield* client.post(importUrl.url, { body: HttpBody.uint8Array(body) });

        expect(response.status).toBe(413);
        expect(yield* exists(destination, "first.txt")).toBe(true);
        expect(yield* exists(destination, "second.txt")).toBe(false);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("413s an import body carrying more entries than its URL was signed for", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* serveProjectSyncRoutes;
        const client = yield* HttpClient.HttpClient;

        // Zero-byte directory records cost nothing against the byte budget, so
        // only the record cap stands between a one-entry token and as many
        // inodes as the peer cares to send.
        const destination = yield* makeTempDir;
        const body = yield* Effect.promise(() =>
          encodeRecords(
            ["one", "two", "three"].map((path) => ({
              header: { path, size: 0, kind: "dir" as const },
              content: new Uint8Array(0),
            })),
          ),
        );

        const importUrl = yield* issueProjectSyncImportUrl({
          projectId: "project-http-6",
          workspaceRoot: destination,
          fileCount: 1,
          totalBytes: 1024,
        });
        const response = yield* client.post(importUrl.url, { body: HttpBody.uint8Array(body) });

        expect(response.status).toBe(413);
        expect(yield* exists(destination, "one")).toBe(true);
        expect(yield* exists(destination, "two")).toBe(false);
        expect(yield* exists(destination, "three")).toBe(false);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("refuses an import whose framing header lies about its size", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* serveProjectSyncRoutes;
        const client = yield* HttpClient.HttpClient;

        // A negative size would otherwise *credit* the byte budget, letting a
        // token signed for a kilobyte authorize an unbounded write.
        const destination = yield* makeTempDir;
        const headerBytes = encoder.encode(
          '{"path":"planted.txt","size":-10000000000,"kind":"file"}',
        );
        const body = new Uint8Array(4 + headerBytes.length);
        new DataView(body.buffer).setUint32(0, headerBytes.length, false);
        body.set(headerBytes, 4);

        const importUrl = yield* issueProjectSyncImportUrl({
          projectId: "project-http-7",
          workspaceRoot: destination,
          fileCount: 1,
          totalBytes: 1024,
        });
        const response = yield* client.post(importUrl.url, { body: HttpBody.uint8Array(body) });

        expect(response.status).toBe(500);
        expect(yield* exists(destination, "planted.txt")).toBe(false);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("500s an import whose framing header over-reports its content", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* serveProjectSyncRoutes;
        const client = yield* HttpClient.HttpClient;

        const destination = yield* makeTempDir;
        const truncated = (yield* Effect.promise(() =>
          encodeRecords([fileRecord("truncated.txt", "0123456789")]),
        )).slice(0, -4);

        const importUrl = yield* issueProjectSyncImportUrl({
          projectId: "project-http-5",
          workspaceRoot: destination,
          fileCount: 1,
          totalBytes: 10,
        });
        const response = yield* client.post(importUrl.url, {
          body: HttpBody.uint8Array(truncated),
        });

        expect(response.status).toBe(500);
        expect(yield* exists(destination, "truncated.txt")).toBe(false);
      }),
    ).pipe(Effect.provide(testLayer)),
  );
});
