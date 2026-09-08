# Thread handoff consistency

An environment owns its thread database and provider processes. Handoff does not turn those
records into a replicated, multi-writer conversation. The departing environment keeps a durable
ownership fence after completion; removing that fence can resurrect an old execution owner.
A prepared destination also remains fenced until the source commits the next generation.

The paired client coordinates two independently authorized servers over their existing connections.
The readiness receipt is relayed by this trusted client; it is not a mutually signed node protocol
or a quorum lease. Both endpoints require orchestration operate permission. Read-only clients may
subscribe to ownership progress. A future autonomous failover protocol cannot infer ownership
from a network timeout or reuse this client-coordinated receipt as a consensus proof.

Cancellation first reserves rollback on the source under the same lock used for commit. Only then
may it revoke destination preparation. Reversing that order lets concurrent recovery revoke a
destination to which the source has already committed. An unknown handoff ID needs a durable
cancellation tombstone, since an earlier preparation request may still arrive after cancellation.
After commit, recovery completes the destination; it never makes the old source executable.

Thread history is imported into persistence and projections atomically with the destination binding.
Historical events must not be republished to provider reactors: old turn-start events are history,
not instructions to execute again. Client workspace references keep their placement while changing
environment; the imported thread retains its conversation IDs.

Claude's external session store mirrors native writes. Calling the SDK's synchronous `close()` does
not prove its asynchronous mirror flush finished. Transferred sessions require awaited disposal
before checkpointing. An append failure or unexpected native session ID permanently invalidates
the store; resume and export must fail closed, even if the SDK swallowed a flush error while closing.
Missing registration in an existing transferred-store directory is incomplete recovery state,
not permission to fall back to another native session store.

Native history retains its opaque historical paths. The adapter changes the current working
directory and store lookup mapping; it does not rewrite arbitrary transcript content. Local
services, credentials and running subprocesses remain environment-specific.
