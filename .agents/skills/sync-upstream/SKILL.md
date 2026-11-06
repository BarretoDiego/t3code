---
name: sync-upstream
description: Merge pingdotgg/t3code main into the BarretoDiego/t3code fork, keep every fork feature working, verify locally, and ship through a PR so Fork Release publishes a new nightly. Use when asked to update, sync, or reconcile the fork with upstream, or when the unattended t3code-sync job is stuck.
---

# Sync the fork with upstream

Bring every commit from upstream (`pingdotgg/t3code`, remote `upstream`) into the fork's `main`
(`BarretoDiego/t3code`, remote `origin`) without losing a fork feature, then ship through the fork's
PR path. Pushing to `main` triggers `.github/workflows/fork-release.yml`, which builds the nightly the
installed app self-updates from, so a broken `main` ships a broken app.

Run it from a T3 Code thread on this project: "sync the fork with upstream" or `/sync-upstream`. Any
provider can follow it; the two scripts next to this file do the mechanical parts.

Arguments (from the user's request): the upstream ref to merge (default `upstream/main`), and
`--no-merge-pr` to stop after opening the PR.

## Facts that shape everything

- `gh` defaults to upstream here, so every `gh` call needs `--repo BarretoDiego/t3code`.
- Merge style is a merge commit (`gh pr merge --merge`), never squash or rebase: the fork's history is a
  chain of upstream merges, and rewriting it re-conflicts every past resolution.
- Fork CI never starts (Blacksmith runners). Local verification is the gate.
- `~/.local/share/t3code-sync/sync.sh` (launchd) is an unattended version of this. It blocks the push when
  typecheck or lint fail, so it stalls after big upstream jumps. Never touch its worktree
  `~/.local/share/t3code-sync/worktree` or branch `t3sync/staging`.
- AGENTS.md still applies: never kill by pattern, never start a server against `~/.t3/userdata`. The
  repo-wide checks it forbids are the explicit exception this skill makes, because a merge touches everything.
- `.repos/` is vendored reference material and dominates the diff stat. Ignore it.

## 1. Preflight and merge

```bash
.agents/skills/sync-upstream/scripts/preflight.sh            # read-only report
.agents/skills/sync-upstream/scripts/preflight.sh --start    # also creates ../t3code-sync-<date> and starts the merge
```

Zero commits behind means "already in sync": report it and stop. An open sync PR means continue it
instead of duplicating. All work happens in the new worktree, never in the primary checkout, which may
hold the user's in-progress branch.

The report lists each conflicted file with its status and hunk count. `DU` (fork deleted, upstream
changed) and `UD` (upstream deleted, fork changed) need a decision, not a text merge.

## 2. Resolve conflicts, preserving both intents

For every hunk:

1. Upstream's evolution and the fork's modification must both survive. If upstream refactored or renamed
   the area, re-implement the fork change on the new structure. Drop a fork change only when upstream now
   does literally the same thing, and say so in the PR body.
2. Learn intent before choosing: `git log --oneline <merge-base>..origin/main --no-merges -- <file>` (fork),
   `git log --oneline <merge-base>..upstream/main -- <file>` (upstream), then `git show`.
3. Upstream's mass comment rewrites are comment-only hunks: take upstream's comment, keep the fork's code.
4. `UD`: find where upstream moved the logic, port the fork's change there, then `git rm` the file.
   `AA` test files: union of both test sets.
5. `DU`: check why the fork deleted it (`git log --diff-filter=D -- <file>`). When the fork replaced it
   with its own implementation, keep it deleted and port the upstream changes to that implementation.
   Today this is `apps/web/src/components/Sidebar.tsx` and `sidebar/*`: the fork renders
   `OriginalSidebar.tsx`, `LegacySidebar.tsx` and `GroupedSidebar.tsx`. Look up each upstream commit that
   touched the deleted files and port it, or record why it does not apply.
6. A default upstream flipped that the fork never changed (compare with the merge base): take upstream's.
7. A hunk is a claim to re-read, never a mechanical pick. When both sides added different code in the
   same place, the answer is usually both.

Hot spots, check every time:

- **SQL migrations, `apps/server/src/persistence/Migrations.ts`.** The fork's migration ids are already in
  real user databases and must NEVER be renumbered. Keep the fork's entries verbatim and append every
  upstream migration the fork lacks with the next free fork id (keep upstream's file name; import as
  `Migration00NN` matching the new id) plus a comment naming the upstream ids. Then fix tests pinned to ids:
  `grep -rn "toMigrationInclusive: *[0-9]" apps/server`, the expected lists in `Migrations.test.ts` and
  `reconcileV2PreviewMigration.test.ts`, the `{ length: N }` and name lists in `055_OrchestrationV2.test.ts`,
  and `077_RepairBooleanSettledOverride.test.ts`. A new upstream test that pins "the last pre-V2 id" uses the
  fork's `PRE_V2`. `reconcileV2PreviewMigration.ts` and `ORCHESTRATION_V2_MIGRATION_ID` stay the fork's.
- **`packages/contracts`** is shared by server, web and mobile. When the fork extracted a schema into a named
  export and upstream added fields inline, add them to the fork's named schema. `rpc.ts`: the fork splits
  `WsCoreRpcGroup` and `WsForkRpcGroup`; new upstream RPCs go into `WsCoreRpcGroup`.
- **`settings.ts`**: fork settings (`sidebarExperience`, `sourceControlReview`, ...) next to upstream's.
- **`package.json` exports and deps**: union; must still parse.
- **`pnpm-workspace.yaml`**: upstream enforces `strictPeerDependencies`. A fork-only dependency with an
  out-of-range peer fails `vp i`; allow it under `peerDependencyRules.allowedVersions` with a comment saying why.
- **Generated files, never hand-merged**: `pnpm-lock.yaml`, `apps/web/src/routeTree.gen.ts`. Take upstream's
  with `git checkout --theirs <f>` and regenerate (below).
- **`ws.ts` / `layerWsRpc`, `McpHttpServer.ts`, `Orchestrator.ts`**: fork services are threaded through long
  positional argument lists and layer compositions. Upstream appends its own; keep both in order.
- **`agentContextBudget.json`**: take either side, then replace it with measured values (step 3).

Large conflict sets: split by area (mobile, web, server minus persistence) across parallel subagents on the
strongest model. Each gets its file list and the rules above, and is forbidden from mutating git, installing,
or starting dev servers. Keep persistence, contracts, the lockfile and generated files yourself. Treat each
report as a claim and re-read its hunks.

Done when no `<<<<<<<` / `>>>>>>>` remains and `git diff --name-only --diff-filter=U` is empty after `git add`.

## 3. Regenerate and verify

Every shell needs the toolchain on PATH (`vp` may be a shell function; pnpm lives in `~/Library/pnpm` on macOS).
Add only the directories that exist; `gate.sh` does this itself:

```bash
for d in "$HOME/.local/share/mise/shims" "$HOME/.local/bin" "$HOME/Library/pnpm" /opt/homebrew/bin; do
  [ -d "$d" ] && PATH="$d:$PATH"
done
export PATH
git checkout --theirs pnpm-lock.yaml apps/web/src/routeTree.gen.ts
vp i
```

Regenerate the route tree with the generator that `@tanstack/router-plugin` bundles, from `apps/web`:

```bash
cd apps/web && GEN=$(node -e 'const {createRequire}=require("module");console.log(createRequire(require.resolve("@tanstack/router-plugin/package.json")).resolve("@tanstack/router-generator"))')
node --input-type=module -e "const {Generator,getConfig}=await import('$GEN');const root=process.cwd();await new Generator({config:getConfig({autoCodeSplitting:true},root),root}).run()"
```

Confirm the fork's routes survive (`ai-runtimes`, `automation`, `mini-skills`, `agent-profiles`). If upstream
moved a route folder, move the fork's route files with it.

The gate runs everything and reports every failure in one pass (logs in a temp dir it prints):

```bash
.agents/skills/sync-upstream/scripts/gate.sh                 # typecheck lint fmt knip migrate tests build
.agents/skills/sync-upstream/scripts/gate.sh typecheck lint  # or a subset while iterating
```

Steps, in order: typecheck every package on its own (`vp run -r typecheck` hides everything after the first
failing package), `vp lint --report-unused-disable-directives`, `vp fmt --check`, `vp run knip:check`,
`node apps/server/scripts/migrate-dev-db.ts` (reads `~/.t3/userdata/statev2.sqlite` read-only and must log only
the newly appended ids), the test suites, and `vp run build:desktop` (what `fork-release.yml` runs; expect 5/5).

What to expect and how to fix it:

- **Upstream tightens its gates every sync** (Effect diagnostics such as `effectFnOpportunity`, `t3code/*` lint
  rules such as `no-low-value-comments`, `no-manual-memo`, `no-unreasoned-state-sync`, and `knip --exports`).
  They fail on fork-only code that predates them. Fix them for real; rule sources live in
  `oxlint-plugin-t3code/`. The only accepted disable is a reasoned
  `// oxlint-disable-next-line <rule> -- <why>`. These fixes are mechanical: delegate them by area to cheaper
  subagents with the error list in a file, after the conflict agents are done with the same files.
- **knip `--exports`** rejects exports only used inside their own file and declarations nothing uses. Run
  `./node_modules/.bin/knip --fix --fix-type exports` with the same `--workspace` list as the `knip:check`
  script in `package.json` (without it knip also rewrites apps/mobile, infra and scripts; revert those with
  `git checkout -- <dir>`), then delete declarations that are truly dead. Confirm each was already unused on
  `origin/main` before deleting. A layer that is intentionally unused by the base server but turns a feature on
  (for example `ThreadExecutionFence.layer`) is kept and listed under `ignoreIssues` in `knip.jsonc` with a
  why-comment; deleting it silently disables the feature.
- **Real type errors** usually mean upstream moved or stopped exporting something a fork feature uses. Re-point
  the fork code at upstream's new API. Recurring shapes:
  - A dependency bump removes a module (Effect 4.1 dropped `effect/Crypto`: random ids now come from
    `effect/crypto/SecureRandom`, digests from `effect/crypto/Digest`, HMAC from `effect/crypto/Mac`, and
    signing from `AssetSigner` / `PayloadSigner`). Migrate every fork call site, then give fork tests
    `NodeCrypto.layer` (and `AssetSigner.layer` where URLs are signed). One missing module cascades into
    hundreds of `unknown` requirement errors; fix the `TS2307` imports first and re-run before reading the rest.
  - Upstream removes an RPC or helper the fork still calls (`serverGetSettings` went away upstream but fork CLI
    commands use it): keep the fork's contract entry and adapt the handler to the new helper signature.
  - A new upstream package that implements a fork-extended interface (a new provider driver) needs the
    fork's extra fields wired (for example `icon` in the driver's instance identity).
  - Upstream adds a test for a file the fork deleted (`Sidebar.browser.test.tsx`): `git rm` it.
- **New `tsconfig.effect.json` rules** (`extendsNativeError`, `processEnvInEffect`, `preferSchemaTaggedError`,
  `effectTryWithoutCatch`, ...) fail on fork code. Fix for real; where the code is deliberately outside Effect,
  use `// @effect-diagnostics-next-line <rule>:off -- <why>`. `schemaClassMissingBrand` shows up as a
  `suggestion`, not an error; ignore those lines.
- **`reactCompilerCoverage.test.ts`** fails when a toolchain bump makes the React Compiler choke on a fork
  component. Rewrite the pattern instead of excluding the file.
- **`AgentContextBudget.test.ts`** compares the MCP tool list and prompt sizes with `agentContextBudget.json`.
  The fork adds tools, so run it, and write the measured numbers into the JSON.
- **Tests pinned to migration ids** use fork ids (see the hot spot above).
- **Environment-only failures on this Mac** (not merge bugs, do not "fix"): tests comparing temp paths without
  a `TMPDIR` that resolves through a symlink (`gate.sh` sets a resolved one), `externalLauncher` VS Code Insiders, `provider-fx` skills (same temp-path issue),
  `promptStashStore` (Node 25 `localStorage`), `usageFormat` DST, `MarketplaceService` manifest test when the cwd
  is not the repo root. A test is environment-only only if it fails identically on `origin/main` or
  `upstream/main`: prove it by running it there, and list the ones you saw in the PR body.

Never silence with `any`, `@ts-ignore` or blanket disables, and never delete a fork feature to go green.
Confirm fork features still exist: grep the fork-only commit list from preflight for features touched by
conflicts and check their entry points are still wired (routes, settings nav, RPC groups, MCP toolkits,
server layers).

Check new upstream workflows (`git diff --name-status origin/main -- .github/workflows`). Upstream deploy and
release workflows must stay disabled on the fork (`gh workflow disable <name> --repo BarretoDiego/t3code`);
ask before disabling.

## 4. Commit, PR, merge

```bash
git add -A && git commit -m "chore(sync): merge upstream main through $(git rev-parse --short upstream/main)"
git push -u origin chore/sync-upstream-<date>
gh pr create --repo BarretoDiego/t3code --base main --head chore/sync-upstream-<date> \
  --title "chore(sync): merge upstream main through <sha>" --body-file <body>
```

The pre-commit hook runs `vp run knip:check`. If an intermediate commit (a merge with known leftovers) must
bypass it, use `--no-verify` for that commit only, never the final one, and say so in the PR body.

PR body: number of upstream commits, conflict count, notable decisions (migration ids appended, fork changes
re-adapted or dropped and why, upstream defaults adopted, upstream deltas ported to the fork's replacement
code), the verification commands and their results, the environment-only failures, and the model and
harness. Link the PR with the T3 `link_pull_request` tool.

Unless `--no-merge-pr`: `gh pr merge <n> --repo BarretoDiego/t3code --merge` (pending checks are expected).
Then confirm the release started: `gh run list --repo BarretoDiego/t3code --workflow fork-release.yml --limit 1`.
It takes about half an hour; the installed app updates itself once the nightly is published.

## 5. Clean up

`git worktree remove <worktree>` and delete the local branch after the merge. Leave the primary checkout on
whatever branch the user had. If the sync taught something new, update this file in the same PR.

## Ask before

- renumbering or deleting any migration already on `origin/main`;
- dropping a fork feature because it conflicts with an upstream redesign;
- force-pushing anything, or merging while typecheck, lint or persistence tests fail.

## Unattended runs

The fork's scheduled tasks run this skill with no human present. Never ask a question: if a step would need
a decision from the "Ask before" list, or the gate fails, stop where you are, leave the PR open (do not merge),
and reply with a short report of what is blocking and what you already did.

- **Prepare** (`--no-merge-pr`): keep exactly one open sync PR. If an open `chore/sync-upstream-*` PR exists
  (preflight lists open PRs), update that branch with the new upstream commits and refresh its body instead of
  opening another. Stop after the gate passes and the PR is up to date.
- **Publish**: take the open sync PR (or prepare one if none exists), re-run the gate on its latest commit,
  and merge only when it passes. With nothing to merge, say so and finish.
