# Organizing threads

Pin a thread from its context menu to keep it in the pinned section above your active work.
Pinned threads are shown independently of their project, including when you connect to more than
one environment.

On web and desktop, drag a pinned thread to change its position. On mobile, open the thread's menu
and choose **Move up** or **Move down**. The order is stored by the server and appears on your
other connected devices.

If reordering is unavailable for one environment, update the T3 Code server running in that
environment. Older servers can still pin and unpin threads, but do not understand synced ordering;
their pinned threads keep the default newest-first order below the ones you have arranged.

## Grouping, filtering, and sorting

Below the project selector, a compact bar controls how the thread list is laid out. Every choice
is remembered.

**Group by** splits the list into collapsible sections. Choose **Leave open (flat list)** for one
uninterrupted list, or group by **Environment**, **Project**, or **Provider**. Once a grouping is
active, **Then by** adds a second level inside each section — for example environment sections
that contain one subsection per project. Click a section header to collapse it; collapsing a
section also hides its subsections. Changing either grouping expands everything again.

**Treat a project as** decides what counts as one project in the sidebar: one row per repository,
one row per folder inside a repository (useful for worktrees and monorepo packages), or one row
per project you added. Individual projects can still override this in project settings.

**All providers** narrows the sidebar to threads running on a single provider, including pinned,
snoozed, and settled ones. The menu only lists providers that currently have threads.

The last menu sorts threads by **Last activity** or **Date created**. Sorting and grouping are
independent: changing one never reshuffles the other.

A collapsed section shows what is waiting inside it as colored dots with counts, in order of
urgency: amber for approvals, indigo for input requests, red for failures, green for finished
threads you have not opened yet, and blue for threads still working. Open sections leave that to
the rows themselves. Unread finished threads also carry a green dot next to their title.

Pinned threads keep their manual order, and the snoozed and settled shelves stay whole — grouping
applies to the main list.

## Environment artwork

Dev and Nightly environments can identify themselves with artwork at the top of the sidebar and in
the send button. Choose **Artwork**, **Version pill**, or **None** in Settings under environment
identification. Artwork is recolored to match each built-in theme. Custom themes use the **Version
pill** fallback because their colors are not controlled by T3 Code.

To generate a fresh title from the conversation, open a thread's context menu and choose
**Regenerate title**. While T3 Code is generating it, the action reads **Regenerating…** and cannot
be selected again. The option is hidden when the connected environment needs a server update.
