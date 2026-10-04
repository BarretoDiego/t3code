/**
 * Settings for `t3 fork`: which remotes to merge, how to verify and build, and
 * where the desktop app is installed. They live in a shell-style `KEY="value"`
 * file so the launchd job, the systemd timer, and a person editing it by hand
 * all read the same thing.
 */

const LINE_PATTERN = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

/** The value of one `KEY=value` line: quotes removed, trailing comment dropped. */
function readValue(raw: string): { readonly text: string; readonly expand: boolean } {
  const trimmed = raw.trim();
  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    const end = trimmed.indexOf(quote, 1);
    // Single quotes are literal in a shell; only double-quoted and bare values expand.
    return { text: end < 0 ? trimmed.slice(1) : trimmed.slice(1, end), expand: quote === '"' };
  }
  return { text: trimmed.replace(/\s+#.*$/, ""), expand: true };
}

/**
 * Reads the config file. `$NAME` and `${NAME}` expand to an earlier key or to
 * `variables`, which is how `$HOME` and `$PATH` get in.
 */
export function parseConfigFile(
  contents: string,
  variables: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of contents.split("\n")) {
    const match = LINE_PATTERN.exec(line);
    if (match === null) continue;
    const [, key = "", raw = ""] = match;
    const { text, expand } = readValue(raw);
    values[key] = expand
      ? text.replace(
          /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
          (_whole, braced: string | undefined, bare: string | undefined) => {
            const name = braced ?? bare ?? "";
            return values[name] ?? variables[name] ?? "";
          },
        )
      : text;
  }
  return values;
}

const flag = (value: string | undefined, fallback: boolean) =>
  value === undefined || value === "" ? fallback : value === "1";

const number = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return value === undefined || value === "" || !Number.isFinite(parsed) ? fallback : parsed;
};

function defaultBuildCommand(platform: NodeJS.Platform, arch: string): string {
  if (platform !== "darwin") return "pnpm run dist:desktop:linux";
  // The target follows the machine: crossing architectures needs a second Rust toolchain.
  return arch === "arm64" ? "pnpm run dist:desktop:dmg:arm64" : "pnpm run dist:desktop:dmg:x64";
}

/** Every setting with its default applied. `baseDir` holds the worktree, logs, lock, and state. */
export function resolveForkSyncConfig(input: {
  readonly values: Readonly<Record<string, string>>;
  readonly baseDir: string;
  readonly home: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
}) {
  const { values, baseDir, home } = input;
  const text = (key: string, fallback: string) => {
    const value = values[key];
    return value === undefined || value === "" ? fallback : value;
  };
  return {
    baseDir,
    platform: input.platform === "darwin" ? ("macos" as const) : ("linux" as const),
    /** The developer's checkout. It is never switched or edited; work happens in `worktree`. */
    repo: values.REPO ?? "",
    worktree: `${baseDir}/worktree`,
    logDir: `${baseDir}/logs`,
    statePath: `${baseDir}/state.json`,
    lockPath: `${baseDir}/.lock`,
    alertPath: `${baseDir}/ALERT`,
    upstreamRemote: text("UPSTREAM_REMOTE", "upstream"),
    upstreamBranch: text("UPSTREAM_BRANCH", "main"),
    forkRemote: text("FORK_REMOTE", "origin"),
    targetBranch: text("TARGET_BRANCH", "main"),
    stagingBranch: text("STAGING_BRANCH", "t3sync/staging"),
    /** `<provider-instance>/<model>` for the agent; empty uses the project's default. */
    agentModel: text("AGENT_MODEL", ""),
    agentTimeoutSeconds: number(values.AI_TIMEOUT, 2700),
    fixAttempts: number(values.AI_FIX_ATTEMPTS, 1),
    push: flag(values.PUSH, true),
    verify: flag(values.VERIFY, true),
    logKeep: number(values.LOG_KEEP, 60),
    workStartHour: number(values.WORK_START_HOUR, 8),
    workEndHour: number(values.WORK_END_HOUR, 17),
    bootGraceMinutes: number(values.BOOT_GRACE_MINUTES, 20),
    buildApp: flag(values.BUILD_APP, false),
    restartApp: flag(values.RESTART_APP, false),
    alwaysOpenApp: flag(values.ALWAYS_OPEN_APP, false),
    buildCommand: text("BUILD_CMD", defaultBuildCommand(input.platform, input.arch)),
    buildTimeoutSeconds: number(values.BUILD_TIMEOUT, 5400),
    nightlyVersion: flag(values.NIGHTLY_VERSION, true),
    /** macOS: where bundles are installed, and an optional fixed bundle path. */
    appDir: text("APP_DIR", "/Applications"),
    appBundle: text("APP_BUNDLE", ""),
    /** Linux: where the AppImage is extracted, and the wrapper that launches it. */
    appOptDir: text("APP_OPT_DIR", `${home}/.local/opt/t3code`),
    appLauncher: text("APP_LAUNCHER", `${home}/.local/bin/t3code`),
    /** Prepended to PATH: a scheduler does not read the shell profile. */
    extraPath: text("EXTRA_PATH", ""),
  };
}
export type ForkSyncConfig = ReturnType<typeof resolveForkSyncConfig>;
