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

describe("ProjectSyncTransfer", () => {
  it.effect("signs an export URL and resolves it back to its workspace and paths", () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* makeTempDir;
      const issued = yield* issueProjectSyncExportUrl({
        projectId: "project-1",
        workspaceRoot,
        paths: ["src/index.ts", "docs/readme.md"],
      });

      expect(issued.url.startsWith(`${PROJECT_SYNC_EXPORT_ROUTE_PREFIX}/`)).toBe(true);

      const resolved = yield* resolveProjectSyncExportToken(
        tokenOf(issued.url, PROJECT_SYNC_EXPORT_ROUTE_PREFIX),
      );
      expect(resolved?.claims.workspaceRoot).toBe(workspaceRoot);
      expect(resolved?.claims.projectId).toBe("project-1");
      expect(resolved?.paths).toEqual(["src/index.ts", "docs/readme.md"]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("refuses to sign an export URL for a path outside the workspace", () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* makeTempDir;
      const error = yield* Effect.flip(
        issueProjectSyncExportUrl({
          projectId: "project-1",
          workspaceRoot,
          paths: ["src/index.ts", "../../etc/passwd"],
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
        paths: ["a.txt"],
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
        paths: manifest.map((entry) => entry.path),
      });
      const resolved = yield* resolveProjectSyncExportToken(
        tokenOf(issued.url, PROJECT_SYNC_EXPORT_ROUTE_PREFIX),
      );
      expect(resolved).not.toBeNull();

      const applied = yield* applyProjectSyncRecords({
        workspaceRoot: destination,
        records: createProjectSyncFrameDecoder(
          encodeProjectSyncRecords(
            projectSyncExportRecords(resolved!.claims.workspaceRoot, resolved!.paths),
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
        paths: ["kept.txt", "vanishing.txt"],
      });
      yield* Effect.promise(() => NodeFSP.rm(NodePath.join(origin, "vanishing.txt")));

      const resolved = yield* resolveProjectSyncExportToken(
        tokenOf(issued.url, PROJECT_SYNC_EXPORT_ROUTE_PREFIX),
      );
      const applied = yield* applyProjectSyncRecords({
        workspaceRoot: destination,
        records: createProjectSyncFrameDecoder(
          encodeProjectSyncRecords(
            projectSyncExportRecords(resolved!.claims.workspaceRoot, resolved!.paths),
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
});
