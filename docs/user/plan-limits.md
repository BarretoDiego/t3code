# Track plan limits

Providers meter subscription plans on rolling windows: Claude Code reports a 5-hour window and
weekly windows, Codex reports its own pair of windows plus any spend limits your workspace applies.
The gauge at the bottom of the sidebar, next to Settings and Usage, shows how much of those windows
is spent. The mobile Usage page shows the same provider breakdown.

The ring fills to the most constrained window across every provider and environment you are
connected to, and turns amber as a window gets tight and red once one is exhausted. Hover or click
it for the breakdown of providers that are not pinned: each plan, every window it reports, how much
is used, and how long the window has left. Pinned providers stay visible in the dock and are omitted
from this popup to avoid showing the same account twice.

On web and desktop, pin any provider from that breakdown to keep a compact plan-limit widget above
the sidebar's Settings and Usage controls. Pinned widgets use an adaptive grid, keep their own
content height, and preserve the provider logo and account name in view. Their monochrome bars use
the theme's action color and show the percentage still available, rather than the amount already
spent. Each session, weekly, or model-specific limit has its own thick horizontal bar across the
card; hover a bar to see the legend with its window, available amount, and reset time.
The short session window is marked with a small hourglass so it remains distinct from weekly limits
at a glance.

Collapse the sidebar to its icon rail and each pinned account shrinks to a single progress ring
around its provider logo. The ring fills with the account's primary window - the session limit when
the provider reports one - so the rail keeps one glyph per account. Hover a ring for the same
legend with its window, available amount, and reset time.

Claude's weekly rows can also be collapsed independently for each connected account. The same
control is available in a pinned widget: its primary limit stays visible while the extra weekly
layers fold away. The choice is shared with the expanded breakdown and persists for that client,
along with the pinned accounts.

Each connected provider account has its own entry. For example, a personal Codex instance and a
company Codex instance keep independent windows and never combine their percentages. Their
configured display names identify them; when two same-provider instances have no display name,
their instance IDs are shown instead.

This is different from the [Usage page](usage.md). Usage counts tokens and API-equivalent cost from
the providers' session history. Plan limits are what the provider itself says about your remaining
headroom, which is what decides whether the next turn runs.

The pinned dock is designed for the web and desktop sidebar. Mobile keeps the full provider and
account breakdown on its Usage page, including session, weekly, model-specific, and credit windows.

## When the numbers refresh

Providers report plan limits while they work, so the gauge updates as your agents run and keeps the
last observation between runs — including across restarts. Claude refreshes its complete 5-hour,
weekly, model-specific (including Fable 5), and extra-usage snapshot when a turn finishes. New
model-scoped windows reported by Claude appear independently without replacing the general weekly
window; provider warnings can update an individual window sooner. A window whose reset time has
passed is shown as reset rather than repeating a spent number, and it fills in again the next time
that provider runs.

Use the refresh button in the Plan limits header to request a fresh snapshot for every connected
account. Codex and Claude currently answer that request through an active provider session, without
starting another turn. If an account has no active session, its last snapshot stays visible and the
app asks you to start that provider before trying again. One unavailable account does not prevent
the other accounts from refreshing.

Changing the account or home configured for a provider instance clears the previous account's last
observation immediately. The replacement account appears after it runs and reports its own limits.

Until a provider has reported anything, the gauge is empty and says so; the refresh button is still
available for supported, installed providers. Providers that do not meter a subscription plan at
all — an API key, Bedrock, Vertex, or a provider without plan limits — never appear in the list.
