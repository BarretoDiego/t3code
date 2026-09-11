// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeAssert from "node:assert/strict";
import { createPackage } from "@electron/asar";
import { afterEach, assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import { copyRelocatableDirectory } from "./lib/packaged-directory.ts";
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

it.skipIf(!symlinksSupported)(
  "installs absolute framework links as a self-contained app after packaging cleanup",
  async () => {
    const directory = await fixture();
    const source = NodePath.join(directory, "stage");
    const output = NodePath.join(directory, "output");
    const installed = NodePath.join(directory, "T3 Code.app");
    const framework = "Contents/Frameworks/Electron Framework.framework";
    const version = NodePath.join(source, framework, "Versions/A");
    await NodeFSP.mkdir(version, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(version, "Electron Framework"), "binary");
    await NodeFSP.symlink(version, NodePath.join(source, framework, "Versions/Current"));
    await NodeFSP.symlink(
      NodePath.join(source, framework, "Versions/Current/Electron Framework"),
      NodePath.join(source, framework, "Electron Framework"),
    );
    await NodeFSP.mkdir(installed);
    await NodeFSP.writeFile(NodePath.join(installed, "old"), "old");
    await copyRelocatableDirectory(source, output);
    await NodeFSP.rm(source, { recursive: true });
    const backup = await replaceInstallation(output, installed);
    await NodeFSP.rm(output, { recursive: true });
    assert.equal(
      await NodeFSP.readFile(NodePath.join(installed, framework, "Electron Framework"), "utf8"),
      "binary",
    );
    assert.equal(await NodeFSP.readFile(NodePath.join(backup, "old"), "utf8"), "old");
  },
);

it.skipIf(!symlinksSupported)(
  "refuses absolute, broken and escaping links before moving the installed app",
  async () => {
    const directory = await fixture();
    const installed = NodePath.join(directory, "installed");
    const source = NodePath.join(directory, "source");
    await NodeFSP.mkdir(source);
    await NodeFSP.writeFile(installed, "old");
    await NodeFSP.writeFile(NodePath.join(source, "binary"), "new");
    const link = NodePath.join(source, "link");
    for (const target of [NodePath.join(source, "binary"), "missing", "../installed", "link"]) {
      await NodeFSP.symlink(target, link);
      await NodeAssert.rejects(replaceInstallation(source, installed), /Packaged symlink/);
      assert.equal(await NodeFSP.readFile(installed, "utf8"), "old");
      await NodeFSP.unlink(link);
    }
  },
);

it("refuses a macOS bundle with no Electron binary before replacing the app", async () => {
  const directory = await fixture();
  const installed = NodePath.join(directory, "T3 Code.app");
  const source = NodePath.join(directory, "source");
  await NodeFSP.mkdir(source);
  await NodeFSP.writeFile(installed, "old");
  await NodeAssert.rejects(replaceInstallation(source, installed), /missing Electron Framework/);
  assert.equal(await NodeFSP.readFile(installed, "utf8"), "old");
});

it.skipIf(!symlinksSupported)("rejects packaging links to files outside the artifact", async () => {
  const directory = await fixture();
  const source = NodePath.join(directory, "source");
  await NodeFSP.mkdir(source);
  const external = NodePath.join(directory, "external");
  await NodeFSP.writeFile(external, "outside");
  await NodeFSP.symlink(external, NodePath.join(source, "link"));
  await NodeAssert.rejects(
    copyRelocatableDirectory(source, NodePath.join(directory, "output")),
    /leaves the source/,
  );
});
