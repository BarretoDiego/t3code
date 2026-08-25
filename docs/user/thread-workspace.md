# Working with multiple threads

Web and desktop can keep several threads visible in one workspace. Use the layout button in the
active thread pane to choose a single pane, two, three or four columns, two or three rows, or a
2 × 2 grid.

Each pane has its own thread tabs. When a layout adds an empty pane, it becomes selected; the next
thread you choose from the sidebar opens there. Select another pane or tab to make it active, then
continue opening threads from the sidebar to add tabs to that pane. Drag a tab to reorder it in its
current pane, or drop it on another pane to move it there. While you drag, every pane shows where
the tab can land and highlights the one under the cursor. Middle-click a tab to close it.

The sidebar remains shared by the whole workspace. The terminal drawer stays inside its thread
pane, while the right panel is shared: browser, files, diff, pull request, terminal, and agent
surfaces always follow the selected thread. Maximizing the right panel temporarily hides the
thread grid and restoring it returns to the same layout.

Reducing the number of panes does not close their threads. Tabs from removed panes move into the
remaining pane, and the selected thread stays active. The final thread tab cannot be closed because
its URL is the workspace's canonical route; opening another thread makes it closable again.

## Picking up where you left off

The workspace is saved in the current browser, so closing and reopening the app brings back the
layout, the open tabs in each pane and the thread that was selected. Saved workspaces are per
device: a phone and a desktop each keep their own.

Tabs for threads that were deleted meanwhile are dropped once the environment that owns them
reconnects and reports what it still has. A thread whose environment is merely offline keeps its
tab, so a slow or interrupted connection never costs you the workspace.

You can also keep named workspaces. The layout button has a **Save current workspace** action that
stores the current layout, tabs and selection under a name you choose, and lists everything you
have saved. Selecting one restores it and switches to the thread it had active; saving again under
an existing name replaces it. Use the delete button on a row to remove one.
