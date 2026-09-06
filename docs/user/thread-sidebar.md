# Working with threads

Use a new thread for a separate task. Choose **New worktree** when its code changes
need a separate branch and working directory.

## Start a thread

On web and desktop, a new thread keeps the current project and carries your model
and mode selections, unless the destination project has its own model default.
Its branch and workspace mode come from your configured defaults. To continue in
an existing worktree, use **New thread in this worktree** from the branch toolbar.

When you change a new thread's project, T3 Code stays in the current environment
if that project exists there. Otherwise it selects an environment that has it.

### Start in the background

In a desktop browser or the desktop app, press `Cmd+Enter` on macOS or `Ctrl+Enter`
on Windows and Linux to start a new thread and immediately open another draft. The
next draft keeps the workspace mode and base branch you selected. With **New
worktree**, each background submission creates its own worktree.

## Pin and reorder threads

Pin a thread from its menu to keep it above your active work.

Pinning does not prevent automatic settlement. Settling a thread removes its pin.

On web and desktop, drag a thread between sections to change its state. Drag a thread up into
the pinned section to pin it at the spot you drop it; drag a pinned thread down into the active
list to unpin it. Dragging a thread onto the **Settled** header settles it, and dragging a settled
thread into the active list un-settles it. A snoozed thread can be dragged out of the snoozed
shelf, which wakes it, but threads cannot be dragged into the shelf because snoozing needs a wake
time. Dragging a pinned thread out of the pinned section does not ask for unpin confirmation.
Pinned and active boundary labels appear only while dragging, without moving the rows. The
destination boundary highlights. When you cross into another section, the dragged thread shows
its destination, such as **→ Active**. Its usual pin, status, and hover actions hide during the
drag. Reordering within the same section does not show a destination badge. When there are no
pins, drag to the top edge to pin a thread. Section labels also identify empty sections and a
collapsed settled shelf.

Drag within the pinned or active section to change its order. Other rows slide aside to show the
spot where the thread will land. Drops into either section keep the position you choose. On
mobile, open a pinned or active thread's menu and choose **Move up** or **Move down**. The server
saves the order, so it survives a refresh and appears on your other connected devices.

On web and desktop, the list also animates section changes made with thread actions such as
**Pin**, **Settle**, and **Snooze**. These transitions respect your system's reduced-motion
preference. While dragging, rows follow the insertion gap without replaying a second transition
after the drop.

New threads appear above the active threads you have arranged. Settling clears a thread's active
position, so using **Un-settle** returns it to the top. Pinning and snoozing preserve its active
position until you move it again. Thread activity does not change the order. The settled shelf
continues to use settlement time.

If dragging is unavailable for one environment, update the T3 Code server running in that
environment. Pinned and active reordering require server support. Threads from older servers keep
their default order until the server is updated.

## Settle finished work

Choose **Settle thread** from its menu to move finished work out of the active list
without deleting the conversation. **Un-settle thread** restores it to active work
and prevents automatic settlement until new activity resumes the usual rules.

By default, environments settle inactive threads after three days and settle
threads whose pull request merged. A closed pull request can also settle an idle
thread. Work in progress, pending questions or approvals, and live background work
prevent automatic settlement. An open pull request does not prevent inactivity
settlement, but an old closed or merged pull request does not settle work you
resumed after it closed.

Change settlement rules in **Settings → General**. They continue to run when your apps
are closed. Changes apply to connected environments that support shared settings;
offline environments and older servers keep their previous values. If connected
environments disagree, **Apply to all** copies your current settings to those named
in the warning. Changing a rule does not reopen already settled threads.

## Sidebar layouts

On web and desktop, choose **Grouped**, **Original**, or **Legacy** in **Settings → General →
Sidebar style**, or from the sidebar's layout menu. T3 Code remembers the choice. The grouped
layout provides the organization controls below; the other two preserve the original and legacy
thread-list experiences.

## Grouping, filtering, and sorting

A compact bar at the top of the sidebar controls how the thread list is laid out. Every choice
is remembered.

**Group by** splits the list into collapsible sections. Out of the box the sidebar is grouped by
**Environment** and then by **Project**. Choose **Leave open (flat list)** for one uninterrupted
list, or group by **Environment**, **Project**, or **Provider**. Once a grouping is active,
**Then by** adds a second level inside each section. Click a section header to collapse it;
collapsing a section also hides its subsections. Changing either grouping expands everything
again.

**Treat a project as** decides what counts as one project in the sidebar: one row per repository,
one row per folder inside a repository (useful for worktrees and monorepo packages), or one row
per project you added. Individual projects can still override this in project settings.

**All providers** narrows the sidebar to threads running on a single provider, including pinned,
snoozed, and settled ones. The menu only lists providers that currently have threads.

The last menu sorts threads by **Last activity** or **Date created**. Sorting and grouping are
independent: changing one never reshuffles the other.

## Arranging sections

The same menu carries **Order sections**, which decides where sections sit rather than which ones
exist. **Busiest first** is the default: sections with live work come first, then the ones that
only hold history, then your quiet projects. **Name (A–Z)** ignores all of that and sorts by
label. **Custom** is your own arrangement.

Drag a section header to move it, or right-click it and choose **Move up** or **Move down**.
Either way the sidebar switches to **Custom** and remembers where you put things, so a section
stays put no matter what arrives in it. Sections only move within their own level: a project
cannot be dragged out of its environment, and a collapsed section travels with everything inside
it.

Switching to **Custom** from the menu freezes the layout exactly as it looks at that moment. A
project you add later joins the end of its level. **Reset section order** in the same menu throws
the arrangement away and goes back to **Busiest first**.

## Acting on a section

Section headers carry the actions for whatever they are about. They appear on hover and always sit
to the left of the collapse arrow, which stays in the same place on every row.

Project sections offer **New thread** and **Project settings**. Every project you have added keeps
a section whether or not it currently has threads, so starting work in a quiet project is one
click, not a detour through a menu.

Environment sections offer **New project**, which opens the project picker already pointed at that
environment.

Provider sections span several projects and environments, so they carry no actions.

Right-clicking a section header opens the same actions as a menu, plus **Remove project**.
Removing is destructive, so it stays out of the row: it tells you the path, the environment and
how many threads go with the project, and asks before doing anything. Threads keep their own
right-click menu with **Archive thread** and **Delete**.

A collapsed section shows what is waiting inside it as colored dots with counts, in order of
urgency: amber for approvals, indigo for input requests, red for failures, green for finished
threads you have not opened yet, and blue for threads still working. Open sections leave that to
the rows themselves. Unread finished threads also carry a green dot next to their title.

## The path above a thread

Every open thread shows its path across the top of the window: the environment it runs on, the
project it belongs to, then the thread's own title. The environment leads it whenever T3 Code can
name one, so with more than one server connected the header says which machine the work is
happening on without you having to guess from the project name.

Both scopes are links.

Clicking the **environment** opens a page listing every project on that server, busiest first,
with each project's live thread count and when it was last touched. **New project** in the corner
adds one to that environment.

Clicking the **project** opens a page listing every thread in it, under the same **Active**,
**Snoozed** and **Settled** shelves the sidebar uses, so the two never disagree about what is
finished. **New thread** in the corner starts one there.

Each page carries the path too, so the project page walks back up to its environment, and any
thread walks back to the project it came from.

## Where settled threads go

When the list is grouped by project, each project section ends with its own **Settled** shelf
holding that project's finished threads. The shelf starts closed and shows a count, so history
stays one click away without pushing live work off the screen. Long histories open a handful at a
time with a **Show more** row.

With any other grouping — including the flat list — settled threads collect in the single
**Settled** shelf at the bottom of the sidebar instead.

Pinned threads keep their manual order and the snoozed shelf stays whole: grouping applies to the
main list.

## Panel motion

## Link a pull request

The server finds the PR for each unsettled thread's saved branch, even when your
apps are closed. Settled threads keep their saved links. Update the server if
automatic branch links do not appear.

On web and desktop, right-click a pull request link in a thread and choose
**Link to thread** to select a different PR. Use **Unlink from thread** on the
same link to return to the branch PR, if one exists.
The linked pull request participates in automatic settlement.

## Find and reference work

On web and desktop, open the command palette with `Cmd/Ctrl+K` to search threads
across connected environments. Message search starts after two characters and
includes your messages and final agent responses.

Use **Settings → Keybindings** to find or customize shortcuts for searching files
and copying a thread reference. A copied reference uses the thread's pull request
link when available, otherwise its thread ID. See [keybindings](./keybindings.md)
for custom configuration.

## Inspect agent work

On web and desktop, use **Agents** to follow work delegated to subagents.

Expand a tool call in the conversation to see its full command and output.
Summaries shorten shell wrappers and can still describe the latest call after it
finishes; the call's own result shows its status.
