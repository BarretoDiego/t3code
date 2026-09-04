# Agent Operations state projection

The Agent Operations Board is a pure projection over the aggregate shell stream. It never subscribes
to thread detail and never issues a per-card query. Its shared view model lives in
`@t3tools/client-runtime/agent-board`; web and mobile supply environment presentation and server
provider snapshots, then render platform-native components.

## Feature 1 compatibility seam

This checkout does not contain the public API from `feat/agent-state-model`. The Board therefore has
one temporary adapter, `agentBoardStateAdapter.ts`. The expected replacement API is:

```ts
type AgentOperationalState =
  | { kind: "needs-you"; reason: "approval" | "user-input"; since: string | null }
  | { kind: "working"; reason: "turn" | "background" | "monitoring"; since: string | null }
  | { kind: "review"; reason: "actionable-plan"; since: string | null }
  | { kind: "settled"; reason: "completed" | "lifecycle"; since: string | null }
  | { kind: "issue"; reason: "session-failed" | "turn-failed"; since: string | null }
  | { kind: "idle"; reason: "quiet"; since: string | null };

declare function deriveAgentOperationalState(
  shell: OrchestrationThreadShell,
): AgentOperationalState;
```

When feature 1 arrives, replace the adapter implementation with imports from its public module and
translate only at this seam if its exported names differ. Do not move classification into Board
components. The Board does not own contracts, persistence, ingestion, or provider adapters.

The fallback precedence is direct user request, failure, liveness, actionable review, completion or
explicit lifecycle settlement, then quiet history. Failure explicitly outranks stale background
liveness. Approval and structured input remain distinct. No shell error text or tool payload is
copied into the card; the fallback exposes only generic, safe attention labels.

## Inclusion policy

- Deleted threads are absent from the shell stream; a legacy `deletedAt` shape is also rejected.
- Archived threads are always excluded. Archive removal follows the next shell upsert.
- A quiet snoozed thread is excluded. The shared raised-hand rules can surface new approval, input,
  failure, or completion.
- Explicit settlement can display in Settled, but requests, failure, and liveness take precedence.
- Only active excludes Idle, not completed or failed work. Idle remains accessible as a collapsed
  section on web and as a mobile state tab when Only active is off.
- A catalog that has not bootstrapped renders partial loading, not a definitive empty state.
- Cached cards survive environment disconnection. Connectivity is an overlay and never feeds the
  agent classifier.
- Older servers decode absent liveness and plan-progress fields normally and use the same fallback.

Sidebar shelf settlement is lifecycle organization. It can include client preferences such as age
or pull-request auto-settlement. Board Settled is an operational display state derived from latest
completion or explicit lifecycle settlement; the two are intentionally orthogonal.

## Projection and performance

The view model indexes environments, scoped projects, and provider instances with `Map`, classifies
each shell once, filters before rendering, and keys every card by `environmentId + threadId`.
Provider identity is resolved with the environment-scoped `providerInstanceId`, never the driver
alone. Filter option counts come from eligible loaded cards. Multi-select is OR within a dimension
and AND across dimensions.

Web owns one coarse elapsed-time ticker for the whole visible Board; cards own no intervals. The
ticker only formats elapsed labels and does not rebuild classification. A separate one-shot timeout
reprojects inclusion at the next snooze wake boundary because no server event fires then. Command
hooks and the shell lookup index are also owned once by the page. Commands wait for normal receipts and shell deltas;
there is no optimistic column movement, polling, relay aggregate, new persistence, or origin config.

Desktop uses the web route inside the Electron renderer and requires no IPC. Mobile uses the same
view model with a root-stack destination, tabs, and native cards. Direct, relay-managed, tunneled,
and remote environments all continue to use their existing environment WebSocket shell streams.
