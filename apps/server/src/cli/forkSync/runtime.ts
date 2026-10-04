// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalTimersInEffect:off globalDate:off - drives child processes and stamps log lines synchronously, outside any fiber.
/**
 * What every `t3 fork` step shares: the run log, child processes, the lock
 * that keeps two runs apart, and the state and alert files a person reads
 * afterwards.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ForkSyncConfig } from "./config.ts";

export class ForkSyncError extends Schema.TaggedError<ForkSyncError>()("ForkSyncError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

const LOCAL_TIME = new Intl.DateTimeFormat("sv-SE", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/** Local time as `YYYY-MM-DD HH:MM:SS`, for log lines. */
const localTime = () => LOCAL_TIME.format(Date.now());

/** Today's local date as `YYYYMMDD`. */
export const localDate = () => localTime().slice(0, 10).replace(/-/g, "");

/** The current instant as an ISO-8601 string. */
export const isoNow = () => DateTime.formatIso(DateTime.makeUnsafe(Date.now()));

/** What a run found, written to the state file when it ends. */
export interface RunOutcome {
  conflicts: number;
  agentUsed: boolean;
  verify: string;
  pushed: string;
  build: string;
  appVersion: string;
  mergedSha: string;
  upstreamSha: string;
  appWasRunning: boolean;
}

export const emptyOutcome = (): RunOutcome => ({
  conflicts: 0,
  agentUsed: false,
  verify: "skipped",
  pushed: "no",
  build: "skipped",
  appVersion: "",
  mergedSha: "",
  upstreamSha: "",
  appWasRunning: false,
});

export interface Run {
  readonly config: ForkSyncConfig;
  readonly logPath: string;
  readonly outcome: RunOutcome;
  readonly info: (message: string) => Effect.Effect<void>;
  readonly warn: (message: string) => Effect.Effect<void>;
  readonly error: (message: string) => Effect.Effect<void>;
  readonly step: (title: string) => Effect.Effect<void>;
  /** Writes text to the run log and the terminal as it is, for child process output. */
  readonly raw: (text: string) => void;
  /** False keeps a run from showing desktop notifications. */
  readonly notifications: boolean;
}

/** Starts a run: its log file under the log directory, and the outcome it will fill in. */
export function makeRun(
  config: ForkSyncConfig,
  options: {
    readonly suffix?: string;
    readonly logPath?: string;
    readonly outcome?: RunOutcome;
    readonly notifications?: boolean;
    /** False writes only to the log file, for runs with no terminal. */
    readonly terminal?: boolean;
  },
): Run {
  NodeFS.mkdirSync(config.logDir, { recursive: true });
  const logPath =
    options.logPath ??
    NodePath.join(
      config.logDir,
      `${localTime().replace(/[-:]/g, "").replace(" ", "-")}${options.suffix ?? ""}.log`,
    );
  const raw = (text: string) => {
    if (options.terminal !== false) process.stdout.write(text);
    NodeFS.appendFileSync(logPath, text);
  };
  const line = (level: string) => (message: string) =>
    Effect.sync(() => raw(`${localTime()} [${level}] ${message}\n`));
  return {
    config,
    logPath,
    outcome: options.outcome ?? emptyOutcome(),
    info: line("INFO"),
    warn: line("WARN"),
    error: line("ERROR"),
    step: (title) => Effect.sync(() => raw(`\n${localTime()} [STEP] === ${title} ===\n`)),
    raw,
    notifications: options.notifications !== false,
  };
}

// ---------------------------------------------------------------------------
// Child processes

export interface ExecResult {
  /** The exit code; 127 when the command could not be started, 124 when it timed out. */
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs a command to completion and never fails: the exit code is the answer.
 * With `echo`, output also goes to the run log as it arrives. Interrupting the
 * effect, or passing `timeoutSeconds`, stops the child this call started.
 */
export const exec = (input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutSeconds?: number;
  readonly echo?: Run;
  readonly shell?: boolean;
}) =>
  Effect.callback<ExecResult>((resume) => {
    const child = NodeChildProcess.spawn(input.command, [...input.args], {
      cwd: input.cwd,
      env: input.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: input.shell ?? false,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      input.echo?.raw(chunk.toString());
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      input.echo?.raw(chunk.toString());
    });
    const stop = () => {
      child.kill("SIGTERM");
      // A child that ignores TERM would otherwise hold the run open forever.
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    };
    const timer =
      input.timeoutSeconds === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            stop();
          }, input.timeoutSeconds * 1000);
    child.once("error", () => {
      clearTimeout(timer);
      resume(Effect.succeed({ code: 127, stdout, stderr }));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resume(
        Effect.succeed({
          code: timedOut ? 124 : (code ?? (signal === null ? 0 : 1)),
          stdout,
          stderr,
        }),
      );
    });
    return Effect.sync(() => {
      clearTimeout(timer);
      stop();
    });
  });

/** Runs git in `cwd` and returns its trimmed stdout; a non-zero exit is not an error here. */
export const git = (cwd: string, args: ReadonlyArray<string>, echo?: Run) =>
  exec({ command: "git", args: ["-C", cwd, ...args], ...(echo === undefined ? {} : { echo }) });

/** Runs git and fails when it exits non-zero. */
export const gitOk = (cwd: string, args: ReadonlyArray<string>, echo?: Run) =>
  Effect.flatMap(git(cwd, args, echo), (result) =>
    result.code === 0
      ? Effect.succeed(result.stdout.trim())
      : Effect.fail(
          new ForkSyncError({
            detail: `git ${args.join(" ")} failed (exit ${result.code}): ${result.stderr.trim().split("\n").at(-1) ?? ""}`,
          }),
        ),
  );

/** Git's stdout when it succeeds, otherwise an empty string. */
export const gitText = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.map(git(cwd, args), (result) => (result.code === 0 ? result.stdout.trim() : ""));

export const commandExists = (command: string) =>
  Effect.map(
    exec({ command: "sh", args: ["-c", 'command -v "$1" >/dev/null 2>&1', "sh", command] }),
    (result) => result.code === 0,
  );

// ---------------------------------------------------------------------------
// Lock

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    // EPERM means the process exists but belongs to someone else.
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The pid holding the lock, when its process is still alive. */
export function lockOwner(lockPath: string): number | null {
  try {
    const pid = Number(NodeFS.readFileSync(lockPath, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 && processAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Takes the run lock, a file holding this process's pid. A lock whose owner
 * died is taken over. Returns false when another run holds it.
 */
export function acquireLock(lockPath: string): boolean {
  NodeFS.mkdirSync(NodePath.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      NodeFS.writeFileSync(lockPath, `${process.pid}\n`, { flag: "wx" });
      return true;
    } catch {
      if (lockOwner(lockPath) !== null) return false;
      NodeFS.rmSync(lockPath, { force: true });
    }
  }
  return false;
}

export function releaseLock(lockPath: string): void {
  if (lockOwner(lockPath) === process.pid) NodeFS.rmSync(lockPath, { force: true });
}

// ---------------------------------------------------------------------------
// State and alerts

export const ForkSyncState = Schema.Struct({
  status: Schema.String,
  message: Schema.String,
  finished_at: Schema.String,
  log: Schema.String,
  merged_sha: Schema.String,
  upstream_sha: Schema.String,
  conflicts: Schema.Number,
  ai_used: Schema.String,
  verify: Schema.String,
  pushed: Schema.String,
  build: Schema.String,
  app_version: Schema.String,
});
export type ForkSyncState = typeof ForkSyncState.Type;

const encodeState = Schema.encodeSync(Schema.fromJsonString(ForkSyncState));
const decodeState = Schema.decodeUnknownOption(Schema.fromJsonString(ForkSyncState));

/** Records how the run ended, for `t3 fork status` and for the next run. */
export const writeState = (run: Run, status: string, message: string) =>
  Effect.sync(() => {
    const { outcome } = run;
    NodeFS.writeFileSync(
      run.config.statePath,
      `${encodeState({
        status,
        message,
        finished_at: isoNow(),
        log: run.logPath,
        merged_sha: outcome.mergedSha,
        upstream_sha: outcome.upstreamSha,
        conflicts: outcome.conflicts,
        ai_used: outcome.agentUsed ? "t3" : "none",
        verify: outcome.verify,
        pushed: outcome.pushed,
        build: outcome.build,
        app_version: outcome.appVersion,
      })}\n`,
    );
  });

export function readState(statePath: string): ForkSyncState | null {
  try {
    const decoded = decodeState(NodeFS.readFileSync(statePath, "utf8"));
    return decoded._tag === "Some" ? decoded.value : null;
  } catch {
    return null;
  }
}

/** Shows a desktop notification; does nothing where there is no desktop session. */
const notify = (run: Run, urgency: "normal" | "critical", title: string, body: string) => {
  if (!run.notifications) return Effect.void;
  const quote = (text: string) => text.replace(/["\\]/g, "\\$&");
  return (
    run.config.platform === "macos"
      ? exec({
          command: "osascript",
          args: ["-e", `display notification "${quote(body)}" with title "${quote(title)}"`],
        })
      : exec({ command: "notify-send", args: ["-a", "t3code-sync", "-u", urgency, title, body] })
  ).pipe(Effect.asVoid);
};

export const notifyDone = (run: Run, title: string, body: string) =>
  notify(run, "normal", title, body);

/**
 * Raises an alert that outlives the notification: scheduled runs happen at
 * night, so a failure only a person can fix must still be there in the
 * morning. `t3 fork status` shows it, and the next good run clears it.
 */
export const raiseAlert = (run: Run, title: string, body: string) =>
  Effect.gen(function* () {
    yield* notify(run, "critical", title, body);
    yield* Effect.sync(() =>
      NodeFS.writeFileSync(
        run.config.alertPath,
        `${isoNow()}\n${title}\n${body}\n${run.logPath}\n`,
      ),
    );
  });

export const clearAlert = (config: ForkSyncConfig) =>
  Effect.sync(() => NodeFS.rmSync(config.alertPath, { force: true }));

export function readAlert(config: ForkSyncConfig) {
  try {
    const [at = "", title = "", body = "", log = ""] = NodeFS.readFileSync(
      config.alertPath,
      "utf8",
    ).split("\n");
    return { at, title, body, log };
  } catch {
    return null;
  }
}

/** Keeps the newest `logKeep` run logs. */
export const pruneLogs = (config: ForkSyncConfig) =>
  Effect.sync(() => {
    const logs = NodeFS.readdirSync(config.logDir)
      .filter((name) => name.endsWith(".log"))
      .toSorted()
      .toReversed();
    for (const name of logs.slice(config.logKeep)) {
      NodeFS.rmSync(NodePath.join(config.logDir, name), { force: true });
    }
  });
