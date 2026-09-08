# Provider adapter contract

A provider configuration contains an id, display name, adapter type, optional
endpoint/environment/node, opaque configuration, and an optional secret
reference. Secret values are resolved by an adapter through server secret
storage; they are never placed in configuration files, RPC responses, logs, or
the job record.

An adapter implements `ComputeProviderAdapter` in the server. It must:

- connect and report health;
- discover capabilities, models, optional resources, and queue depth;
- submit, cancel, retrieve, and reconcile jobs; and
- optionally publish durable job updates through `subscribe`.

The adapter is responsible for protocol translation only. It must preserve the
core job id (or map it durably), expose no provider credential in an output,
and make its discovery safe to call repeatedly. Adapters are registered by
their `type`; an unknown configured type remains offline rather than changing
the core.

The built-in `mock` adapter is the reference lifecycle implementation. It
requires no network, model, GPU, or runtime installation.
It is opt-in and derives progress from persisted job timestamps, allowing a new
adapter instance to finish existing mock jobs. Image generation returns a valid
tiny PNG; the other advertised modalities return JSON simulation artifacts,
not fabricated video/audio/3D binaries. Model parameter defaults and presets are
validated and merged by the core before submission; unknown declared-model
parameters are rejected. Provider schemas must not depend on evaluated code.

Managed cloud services use [the managed driver boundary](managed-cloud.md).
`getJob` and `cancel` receive the persisted `GenerationJob`, including its remote
operation locator. They must not depend on a process-local ID map. `mock-managed`
exercises this boundary without a node; native cloud connectors are deferred.
