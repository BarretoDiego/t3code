# Agent tools

Provider-backed agents receive the generic MCP tools below:

- `compute.listProviders`
- `compute.listCapabilities`
- `compute.listModels`
- `compute.submit`
- `compute.getJob`
- `compute.cancelJob`

An agent should inspect capabilities and models before submitting work. The
submit tool automatically records the issuing thread in job context, while
provider/node/environment remain optional scheduling constraints. Tools return
the durable job and artifact references rather than provider-private protocol
objects.

All tools require an authenticated MCP invocation with compute permission.
Submission binds the issuing thread and validates its project; agents cannot
read or cancel another thread's jobs. Environment RPC writes separately require
the server's write scope. Shared client-runtime exposes the same typed RPCs for
web, desktop, and mobile; this change does not add a generation screen.

## Managed execution

`compute.listProviders` also returns the managed target and cancellation/recovery
support. Use an explicit provider for a chosen cloud account. Submission may be
billable; do not retry a request just because its acknowledgement was lost.
`compute.cancelJob` returns the provider's current state, which may remain running
after a cancellation request, or reports that cancellation is unsupported.
