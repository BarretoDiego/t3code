#!/usr/bin/env bash
# Verification gate for an upstream sync. Run from the sync worktree root:
#
#   .agents/skills/sync-upstream/scripts/gate.sh [step ...]
#
# Steps (default: all, in this order): typecheck lint fmt knip migrate tests build
# Every step runs even if an earlier one fails, so one pass lists everything that is broken.
# Logs land in $GATE_LOG_DIR (default: <tmp>/t3sync-gate-<worktree name>); the summary prints
# the log path of each failing step. Exit code is 0 only when every selected step passed.
set -uo pipefail

export PATH="/opt/homebrew/bin:$HOME/Library/pnpm:$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
LOG_DIR="${GATE_LOG_DIR:-${TMPDIR:-/tmp}/t3sync-gate-$(basename "$ROOT")}"
SERVER_TMPDIR="${GATE_SERVER_TMPDIR:-/private/tmp/t3tmp}"
mkdir -p "$LOG_DIR" "$SERVER_TMPDIR"

ALL_STEPS=(typecheck lint fmt knip migrate tests build)
STEPS=("$@")
[[ ${#STEPS[@]} -eq 0 ]] && STEPS=("${ALL_STEPS[@]}")

if grep -rlq '^<<<<<<< \|^>>>>>>> ' --include='*.ts' --include='*.tsx' --include='*.json' --include='*.md' \
  apps packages scripts 2>/dev/null; then
  echo "Conflict markers are still in the tree; resolve them first:" >&2
  grep -rl '^<<<<<<< \|^>>>>>>> ' --include='*.ts' --include='*.tsx' --include='*.json' --include='*.md' \
    apps packages scripts 2>/dev/null | head -20 >&2
  exit 2
fi

FAILED=()
PASSED=()

# run_step <name> <command...>: logs to $LOG_DIR/<name>.log and records the outcome.
run_step() {
  local name="$1"
  shift
  local log="$LOG_DIR/$name.log"
  echo "==> $name"
  if "$@" >"$log" 2>&1; then
    PASSED+=("$name")
    echo "    pass"
  else
    FAILED+=("$name")
    echo "    FAIL  ($log)"
    tail -n 15 "$log" | sed 's/^/    | /'
  fi
}

# typecheck_package <dir>: `vp run -r typecheck` stops at the first failing package and hides the
# rest, and apps/web / apps/desktop define `typecheck` as a Vite+ task rather than a package
# script, so each package is checked on its own.
typecheck_package() {
  local dir="$1"
  local log="$LOG_DIR/typecheck-$(echo "$dir" | tr '/' '_').log"
  if (cd "$dir" && vp run typecheck >"$log" 2>&1); then
    echo "pass $dir"
  elif grep -qiE 'task .*not found|no .*typecheck|missing script' "$log"; then
    echo "skip $dir"
  else
    echo "FAIL $dir ($log)"
  fi
}
export -f typecheck_package
export LOG_DIR

step_typecheck() {
  local out="$LOG_DIR/typecheck.log"
  : >"$out"
  # Four at a time keeps the machine usable; tsgo is the heavy part.
  ls -d packages/*/ apps/*/ | sed 's#/$##' | while read -r d; do [[ -f "$d/package.json" ]] && echo "$d"; done |
    xargs -P 4 -I{} bash -c 'typecheck_package {}' >>"$out" 2>&1
  cat "$out"
  ! grep -q '^FAIL ' "$out"
}

step_lint() { vp lint --report-unused-disable-directives; }
step_fmt() { vp fmt --check; }
# Upstream's pre-commit hook runs this with --exports; it is the check that rejects a commit.
step_knip() { vp run knip:check; }
# Reads ~/.t3/userdata/statev2.sqlite read-only; must log only the newly appended migration ids.
step_migrate() { node apps/server/scripts/migrate-dev-db.ts; }

step_tests() {
  local rc=0
  vp test run apps/server/src/persistence || rc=1
  vp test run packages || rc=1
  (cd apps/web && vp test run --project unit) || rc=1
  vp test run apps/mobile/src || rc=1
  # The server suite compares temp paths, so it needs a TMPDIR without the /var symlink.
  (cd apps/server && TMPDIR="$SERVER_TMPDIR" vp test run) || rc=1
  return $rc
}

step_build() { vp run build:desktop; }

for step in "${STEPS[@]}"; do
  case "$step" in
    typecheck | lint | fmt | knip | migrate | tests | build)
      if [[ "$step" == "typecheck" ]]; then
        echo "==> typecheck"
        if step_typecheck; then PASSED+=("typecheck"); echo "    pass"; else FAILED+=("typecheck"); echo "    FAIL (see $LOG_DIR/typecheck-*.log)"; fi
      else
        run_step "$step" "step_$step"
      fi
      ;;
    *)
      echo "Unknown step: $step (expected one of: ${ALL_STEPS[*]})" >&2
      exit 2
      ;;
  esac
done

echo
echo "passed: ${PASSED[*]:-none}"
echo "failed: ${FAILED[*]:-none}"
echo "logs:   $LOG_DIR"
[[ ${#FAILED[@]} -eq 0 ]]
