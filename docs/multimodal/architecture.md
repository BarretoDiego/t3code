# Multimodal compute architecture

T3 Code models multimodal execution as distributed compute, not as a catalog of
models. A compute provider belongs to an environment and may identify the node
that executes its jobs. The provider discovers its capabilities, models, queue,
and optional resources dynamically.

The server owns scheduling, durable job history, reconciliation, and event
delivery. An adapter owns only a provider protocol. Consequently neither the
core nor the clients know about a GPU vendor, an inference runtime, or a model
family.

`ComputeService` is the application boundary. Its public contracts live in
`packages/contracts/src/compute.ts`; its SQLite history is separate from the
event-sourced thread projection because provider work can outlive a turn and
can be reconciled independently.

An environment advertises the `compute` capability when its generic compute
RPC and MCP interfaces are present. This is a protocol capability, not an
assertion that the environment can generate any particular kind of media.

## Scheduling

`selectComputeProvider` first respects explicit provider, node, and environment
constraints. It then requires an online provider with the requested capability
and operation, and a compatible ready model when a model was requested. Among
matches it prefers a loaded model and then the least-deep declared queue.

Resource details are opaque metadata at this layer. Hardware-specific policies
belong in a future scheduler policy or provider adapter, never in the core.
