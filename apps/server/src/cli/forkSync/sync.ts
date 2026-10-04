// @effect-diagnostics nodeBuiltinImport:off - reads and writes files in the sync worktree.
/**
 * Brings the upstream branch into the fork's branch: fetch both remotes, merge
 * in an isolated worktree, let an agent resolve conflicts, verify, commit, and
 * push. The developer's checkout is never switched or edited.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  cleanCommitMessage,
  commitMessagePrompt,
  conflictPrompt,
  fallbackCommitMessage,
  fixPrompt,
} from "./prompts.ts";
import {
  clearAlert,
  commandExists,
  exec,
  ForkSyncError,
  git,
  gitOk,
  gitText,
  isoNow,
  raiseAlert,
  type Run,
  writeState,
} from "./runtime.ts";

/** Runs coding agents in the sync worktree. The CLI backs this with T3 Code threads. */
export interface ForkSyncAgent<R = never> {
  /** Whether an agent can be started right now. */
  readonly available: Effect.Effect<boolean, never, R>;
  /**
   * Runs one agent turn in the worktree and returns its reply. `edits` is
   * false for a turn that only has to answer.
   */
  readonly run: (input: {
    readonly title: string;
    readonly prompt: string;
    readonly edits: boolean;
    readonly timeoutSeconds: number;
  }) => Effect.Effect<
    { readonly ok: boolean; readonly reply: string; readonly detail: string },
    never,
    R
  >;
}

/** A run that ended early for a reason already logged, recorded, and alerted. */
export class ForkSyncStopped extends Schema.TaggedError<ForkSyncStopped>()("ForkSyncStopped", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

const stop = (detail: string) => Effect.fail(new ForkSyncStopped({ detail }));

const lines = (text: string) => text.split("\n").filter((line) => line.trim().length > 0);

const CONFLICT_MARKER = /^(<{7}|={7}|>{7})( |$)/m;

// ---------------------------------------------------------------------------
// Worktree

/** Points the isolated worktree at `base`, creating it or discarding whatever a past run left. */
const ensureWorktree = (run: Run, base: string) =>
  Effect.gen(function* () {
    const { repo, worktree, stagingBranch } = run.config;
    yield* git(repo, ["worktree", "prune"]);
    if (!NodeFS.existsSync(NodePath.join(worktree, ".git"))) {
      NodeFS.rmSync(worktree, { recursive: true, force: true });
      yield* run.info(`creating the isolated worktree at ${worktree}`);
      yield* gitOk(repo, ["worktree", "add", "--force", "-B", stagingBranch, worktree, base]);
    } else {
      for (const operation of ["merge", "rebase", "cherry-pick"]) {
        yield* git(worktree, [operation, "--abort"]);
      }
      yield* git(worktree, ["reset", "--hard"]);
      // Dependencies survive between runs: reinstalling them costs minutes.
      yield* git(worktree, [
        "clean",
        "-fdx",
        ...["node_modules", "**/node_modules", ".turbo", "**/.turbo", ".pnpm-store"].flatMap(
          (keep) => ["-e", keep],
        ),
      ]);
      yield* gitOk(worktree, ["checkout", "-B", stagingBranch, base]);
    }
    yield* gitOk(worktree, ["reset", "--hard", base]);
  });

/** The checkout where `branch` is currently in use, if any. */
const checkoutOf = (repo: string, branch: string) =>
  Effect.map(gitText(repo, ["worktree", "list", "--porcelain"]), (output) => {
    let current = "";
    for (const line of output.split("\n")) {
      if (line.startsWith("worktree ")) current = line.slice("worktree ".length);
      if (line === `branch refs/heads/${branch}`) return current;
    }
    return null;
  });

/**
 * Moves the local target branch to `sha`. A checkout that has the branch open
 * is fast-forwarded only when it is clean; uncommitted work is never touched.
 */
const updateLocalBranch = (run: Run, sha: string) =>
  Effect.gen(function* () {
    const { repo, targetBranch } = run.config;
    const checkout = yield* checkoutOf(repo, targetBranch);
    if (checkout === null) {
      yield* gitOk(repo, ["branch", "-f", targetBranch, sha]);
      return yield* run.info(`local ${targetBranch} updated`);
    }
    const clean =
      (yield* git(checkout, ["diff", "--quiet"])).code === 0 &&
      (yield* git(checkout, ["diff", "--cached", "--quiet"])).code === 0;
    if (!clean) {
      return yield* run.warn(
        `${targetBranch} has uncommitted changes in ${checkout}; the local branch was not updated`,
      );
    }
    yield* gitOk(checkout, ["merge", "--ff-only", sha]);
    yield* run.info(`${targetBranch} updated in ${checkout}`);
  });

// ---------------------------------------------------------------------------
// Conflicts

const unmergedPaths = (worktree: string) =>
  Effect.map(gitText(worktree, ["diff", "--name-only", "--diff-filter=U"]), lines);

/**
 * Has the agent resolve the conflicted files, then stages what it did. The
 * agent only edits files; it is told not to touch git state, and that is
 * checked afterwards rather than trusted.
 */
const resolveConflicts = <R>(run: Run, agent: ForkSyncAgent<R>, conflicts: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const { config } = run;
    const { worktree } = config;
    const headBefore = yield* gitOk(worktree, ["rev-parse", "HEAD"]);
    const forkCommits = yield* gitText(config.repo, [
      "log",
      "--oneline",
      "--no-merges",
      "-40",
      `${config.upstreamRemote}/${config.upstreamBranch}..${config.stagingBranch}`,
    ]);
    run.outcome.agentUsed = true;
    const result = yield* agent.run({
      title: `Sync: resolve ${conflicts.length} merge conflict${conflicts.length === 1 ? "" : "s"}`,
      prompt: conflictPrompt({ config, forkCommits, conflicts }),
      edits: true,
      timeoutSeconds: config.agentTimeoutSeconds,
    });
    if (!result.ok) yield* run.warn(`the agent did not finish cleanly: ${result.detail}`);
    if (result.reply.length > 0) {
      run.raw(`${result.reply.replace(/^/gm, "    | ")}\n`);
    }

    const abort = (state: string, detail: string) =>
      Effect.gen(function* () {
        yield* run.error(detail);
        yield* git(worktree, ["merge", "--abort"]);
        yield* writeState(run, state, detail);
        yield* raiseAlert(
          run,
          "t3 fork sync: conflicts not resolved",
          "Merge aborted. See: t3 fork status",
        );
        return yield* stop(detail);
      });

    const mergeHead = yield* gitText(worktree, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
    if ((yield* gitOk(worktree, ["rev-parse", "HEAD"])) !== headBefore || mergeHead === "") {
      return yield* abort(
        "unresolved",
        "the agent changed git state instead of only editing files",
      );
    }

    for (const path of conflicts) {
      yield* NodeFS.existsSync(NodePath.join(worktree, path))
        ? git(worktree, ["add", "--", path])
        : git(worktree, ["rm", "-q", "--", path]);
    }
    // Only the files that conflicted can hold markers; a `=======` line elsewhere is content.
    const withMarkers = conflicts.filter((path) => {
      try {
        return CONFLICT_MARKER.test(NodeFS.readFileSync(NodePath.join(worktree, path), "utf8"));
      } catch {
        return false;
      }
    });
    const unmerged = yield* unmergedPaths(worktree);
    if (withMarkers.length > 0 || unmerged.length > 0) {
      for (const path of withMarkers) yield* run.error(`    marker left in: ${path}`);
      for (const path of unmerged) yield* run.error(`    still unmerged: ${path}`);
      return yield* abort("unresolved", "the agent did not resolve every conflict");
    }
    yield* run.info("conflicts resolved by the agent");
  });

// ---------------------------------------------------------------------------
// Verification

/** The package manager the repository declares, falling back to its lockfile. */
export function detectPackageManager(worktree: string): string {
  try {
    const declared = String(
      (
        JSON.parse(NodeFS.readFileSync(NodePath.join(worktree, "package.json"), "utf8")) as {
          readonly packageManager?: unknown;
        }
      ).packageManager ?? "",
    ).split("@")[0];
    if (declared) return declared;
  } catch {
    // Fall through to the lockfile.
  }
  const has = (name: string) => NodeFS.existsSync(NodePath.join(worktree, name));
  if (has("pnpm-lock.yaml")) return "pnpm";
  if (has("bun.lock") || has("bun.lockb")) return "bun";
  return has("yarn.lock") ? "yarn" : "npm";
}

export function installArguments(packageManager: string): ReadonlyArray<string> {
  switch (packageManager) {
    case "pnpm":
    case "bun":
      return ["install", "--frozen-lockfile"];
    case "yarn":
      return ["install", "--immutable"];
    default:
      return ["ci"];
  }
}

/**
 * Installs, typechecks, and lints the merge. A failure gets the agent a
 * limited number of attempts to fix it; if it still fails the merge is kept
 * locally but not pushed.
 */
const verify = <R>(run: Run, agent: ForkSyncAgent<R>) =>
  Effect.gen(function* () {
    const { config } = run;
    const { worktree } = config;
    const output = NodePath.join(config.baseDir, ".verify.log");
    const packageManager = detectPackageManager(worktree);
    yield* run.info(`package manager: ${packageManager}`);
    if (!(yield* commandExists(packageManager))) {
      yield* run.warn(`${packageManager} is not on PATH; skipping verification`);
      run.outcome.verify = `skipped(no-${packageManager})`;
      return;
    }

    for (let attempt = 0; ; attempt += 1) {
      let log = "";
      let passed = true;
      for (const args of [
        installArguments(packageManager),
        ["run", "typecheck"],
        ["run", "lint"],
      ]) {
        const result = yield* exec({ command: packageManager, args, cwd: worktree });
        log += result.stdout + result.stderr;
        if (result.code !== 0) {
          passed = false;
          break;
        }
      }
      NodeFS.writeFileSync(output, log);
      if (passed) {
        run.outcome.verify = "pass";
        return yield* run.info("typecheck and lint pass");
      }
      run.raw(`${log.trimEnd().split("\n").slice(-60).join("\n").replace(/^/gm, "    ")}\n`);
      if (attempt >= config.fixAttempts || !(yield* agent.available)) break;

      yield* run.warn(`verification failed; fix attempt ${attempt + 1}/${config.fixAttempts}`);
      run.outcome.agentUsed = true;
      const fix = yield* agent.run({
        title: "Sync: fix typecheck and lint after the merge",
        prompt: fixPrompt({
          config,
          packageManager,
          failure: log.trimEnd().split("\n").slice(-120).join("\n"),
        }),
        edits: true,
        timeoutSeconds: config.agentTimeoutSeconds,
      });
      if (fix.reply.length > 0) run.raw(`${fix.reply.replace(/^/gm, "    | ")}\n`);
      yield* gitOk(worktree, ["add", "-A"]);
    }

    run.outcome.verify = "fail";
    yield* run.warn("typecheck or lint still fail; the merge is committed locally but not pushed");
    yield* raiseAlert(
      run,
      "t3 fork sync: broken build",
      "Merged locally, push blocked. See: t3 fork status",
    );
  });

// ---------------------------------------------------------------------------
// Commit message

const commitMessage = <R>(run: Run, agent: ForkSyncAgent<R>, commitCount: number) =>
  Effect.gen(function* () {
    const { config, outcome } = run;
    const upstreamShort = yield* gitText(config.repo, [
      "rev-parse",
      "--short",
      outcome.upstreamSha,
    ]);
    const details = { config, upstreamShort, commitCount, conflicts: outcome.conflicts };
    let message = "";
    if (yield* agent.available) {
      const titles = yield* gitText(config.repo, [
        "log",
        "--no-merges",
        "--format=- %s",
        "-80",
        `${config.stagingBranch}..${config.upstreamRemote}/${config.upstreamBranch}`,
      ]);
      const diffstat = (yield* gitText(config.worktree, ["diff", "--cached", "--stat"]))
        .split("\n")
        .slice(-40)
        .join("\n");
      const result = yield* agent.run({
        title: "Sync: write the merge commit message",
        prompt: commitMessagePrompt({ ...details, titles, diffstat }),
        edits: false,
        timeoutSeconds: 600,
      });
      message = result.ok ? cleanCommitMessage(result.reply) : "";
    }
    if (message.trim().length === 0) {
      yield* run.warn("no commit message from the agent; using the fallback");
      message = fallbackCommitMessage({ ...details, verify: outcome.verify });
    }
    return `${message}\n\nSync automatico t3code-sync em ${isoNow()}\n`;
  });

// ---------------------------------------------------------------------------
// Run

export type SyncResult =
  | { readonly kind: "up-to-date" }
  | { readonly kind: "merged"; readonly commitCount: number };

/**
 * Syncs the fork with upstream. Returns once the merge is committed and, when
 * allowed, pushed; building and installing the app is the caller's next step.
 */
export const syncFork = <R>(run: Run, agent: ForkSyncAgent<R>) =>
  Effect.gen(function* () {
    const { config, outcome } = run;
    const { repo, worktree, forkRemote, targetBranch, upstreamRemote, upstreamBranch } = config;
    const upstream = `${upstreamRemote}/${upstreamBranch}`;
    yield* run.info(`repo=${repo}  upstream=${upstream}  fork=${forkRemote}/${targetBranch}`);

    yield* run.step("fetch");
    yield* gitOk(repo, ["fetch", "--prune", "--tags", upstreamRemote, upstreamBranch], run);
    yield* gitOk(repo, ["fetch", "--prune", forkRemote], run);

    outcome.upstreamSha = yield* gitOk(repo, ["rev-parse", upstream]);
    const remoteTarget = yield* gitText(repo, [
      "rev-parse",
      "-q",
      "--verify",
      `${forkRemote}/${targetBranch}`,
    ]);
    const localTarget = yield* gitText(repo, [
      "rev-parse",
      "-q",
      "--verify",
      `refs/heads/${targetBranch}`,
    ]);
    const isAncestor = (older: string, newer: string) =>
      Effect.map(
        git(repo, ["merge-base", "--is-ancestor", older, newer]),
        (result) => result.code === 0,
      );

    // The newer of the local branch and the fork's is the base: that is the "pull".
    let base = localTarget || remoteTarget;
    if (localTarget !== "" && remoteTarget !== "") {
      if (yield* isAncestor(remoteTarget, localTarget)) base = localTarget;
      else if (yield* isAncestor(localTarget, remoteTarget)) base = remoteTarget;
      else {
        const detail = `${targetBranch} diverged between this machine and ${forkRemote}; resolve it by hand`;
        yield* run.error(detail);
        yield* writeState(run, "diverged", detail);
        yield* raiseAlert(
          run,
          "t3 fork sync stopped",
          `local ${targetBranch} and the fork's diverged`,
        );
        return yield* stop(detail);
      }
    }
    if (base === "")
      return yield* new ForkSyncError({ detail: `branch ${targetBranch} does not exist` });

    const behind = Number(
      yield* gitOk(repo, ["rev-list", "--count", `${base}..${outcome.upstreamSha}`]),
    );
    yield* run.info(
      `base=${base.slice(0, 9)}  upstream=${outcome.upstreamSha.slice(0, 9)}  behind by ${behind} commits`,
    );

    if (behind === 0) {
      // Nothing to merge, but the two copies of the branch may still differ.
      if (localTarget !== base) yield* updateLocalBranch(run, base);
      if (remoteTarget !== base && config.push) {
        yield* run.info(`pushing unpublished commits to ${forkRemote}/${targetBranch}`);
        yield* gitOk(repo, ["push", forkRemote, `${base}:refs/heads/${targetBranch}`], run);
        outcome.pushed = "yes";
      }
      outcome.mergedSha = base;
      yield* run.info("already in sync with upstream");
      yield* clearAlert(config);
      yield* writeState(run, "up-to-date", `in sync (${outcome.upstreamSha.slice(0, 9)})`);
      return { kind: "up-to-date" } satisfies SyncResult as SyncResult;
    }

    yield* run.step("preparing the isolated worktree");
    yield* ensureWorktree(run, base);

    yield* run.step(`merge ${upstream} -> ${targetBranch}`);
    const merge = yield* git(worktree, ["merge", "--no-ff", "--no-commit", upstream], run);
    const conflicts = yield* unmergedPaths(worktree);
    outcome.conflicts = conflicts.length;

    if (conflicts.length > 0) {
      yield* run.warn(`${conflicts.length} conflicted file(s); handing them to an agent`);
      if (!(yield* agent.available)) {
        const detail = `${conflicts.length} conflicts and no T3 Code server to run an agent`;
        yield* run.error(`${detail}; aborting the merge`);
        yield* git(worktree, ["merge", "--abort"]);
        yield* writeState(run, "conflict-no-agent", detail);
        yield* raiseAlert(
          run,
          "t3 fork sync: conflict without an agent",
          `${conflicts.length} files. Open T3 Code and run: t3 fork sync`,
        );
        return yield* stop(detail);
      }
      yield* resolveConflicts(run, agent, conflicts);
    } else if (merge.code !== 0) {
      yield* git(worktree, ["merge", "--abort"]);
      return yield* new ForkSyncError({
        detail: `the merge failed without file conflicts (exit ${merge.code})`,
      });
    } else {
      yield* run.info("clean merge, no conflicts");
    }
    yield* gitOk(worktree, ["add", "-A"]);

    if (config.verify) {
      yield* run.step("verification (typecheck + lint)");
      yield* verify(run, agent);
    }

    yield* run.step("commit");
    const message = yield* commitMessage(run, agent, behind);
    run.raw(`${message.trimEnd().replace(/^/gm, "    ")}\n`);
    const nothingStaged = (yield* git(worktree, ["diff", "--cached", "--quiet"])).code === 0;
    const merging =
      (yield* gitText(worktree, ["rev-parse", "-q", "--verify", "MERGE_HEAD"])) !== "";
    if (nothingStaged && !merging) {
      yield* run.info("nothing to commit");
    } else {
      const messagePath = NodePath.join(config.baseDir, ".commit-msg");
      NodeFS.writeFileSync(messagePath, message);
      const identity = (key: string, fallback: string) =>
        Effect.map(gitText(repo, ["config", key]), (value) => value || fallback);
      yield* gitOk(worktree, [
        "-c",
        `user.name=${yield* identity("user.name", "t3code-sync")}`,
        "-c",
        `user.email=${yield* identity("user.email", "t3code-sync@localhost")}`,
        "commit",
        "-q",
        "-F",
        messagePath,
      ]);
    }
    outcome.mergedSha = yield* gitOk(worktree, ["rev-parse", "HEAD"]);
    yield* run.info(`merge commit: ${outcome.mergedSha.slice(0, 9)}`);

    yield* run.step(`updating local ${targetBranch}`);
    yield* updateLocalBranch(run, outcome.mergedSha);

    if (config.push && outcome.verify !== "fail") {
      yield* run.step(`push to ${forkRemote}/${targetBranch}`);
      const pushed = yield* git(
        repo,
        ["push", forkRemote, `${outcome.mergedSha}:refs/heads/${targetBranch}`],
        run,
      );
      if (pushed.code !== 0) {
        outcome.pushed = "failed";
        yield* run.error("push failed");
        yield* writeState(run, "push-failed", "merged, but the push failed");
        yield* raiseAlert(
          run,
          "t3 fork sync: push failed",
          "The local merge is fine; pushing to the fork failed.",
        );
        return yield* stop("merged, but the push failed");
      }
      outcome.pushed = "yes";
      yield* run.info("push ok");
    } else {
      yield* run.info("the merge stays local (push disabled or verification failed)");
    }
    return { kind: "merged", commitCount: behind } satisfies SyncResult as SyncResult;
  });
