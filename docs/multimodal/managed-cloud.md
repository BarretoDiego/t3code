# Managed cloud execution

Compute destinations can be managed services, not just machines. An environment
owns the connection, credentials and durable history; `execution` describes where
the provider executes. A managed destination does not need `nodeId`, GPU telemetry
or an installable model. Region/project/account are cloud identifiers, not T3
project or environment IDs. Model availability still comes from discovery.

## What ships now

The generic managed adapter, server-side polling, credential resolver and
`mock-managed` simulator ship here. **There is no native Vertex AI or Amazon
Bedrock connector yet.** Merely configuring those service names or endpoints does
not enable their APIs. Unknown adapter types remain offline. No SDK, cloud account,
credential, bucket, model, VM, tunnel or paid invocation is provisioned by this work.

To exercise the complete path, save this provider through `compute.saveProvider`
(the existing server RPC), then submit through `compute.submit`:

```json
{
  "provider": {
    "id": "managed-demo",
    "name": "Managed service simulation",
    "type": "mock-managed",
    "execution": { "kind": "managed", "service": "simulation", "region": "test" },
    "authentication": { "type": "workload-identity" },
    "configuration": {}
  }
}
```

```json
{
  "request": {
    "providerId": "managed-demo",
    "capability": "document.generate",
    "operation": "generate",
    "model": "mock-managed-v1",
    "parameters": {}
  }
}
```

The simulator completes after two simulated seconds, with a valid empty JSON
artifact. Server polling observes it on the next five-second cycle, including
when no client is connected. It can also be refreshed explicitly. It has no
hardware resources and does not emulate any vendor's protocol. Its remote state
is memory-only; a full process restart loses the simulated service, unlike an
actual external service. Tests recreate the T3 adapter while keeping the simulated
remote service alive to exercise recovery independently.

## Boundary for future native connectors

Implement `ManagedComputeDriver` and register
`makeManagedComputeProvider(driver)` in `ComputeProviderAdapters.ts`. The core
does not change when a driver is added. A driver creates one
`ManagedComputeConnection` per provider/account/region. It owns:

- Native authentication and refresh, model access checks and payload translation.
- Capability/model discovery, including regional availability. Do not claim every
  model or modality exists in every region/account. No hardware telemetry is required.
- Synchronous results or asynchronous operation submission and status mapping.
- Quota handling, deadlines and request throttling. Do not silently retry a paid
  invocation unless the native API guarantees idempotency.
- Artifact ingestion/resolution through the existing asset infrastructure. Store
  durable object identifiers, not expiring signed URLs or inline credentials.

`resolveComputeCredential` returns redacted bytes from `ServerSecretStore` for
secret references. `secretRef: "cloud-token"` resolves only the dedicated
`compute-cloud-token` name. Provision secrets separately using that store, never
in provider JSON. Resolve again on refresh to observe rotation. With
`authentication: { "type": "workload-identity" }`, no secret is read: the future
native SDK must use its ambient identity mechanism. The generic layer does not
mint tokens or authenticate to any cloud itself.

## Durable execution and cancellation

The core saves the queued job before invoking the driver and saves the returned
`remoteOperation: { id, adapterType }` in the same SQLite job record. It also
preserves `execution`. Queries and cancellation receive the persisted job, not an
in-memory mapping from local to remote IDs. Connections are recreated from saved
provider configuration; active providers cannot be edited or removed through the
API until their jobs settle. Do not edit their configuration file while jobs run.

Pass `job.id` as the native idempotency key where supported. If T3 loses the
submission acknowledgement, `findByRequestId` may recover it by read-only lookup.
Without such a native facility, the queued job remains unresolved and requires
operator investigation; the core does **not** resubmit or promise exactly-once
execution. Transient polling failures preserve the last known job and are retried
on the next cycle. Drivers must distinguish temporary unavailability from a
definitive remote failure. Terminal jobs are not polled again.

Discovery exposes `executionSupport.cancellation` and `recovery`. Omit the driver
`cancel` method when unsupported: cancellation then reports `cancel-unsupported`
and does not mark the job cancelled. Even a successful cancel request is only an
acknowledgement; status changes when remote lookup confirms it. The operation may
continue and incur charges. Cancellation and disconnect never imply resource
deletion. Each job has exactly one provider destination.

## Native connector follow-up

Vertex AI and Bedrock need their own API implementations, authorization tests,
regional/model catalogs, output storage handling and billing-aware integration
tests. Their differing remote locators fit this boundary; they are not a shared
HTTP protocol. For example, Bedrock's
[StartAsyncInvoke](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_StartAsyncInvoke.html)
accepts a client request token, and
[GetAsyncInvoke](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_GetAsyncInvoke.html)
queries an invocation ARN. Vertex's
[prediction API](https://docs.cloud.google.com/vertex-ai/docs/predictions/get-online-predictions)
uses project/location endpoints and its own authentication.

Before deploying a real connector, implement vendor-specific backoff/quota limits,
timeouts, credential refresh and safe artifact access. Validate with a separately
authorized cloud account; simulator tests are not evidence of live cloud compatibility.
