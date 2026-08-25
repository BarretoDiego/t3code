# Working with multiple threads

Web and desktop can keep several threads visible in one workspace. Use the layout button in the
active thread pane to choose a single pane, two or three columns, two or three rows, or a 2 × 2
grid.

Each pane has its own thread tabs. When a layout adds an empty pane, it becomes selected; the next
thread you choose from the sidebar opens there. Select another pane or tab to make it active, then
continue opening threads from the sidebar to add tabs to that pane. Drag a tab to reorder it in its
current pane, or drop it on another pane to move it there.

The sidebar remains shared by the whole workspace. The terminal drawer stays inside its thread
pane, while the right panel is shared: browser, files, diff, pull request, terminal, and agent
surfaces always follow the selected thread. Maximizing the right panel temporarily hides the
thread grid and restoring it returns to the same layout.

Reducing the number of panes does not close their threads. Tabs from removed panes move into the
remaining pane, and the selected thread stays active. The final thread tab cannot be closed because
its URL is the workspace's canonical route; opening another thread makes it closable again.

The selected layout is saved in the current browser. Open tabs are rebuilt from the active thread
after a reload, so deleted or inaccessible threads are not restored as stale tabs.
