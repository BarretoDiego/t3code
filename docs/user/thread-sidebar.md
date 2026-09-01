# Organizing threads

Pin a thread from its context menu to keep it in the pinned section above your active work.
`mod+shift+p` pins or unpins the thread you have open. Pinned threads are shown independently of
their project, including when you connect to more than one environment.

To require confirmation before unpinning, enable **Settings → General → Unpin confirmation**. The
confirmation applies to the sidebar controls, thread menus, and the `mod+shift+p` shortcut.

Pinned threads still move to **Settled** when they become inactive. They also move when their pull
request merges if **Auto-settle merged threads** is enabled.

Each environment owns its automatic settlement settings. The server checks them even when no web,
desktop, or mobile client is connected. By default, it settles threads after three days without
activity and when their pull request merges. An eligible idle thread also settles when its pull
request closes. An open pull request blocks inactivity settlement. Active work, pending input, and
live background work keep the thread active. T3 Code settles from a closed or merged pull request
only when its timestamp is not older than the user's latest activity. If that timestamp is not
available, the inactivity rule still applies. A manual un-settle also keeps the thread active.
Change these rules in **Settings > General** for the environment. A settings change affects future
settlement and does not reopen a settled thread. Settings saved by older clients on one device no
longer control this behavior.

When you un-settle a thread, it returns to the top of the active list so you can find it right
away. Its timestamps do not change. Other threads keep their positions.

Right-click a pull request link in a thread and choose **Link to thread** to show that pull request
in the sidebar. The thread settles when the linked pull request merges if **Auto-settle merged
threads** is enabled. Right-click the same link and choose **Unlink from thread** to remove it.

On web and desktop, drag a pinned thread to change its position. On mobile, open the thread's menu
and choose **Move up** or **Move down**. The order is stored by the server and appears on your
other connected devices.

If reordering is unavailable for one environment, update the T3 Code server running in that
environment. Older servers can still pin and unpin threads, but do not understand synced ordering;
their pinned threads keep the default newest-first order below the ones you have arranged.

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

## Environment artwork

Dev and Nightly environments can identify themselves with artwork at the top of the sidebar and in
the send button. Choose **Artwork**, **Version pill**, or **None** in Settings under environment
identification. Artwork is recolored to match each built-in theme. Custom themes use the **Version
pill** fallback because their colors are not controlled by T3 Code.

To generate a fresh title from the conversation, open a thread's context menu and choose
**Regenerate title**. While T3 Code is generating it, the action reads **Regenerating…** and cannot
be selected again. The option is hidden when the connected environment needs a server update.
