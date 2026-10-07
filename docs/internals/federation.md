# Federation and jobs

Two environments talk server to server, with no server in between. This page holds the decisions
that cross components and the traps that are hard to see from the code. The contracts are in
[`automation.ts`](../../packages/contracts/src/automation.ts); the code is under
[`automation/federation`](../../apps/server/src/automation/federation) and
[`automation/jobs`](../../apps/server/src/automation/jobs).

## A link is one direction

A peer row means two things at once: "this environment holds a credential to call that one" and
"that environment may call this one, within these permissions". The link worker only pushes:
`peer.hello`, then `peer.deliver`. Anything that reports back, such as the status of a delegated
task, travels on the reverse link, so both sides add each other. A call from an environment that
has no row here is refused, whatever its credential says.

There is no relay. The peer's own HTTP origin must be reachable from the caller: LAN, Tailscale, or
a tunnel the operator already runs. A relay would be a central dependency and is deliberately
absent; do not add one behind the transport without making it visible in the peer's status.

## Identity comes from the session

A peer credential is a session whose subject is `peer:<caller environment id>` and whose only scope
is `federation:peer` (`t3 peer credential create`). `callerFromSession` turns exactly that pair into
a peer caller. `fromEnvironmentId` in a message body is checked against it and never trusted: a
mismatch is rejected before the message is stored.

Pairing a person's client never yields that scope, and holding it grants nothing by itself. What a
peer may ask is the `PeerPermissions` stored on its row, empty by default.

The environment id pinned when a peer is added is its identity. The name and URL may change; if the
URL later answers as a different id, the handshake stops and nothing is sent.

## Authorization happens when the action runs

Scopes are snapshotted when a WebSocket opens, and revoking a session does not close the socket. So
the peer-facing methods read the peer row on every call: a disabled or removed peer is refused on
its next request over a link that is still open.

Inbound messages are stored before they are acknowledged and run afterwards by the inbox processor.
The processor re-reads the peer, its permissions, project and node scopes, and the message's expiry
at that moment. A message queued before a permission was withdrawn is rejected when it would run,
not when it arrived.

## What "delivered" means

- `pending_delivery`: stored here. An offline peer leaves it here; it is never shown as sent.
- `delivered`: the peer stored it. Nothing is known yet about the work inside.
- Accepted, running, finished: a later `task.status` message from the peer.
- `rejected`: the peer refused it, at storage or when it ran, with a code.

Message ids derive from the sender, the receiver and the caller's dedup key, so a retry is the same
message. The receiver dedupes on the id per peer, and each downstream call (`acceptRemote`, the
orchestrator inbox, journal import) is idempotent on a key derived from it. That is at-least-once
with deduplication. A crash between a handler's effect and marking the row processed replays the
handler; a handler that is not idempotent on the message id would run twice.

A local cancel or timeout of remote work is a request. It stays `cancel_requested` or
`pending_delivery` until the peer reports the outcome.

## The rejection report protocol

A rejection decided after the acknowledgement has to reach the sender on a later call.
`peer.deliver` returns unreported rejections with every response, and the link worker calls it with
no messages as a heartbeat. The receiver treats a second `deliver` without an intervening `hello`
as proof that the previous response arrived; a `hello` means the link was rebuilt, so the last
batch of rejections is reported again. **A caller must send `hello` after any failed call before it
delivers again.** A caller that keeps delivering on a link whose response it lost would silently
drop rejections.

## Forwarded events

An environment forwards only events that originated in it, and accepts only events whose origin is
the sending peer. Nothing is relayed on a third environment's behalf: origins are not signed, and
the journal dedupes on (origin, origin cursor), so accepting a relayed origin would let one peer
shadow another's events. Echo to the origin is therefore impossible by construction, and the hop
limit and the administrative event types are checked on both ends anyway. The forwarding cursor
moves in the same transaction as the outbox row it produced.

## Jobs

A job is stored as `accepted` before an executor is involved, and a marker is written just before
the hand-off. After a restart, a job with that marker and no recorded end is `unknown`: the server
cannot know the exit code of a process it no longer holds, even when it can see the process is
still running. `reconcile` re-reads; it runs the job again only if the requester declared it
idempotent and its process is not verifiably alive. Nothing re-runs by itself.

`JobRecovery.start` does that marking and is separate from the service on purpose. Run from a
second process that opens the same database, it would declare the server's live jobs lost.

A job's `cwd` is resolved on the node (symlinks, `..`) before it is compared with the node's
workspace roots. The built-in `local` node has no roots until the operator adds one. Shell needs
three separate grants: the node's `allowShell`, the caller's `automation:execute` scope, and, for
an orchestrator, its `job.shell` action. On an SSH node every argument is quoted into one remote
command line, so a `command` action stays a fixed argv; the job inherits `PATH` and `HOME` and
nothing else.

Distributed code is passed by reference: commits, patches and artifacts in `refs`. Working
directories, databases and live provider sessions are not synchronized.
