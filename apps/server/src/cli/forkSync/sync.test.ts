// @effect-diagnostics nodeBuiltinImport:off - builds throwaway git repositories on disk.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { resolveForkSyncConfig } from "./config.ts";
import { makeRun, readState } from "./runtime.ts";
import { type ForkSyncAgent, syncFork } from "./sync.ts";

const sh = (cwd: string, ...args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  }).trim();

const write = (dir: string, name: string, contents: string) =>
  NodeFS.writeFileSync(NodePath.join(dir, name), contents);

/**
 * A fork one commit ahead of the point where it left upstream, with upstream
 * moved on since. `upstreamEdit` decides whether the two touch the same line.
 */
function scenario(upstreamEdit: { readonly file: string; readonly contents: string } | null) {
  const root = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-")));
  const upstream = NodePath.join(root, "upstream.git");
  const fork = NodePath.join(root, "fork.git");
  const seed = NodePath.join(root, "seed");
  const repo = NodePath.join(root, "repo");
  sh(root, "init", "-q", "--bare", "-b", "main", upstream);
  sh(root, "init", "-q", "-b", "main", seed);
  write(seed, "shared.txt", "original\n");
  sh(seed, "add", "-A");
  sh(seed, "commit", "-q", "-m", "base");
  sh(seed, "push", "-q", upstream, "main");
  sh(root, "clone", "-q", "--bare", upstream, fork);
  sh(root, "clone", "-q", fork, repo);
  sh(repo, "remote", "add", "upstream", upstream);
  sh(repo, "config", "user.name", "Fork Owner");
  sh(repo, "config", "user.email", "owner@example.com");
  write(repo, "shared.txt", "fork change\n");
  sh(repo, "commit", "-q", "-am", "fork: change shared");
  sh(repo, "push", "-q", "origin", "main");
  if (upstreamEdit !== null) {
    write(seed, upstreamEdit.file, upstreamEdit.contents);
    sh(seed, "add", "-A");
    sh(seed, "commit", "-q", "-m", "upstream: next");
    sh(seed, "push", "-q", upstream, "main");
  }
  const baseDir = NodePath.join(root, "sync");
  const config = resolveForkSyncConfig({
    values: { REPO: repo, VERIFY: "0" },
    baseDir,
    home: root,
    platform: "linux",
    arch: "x64",
  });
  NodeFS.mkdirSync(baseDir, { recursive: true });
  return {
    repo,
    fork,
    config,
    run: makeRun(config, { notifications: false, terminal: false }),
    forkHead: () => sh(fork, "rev-parse", "main"),
    forkFile: (name: string) => sh(fork, "show", `main:${name}`),
  };
}

const noAgent: ForkSyncAgent = {
  available: Effect.succeed(false),
  run: () => Effect.succeed({ ok: false, reply: "", detail: "no agent" }),
};

/** An agent that answers message requests and applies `edit` when asked to change files. */
const agentThat = (edit: (worktree: string) => void, worktree: string): ForkSyncAgent => ({
  available: Effect.succeed(true),
  run: (input) =>
    Effect.sync(() => {
      if (!input.edits)
        return {
          ok: true,
          reply: "```\nchore(sync): merge upstream\n\n\n- one thing\n```",
          detail: "",
        };
      edit(worktree);
      return { ok: true, reply: "resolved shared.txt", detail: "" };
    }),
});

const CONFLICTING = { file: "shared.txt", contents: "upstream change\n" };

describe("fork sync", () => {
  it.effect("merges upstream cleanly and publishes it without needing an agent", () =>
    Effect.gen(function* () {
      const test = scenario({ file: "new.txt", contents: "from upstream\n" });
      const result = yield* syncFork(test.run, noAgent);

      assert.deepStrictEqual(result, { kind: "merged", commitCount: 1 });
      assert.strictEqual(test.forkFile("new.txt"), "from upstream");
      assert.strictEqual(test.forkFile("shared.txt"), "fork change");
      assert.strictEqual(test.run.outcome.pushed, "yes");
      // The developer's checkout had the branch open and clean, so it follows.
      assert.strictEqual(sh(test.repo, "rev-parse", "HEAD"), test.forkHead());
      assert.include(sh(test.repo, "log", "-1", "--format=%s"), "chore(sync): merge upstream/main");
      assert.strictEqual(sh(test.repo, "log", "-1", "--format=%an"), "Fork Owner");
    }),
  );

  it.effect("has an agent resolve conflicts and commits its message", () =>
    Effect.gen(function* () {
      const test = scenario(CONFLICTING);
      const agent = agentThat(
        (worktree) => write(worktree, "shared.txt", "fork change\nupstream change\n"),
        test.config.worktree,
      );
      yield* syncFork(test.run, agent);

      assert.strictEqual(test.forkFile("shared.txt"), "fork change\nupstream change");
      assert.strictEqual(test.run.outcome.conflicts, 1);
      assert.strictEqual(test.run.outcome.agentUsed, true);
      // Code fences and repeated blank lines in the agent's reply are cleaned up.
      assert.strictEqual(
        sh(test.fork, "log", "-1", "--format=%B", "main").split("\n").slice(0, 3).join("|"),
        "chore(sync): merge upstream||- one thing",
      );
    }),
  );

  it.effect("leaves the fork untouched when conflicts have no agent to resolve them", () =>
    Effect.gen(function* () {
      const test = scenario(CONFLICTING);
      const before = test.forkHead();
      const error = yield* Effect.flip(syncFork(test.run, noAgent));

      assert.include(error.message, "no T3 Code server");
      assert.strictEqual(test.forkHead(), before);
      assert.strictEqual(readState(test.config.statePath)?.status, "conflict-no-agent");
      assert.isTrue(NodeFS.existsSync(test.config.alertPath));
      // The merge was aborted, so the next run starts from a clean worktree.
      assert.strictEqual(sh(test.config.worktree, "status", "--porcelain"), "");
    }),
  );

  it.effect("rejects a resolution that leaves conflict markers behind", () =>
    Effect.gen(function* () {
      const test = scenario(CONFLICTING);
      const before = test.forkHead();
      const error = yield* Effect.flip(
        syncFork(
          test.run,
          agentThat(() => {}, test.config.worktree),
        ),
      );

      assert.include(error.message, "did not resolve every conflict");
      assert.strictEqual(test.forkHead(), before);
      assert.strictEqual(readState(test.config.statePath)?.status, "unresolved");
    }),
  );

  it.effect("rejects an agent that commits instead of only editing files", () =>
    Effect.gen(function* () {
      const test = scenario(CONFLICTING);
      const before = test.forkHead();
      const agent = agentThat((worktree) => {
        write(worktree, "shared.txt", "agent took over\n");
        sh(worktree, "commit", "-q", "-am", "agent commit");
      }, test.config.worktree);
      const error = yield* Effect.flip(syncFork(test.run, agent));

      assert.include(error.message, "changed git state");
      assert.strictEqual(test.forkHead(), before);
    }),
  );

  it.effect("does nothing when upstream has nothing new", () =>
    Effect.gen(function* () {
      const test = scenario(null);
      const before = test.forkHead();
      const result = yield* syncFork(test.run, noAgent);

      assert.deepStrictEqual(result, { kind: "up-to-date" });
      assert.strictEqual(test.forkHead(), before);
      assert.strictEqual(readState(test.config.statePath)?.status, "up-to-date");
    }),
  );

  it.effect("publishes local commits the fork does not have yet, even with nothing to merge", () =>
    Effect.gen(function* () {
      const test = scenario(null);
      write(test.repo, "local.txt", "not pushed yet\n");
      sh(test.repo, "add", "-A");
      sh(test.repo, "commit", "-q", "-m", "fork: local only");
      yield* syncFork(test.run, noAgent);

      assert.strictEqual(test.forkFile("local.txt"), "not pushed yet");
    }),
  );
});
