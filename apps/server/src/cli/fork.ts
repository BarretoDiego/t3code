// @effect-diagnostics nodeBuiltinImport:off - reads the sync configuration and detaches the installer.
/**
 * `t3 fork` - keeps a fork of T3 Code current with upstream and installs the
 * result on this machine.
 *
 * `sync` merges upstream into the fork's branch in an isolated worktree,
 * publishes the merge, builds the desktop app from it, and installs it. When
 * the merge conflicts, or the merged code no longer typechecks, the work goes
 * to a coding agent in a T3 Code thread on this machine's server.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { WS_METHODS } from "@t3tools/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/unstable/cli";

import { jsonFlag, printJson } from "./common.ts";
import { baseDirFlag } from "./config.ts";
import { withEnvironmentRpc } from "./environmentRpc.ts";
import { buildApp, installApp, startedByApp } from "./forkSync/app.ts";
import { type ForkSyncConfig, parseConfigFile, resolveForkSyncConfig } from "./forkSync/config.ts";
import {
  acquireLock,
  clearAlert,
  emptyOutcome,
  ForkSyncError,
  gitText,
  lockOwner,
  makeRun,
  notifyDone,
  pruneLogs,
  raiseAlert,
  readAlert,
  readState,
  releaseLock,
  type Run,
  type RunOutcome,
  writeState,
} from "./forkSync/runtime.ts";
import { type ForkSyncAgent, ForkSyncStopped, syncFork } from "./forkSync/sync.ts";
import { launchThreadAndWait, loadShell, resolveNewThreadDefaults } from "./thread.ts";

const isForkSyncStopped = Schema.is(ForkSyncStopped);

const BUILD_FAILURES = new Set([
  "build-failed",
  "deps-failed",
  "artifact-missing",
  "artifact-invalid",
  "mount-failed",
  "install-failed",
  "extract-failed",
  "extract-invalid",
  "prereq-missing",
]);

// ---------------------------------------------------------------------------
// Configuration

const configDirFlag = Flag.String("config-dir").pipe(
  Flag.withDescription(
    "Directory holding config.env, the worktree, logs, and state. Default: ~/.local/share/t3code-sync.",
  ),
  Flag.optional,
);

const loadConfig = Effect.fn("cli.fork.loadConfig")(function* (configDir: Option.Option<string>) {
  const home = NodeOS.homedir();
  const baseDir = NodePath.resolve(
    Option.getOrElse(configDir, () => NodePath.join(home, ".local/share/t3code-sync")),
  );
  const configPath = NodePath.join(baseDir, "config.env");
  if (!NodeFS.existsSync(configPath)) {
    return yield* new ForkSyncError({
      detail: `No configuration at ${configPath}. Create it with at least REPO="<path to your fork's checkout>"; see docs/user/cli.md#fork-maintenance.`,
    });
  }
  const config = resolveForkSyncConfig({
    values: parseConfigFile(NodeFS.readFileSync(configPath, "utf8"), {
      ...process.env,
      HOME: home,
    }),
    baseDir,
    home,
    platform: yield* HostProcessPlatform,
    arch: yield* HostProcessArchitecture,
  });
  if (config.repo === "" || !NodeFS.existsSync(NodePath.join(config.repo, ".git"))) {
    return yield* new ForkSyncError({
      detail: `REPO in ${configPath} must point at a git checkout; got '${config.repo}'.`,
    });
  }
  // A scheduler does not read the shell profile, so the tools' locations come from the config.
  if (config.extraPath !== "") process.env.PATH = `${config.extraPath}:${process.env.PATH ?? ""}`;
  return config;
});

/** Runs `use` holding the run lock; a second run started meanwhile reports that and stops. */
const withLock = <A, E, R>(config: ForkSyncConfig, use: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    if (!acquireLock(config.lockPath)) {
      return yield* Console.log(
        `Another run is in progress (pid ${lockOwner(config.lockPath) ?? "?"}). See: t3 fork status`,
      );
    }
    return yield* use.pipe(Effect.ensuring(Effect.sync(() => releaseLock(config.lockPath))));
  });

// ---------------------------------------------------------------------------
// The agent

/**
 * Runs agent turns as T3 Code threads in the repository's project, with the
 * sync worktree as their workspace. Each turn opens its own connection: a run
 * can spend an hour building between two of them.
 */
function threadAgent(flags: { readonly baseDir: Option.Option<string> }, config: ForkSyncConfig) {
  const target = { baseDir: flags.baseDir, env: Option.none<string>() };
  return {
    available: withEnvironmentRpc(target, (client) => client[WS_METHODS.serverProbe]({})).pipe(
      Effect.as(true),
      Effect.catchCause(() => Effect.succeed(false)),
    ),
    run: (input: Parameters<ForkSyncAgent["run"]>[0]) =>
      withEnvironmentRpc(target, (client) =>
        Effect.gen(function* () {
          const shell = yield* loadShell(client);
          const project = shell.projects.find((entry) => entry.workspaceRoot === config.repo);
          if (project === undefined) {
            return {
              ok: false,
              reply: "",
              detail: `${config.repo} is not a T3 Code project. Add it with: t3 project add ${config.repo}`,
            };
          }
          const defaults = yield* resolveNewThreadDefaults(
            client,
            shell,
            project,
            config.agentModel === "" ? Option.none() : Option.some(config.agentModel),
          );
          const turn = yield* launchThreadAndWait(client, {
            projectId: project.id,
            title: input.title,
            text: input.prompt,
            modelSelection: defaults.modelSelection,
            // A turn that only answers gets no permission to change anything.
            runtimeMode: input.edits ? "full-access" : "approval-required",
            workspaceStrategy: { type: "existing_worktree", worktreePath: config.worktree },
            timeout: Duration.seconds(input.timeoutSeconds),
            archiveWhenDone: !input.edits,
          });
          return {
            ok: turn.status === "completed",
            reply: turn.reply,
            detail: `thread ${turn.threadId} ended ${turn.status}${turn.lastError === null ? "" : `: ${turn.lastError}`}`,
          };
        }),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed({
            ok: false,
            reply: "",
            detail: Cause.pretty(cause).split("\n")[0] ?? "",
          }),
        ),
      ),
  };
}

// ---------------------------------------------------------------------------
// Finishing a run

/** Records the result, tells the person, and tidies up. `summary` is the one-line account. */
const finish = (run: Run, summary: string) =>
  Effect.gen(function* () {
    const ok = !BUILD_FAILURES.has(run.outcome.build);
    yield* writeState(run, ok ? "ok" : "ok-build-failed", summary);
    yield* run.info(`DONE: ${summary}`);
    if (ok) {
      yield* clearAlert(run.config);
      yield* notifyDone(run, "t3 fork: done", summary);
    } else {
      yield* raiseAlert(run, "t3 fork: app not updated", summary);
    }
    yield* pruneLogs(run.config);
  });

const summaryOf = (outcome: RunOutcome, commitCount: number | null) =>
  commitCount === null
    ? `manual build: app=${outcome.build}${outcome.appVersion === "" ? "" : ` (${outcome.appVersion})`}`
    : `+${commitCount} commits from upstream, ${outcome.conflicts} conflict(s), verify=${outcome.verify}, push=${outcome.pushed}, app=${outcome.build}`;

/** An unexpected failure still leaves a state and an alert behind, then fails the command. */
const recordingFailure = <A, R>(
  run: Run,
  effect: Effect.Effect<A, ForkSyncError | ForkSyncStopped, R>,
) =>
  effect.pipe(
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        const error = Cause.squash(cause);
        // A stop already logged, recorded, and alerted its own reason.
        if (!isForkSyncStopped(error)) {
          const detail = error instanceof Error ? error.message : String(error);
          yield* run.error(`aborted: ${detail}`);
          yield* writeState(run, "error", `failed: ${detail}`);
          yield* raiseAlert(run, "t3 fork failed", "See: t3 fork status");
        }
        return yield* Effect.failCause(cause);
      }),
    ),
  );

const PendingInstall = Schema.fromJsonString(
  Schema.Struct({
    artifact: Schema.String,
    logPath: Schema.String,
    commitCount: Schema.NullOr(Schema.Number),
    outcome: Schema.Struct({
      conflicts: Schema.Number,
      agentUsed: Schema.Boolean,
      verify: Schema.String,
      pushed: Schema.String,
      build: Schema.String,
      appVersion: Schema.String,
      mergedSha: Schema.String,
      upstreamSha: Schema.String,
      appWasRunning: Schema.Boolean,
    }),
  }),
);
const encodePendingInstall = Schema.encodeSync(PendingInstall);
const decodePendingInstall = Schema.decodeUnknownEffect(PendingInstall);

/**
 * Builds the app and installs it. When this command was started from inside
 * the app (one of its terminals, or an agent it runs), the install continues
 * in a process of its own: installing closes the app, which would otherwise
 * take this command down between removing the old version and copying the new.
 */
const buildAndInstall = (run: Run, commitCount: number | null) =>
  Effect.gen(function* () {
    const { config } = run;
    const artifact = yield* buildApp(run);
    if (artifact === null) return yield* finish(run, summaryOf(run.outcome, commitCount));
    if (!config.restartApp) {
      yield* run.info("RESTART_APP=0: the artifact is built but not installed");
      return yield* finish(run, summaryOf(run.outcome, commitCount));
    }
    if (!(yield* startedByApp(run))) {
      yield* installApp(run, artifact);
      return yield* finish(run, summaryOf(run.outcome, commitCount));
    }

    const pending = NodePath.join(config.baseDir, ".pending-install.json");
    NodeFS.writeFileSync(
      pending,
      encodePendingInstall({ artifact, logPath: run.logPath, commitCount, outcome: run.outcome }),
    );
    yield* writeState(run, "installing", `installing ${run.outcome.appVersion}`);
    yield* run.info(
      "this command runs inside the app, which is about to close; the install continues in the background",
    );
    yield* run.info(`follow it with: t3 fork status   (log: ${run.logPath})`);
    // The lock passes to the installer, which takes it as soon as it starts.
    releaseLock(config.lockPath);
    const entry = process.argv[1];
    NodeChildProcess.spawn(
      process.execPath,
      [
        ...process.execArgv,
        ...(entry === undefined ? [] : [entry]),
        "fork",
        "install-pending",
        "--config-dir",
        config.baseDir,
        pending,
      ],
      { detached: true, stdio: "ignore" },
    ).unref();
  });

// ---------------------------------------------------------------------------
// Commands

const syncCommand = Command.make("sync", {
  baseDir: baseDirFlag,
  configDir: configDirFlag,
  scheduled: Flag.Boolean("scheduled").pipe(
    Flag.withDescription(
      "Mark this as a scheduled run: it is skipped during the configured working hours, except right after boot.",
    ),
    Flag.withDefault(false),
  ),
  noBuild: Flag.Boolean("no-build").pipe(
    Flag.withDescription("Sync and push, but do not build or install the app."),
    Flag.withDefault(false),
  ),
  noPush: Flag.Boolean("no-push").pipe(
    Flag.withDescription("Keep the merge on this machine instead of pushing it to the fork."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Merge upstream into the fork's branch, push it, then build and install the app. Conflicts go to an agent in a T3 Code thread.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const loaded = yield* loadConfig(flags.configDir);
      const config = { ...loaded, push: loaded.push && !flags.noPush };
      if (flags.scheduled) {
        const hour = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false }).format();
        const uptimeMinutes = NodeOS.uptime() / 60;
        // A run right after boot always goes ahead, so the day starts up to date.
        if (
          uptimeMinutes >= config.bootGraceMinutes &&
          Number(hour) >= config.workStartHour &&
          Number(hour) <= config.workEndHour
        ) {
          const run = makeRun(config, { suffix: "-skipped" });
          yield* writeState(
            run,
            "skipped-work-hours",
            `postponed: ${hour}h is inside working hours`,
          );
          NodeFS.rmSync(run.logPath, { force: true });
          return yield* Console.log(`Inside working hours (${hour}h); scheduled run postponed.`);
        }
      }
      yield* withLock(
        config,
        Effect.gen(function* () {
          const run = makeRun(config, {});
          yield* recordingFailure(
            run,
            Effect.gen(function* () {
              const result = yield* syncFork(run, threadAgent(flags, config));
              if (result.kind === "up-to-date") return yield* pruneLogs(config);
              if (!config.buildApp || flags.noBuild) {
                yield* run.info("build skipped (BUILD_APP=0 or --no-build)");
                return yield* finish(run, summaryOf(run.outcome, result.commitCount));
              }
              yield* buildAndInstall(run, result.commitCount);
            }),
          );
        }),
      );
    }),
  ),
);

const buildCommand = Command.make("build", { configDir: configDirFlag }).pipe(
  Command.withDescription(
    "Build and install the app from the fork's branch as it is, without syncing with upstream.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const config = yield* loadConfig(flags.configDir);
      yield* withLock(
        config,
        Effect.gen(function* () {
          const run = makeRun(config, { suffix: "-build" });
          yield* recordingFailure(
            run,
            Effect.gen(function* () {
              const head = yield* gitText(config.repo, ["rev-parse", config.targetBranch]);
              if (head === "") {
                return yield* new ForkSyncError({
                  detail: `branch ${config.targetBranch} does not exist in ${config.repo}`,
                });
              }
              // The build needs a worktree pointed at the branch; syncing with
              // nothing to merge would not prepare one.
              yield* prepareBuildWorktree(run, head);
              run.outcome.mergedSha = head;
              yield* buildAndInstall(run, null);
            }),
          );
        }),
      );
    }),
  ),
);

/** Points the sync worktree at `sha` so a build can run without a merge. */
const prepareBuildWorktree = (run: Run, sha: string) =>
  Effect.gen(function* () {
    const { repo, worktree, stagingBranch } = run.config;
    const args = NodeFS.existsSync(NodePath.join(worktree, ".git"))
      ? (["-C", worktree, "checkout", "-f", "-B", stagingBranch, sha] as const)
      : (["-C", repo, "worktree", "add", "--force", "-B", stagingBranch, worktree, sha] as const);
    const prepared = yield* Effect.sync(() =>
      NodeChildProcess.spawnSync("git", [...args], { encoding: "utf8" }),
    );
    if (prepared.status !== 0) {
      return yield* new ForkSyncError({
        detail: `could not prepare the worktree: ${prepared.stderr.trim()}`,
      });
    }
  });

const installPendingCommand = Command.make("install-pending", {
  configDir: configDirFlag,
  pending: Argument.String("pending-file"),
}).pipe(
  Command.withDescription("Finish an install handed over by a run that started inside the app."),
  Command.unlisted,
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const config = yield* loadConfig(flags.configDir);
      const pending = yield* decodePendingInstall(NodeFS.readFileSync(flags.pending, "utf8")).pipe(
        Effect.mapError(
          () => new ForkSyncError({ detail: `${flags.pending} is not a pending install` }),
        ),
      );
      NodeFS.rmSync(flags.pending, { force: true });
      yield* withLock(
        config,
        Effect.gen(function* () {
          const run = makeRun(config, {
            logPath: pending.logPath,
            outcome: { ...emptyOutcome(), ...pending.outcome },
            terminal: false,
          });
          yield* recordingFailure(
            run,
            Effect.gen(function* () {
              yield* installApp(run, pending.artifact);
              yield* finish(run, summaryOf(run.outcome, pending.commitCount));
            }),
          );
        }),
      );
    }),
  ),
);

const statusCommand = Command.make("status", { configDir: configDirFlag, json: jsonFlag }).pipe(
  Command.withDescription(
    "Show the last run, any pending alert, and how far the fork is behind upstream.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const config = yield* loadConfig(flags.configDir);
      const { repo, targetBranch, forkRemote } = config;
      const upstream = `${config.upstreamRemote}/${config.upstreamBranch}`;
      const count = (range: string) =>
        Effect.map(gitText(repo, ["rev-list", "--count", range]), (text) =>
          text === "" ? null : Number(text),
        );
      const status = {
        running: lockOwner(config.lockPath),
        alert: readAlert(config),
        lastRun: readState(config.statePath),
        repository: {
          behindUpstream: yield* count(`${targetBranch}..${upstream}`),
          ownCommits: yield* count(`${upstream}..${targetBranch}`),
          unpushed: yield* count(`${forkRemote}/${targetBranch}..${targetBranch}`),
        },
      };
      if (flags.json) return yield* printJson(status);
      const { alert, lastRun, repository } = status;
      yield* Console.log(
        [
          ...(alert === null
            ? []
            : [`!! ${alert.title}`, `   ${alert.body}`, `   ${alert.at}  log: ${alert.log}`, ""]),
          status.running === null ? "No run in progress." : `Running now (pid ${status.running}).`,
          "",
          ...(lastRun === null
            ? ["No run recorded yet."]
            : [
                `Last run: ${lastRun.status}  ${lastRun.message}`,
                `  when:      ${lastRun.finished_at}`,
                `  conflicts: ${lastRun.conflicts}   agent: ${lastRun.ai_used}   verify: ${lastRun.verify}   push: ${lastRun.pushed}   app: ${lastRun.build}`,
                ...(lastRun.app_version === "" ? [] : [`  artifact:  ${lastRun.app_version}`]),
                `  log:       ${lastRun.log}`,
              ]),
          "",
          `${targetBranch}: ${repository.behindUpstream ?? "?"} behind ${upstream} (as of the last fetch), ${repository.ownCommits ?? "?"} of its own, ${repository.unpushed ?? "?"} not pushed to ${forkRemote}`,
        ].join("\n"),
      );
    }),
  ),
);

export const forkCommand = Command.make("fork").pipe(
  Command.withDescription(
    "Keep a fork of T3 Code in sync with upstream and install the result on this machine.",
  ),
  Command.withSubcommands([syncCommand, buildCommand, statusCommand, installPendingCommand]),
);
