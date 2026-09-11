#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { extractFile } from "@electron/asar";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { HostProcessPlatform, HostProcessArchitecture } from "@t3tools/shared/hostProcess";
import { resolveLocalNightlyVersion } from "./build-local-desktop.ts";
import { validatePackagedDirectory } from "./lib/packaged-directory.ts";
import desktopPackage from "../apps/desktop/package.json" with { type: "json" };

type Channel = "stable" | "nightly";
export interface Installation {
  path: string;
  channel: Channel;
  kind: "directory" | "appimage";
}
const root = NodeURL.fileURLToPath(new URL("..", import.meta.url));
const exec = NodeUtil.promisify(NodeChildProcess.execFile);
const log = (message: string) => process.stdout.write(`${message}\n`);

async function entries(directory: string) {
  return NodeFSP.readdir(directory, { withFileTypes: true }).catch(() => []);
}

export function desktopExecutable(contents: string): string | undefined {
  const command = /^Exec=(.+)$/m.exec(contents)?.[1]?.trim();
  const executable = command?.startsWith('"')
    ? /^"((?:\\.|[^"\\])+)"/.exec(command)?.[1]?.replace(/\\(["\\`$])/g, "$1")
    : command?.split(/\s/)[0];
  return executable && NodePath.isAbsolute(executable) ? executable : undefined;
}

export async function inspectInstallation(
  candidate: string,
  hint?: string,
): Promise<Installation | undefined> {
  const resolved = await NodeFSP.realpath(candidate).catch(() => undefined);
  if (!resolved) return;
  const stat = await NodeFSP.lstat(resolved);
  if (
    stat.isFile() &&
    /\.AppImage$/i.test(resolved) &&
    /t3[ -]?code/i.test(hint ?? NodePath.basename(resolved))
  ) {
    return {
      path: resolved,
      kind: "appimage",
      channel: /nightly/i.test(`${hint ?? ""} ${NodePath.basename(resolved)}`)
        ? "nightly"
        : "stable",
    };
  }
  const directory = stat.isDirectory() ? resolved : NodePath.dirname(resolved);
  const resources = directory.endsWith(".app")
    ? NodePath.join(directory, "Contents", "Resources")
    : NodePath.join(directory, "resources");
  try {
    const metadata: unknown = JSON.parse(
      extractFile(NodePath.join(resources, "app.asar"), "package.json").toString(),
    );
    if (
      !metadata ||
      typeof metadata !== "object" ||
      !("name" in metadata) ||
      metadata.name !== "t3code" ||
      !("version" in metadata) ||
      typeof metadata.version !== "string"
    )
      return;
    // Preview/PR builds are separate installations, never stable targets.
    if (metadata.version.includes("-") && !/-nightly\.\d{8}\.\d+$/.test(metadata.version)) return;
    return {
      path: directory,
      kind: "directory",
      channel: metadata.version.includes("-nightly.") ? "nightly" : "stable",
    };
  } catch {
    return;
  }
}

export async function discoverInstallations(
  platform = Effect.runSync(HostProcessPlatform),
): Promise<Installation[]> {
  const candidates = new Map<string, string | undefined>();
  const registered = new Set<string>();
  const home = NodeOS.homedir();
  const add = (value: string, hint?: string) => {
    candidates.set(value, hint);
  };
  if (platform === "linux") {
    const dataDirs = [
      process.env.XDG_DATA_HOME ?? NodePath.join(home, ".local/share"),
      ...(process.env.XDG_DATA_DIRS ?? "/usr/local/share:/usr/share").split(":"),
    ];
    await Promise.all(
      dataDirs.map(async (base) => {
        const directory = NodePath.join(base, "applications");
        await Promise.all(
          (await entries(directory))
            .filter((entry) => entry.name.endsWith(".desktop"))
            .map(async (entry) => {
              const contents = await NodeFSP.readFile(
                NodePath.join(directory, entry.name),
                "utf8",
              ).catch(() => "");
              const name = /^Name=(.+)$/m.exec(contents)?.[1];
              if (!name || !/t3[ -]?code/i.test(name)) return;
              const executable = desktopExecutable(contents);
              if (executable) {
                add(executable, name);
                registered.add(executable);
              }
            }),
        );
      }),
    );
    for (const base of [
      NodePath.join(home, ".local/opt"),
      NodePath.join(home, "Applications"),
      "/opt",
      "/usr/lib",
    ]) {
      for (const entry of await entries(base))
        if (/t3[ -]?code/i.test(entry.name)) add(NodePath.join(base, entry.name));
    }
    for (const base of (process.env.PATH ?? "").split(NodePath.delimiter).filter(Boolean)) {
      for (const name of ["t3code", "t3code-nightly"]) add(NodePath.join(base, name));
    }
  } else if (platform === "darwin") {
    for (const base of ["/Applications", NodePath.join(home, "Applications")]) {
      for (const entry of await entries(base))
        if (/t3.*\.app$/i.test(entry.name)) add(NodePath.join(base, entry.name));
    }
    const result = await exec("mdfind", ["kMDItemCFBundleIdentifier == 'com.t3tools.t3code'"], {
      timeout: 10000,
    }).catch(() => undefined);
    for (const candidate of result?.stdout.split("\n").filter(Boolean) ?? []) add(candidate);
  } else if (platform === "win32") {
    const registry = await exec(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ErrorActionPreference = 'SilentlyContinue'; Get-ItemProperty HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*, HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*, HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\* | Where-Object { $_.DisplayName -match '^T3 ?Code' } | ForEach-Object { if ($_.InstallLocation) { $_.InstallLocation } elseif ($_.DisplayIcon) { ($_.DisplayIcon -replace ',\\d+$','').Trim('\"') } }",
      ],
      { timeout: 10000 },
    ).catch(() => undefined);
    for (const candidate of registry?.stdout.split(/\r?\n/).filter(Boolean) ?? [])
      add(candidate.trim());
    for (const base of [
      process.env.LOCALAPPDATA && NodePath.join(process.env.LOCALAPPDATA, "Programs"),
      process.env.ProgramFiles,
      process.env["ProgramFiles(x86)"],
    ].filter((value): value is string => Boolean(value))) {
      for (const entry of await entries(base))
        if (/t3[ -]?code/i.test(entry.name)) add(NodePath.join(base, entry.name));
    }
  } else {
    throw new Error(`Unsupported desktop platform: ${platform}`);
  }
  const found = await Promise.all(
    [...candidates].map(async ([candidate, hint]) => ({
      installation: await inspectInstallation(candidate, hint),
      registered: registered.has(candidate),
    })),
  );
  // Desktop launchers identify the active copy; nearby backup directories do not.
  const registeredChannels = new Set(
    found.filter((item) => item.registered).map((item) => item.installation?.channel),
  );
  const installations = found
    .filter((item) => item.registered || !registeredChannels.has(item.installation?.channel))
    .map((item) => item.installation)
    .filter((item): item is Installation => Boolean(item));
  return [...new Map(installations.map((item) => [item.path, item])).values()];
}

export function selectInstallations(found: Installation[], channel: string) {
  const selected = found.filter((item) => channel === "all" || item.channel === channel);
  if (selected.length === 0)
    throw new Error(
      `No ${channel} desktop installation found. Use --install-path with an existing application directory, .app, or AppImage.`,
    );
  for (const current of ["stable", "nightly"]) {
    if (selected.filter((item) => item.channel === current).length > 1)
      throw new Error(
        `Multiple ${current} installations found. Select one with --install-path:\n${selected
          .filter((item) => item.channel === current)
          .map((item) => item.path)
          .join("\n")}`,
      );
  }
  for (const item of selected) {
    if (selected.some((other) => other !== item && item.path.startsWith(other.path + NodePath.sep)))
      throw new Error("Installation paths must not overlap.");
  }
  return selected;
}

async function run(command: string, args: string[]) {
  const resolved = await Effect.runPromise(
    resolveSpawnCommand(command, args).pipe(Effect.provide(NodeServices.layer)),
  );
  await new Promise<void>((resolve, reject) => {
    const child = NodeChildProcess.spawn(resolved.command, [...resolved.args], {
      cwd: root,
      shell: resolved.shell,
      stdio: "inherit",
      env: {
        ...process.env,
        T3CODE_DESKTOP_UPDATE_REPOSITORY:
          process.env.T3CODE_DESKTOP_UPDATE_REPOSITORY ?? "pingdotgg/t3code",
      },
    });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`${command} failed (${signal ?? code}).`)),
    );
  });
}

// The new payload is prepared on the destination filesystem. A failed promotion
// restores the original; a successful update retains its backup for manual rollback.
export async function replaceInstallation(
  source: string,
  destination: string,
  move = NodeFSP.rename,
) {
  const staging = await NodeFSP.mkdtemp(
    NodePath.join(NodePath.dirname(destination), ".t3code-update-"),
  );
  const payload = NodePath.join(staging, "new");
  const backup = NodePath.join(staging, "previous");
  let moved = false;
  try {
    await NodeFSP.cp(source, payload, {
      recursive: true,
      verbatimSymlinks: true,
      mode: NodeFS.constants.COPYFILE_FICLONE,
    });
    if ((await NodeFSP.stat(payload)).isDirectory()) {
      await validatePackagedDirectory(payload);
      if (destination.endsWith(".app")) {
        const framework = NodePath.join(
          payload,
          "Contents/Frameworks/Electron Framework.framework/Electron Framework",
        );
        const binary = await NodeFSP.stat(framework).catch(() => undefined);
        if (!binary?.isFile() || binary.size === 0) {
          throw new Error(`Packaged app is missing Electron Framework: ${framework}`);
        }
      }
    }
    await move(destination, backup);
    moved = true;
    try {
      await move(payload, destination);
    } catch (error) {
      try {
        await move(backup, destination);
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          `Update and automatic restore failed. Recover the original application from ${backup}.`,
          { cause: restoreError },
        );
      }
      moved = false;
      throw error;
    }
    return backup;
  } finally {
    if (!moved) await NodeFSP.rm(staging, { recursive: true, force: true });
  }
}

async function findPayload(directory: string, platform: NodeJS.Platform): Promise<string> {
  for (const entry of await entries(directory)) {
    if (!entry.isDirectory()) continue;
    const candidate = NodePath.join(directory, entry.name);
    if (platform === "darwin" && entry.name.endsWith(".app")) return candidate;
    if (platform !== "darwin" && (await inspectInstallation(candidate))) return candidate;
    if (/^(mac|linux|win)/.test(entry.name)) {
      const nested = await findPayload(candidate, platform).catch(() => undefined);
      if (nested) return nested;
    }
  }
  throw new Error(`No packaged application found in ${directory}.`);
}

export async function main(args: string[]) {
  const platform = Effect.runSync(HostProcessPlatform);
  const architecture = Effect.runSync(HostProcessArchitecture);
  const { values } = NodeUtil.parseArgs({
    args: args.filter((arg) => arg !== "--"),
    options: {
      channel: { type: "string", default: "stable" },
      "install-path": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "skip-build": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    log(
      "Build and replace an existing desktop installation from this checkout.\n--channel stable|nightly|all (default: stable; all updates detected channels)\n--install-path PATH   Resolve an unusual or ambiguous installation\n--dry-run             Show destinations without building or writing\n--skip-build          Reuse existing desktop/server/web dist files\nClose the desktop app before installing; no processes or services are stopped.",
    );
    return;
  }
  if (!["stable", "nightly", "all"].includes(values.channel))
    throw new Error("Invalid --channel; use stable, nightly, or all.");
  const explicit = values["install-path"]
    ? await inspectInstallation(NodePath.resolve(values["install-path"]))
    : undefined;
  if (values["install-path"] && !explicit)
    throw new Error("--install-path is not a recognized T3 Code desktop installation.");
  const selected = selectInstallations(
    explicit ? [explicit] : await discoverInstallations(),
    values.channel,
  );
  for (const item of selected) log(`[build:install] ${item.channel}: ${item.path} (${item.kind})`);
  if (values["dry-run"]) return;
  await Promise.all(
    selected.map((item) => NodeFSP.access(NodePath.dirname(item.path), NodeFS.constants.W_OK)),
  );
  if (!values["skip-build"]) await run("vp", ["run", "build:desktop"]);
  const workspace = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3code-build-install-"));
  try {
    const prepared: Array<{ source: string; destination: string }> = [];
    // Packaging currently brands shared dist files. Serialize channels until
    // that step operates only on the private packaging stage.
    for (const item of selected) {
      const output = NodePath.join(workspace, item.channel);
      const version =
        item.channel === "nightly"
          ? resolveLocalNightlyVersion(
              desktopPackage.version,
              DateTime.formatIso(Effect.runSync(DateTime.now)),
            )
          : desktopPackage.version;
      await run(process.execPath, [
        NodePath.join(root, "scripts/build-desktop-artifact.ts"),
        "--skip-build",
        "--platform",
        platform === "darwin" ? "mac" : platform === "win32" ? "win" : "linux",
        "--arch",
        architecture,
        "--target",
        item.kind === "appimage" ? "AppImage" : "dir",
        "--build-version",
        version,
        "--output-dir",
        output,
      ]);
      let source: string;
      if (item.kind === "appimage") {
        const images = (await entries(output)).filter((entry) => entry.name.endsWith(".AppImage"));
        if (images.length !== 1) throw new Error(`Expected one AppImage in ${output}.`);
        source = NodePath.join(output, images[0]!.name);
        await NodeFSP.chmod(source, 0o755);
      } else {
        source = await findPayload(output, platform);
        const built = await inspectInstallation(source);
        if (built?.channel !== item.channel)
          throw new Error(`Packaged channel does not match ${item.channel}.`);
        // Keep the NSIS uninstaller so Windows retains its uninstall entry.
        if (platform === "win32")
          for (const entry of await entries(item.path)) {
            if (entry.isFile() && /^Uninstall .*\.exe$/i.test(entry.name))
              await NodeFSP.copyFile(
                NodePath.join(item.path, entry.name),
                NodePath.join(source, entry.name),
              );
          }
      }
      prepared.push({ source, destination: item.path });
    }
    for (const item of prepared) {
      const backup = await replaceInstallation(item.source, item.destination);
      log(`[build:install] Updated ${item.destination}\nBackup: ${backup}`);
    }
    log("[build:install] Done. Reopen the desktop app to use the new build.");
  } finally {
    await NodeFSP.rm(workspace, { recursive: true, force: true });
  }
}

if (import.meta.main)
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
