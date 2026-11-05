---
description: Merge pingdotgg/t3code main into the BarretoDiego fork, keep fork features working, ship via PR
argument-hint: "[upstream-ref (default: upstream/main)] [--no-merge-pr]"
---

Run the `sync-upstream` skill (`.agents/skills/sync-upstream/SKILL.md`) end to end and follow it exactly. It is the
single source of truth for this procedure; update it, not this file, when a run teaches something new.

Arguments: $ARGUMENTS

- First positional arg: upstream ref to merge (default `upstream/main`).
- `--no-merge-pr`: stop after opening the PR instead of merging it.
