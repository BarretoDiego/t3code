# Sync Projects Between Environments

Copy a project from one environment to another — for example, from your desktop to a homelab
server, or from a laptop to a remote box you pair over Tailscale. T3 Code reads the files from
wherever the project already lives and writes them to the destination, using whatever connection
you already have to each environment. There is no separate transfer setup: if you can pair with
both environments, you can sync between them.

## When to Use It

- Starting the same project on a second machine, such as moving work from a laptop onto a
  homelab or cloud box for a long-running task.
- Keeping a project's working tree up to date on a remote environment as you keep working on it
  locally (or the other way around).
- Standing up a fresh environment with a project you already have elsewhere, including its Git
  history.

This is a filesystem copy between two environments you already control. It does not create
threads, run an agent, or touch either environment's conversation history — only project files
move.

## Starting a Sync

You can start a sync from either environment involved, in two places:

- **Command Palette** (`Cmd/Ctrl + K`) → **Sync project between environments**
- **Project Settings** → **Sync**, from the project you want to copy

Either entry point walks you through picking the other environment and the project (or
destination folder) on that side.

## Send vs. Sync

Two modes cover the two things you actually want to do:

- **Send** creates a new project on the destination environment and copies everything into it.
  The destination folder defaults to that environment's own "Add project starts in" location, and
  you can change it before sending. Use Send the first time a project needs to exist somewhere
  else.
- **Sync** updates a project that already exists on both sides. T3 Code compares the two projects
  file by file and copies only what changed.

Before either mode starts moving files, T3 Code shows you a summary of the plan — how many files
will be copied and how much data that is — so you know what you are about to do.

## Sync Mirrors the Source

**Sync is a mirror, not a merge.** If a file exists on the destination but not on the source, Sync
deletes it from the destination so the two projects match. When a plan includes deletions, T3 Code
calls them out and asks you to confirm before continuing. If you are not sure both sides agree on
which one is the "real" copy, use Send into a fresh location instead of Sync, or review the plan
carefully before confirming.

## Including Git History

Sync includes your project's `.git` history by default, so the destination ends up as a complete
working copy you can commit and push from independently. Turn off **Include .git** if you only
want the working files without history — useful for a quick copy where you do not need the
destination to be its own Git checkout.

## Progress and Cancelling

While a sync runs, T3 Code shows progress by bytes and files transferred. You can cancel at any
time; anything already copied stays on the destination, and nothing partially written is left in a
broken state.

## Limitations

- **Mobile is not supported yet.** Start and manage a sync from the web or desktop app.
- **Ignoring extra folders** (beyond the always-skipped `node_modules`, T3's own state, and
  `.DS_Store`) matches exact folder names only — you cannot use wildcard patterns.
- **Avoid syncing while a turn is actively running** in the project you're copying from or to.
  Sync does not lock the workspace against concurrent writes, so files an agent is mid-edit on can
  end up copied in an inconsistent state. Wait for the agent to finish, or pause it, before you
  sync.
- Sync transfers are time-limited in flight. If a transfer sits idle for a long time and the link
  it was using expires, start the sync again rather than trying to resume it.
