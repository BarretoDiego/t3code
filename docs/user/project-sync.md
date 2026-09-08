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

Before Sync starts moving files, T3 Code compares both projects and shows you a summary of the
plan — how many files will be copied, how much data that is, and how many files (if any) will be
deleted — so you know what you are about to do before anything changes. Send skips this preview:
it is copying into a brand-new project, so there is nothing on the destination yet to compare
against.

## Sync Mirrors the Source

**Sync is a mirror, not a merge.** If a file exists on the destination but not on the source, Sync
deletes it from the destination so the two projects match. When a plan includes deletions, T3 Code
calls them out and asks you to confirm before continuing. If you are not sure both sides agree on
which one is the "real" copy, use Send into a fresh location instead of Sync, or review the plan
carefully before confirming.

## Including Git History

Both Send and Sync include your project's `.git` history by default, so the destination ends up as
a complete working copy you can commit and push from independently. Turn off **Include .git** if
you only want the working files without history — useful for a quick copy where you do not need
the destination to be its own Git checkout.

## Progress and Cancelling

While a sync runs, T3 Code shows progress by bytes and files transferred. You can cancel at any
time; anything already copied stays on the destination, and nothing partially written is left in a
broken state.

## Limitations

- **Mobile is not supported yet.** Start and manage a sync from the web or desktop app.
- **Fixed exclusions.** Sync always skips `node_modules`, T3's own state, and `.DS_Store`. There
  is no way to add your own ignore list from the UI in this version.
- **Avoid syncing while a turn is actively running** in the project you're copying from or to.
  Sync does not lock the workspace against concurrent writes, so files an agent is mid-edit on can
  end up copied in an inconsistent state. Wait for the agent to finish, or pause it, before you
  sync.
- Sync transfers are time-limited in flight. If a transfer sits idle for a long time and the link
  it was using expires, start the sync again rather than trying to resume it.

## Continue a Thread on Another Environment

For a Claude thread with a native session, choose **Continue on…** from the thread menu or
**Continue thread on…** in the command palette. Web, desktop and mobile can start the transfer.
Both environments must be connected, have compatible authenticated Claude installations, and
have the matching Git project available. The destination uses its own credentials.

An idle thread moves immediately. During a turn, choose to wait for it to finish or interrupt it
using Claude's normal stop mechanism. T3 preserves the conversation and native session, then
restores the branch, staged and unstaged changes, and relevant untracked files in a separate
checkout on the destination. Installed dependencies and ignored or reproducible untracked
artifacts are excluded. Historical absolute paths, local MCP services, terminals and running
processes are not recreated automatically.

Keep the transferring client and both environments available until completion. The thread's
execution indicator shows its owner and transfer progress. Once transfer completes, open the
same thread on the destination; the source can be shut down. An idle or interrupted thread
remains idle: T3 does not send an invented continuation message.

If the connection fails, use **Recover transfer**. Before ownership changes, recovery cancels
preparation and leaves the source resumable. After ownership changes, recovery finishes on the
destination. Do not manually resume the old source copy while recovery is pending.

This first version supports native Claude sessions only. Codex and other providers, threads with
attachments, custom source Claude homes that differ from the server configuration, and returning
a thread to an environment that already holds an earlier copy are blocked. The destination must
have an existing project; automatic clone setup is not available in the transfer selector.
