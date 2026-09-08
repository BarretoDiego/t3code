// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeAssert from "node:assert/strict";
import { createPackage } from "@electron/asar";
import { afterEach, assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import {
  desktopExecutable,
  inspectInstallation,
  replaceInstallation,
  selectInstallations,
} from "./build-install-desktop.ts";

const temporary: string[] = [];
async function fixture() {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3code-install-test-"));
  temporary.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((directory) => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
});

it("reads quoted desktop executable paths without executing service wrappers", () => {
  assert.equal(
    desktopExecutable('[Desktop Entry]\nExec="/opt/T3 Code/t3code" %U'),
    "/opt/T3 Code/t3code",
  );
  assert.isUndefined(desktopExecutable("Exec=systemctl --user start t3code.service"));
});

it("uses packaged metadata to distinguish nightly, stable, preview and unrelated apps", async () => {
  const directory = await fixture();
  const source = NodePath.join(directory, "source");
  await NodeFSP.mkdir(source);
  for (const [index, name, version, channel] of [
    [0, "t3code", "0.0.40", "stable"],
    [1, "t3code", "0.0.41-nightly.20260908.1", "nightly"],
    [2, "t3code", "0.0.41-pr.123", undefined],
    [3, "unrelated", "0.0.40", undefined],
  ] as const) {
    const app = NodePath.join(directory, `app-${index}`);
    await NodeFSP.mkdir(NodePath.join(app, "resources"), { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(source, "package.json"),
      JSON.stringify({ name, version }),
    );
    await createPackage(source, NodePath.join(app, "resources/app.asar"));
    assert.equal((await inspectInstallation(app))?.channel, channel);
  }
});

it.effect("resolves symlinked AppImages without replacing the launcher symlink", () =>
  Effect.gen(function* () {
    if ((yield* HostProcessPlatform) === "win32") return;
    yield* Effect.promise(async () => {
      const directory = await fixture();
      const image = NodePath.join(directory, "T3-Code-nightly.AppImage");
      const launcher = NodePath.join(directory, "t3code");
      await NodeFSP.writeFile(image, "image");
      await NodeFSP.symlink(image, launcher);
      const found = await inspectInstallation(launcher, "T3 Code");
      assert.equal(found?.path, await NodeFSP.realpath(image));
      assert.equal(found?.channel, "nightly");
    });
  }),
);

it("refuses ambiguous destinations and missing channels", () => {
  const stable = {
    path: NodePath.resolve("/opt/t3"),
    channel: "stable",
    kind: "directory",
  } as const;
  const nightly = {
    path: NodePath.resolve("/opt/t3-nightly"),
    channel: "nightly",
    kind: "directory",
  } as const;
  assert.deepEqual(selectInstallations([stable, nightly], "stable"), [stable]);
  assert.deepEqual(selectInstallations([nightly], "all"), [nightly]);
  assert.throws(() => selectInstallations([nightly], "stable"), /No stable/);
  assert.throws(
    () => selectInstallations([stable, { ...stable, path: "/another/t3" }], "all"),
    /Multiple stable/,
  );
  assert.throws(
    () =>
      selectInstallations(
        [stable, { ...nightly, path: NodePath.join(stable.path, "nightly") }],
        "all",
      ),
    /overlap/,
  );
});

it("replaces a payload while preserving a recoverable backup", async () => {
  const directory = await fixture();
  const installed = NodePath.join(directory, "installed");
  const built = NodePath.join(directory, "built");
  await NodeFSP.mkdir(installed);
  await NodeFSP.mkdir(built);
  await NodeFSP.writeFile(NodePath.join(installed, "app"), "old");
  await NodeFSP.writeFile(NodePath.join(built, "app"), "new");
  const backup = await replaceInstallation(built, installed);
  assert.equal(await NodeFSP.readFile(NodePath.join(installed, "app"), "utf8"), "new");
  assert.equal(await NodeFSP.readFile(NodePath.join(backup, "app"), "utf8"), "old");
});

it("restores the installed app if promotion fails", async () => {
  const directory = await fixture();
  const installed = NodePath.join(directory, "installed");
  const built = NodePath.join(directory, "built");
  await NodeFSP.writeFile(installed, "old");
  await NodeFSP.writeFile(built, "new");
  await NodeAssert.rejects(
    replaceInstallation(built, installed, async (from, to) => {
      if (NodePath.basename(String(from)) === "new") throw new Error("promotion failed");
      await NodeFSP.rename(from, to);
    }),
    /promotion failed/,
  );
  assert.equal(await NodeFSP.readFile(installed, "utf8"), "old");
});

it("leaves the installed app intact when preparing the new payload fails", async () => {
  const directory = await fixture();
  const installed = NodePath.join(directory, "installed");
  await NodeFSP.writeFile(installed, "old");
  await NodeAssert.rejects(replaceInstallation(NodePath.join(directory, "missing"), installed));
  assert.equal(await NodeFSP.readFile(installed, "utf8"), "old");
});
