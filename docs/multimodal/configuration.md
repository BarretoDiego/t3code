# Configuration and secrets

Configured providers are stored as declarative JSON below the T3 home directory
at `compute-providers/providers.json`, as an array of provider configurations.
No provider is enabled automatically. For a runnable local simulator, call the
`compute.saveProvider` RPC with
`{"provider":{"id":"demo","name":"Demo","type":"mock","configuration":{}}}`.
The server binds configurations to its own environment; omit `environmentId`
unless using that environment's actual id.

```json
{
  "id": "remote-worker",
  "name": "Remote worker",
  "type": "http-worker",
  "nodeId": "gpu-1",
  "endpoint": "https://worker.example",
  "configuration": { "transport": "ssh-forward" },
  "authentication": { "type": "token", "secretRef": "remote-worker-token" }
}
```

The example is declarative only. This infrastructure intentionally does not
ship an `http-worker` adapter or establish an SSH tunnel. An adapter may use
`secretRef` to resolve a credential from T3 secret storage; direct token fields
are deliberately absent from the schema.

Configuration writes use atomic replacement and owner-only file permissions.
Configurations must be JSON, are bounded to 64 KiB per provider and 64 providers,
and reject recognized credential fields and endpoints containing credentials,
query strings, or fragments. These checks are not a secret detector: adapters
must never put credentials in opaque metadata or arbitrary parameter values.
Only secret references belong in declarative configuration. Changes are observed
without restarting the server; editing or removing a provider with active jobs
is rejected to preserve its execution destination.

For managed services, omit `nodeId` and use `execution.kind: "managed"`.
Cloud region/project/account identifiers belong to `execution`, separately from
T3's environment and project identifiers. `authentication.type: "workload-identity"`
does not require a stored key. See [managed cloud execution](managed-cloud.md)
for a runnable simulator configuration and the deferred native connector scope.
