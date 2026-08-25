#!/usr/bin/env node

import desktopPackage from "../apps/desktop/package.json" with { type: "json" };

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { resolveNightlyTargetVersion } from "./resolve-nightly-release.ts";

export class LocalDesktopBuildFailedError extends Schema.TaggedErrorClass<LocalDesktopBuildFailedError>()(
  "LocalDesktopBuildFailedError",
  { exitCode: Schema.Number },
) {
  override get message(): string {
    return `Local desktop build exited with code ${this.exitCode}.`;
  }
}

export function resolveLocalNightlyVersion(version: string, isoTimestamp: string): string {
  const baseVersion = Effect.runSync(resolveNightlyTargetVersion(version));
  const date = isoTimestamp.slice(0, 10).replaceAll("-", "");
  const runNumber = isoTimestamp.slice(11, 19).replaceAll(":", "");
  return `${baseVersion}-nightly.${date}.${runNumber}`;
}

export function resolveLocalDesktopBuildArgs(
  nightly: boolean,
  isoTimestamp: string,
): ReadonlyArray<string> {
  const args = [new URL("build-desktop-artifact.ts", import.meta.url).pathname];
  if (!nightly) return args;

  return [
    ...args,
    "--build-version",
    resolveLocalNightlyVersion(desktopPackage.version, isoTimestamp),
  ];
}

export const runLocalDesktopBuild = Effect.fn("runLocalDesktopBuild")(function* (nightly: boolean) {
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const workspaceRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
  const isoTimestamp = DateTime.formatIso(yield* DateTime.now);
  const updateRepository =
    process.env.T3CODE_DESKTOP_UPDATE_REPOSITORY ??
    process.env.GITHUB_REPOSITORY ??
    "pingdotgg/t3code";
  const child = yield* spawner.spawn(
    ChildProcess.make(process.execPath, resolveLocalDesktopBuildArgs(nightly, isoTimestamp), {
      cwd: workspaceRoot,
      env: { T3CODE_DESKTOP_UPDATE_REPOSITORY: updateRepository },
      extendEnv: true,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }),
  );
  const exitCode = Number(yield* child.exitCode);
  if (exitCode !== 0) {
    return yield* new LocalDesktopBuildFailedError({ exitCode });
  }
});

if (import.meta.main) {
  runLocalDesktopBuild(process.argv.slice(2).includes("--nightly")).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
