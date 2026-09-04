// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  PROJECT_SYNC_EXPORT_ROUTE_PREFIX,
  PROJECT_SYNC_IMPORT_ROUTE_PREFIX,
} from "@t3tools/contracts";
import {
  createProjectSyncFrameDecoder,
  encodeProjectSyncRecords,
} from "@t3tools/shared/projectSyncFraming";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { applyProjectSyncRecords } from "./ProjectSyncApply.ts";
import { buildProjectSyncManifest } from "./ProjectSyncManifest.ts";
import {
  issueProjectSyncExportUrl,
  issueProjectSyncImportUrl,
  projectSyncExportRecords,
  resolveProjectSyncExportToken,
  resolveProjectSyncImportToken,
} from "./ProjectSyncTransfer.ts";

const testLayer = ServerSecretStore.layer.pipe(
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-project-sync-transfer-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-project-sync-transfer-" });
});

const writeFile = (root: string, relativePath: string, contents: string) =>
  Effect.promise(async () => {
    const absolutePath = NodePath.join(root, relativePath);
    await NodeFSP.mkdir(NodePath.dirname(absolutePath), { recursive: true });
    await NodeFSP.writeFile(absolutePath, contents);
    return absolutePath;
  });

const tokenOf = (url: string, prefix: string) => url.slice(`${prefix}/`.length);

/** The `{ path, size }` pairs a client sends after diffing a manifest. */
const exportEntries = (entries: ReadonlyArray<{ readonly path: string; readonly size: number }>) =>
  entries.map((entry) => ({ path: entry.path, size: entry.size }));

const pathsOf = (records: ReadonlyArray<{ readonly header: { readonly path: string } }>) =>
  records.map((record) => record.header.path);

/** Drains an export stream through the real framing round trip. */
const collectExport = (input: {
  readonly workspaceRoot: string;
  readonly entries: ReadonlyArray<{ readonly path: string; readonly size: number }>;
  readonly requestId?: string;
}) =>
  Effect.promise(async () => {
    const collected: Array<{ header: { path: string }; content: string }> = [];
    const decoder = createProjectSyncFrameDecoder(
      encodeProjectSyncRecords(projectSyncExportRecords(input)),
    );
    for await (const record of decoder) {
      const parts: Uint8Array[] = [];
      for await (const chunk of record.content) parts.push(chunk);
      collected.push({
        header: record.header,
        content: parts.map((part) => new TextDecoder().decode(part)).join(""),
      });
    }
    return collected;
  });

describe("ProjectSyncTransfer", () => {
  it.effect("signs an export URL and resolves it back to its workspace and entries", () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* makeTempDir;
      const issued = yield* issueProjectSyncExportUrl({
        projectId: "project-1",
        workspaceRoot,
        entries: [
          { path: "src/index.ts", size: 12 },
          { path: "docs/readme.md", size: 34 },
        ],
      });

      expect(issued.url.startsWith(`${PROJECT_SYNC_EXPORT_ROUTE_PREFIX}/`)).toBe(true);

      const resolved = yield* resolveProjectSyncExportToken(
        tokenOf(issued.url, PROJECT_SYNC_EXPORT_ROUTE_PREFIX),
      );
      expect(resolved?.claims.workspaceRoot).toBe(workspaceRoot);
      expect(resolved?.claims.projectId).toBe("project-1");
      expect(resolved?.entries).toEqual([
        { path: "src/index.ts", size: 12 },
        { path: "docs/readme.md", size: 34 },
      ]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("refuses to sign an export URL for a path outside the workspace", () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* makeTempDir;
      const error = yield* Effect.flip(
        issueProjectSyncExportUrl({
          projectId: "project-1",
          workspaceRoot,
          entries: [
            { path: "src/index.ts", size: 0 },
            { path: "../../etc/passwd", size: 0 },
          ],
        }),
      );
      expect(error._tag).toBe("ProjectSyncPathViolationError");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects tampered, malformed, and expired export tokens", () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* makeTempDir;
      const issued = yield* issueProjectSyncExportUrl({
        projectId: "project-1",
        workspaceRoot,
        entries: [{ path: "a.txt", size: 0 }],
      });
      const token = tokenOf(issued.url, PROJECT_SYNC_EXPORT_ROUTE_PREFIX);
      const [payload, signature] = token.split(".");

      expect(yield* resolveProjectSyncExportToken(`${payload}x.${signature}`)).toBeNull();
      expect(yield* resolveProjectSyncExportToken(`${token}.extra`)).toBeNull();
      expect(yield* resolveProjectSyncExportToken("garbage")).toBeNull();

      yield* TestClock.adjust("11 minutes");
      expect(yield* resolveProjectSyncExportToken(token)).toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("signs an import URL carrying its workspace and byte budget", () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* makeTempDir;
      const issued = yield* issueProjectSyncImportUrl({
        projectId: "project-2",
        workspaceRoot,
        fileCount: 3,
        totalBytes: 4096,
      });

      expect(issued.url.startsWith(`${PROJECT_SYNC_IMPORT_ROUTE_PREFIX}/`)).toBe(true);
      const claims = yield* resolveProjectSyncImportToken(
        tokenOf(issued.url, PROJECT_SYNC_IMPORT_ROUTE_PREFIX),
      );
      expect(claims).toMatchObject({
        kind: "project-sync-import",
        projectId: "project-2",
        workspaceRoot,
        fileCount: 3,
        totalBytes: 4096,
      });

      yield* TestClock.adjust("11 minutes");
      expect(
        yield* resolveProjectSyncImportToken(tokenOf(issued.url, PROJECT_SYNC_IMPORT_ROUTE_PREFIX)),
      ).toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("exports and re-imports a workspace into an identical manifest", () =>
    Effect.gen(function* () {
      const origin = yield* makeTempDir;
      const destination = yield* makeTempDir;

      yield* writeFile(origin, "README.md", "# hello\n");
      yield* writeFile(origin, "src/nested/index.ts", "export const answer = 42;\n");
      const script = yield* writeFile(origin, "bin/run.sh", "#!/bin/sh\n");
      yield* Effect.promise(() => NodeFSP.chmod(script, 0o755));
      yield* Effect.promise(() =>
        NodeFSP.mkdir(NodePath.join(origin, "empty"), { recursive: true }),
      );
      yield* Effect.promise(() => NodeFSP.symlink("README.md", NodePath.join(origin, "link.md")));

      const manifest = yield* buildProjectSyncManifest({ workspaceRoot: origin, includeGit: true });
      const issued = yield* issueProjectSyncExportUrl({
        projectId: "project-3",
        workspaceRoot: origin,
        entries: exportEntries(manifest),
      });
      const resolved = yield* resolveProjectSyncExportToken(
        tokenOf(issued.url, PROJECT_SYNC_EXPORT_ROUTE_PREFIX),
      );
      expect(resolved).not.toBeNull();

      const applied = yield* applyProjectSyncRecords({
        workspaceRoot: destination,
        records: createProjectSyncFrameDecoder(
          encodeProjectSyncRecords(
            projectSyncExportRecords({
              workspaceRoot: resolved!.claims.workspaceRoot,
              entries: resolved!.entries,
            }),
          ),
        ),
      });

      expect(applied.applied).toBe(manifest.length);
      const destinationManifest = yield* buildProjectSyncManifest({
        workspaceRoot: destination,
        includeGit: true,
      });
      expect(destinationManifest).toEqual(manifest);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("skips entries that vanished between the manifest and the export", () =>
    Effect.gen(function* () {
      const origin = yield* makeTempDir;
      const destination = yield* makeTempDir;
      yield* writeFile(origin, "kept.txt", "kept");
      yield* writeFile(origin, "vanishing.txt", "gone");

      const issued = yield* issueProjectSyncExportUrl({
        projectId: "project-4",
        workspaceRoot: origin,
        entries: [
          { path: "kept.txt", size: 4 },
          { path: "vanishing.txt", size: 4 },
        ],
      });
      yield* Effect.promise(() => NodeFSP.rm(NodePath.join(origin, "vanishing.txt")));

      const resolved = yield* resolveProjectSyncExportToken(
        tokenOf(issued.url, PROJECT_SYNC_EXPORT_ROUTE_PREFIX),
      );
      const applied = yield* applyProjectSyncRecords({
        workspaceRoot: destination,
        records: createProjectSyncFrameDecoder(
          encodeProjectSyncRecords(
            projectSyncExportRecords({
              workspaceRoot: resolved!.claims.workspaceRoot,
              entries: resolved!.entries,
            }),
          ),
        ),
      });

      expect(applied.applied).toBe(1);
      expect(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(destination, "kept.txt"), "utf8"),
        ),
      ).toBe("kept");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("never exports through a symlinked ancestor", () =>
    Effect.gen(function* () {
      // The apply side refuses to *write* through a symlinked ancestor; without
      // the same check here a `link -> $HOME` planted in a workspace would let
      // a signed export URL *read* whatever lives under it.
      const origin = yield* makeTempDir;
      const outside = yield* makeTempDir;
      yield* writeFile(outside, ".ssh/id_rsa", "PRIVATE KEY");
      yield* writeFile(origin, "legit.txt", "legit");
      yield* Effect.promise(() => NodeFSP.symlink(outside, NodePath.join(origin, "link")));

      const records = yield* collectExport({
        workspaceRoot: origin,
        entries: [
          { path: "link/.ssh/id_rsa", size: 11 },
          { path: "legit.txt", size: 5 },
        ],
      });

      expect(pathsOf(records)).toEqual(["legit.txt"]);
      expect(records[0]!.content).toBe("legit");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("skips a file that changed size between the manifest and the fetch", () =>
    Effect.gen(function* () {
      // The destination's import token is signed for the manifest's byte total.
      // Emitting the file's new, larger size would blow that budget and 413 the
      // whole batch; the entry waits for the next sync instead.
      const origin = yield* makeTempDir;
      yield* writeFile(origin, "grows.txt", "small");
      yield* writeFile(origin, "shrinks.txt", "0123456789");
      yield* writeFile(origin, "steady.txt", "same");

      const entries = [
        { path: "grows.txt", size: 5 },
        { path: "shrinks.txt", size: 10 },
        { path: "steady.txt", size: 4 },
      ];
      yield* writeFile(origin, "grows.txt", "small plus a lot more");
      yield* writeFile(origin, "shrinks.txt", "0");

      const records = yield* collectExport({ workspaceRoot: origin, entries });

      expect(pathsOf(records)).toEqual(["steady.txt"]);
      expect(records[0]!.content).toBe("same");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("releases a pending export once its stream completes", () =>
    Effect.gen(function* () {
      const origin = yield* makeTempDir;
      yield* writeFile(origin, "a.txt", "aaaa");

      const issued = yield* issueProjectSyncExportUrl({
        projectId: "project-5",
        workspaceRoot: origin,
        entries: [{ path: "a.txt", size: 4 }],
      });
      const token = tokenOf(issued.url, PROJECT_SYNC_EXPORT_ROUTE_PREFIX);

      const resolved = yield* resolveProjectSyncExportToken(token);
      expect(resolved).not.toBeNull();

      // `requestId` is what makes the URL single-use, so it travels with the
      // stream exactly the way the HTTP route passes it.
      const records = yield* collectExport({
        workspaceRoot: resolved!.claims.workspaceRoot,
        entries: resolved!.entries,
        requestId: resolved!.claims.requestId,
      });
      expect(pathsOf(records)).toEqual(["a.txt"]);

      expect(yield* resolveProjectSyncExportToken(token)).toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps unexpired tokens alive while many URLs are issued", () =>
    Effect.gen(function* () {
      // The registry used to evict the oldest entry once 64 piled up, so a
      // burst of concurrent syncs could 404 a token that was still in flight.
      const workspaceRoot = yield* makeTempDir;
      const tokens: Array<string> = [];
      for (let index = 0; index < 200; index += 1) {
        const issued = yield* issueProjectSyncExportUrl({
          projectId: "project-6",
          workspaceRoot,
          entries: [{ path: `file-${index}.txt`, size: 0 }],
        });
        tokens.push(tokenOf(issued.url, PROJECT_SYNC_EXPORT_ROUTE_PREFIX));
      }

      const firstResolved = yield* resolveProjectSyncExportToken(tokens[0]!);
      expect(firstResolved?.entries).toEqual([{ path: "file-0.txt", size: 0 }]);
      expect(yield* resolveProjectSyncExportToken(tokens.at(-1)!)).not.toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );
});
