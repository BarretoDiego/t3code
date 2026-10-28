---
description: Merge pingdotgg/t3code main into the BarretoDiego fork, keep fork features working, ship via PR
argument-hint: "[upstream-ref (default: upstream/main)] [--no-merge-pr]"
---

<task>
Bring every commit from upstream (`pingdotgg/t3code`, remote `upstream`) into the fork's `main`
(`BarretoDiego/t3code`, remote `origin`) while keeping every fork modification working, then ship it
through the fork's PR path so the Fork Release workflow publishes a new nightly.

Arguments: $ARGUMENTS

- First positional arg: upstream ref to merge (default `upstream/main`).
- `--no-merge-pr`: stop after opening the PR instead of merging it.
</task>

<context>
- Remotes: `origin` = BarretoDiego/t3code (fork), `upstream` = pingdotgg/t3code. `gh` defaults to
  upstream here, so EVERY `gh` call needs `--repo BarretoDiego/t3code`.
- Merge style is a merge commit (`gh pr merge --merge`), never squash/rebase: the fork's history is
  a chain of upstream merges and rewriting it re-conflicts every past resolution.
- Fork CI (`ci.yml`) never starts (Blacksmith runners). Verification is local and is the gate.
  Pushing to `main` triggers `.github/workflows/fork-release.yml`, which builds the nightly the
  installed app self-updates from. A broken `main` ships a broken app.
- `~/.local/share/t3code-sync/sync.sh` (launchd) does an unattended version of this; it uses the
  worktree `~/.local/share/t3code-sync/worktree` on branch `t3sync/staging`. Never touch that
  worktree or branch from here.
- Follow AGENTS.md: never kill by pattern, never start a server against `~/.t3/userdata`, no
  repo-wide `vp check` / `vp run -r test` (typecheck + lint ARE run here because a merge touches
  everything; that is the explicit exception this command makes).
</context>

<procedure>
## 1. Preflight (read-only)
```bash
cd ~/Developer/open-source/t3code
git fetch upstream --quiet && git fetch origin --quiet
git rev-list --count origin/main..upstream/main      # 0 → report "already in sync" and stop
git rev-list --count --no-merges upstream/main..origin/main   # fork-only commits to protect
gh pr list --repo BarretoDiego/t3code --state open    # an open sync PR? continue it, don't duplicate
```
Do the work in a NEW worktree from `origin/main`, never in the main checkout (it may hold the
user's in-progress branch):
```bash
DATE=$(date +%Y%m%d); BR=chore/sync-upstream-$DATE; WT=../t3code-sync-$DATE
git worktree add -b $BR $WT origin/main
cd $WT && git merge --no-ff --no-commit upstream/main
git diff --name-only --diff-filter=U > /tmp/t3conflicts.txt
```

## 2. Resolve conflicts — preserve BOTH intents

Rules for every hunk:

1. Upstream's evolution AND the fork's modification must both survive. If upstream refactored or
   renamed the area, re-implement the fork change on the new structure. Drop a fork change only when
   upstream now does literally the same thing — and say so in the PR body.
2. Learn intent before choosing: `git log --oneline upstream/main..origin/main --no-merges -- <f>`
   (fork) and `git log --oneline origin/main..upstream/main -- <f>` (upstream), then `git show`.
3. Upstream's mass comment rewrites (e.g. "halve code comments") are comment-only hunks: take
   upstream's comment, keep the fork's code.
4. Status `UD` (upstream deleted, fork modified): find where upstream moved the logic, port the fork
   change there, then `git rm` the file. `AA` test files: union of both test sets.
5. Defaults that upstream flipped and the fork never changed (compare against
   `git merge-base origin/main upstream/main`): take upstream's.

Known hot spots (check every time):

- **SQL migrations — `apps/server/src/persistence/Migrations.ts`.** The fork's migration ids are
  already recorded in real user databases and must NEVER be renumbered. Keep the fork's entries
  verbatim, and append every upstream migration that isn't in the fork yet with the next free fork
  id (keep upstream's file name; import as `Migration00NN` matching the new id). Add a short comment
  saying which upstream ids they were. Then update tests pinned to ids:
  `grep -rn "toMigrationInclusive: *[0-9]" apps/server` for new upstream migration tests, the expected
  list in `Migrations.test.ts`, and `reconcileV2PreviewMigration.test.ts`. The fork's
  `reconcileV2PreviewMigration.ts` (refuse upstream-preview ledgers) and `ORCHESTRATION_V2_MIGRATION_ID`
  stay the fork's version.
- **`packages/contracts`**: shared by server/web/mobile. When the fork extracted a schema into a named
  export (e.g. `OrchestrationV2MessageDispatchCommand`) and upstream added fields inline, add the
  new fields to the fork's named schema. `rpc.ts`: the fork splits `WsCoreRpcGroup` + `WsForkRpcGroup`;
  new upstream RPCs go into `WsCoreRpcGroup`.
- **`settings.ts`**: keep fork settings (`sidebarExperience`, `sourceControlReview`, ...) next to
  upstream's new ones.
- **`package.json` exports/deps**: union; must still parse as JSON.
- **Generated files** — never hand-merge: `pnpm-lock.yaml` and `apps/web/src/routeTree.gen.ts`.
  Take upstream's (`git checkout --theirs <f>`), then regenerate in step 3.

For large conflict sets, split by area (apps/mobile, apps/web, apps/server minus persistence) across
parallel subagents on the strongest model, each restricted to its file list and forbidden from any
mutating git command, installs, or dev servers. Keep persistence, contracts, lockfile and generated
files yourself. Treat each subagent report as a claim: re-read its hunks.

Done when: `grep -rn '^<<<<<<<\|^>>>>>>>' $(cat /tmp/t3conflicts.txt)` prints nothing.

## 3. Regenerate and verify (the gate)

Every shell needs the toolchain on PATH (vp is a global shell function; pnpm comes from
`~/Library/pnpm`):
`export PATH="/opt/homebrew/bin:$HOME/Library/pnpm:$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"`

```bash
git checkout --theirs pnpm-lock.yaml apps/web/src/routeTree.gen.ts
vp i                                    # rewrites pnpm-lock.yaml from the merged package.jsons
```

`routeTree.gen.ts`: regenerate with the TanStack generator that `@tanstack/router-plugin` bundles
(it is not a direct dependency, so resolve it through the plugin), run from `apps/web`:

```bash
cd apps/web && GEN=$(node -e 'const {createRequire}=require("module");console.log(createRequire(require.resolve("@tanstack/router-plugin/package.json")).resolve("@tanstack/router-generator"))')
node --input-type=module -e "const {Generator,getConfig}=await import('$GEN');const root=process.cwd();await new Generator({config:getConfig({autoCodeSplitting:true},root),root}).run()"
```

Then confirm the fork's own routes (e.g. `_chat.settings.ai-runtimes`, `automation`, `mini-skills`,
`agent-profiles`) are in it. If upstream moved a route folder, move the fork's route files with it.

Gate, in this order (all must pass):

1. **Typecheck every package.** `vp run -r typecheck` stops at the first failing package and hides
   the rest, and `apps/web` / `apps/desktop` define `typecheck` as a Vite+ task, not a package
   script. Run `vp run typecheck` inside each `packages/*` and `apps/*` that has one (in parallel,
   4 at a time) to get the full error list; finish with `vp run -r typecheck` = exit 0.
2. **Lint** `vp lint --report-unused-disable-directives` = 0 errors.
3. **Format** `vp fmt --check` (run `vp fmt <files>` on what it lists).
4. **Migrations on real data**: `node apps/server/scripts/migrate-dev-db.ts` in the worktree. It
   reads `~/.t3/userdata/statev2.sqlite` read-only and must log only the newly appended ids.
5. **Tests**: `vp test run apps/server/src/persistence`, `vp test run packages`,
   `cd apps/web && vp test run --project unit`, `vp test run apps/mobile/src`, and
   `cd apps/server && TMPDIR=/private/tmp/t3tmp vp test run` (create the dir first).
6. **Release build**: `vp run build:desktop` (what `fork-release.yml` runs) = 5/5 successful.

What to expect and how to fix it:

- Upstream regularly turns on new Effect language-service diagnostics (`effectFnOpportunity`,
  `catchToOrElseSucceed`, ...) and new `t3code/*` lint rules (`no-low-value-comments`,
  `no-manual-memo`, `no-unreasoned-state-sync`, ...). They fail on fork-only code that predates
  them. Fix them for real (the rule sources live in `oxlint-plugin-t3code/`); the only accepted
  disable is a reasoned `// oxlint-disable-next-line <rule> -- <why>`. These are mechanical:
  delegate them by area to cheaper subagents with the error list in a file, after the
  conflict/type-error agents are done with the same files.
- Real type errors usually mean upstream moved or stopped exporting something a fork feature uses
  (package `exports`, removed helpers, renamed props). Re-point the fork code at upstream's new API.
- `reactCompilerCoverage.test.ts` fails when a Vite+/oxc bump makes the React Compiler choke on a
  fork component; rewrite the offending pattern (e.g. move a rest-parameter callback to module
  scope) instead of excluding the file.
- Tests pinned to migration ids (`toMigrationInclusive: N`, expected ledger lists in
  `Migrations.test.ts`, `055_OrchestrationV2.test.ts`, `reconcileV2PreviewMigration.test.ts`) must
  use fork ids.
- Known environment-only failures on this Mac (not merge bugs, don't "fix"): tests comparing temp
  paths without `TMPDIR=/private/tmp/...` (`/var` vs `/private/var`), `externalLauncher` VS Code
  Insiders test (real VS Code is installed), `026_CanonicalizeModelSelectionOptions` (local SQLite
  JSON behavior), `provider-fx` skills tests (same temp-path issue). Re-check this list each time:
  a test is environment-only only if it fails identically on `origin/main` or `upstream/main`.

Never silence with `any`, `@ts-ignore`, or blanket disables; never delete a fork feature to go
green. Confirm fork features still exist (grep the fork-only commit list from step 1 for features
touched by conflicts and check their entry points are still wired: routes, settings nav, RPC
groups, MCP toolkits, server layers).

Also check new upstream workflows in `.github/workflows/` (`git diff --name-status origin/main --
.github/workflows`): upstream deploy/release workflows must stay disabled on the fork
(`gh workflow disable <name> --repo BarretoDiego/t3code`) — ask before disabling.

## 4. Commit, PR, merge

```bash
git add -A && git commit -m "chore(sync): merge upstream main through $(git rev-parse --short upstream/main)"
git push -u origin $BR
gh pr create --repo BarretoDiego/t3code --base main --head $BR --title "chore(sync): merge upstream main through <sha>" --body-file <body>
```

PR body: number of upstream commits, conflict count, notable decisions (migration ids appended,
fork changes re-adapted or dropped and why, upstream defaults adopted), verification commands run
and their results, model and harness. Link the PR with the T3 `link_pull_request` tool.

Unless `--no-merge-pr`: `gh pr merge <n> --repo BarretoDiego/t3code --merge` (CI pending is expected).
Then confirm the release started:
`gh run list --repo BarretoDiego/t3code --workflow fork-release.yml --limit 1`.

## 5. Clean up

`git worktree remove $WT` and delete the local branch after merge. Leave the main checkout on
whatever branch the user had.
</procedure>

<human_review_needed>
Stop and ask before:

- renumbering or deleting any migration already on `origin/main`;
- dropping a fork feature because it conflicts with an upstream redesign;
- force-pushing anything, or merging while typecheck/lint/persistence tests fail.
  </human_review_needed>
