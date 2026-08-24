# Track plan limits

Providers meter subscription plans on rolling windows: Claude Code reports a 5-hour window and
weekly windows, Codex reports its own pair of windows plus any spend limits your workspace applies.
The gauge at the bottom of the sidebar, next to Settings and Usage, shows how much of those windows
is spent.

The ring fills to the most constrained window across every provider and environment you are
connected to, and turns amber as a window gets tight and red once one is exhausted. Hover or click
it for the full breakdown: each provider, its plan, every window it reports, how much is used, and
how long the window has left.

This is different from the [Usage page](usage.md). Usage counts tokens and API-equivalent cost from
the providers' session history. Plan limits are what the provider itself says about your remaining
headroom, which is what decides whether the next turn runs.

## When the numbers refresh

Providers report plan limits while they work, so the gauge updates as your agents run and keeps the
last observation between runs — including across restarts. A window whose reset time has passed is
shown as reset rather than repeating a spent number, and it fills in again the next time that
provider runs.

Until a provider has reported anything, the gauge is empty and says so. Providers that do not meter
a subscription plan at all — an API key, Bedrock, Vertex, or a provider without plan limits — never
appear in the list.
