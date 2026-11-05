#!/usr/bin/env bash
# Preflight for an upstream sync. Works from any checkout of the repo.
#
#   preflight.sh [--ref <upstream-ref>] [--start]
#
# Without --start it is read-only: fetches both remotes, reports how far behind the fork is,
# the fork-only commits to protect, open PRs, and leftover sync worktrees.
# With --start it also creates a sync worktree next to the primary checkout from origin/main and
# begins `git merge --no-ff --no-commit`, then lists the conflicts with their status and hunk count.
set -euo pipefail

REF="upstream/main"
START=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref) REF="$2"; shift 2 ;;
    --start) START=1; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

FORK_REPO="BarretoDiego/t3code"
# The first entry of `git worktree list` is the primary checkout, whatever worktree we run from.
PRIMARY="$(git worktree list --porcelain | awk '/^worktree /{print substr($0,10); exit}')"
cd "$PRIMARY"

git fetch upstream --quiet
git fetch origin --quiet

BEHIND="$(git rev-list --count origin/main.."$REF")"
echo "fork main:        $(git log -1 --format='%h %s' origin/main)"
echo "upstream ($REF): $(git log -1 --format='%h %cs %s' "$REF")"
echo "commits to merge: $BEHIND"
if [[ "$BEHIND" == "0" ]]; then
  echo "Already in sync; nothing to do."
  exit 0
fi
echo "fork-only commits to protect: $(git rev-list --count --no-merges "$REF"..origin/main)"
echo
echo "open PRs on the fork (an open sync PR means: continue it, do not duplicate):"
gh pr list --repo "$FORK_REPO" --state open || echo "  (gh failed; check auth)"
echo
echo "existing sync worktrees/branches (never touch t3sync/staging or ~/.local/share/t3code-sync):"
git worktree list | grep -i 'sync' || echo "  none"

[[ "$START" == "1" ]] || exit 0

DATE="$(date +%Y%m%d)"
BRANCH="chore/sync-upstream-$DATE"
WT="$(dirname "$PRIMARY")/t3code-sync-$DATE"
if [[ -e "$WT" ]]; then
  echo "Worktree $WT already exists; resuming there." >&2
  cd "$WT"
else
  git worktree add -b "$BRANCH" "$WT" origin/main
  cd "$WT"
  # Conflicts make the merge exit non-zero; that is the expected outcome.
  git merge --no-ff --no-commit "$REF" >/dev/null 2>&1 || true
fi

echo
echo "worktree: $WT"
echo "branch:   $BRANCH"
echo "conflicts (status, hunks, file):"
git diff --name-only --diff-filter=U | while read -r f; do
  status="$(git status --short -- "$f" | cut -c1-2)"
  hunks="$(grep -c '^<<<<<<< ' "$f" 2>/dev/null || true)"
  echo "  $status ${hunks:-0} $f"
done | sort -k2 -rn
echo
echo "Status legend: UU both modified | DU the fork deleted it, upstream changed it | UD upstream deleted it, the fork changed it | AA both added."
