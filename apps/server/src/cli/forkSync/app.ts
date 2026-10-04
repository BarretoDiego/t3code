// @effect-diagnostics nodeBuiltinImport:off - inspects processes and replaces the installed app on disk.
/**
 * Builds the desktop app from the sync worktree and swaps it in for the
 * installed one: stop the running app, keep the old version beside the new
 * one, and reopen it. macOS installs a bundle from the `.dmg`; Linux extracts
 * the AppImage.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";

import { commandExists, exec, gitText, localDate, raiseAlert, type Run } from "./runtime.ts";
import { detectPackageManager, installArguments } from "./sync.ts";

const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister";

/** The newest file in `dir` with this extension, by modification time. */
function newestArtifact(dir: string, extension: string): string | null {
  try {
    return (
      NodeFS.readdirSync(dir)
        .filter((name) => name.endsWith(extension))
        .map((name) => NodePath.join(dir, name))
        .toSorted(
          (left, right) => NodeFS.statSync(right).mtimeMs - NodeFS.statSync(left).mtimeMs,
        )[0] ?? null
    );
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The running app

/**
 * Which bundle is "the app" on this Mac. Without a fixed path the channel
 * decides, so a nightly build never closes or overwrites a stable install
 * that sits beside it.
 */
function installedBundle(run: Run, installed?: string): string | null {
  const { config } = run;
  if (installed !== undefined) return installed;
  if (config.appBundle !== "") return config.appBundle;
  const candidate = NodePath.join(
    config.appDir,
    config.nightlyVersion ? "T3 Code (Nightly).app" : "T3 Code.app",
  );
  if (NodeFS.existsSync(candidate)) return candidate;
  try {
    const other = NodeFS.readdirSync(config.appDir).find(
      (name) => name.startsWith("T3 Code") && name.endsWith(".app"),
    );
    return other === undefined ? null : NodePath.join(config.appDir, other);
  } catch {
    return null;
  }
}

export interface AppProcess {
  readonly pid: number;
  readonly ppid: number;
}

/**
 * The app's processes in `ps -axo pid=,ppid=,command=` output. The comparison
 * is a literal prefix: the nightly bundle's path contains parentheses, which a
 * pattern match reads as a group and then never finds the app. `self` is left
 * out, because this CLI may be running from the very bundle it replaces.
 */
export function appProcesses(psOutput: string, prefix: string, self: number): Array<AppProcess> {
  return psOutput.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match === null) return [];
    const [, pid, ppid, command = ""] = match;
    return command.startsWith(prefix) && Number(pid) !== self
      ? [{ pid: Number(pid), ppid: Number(ppid) }]
      : [];
  });
}

/**
 * The app's main process. The app starts its server from the same executable,
 * so the main one is the process whose parent is not itself part of the app.
 */
export function mainProcess(processes: ReadonlyArray<AppProcess>): number | null {
  const pids = new Set(processes.map((entry) => entry.pid));
  return processes.find((entry) => !pids.has(entry.ppid))?.pid ?? null;
}

const processTable = (run: Run, installed?: string) =>
  Effect.gen(function* () {
    const location =
      run.config.platform === "macos" ? installedBundle(run, installed) : run.config.appOptDir;
    if (location === null) return [];
    const ps = yield* exec({ command: "ps", args: ["-axo", "pid=,ppid=,command="] });
    return appProcesses(ps.stdout, `${location}/`, process.pid);
  });

/** Signals a process this module found in the app's own process table. */
const signal = (pid: number, name: NodeJS.Signals) =>
  Effect.sync(() => {
    try {
      process.kill(pid, name);
    } catch {
      // It exited on its own in the meantime.
    }
  });

/**
 * Closes the app and waits for every one of its processes to go, not just the
 * main one. The server child outlives the parent's TERM; while it lives, the
 * new version starts, finds the single instance taken, and exits silently.
 */
const stopApp = (run: Run) =>
  Effect.gen(function* () {
    const main = mainProcess(yield* processTable(run));
    if (main === null) {
      run.outcome.appWasRunning = false;
      return yield* run.info("the app was not open");
    }
    run.outcome.appWasRunning = true;
    yield* run.info(`closing the app (pid ${main})`);
    yield* signal(main, "SIGTERM");
    for (let second = 0; second < 40; second += 1) {
      yield* Effect.sleep("1 second");
      if ((yield* processTable(run)).length === 0) {
        yield* run.info("app closed");
        // Launch Services still holds the old instance for a moment; opening
        // inside that window is a request that gets swallowed.
        if (run.config.platform === "macos") yield* Effect.sleep("2 seconds");
        return;
      }
    }
    yield* run.warn("the app did not close in 40s; forcing it");
    for (const entry of yield* processTable(run)) yield* signal(entry.pid, "SIGKILL");
    yield* Effect.sleep("2 seconds");
  });

/** Waits for the app to show up in the process table: `open` returns before it does. */
const waitForApp = (run: Run, seconds: number, installed?: string) =>
  Effect.gen(function* () {
    for (let second = 0; second < seconds; second += 1) {
      const main = mainProcess(yield* processTable(run, installed));
      if (main !== null) {
        yield* run.info(`app open (pid ${main})`);
        return true;
      }
      yield* Effect.sleep("1 second");
    }
    return false;
  });

const startAppMacos = (run: Run, bundle: string) =>
  Effect.gen(function* () {
    // `open` exits 0 without guaranteeing anything, so each attempt is checked
    // against the process table.
    yield* run.info("opening the app");
    for (const args of [
      ["-a", bundle],
      ["-n", "-a", bundle],
    ]) {
      const opened = yield* exec({ command: "open", args });
      if (opened.code !== 0) yield* run.warn(`open failed: ${opened.stderr.trim() || "no output"}`);
      if (yield* waitForApp(run, 20, bundle)) return;
      yield* run.warn("the app did not start in 20s");
    }
    // Last resort: run the bundle's binary without going through Launch Services.
    const executable = (yield* exec({
      command: "defaults",
      args: ["read", `${bundle}/Contents/Info`, "CFBundleExecutable"],
    })).stdout.trim();
    if (executable !== "") {
      const binary = `${bundle}/Contents/MacOS/${executable}`;
      yield* run.warn(`starting the binary directly: ${binary}`);
      yield* exec({
        command: "sh",
        args: ["-c", 'nohup "$1" >/dev/null 2>&1 </dev/null &', "sh", binary],
      });
      if (yield* waitForApp(run, 20, bundle)) return;
    }
    yield* run.error(`could not reopen the app; open it by hand: open -a "${bundle}"`);
    yield* raiseAlert(
      run,
      "t3 fork: app did not reopen",
      "The new version is installed, but the app has to be opened by hand.",
    );
  });

const startAppLinux = (run: Run) =>
  Effect.gen(function* () {
    const { appLauncher } = run.config;
    // A scheduler's environment may lack the graphical session; ask the manager for it.
    const environment = { ...process.env };
    if (!environment.DISPLAY && !environment.WAYLAND_DISPLAY) {
      const shown = yield* exec({ command: "systemctl", args: ["--user", "show-environment"] });
      for (const line of shown.stdout.split("\n")) {
        const [key, ...rest] = line.split("=");
        if (
          key !== undefined &&
          [
            "DISPLAY",
            "WAYLAND_DISPLAY",
            "XAUTHORITY",
            "XDG_RUNTIME_DIR",
            "DBUS_SESSION_BUS_ADDRESS",
          ].includes(key)
        ) {
          environment[key] = rest.join("=");
        }
      }
    }
    if (!environment.DISPLAY && !environment.WAYLAND_DISPLAY) {
      return yield* run.warn("no graphical session available; the app is installed but not opened");
    }
    yield* run.info("opening the app");
    // A transient unit gives the app a life of its own: started as a child, it
    // would die with the cgroup of whatever ran this command.
    const started = yield* exec({
      command: "systemd-run",
      args: ["--user", "--collect", "--quiet", `--unit=t3code-app-${process.pid}`, appLauncher],
      env: environment,
    });
    if (started.code === 0) return yield* run.info("app opened in a transient unit");
    yield* run.warn("systemd-run is unavailable; the app may not outlive this command");
    yield* exec({
      command: "sh",
      args: ["-c", 'setsid nohup "$1" >/dev/null 2>&1 </dev/null &', "sh", appLauncher],
      env: environment,
    });
  });

// ---------------------------------------------------------------------------
// Build

/**
 * The nightly stamp, in upstream's `X.Y.Z-nightly.YYYYMMDD.N` convention.
 * Without it the artifact carries the raw package version, cannot be told from
 * the stable build, and picks the stable channel's icons and label.
 */
export function nightlyVersion(packageVersion: string, date: string, commitCount: number): string {
  const [major = "0", minor = "0", patch = "0"] = packageVersion.split(".");
  return `${major}.${minor}.${(Number.parseInt(patch, 10) || 0) + 1}-nightly.${date}.${commitCount}`;
}

/** The desktop package's version, which is the one the artifact is named after. */
function desktopVersion(worktree: string): string {
  try {
    const manifest = JSON.parse(
      NodeFS.readFileSync(NodePath.join(worktree, "apps/desktop/package.json"), "utf8"),
    ) as { readonly version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Says which build tools are missing, before a build spends a minute finding out. */
const missingPrerequisites = (run: Run, packageManager: string) =>
  Effect.gen(function* () {
    const missing: Array<string> = [];
    for (const [command, hint] of [
      ["node", "node"],
      [packageManager, `${packageManager} (the repository's package manager)`],
      ["cargo", "cargo (compiles the resource monitor)"],
    ] as const) {
      if (!(yield* commandExists(command))) missing.push(hint);
    }
    if (run.config.platform === "macos") {
      if ((yield* exec({ command: "xcode-select", args: ["-p"] })).code !== 0) {
        missing.push("Command Line Tools (xcode-select --install)");
      }
    } else if (!(yield* commandExists("magick")) && !(yield* commandExists("convert"))) {
      missing.push("ImageMagick (resizes the AppImage icons)");
    }
    return missing;
  });

/**
 * Builds the desktop artifact from the sync worktree, never from the
 * developer's checkout, so the result is exactly the commit that was merged.
 * Returns the artifact's path, or null with `outcome.build` saying why not.
 */
export const buildApp = (run: Run) =>
  Effect.gen(function* () {
    const { config, outcome } = run;
    const { worktree } = config;
    if (!NodeFS.existsSync(worktree)) {
      outcome.build = "skipped-no-worktree";
      yield* run.warn(`worktree ${worktree} is missing; build skipped`);
      return null;
    }
    const head = yield* gitText(worktree, ["rev-parse", "--short", "HEAD"]);
    yield* run.info(`building from ${worktree} (${head})`);

    yield* run.step("build prerequisites");
    const packageManager = detectPackageManager(worktree);
    const missing = yield* missingPrerequisites(run, packageManager);
    if (missing.length > 0) {
      for (const item of missing) yield* run.error(`  missing: ${item}`);
      outcome.build = "prereq-missing";
      yield* raiseAlert(
        run,
        "t3 fork: build did not run",
        "Build tools are missing. See: t3 fork status",
      );
      return null;
    }

    yield* run.step("worktree dependencies");
    const hadDependencies = NodeFS.existsSync(NodePath.join(worktree, "node_modules"));
    const installed = yield* exec({
      command: packageManager,
      args: installArguments(packageManager),
      cwd: worktree,
      ...(hadDependencies ? {} : { echo: run }),
    });
    if (installed.code !== 0) {
      if (!hadDependencies) {
        outcome.build = "deps-failed";
        yield* run.error(`${packageManager} install failed`);
        return null;
      }
      yield* run.warn(`${packageManager} install failed; building with what is already installed`);
    }

    yield* run.step("desktop app build");
    const stamp = config.nightlyVersion
      ? nightlyVersion(
          desktopVersion(worktree),
          localDate(),
          Number(yield* gitText(worktree, ["rev-list", "--count", "HEAD"])) || 0,
        )
      : "";
    if (stamp !== "") yield* run.info(`stamping the build as ${stamp}`);
    yield* run.info(`command: ${config.buildCommand}  (this takes several minutes)`);
    // The version goes in through the environment: an argument after `--`
    // reaches the build script as a positional and is rejected.
    const built = yield* exec({
      command: config.buildCommand,
      args: [],
      shell: true,
      cwd: worktree,
      env: { ...process.env, T3CODE_DESKTOP_VERSION: stamp },
      timeoutSeconds: config.buildTimeoutSeconds,
      echo: run,
    });
    if (built.code !== 0) {
      outcome.build = "build-failed";
      yield* run.error(`the app build failed (exit ${built.code})`);
      yield* raiseAlert(
        run,
        "t3 fork: build failed",
        "The branch is synced, but no artifact was produced.",
      );
      return null;
    }

    const artifact = newestArtifact(
      NodePath.join(worktree, "release"),
      config.platform === "macos" ? ".dmg" : ".AppImage",
    );
    if (artifact === null) {
      outcome.build = "artifact-missing";
      yield* run.error(`no artifact found in ${worktree}/release`);
      return null;
    }
    outcome.appVersion = NodePath.basename(artifact);
    outcome.build = "built-not-installed";
    yield* run.info(`artifact: ${outcome.appVersion}`);
    return artifact;
  });

// ---------------------------------------------------------------------------
// Install

const installMacos = (run: Run, dmg: string) =>
  Effect.gen(function* () {
    const { config, outcome } = run;
    const mount = NodeFS.mkdtempSync(NodePath.join(config.baseDir, ".mount-"));
    const unmount = Effect.gen(function* () {
      const detached = yield* exec({ command: "hdiutil", args: ["detach", "-quiet", mount] });
      if (detached.code !== 0) {
        yield* exec({ command: "hdiutil", args: ["detach", "-force", "-quiet", mount] });
      }
      NodeFS.rmSync(mount, { recursive: true, force: true });
    });
    const attached = yield* exec({
      command: "hdiutil",
      args: ["attach", "-nobrowse", "-noautoopen", "-quiet", "-mountpoint", mount, dmg],
    });
    if (attached.code !== 0) {
      NodeFS.rmSync(mount, { recursive: true, force: true });
      outcome.build = "mount-failed";
      return yield* run.error(`could not mount ${dmg}`);
    }
    const bundleName = NodeFS.readdirSync(mount).find((name) => name.endsWith(".app"));
    if (bundleName === undefined) {
      yield* unmount;
      outcome.build = "artifact-invalid";
      return yield* run.error("the .dmg has no .app in it");
    }
    // The destination takes the name inside the .dmg, so the build's channel
    // decides where it installs unless a path is fixed.
    const destination = config.appBundle || NodePath.join(config.appDir, bundleName);
    yield* run.info(`destination: ${destination}`);

    yield* stopApp(run);

    const backup = `${destination}.anterior`;
    NodeFS.rmSync(backup, { recursive: true, force: true });
    if (NodeFS.existsSync(destination)) {
      NodeFS.renameSync(destination, backup);
      yield* run.info(`previous version kept at ${backup}`);
    }
    // ditto, not a plain copy: it keeps the bundle's internal links and
    // extended attributes, without which the app may not open.
    const copied = yield* exec({
      command: "ditto",
      args: [NodePath.join(mount, bundleName), destination],
    });
    if (copied.code !== 0) {
      yield* run.error(`could not copy the bundle to ${destination}`);
      NodeFS.rmSync(destination, { recursive: true, force: true });
      if (NodeFS.existsSync(backup)) {
        NodeFS.renameSync(backup, destination);
        yield* run.warn("previous version restored");
      }
      yield* unmount;
      outcome.build = "install-failed";
      // The app was closed for nothing; bring the old version back up.
      if (outcome.appWasRunning) yield* startAppMacos(run, destination);
      return;
    }
    yield* unmount;

    // A bundle taken from a .dmg can inherit quarantine, and then macOS asks
    // for confirmation every time a build made here is opened.
    yield* exec({ command: "xattr", args: ["-dr", "com.apple.quarantine", destination] });
    // Without re-registering, Spotlight and the Dock keep opening the old bundle.
    if (NodeFS.existsSync(LSREGISTER))
      yield* exec({ command: LSREGISTER, args: ["-f", destination] });

    outcome.build = "installed";
    yield* run.info(`installed: ${destination} (${outcome.appVersion})`);
    if (outcome.appWasRunning || config.alwaysOpenApp)
      return yield* startAppMacos(run, destination);
    yield* run.info("the app was not open, so it is not opened now");
  });

/** The icon from the extracted app's icon theme, at the largest size it ships. */
function largestShippedIcon(appOptDir: string): string | null {
  try {
    const root = NodePath.join(appOptDir, "usr/share/icons");
    return (
      NodeFS.readdirSync(root, { recursive: true, encoding: "utf8" })
        .filter((name) => name.endsWith(".png"))
        .map((name) => NodePath.join(root, name))
        .toSorted()
        .at(-1) ?? null
    );
  } catch {
    return null;
  }
}

/** Keeps the app in the applications list and the dock after each version swap. */
const refreshDesktopEntry = (run: Run) =>
  Effect.gen(function* () {
    const { appOptDir, appLauncher } = run.config;
    const share = NodePath.join(NodeOS.homedir(), ".local/share");
    const applications = NodePath.join(share, "applications");
    const icons = NodePath.join(share, "icons/hicolor/512x512/apps");
    NodeFS.mkdirSync(applications, { recursive: true });
    NodeFS.mkdirSync(icons, { recursive: true });

    const entries = NodeFS.readdirSync(appOptDir);
    const rootIcon = entries.find((name) => name.endsWith(".png"));
    const icon =
      rootIcon === undefined ? largestShippedIcon(appOptDir) : NodePath.join(appOptDir, rootIcon);
    if (icon === null) {
      yield* run.warn("the new bundle has no icon; keeping the previous one");
    } else {
      NodeFS.copyFileSync(icon, NodePath.join(icons, "t3code.png"));
    }
    const shipped = entries.find((name) => name.endsWith(".desktop"));
    const name =
      (shipped === undefined
        ? undefined
        : /^Name=(.+)$/m.exec(
            NodeFS.readFileSync(NodePath.join(appOptDir, shipped), "utf8"),
          )?.[1]) ?? "T3 Code";
    // The file name never changes, or the favorite pinned to the dock is lost.
    NodeFS.writeFileSync(
      NodePath.join(applications, "t3code.desktop"),
      [
        "[Desktop Entry]",
        `Name=${name}`,
        "Comment=GUI for coding agents",
        `Exec=${appLauncher} %U`,
        "Icon=t3code",
        "Terminal=false",
        "Type=Application",
        "StartupWMClass=t3code",
        "MimeType=x-scheme-handler/t3code;x-scheme-handler/t3code-dev;",
        "Categories=Development;",
        `X-T3Code-Version=${run.outcome.appVersion || "unknown"}`,
        "",
      ].join("\n"),
    );
    yield* exec({ command: "update-desktop-database", args: [applications] });
    yield* exec({
      command: "gtk-update-icon-cache",
      args: ["-f", "-t", NodePath.join(share, "icons/hicolor")],
    });
    yield* run.info(`application entry updated: ${name}`);
  });

const installLinux = (run: Run, appImage: string) =>
  Effect.gen(function* () {
    const { config, outcome } = run;
    const { appOptDir, appLauncher } = config;
    const stage = NodeFS.mkdtempSync(NodePath.join(config.baseDir, ".install-"));
    NodeFS.chmodSync(appImage, 0o755);
    const extracted = yield* exec({ command: appImage, args: ["--appimage-extract"], cwd: stage });
    const root = NodePath.join(stage, "squashfs-root");
    if (extracted.code !== 0 || !NodeFS.existsSync(NodePath.join(root, "AppRun"))) {
      NodeFS.rmSync(stage, { recursive: true, force: true });
      outcome.build = extracted.code === 0 ? "extract-invalid" : "extract-failed";
      return yield* run.error("could not extract a usable app from the AppImage");
    }

    yield* stopApp(run);

    const backup = `${appOptDir}.anterior`;
    NodeFS.rmSync(backup, { recursive: true, force: true });
    if (NodeFS.existsSync(appOptDir)) {
      NodeFS.renameSync(appOptDir, backup);
      yield* run.info(`previous version kept at ${backup}`);
    }
    NodeFS.mkdirSync(NodePath.dirname(appOptDir), { recursive: true });
    NodeFS.renameSync(root, appOptDir);
    NodeFS.rmSync(stage, { recursive: true, force: true });

    if (!NodeFS.existsSync(appLauncher)) {
      yield* run.warn(`launcher ${appLauncher} is missing; recreating it`);
      NodeFS.mkdirSync(NodePath.dirname(appLauncher), { recursive: true });
      NodeFS.writeFileSync(
        appLauncher,
        `#!/usr/bin/env bash\n# T3 Code desktop app, extracted to ${appOptDir}\nexec "${appOptDir}/AppRun" --no-sandbox "$@"\n`,
        { mode: 0o755 },
      );
    }
    yield* refreshDesktopEntry(run);

    outcome.build = "installed";
    yield* run.info(`installed: ${outcome.appVersion}`);
    if (outcome.appWasRunning || config.alwaysOpenApp) return yield* startAppLinux(run);
    yield* run.info("the app was not open, so it is not opened now");
  });

/** Replaces the installed app with `artifact` and reopens it if it was open. */
export const installApp = (run: Run, artifact: string) =>
  Effect.gen(function* () {
    yield* run.step("install");
    yield* run.config.platform === "macos"
      ? installMacos(run, artifact)
      : installLinux(run, artifact);
  });

/**
 * Whether this process was started from inside the app, as it is when run in
 * one of the app's terminals. Installing closes the app, which would take
 * this process down halfway through the swap.
 */
export const startedByApp = (run: Run) =>
  Effect.gen(function* () {
    const location = run.config.platform === "macos" ? installedBundle(run) : run.config.appOptDir;
    if (location === null) return false;
    const ps = yield* exec({ command: "ps", args: ["-axo", "pid=,ppid=,command="] });
    const app = new Set(
      appProcesses(ps.stdout, `${location}/`, process.pid).map((entry) => entry.pid),
    );
    const parents = new Map(
      ps.stdout.split("\n").flatMap((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s/.exec(line);
        return match === null ? [] : [[Number(match[1]), Number(match[2])] as const];
      }),
    );
    for (
      let pid = parents.get(process.pid), hops = 0;
      pid !== undefined && pid > 1 && hops < 64;
      hops += 1
    ) {
      if (app.has(pid)) return true;
      pid = parents.get(pid);
    }
    return false;
  });
