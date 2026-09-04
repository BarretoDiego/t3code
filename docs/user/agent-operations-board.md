# Agent Operations Board

Agent Operations is a global view of work across every connected environment. It complements the
thread sidebar: the sidebar answers where work lives, while the Board groups work by what needs
attention now.

Open **Agent Operations** from the sidebar footer, the command palette, or the equivalent button
on mobile. The destination has its own `/board` URL on web and desktop and a `board` deep link on
mobile, so Back returns to the previous thread or list.

## Columns

- **Needs You** contains approval and structured-input requests. The oldest request appears first.
- **Working** contains active turns, background work, and monitoring work. Recent activity appears
  first.
- **Review** contains an actionable plan ready to review.
- **Settled** contains completed runs and threads explicitly settled in their lifecycle.
- **Issue** contains failed turns or sessions. A disconnected environment does not create an issue.

Quiet historical threads are hidden while **Only active** is on. Turn it off to reveal the collapsed
**Idle history** section. Archived and deleted threads never appear. A snoozed thread stays hidden
unless a new approval, input request, failure, or completion raises its hand.

The sidebar's **Settled** shelf and the Board's **Settled** display state answer different questions.
The shelf is a lifecycle organization rule and may include automatic age or pull-request rules. The
Board display state means the latest execution completed or the thread was explicitly settled.
Live work, requests, and failures always win over settlement in the Board.

## Filters and actions

Web and desktop filters support multiple environments, projects, providers, accounts, and models.
Selections within one filter are combined as alternatives; different filters are combined together.
Filters live in the URL and do not create a server preference. If an environment or provider is
removed, the unavailable filter is ignored and the Board offers to clear it.

Each card can open its thread, project, or environment. Stop, Archive, Settle, and Unsettle only
appear when the connected server and current thread state support them. A card stays in its current
column until the server accepts the command and the shell stream reports the resulting state.

Mobile uses state tabs and a native list instead of squeezing five columns onto the screen. Tapping
the environment or project on a mobile card scopes the current Board list; **Clear scope** returns
to the global view.

When an environment disconnects, cached cards remain visible with a connectivity label. Their last
known operational state is preserved until the environment reconnects and streams newer data.
