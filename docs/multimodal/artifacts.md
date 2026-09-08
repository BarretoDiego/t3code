# Generated artifacts and lineage

`ArtifactReference` identifies a provider-produced output with an id, URI,
MIME type, optional display metadata, and opaque metadata. A completed job
records its outputs and also writes rows in `compute_artifacts`.

Each persisted artifact stores its producing job, capability, operation,
provider, model, parameters, and input artifact ids. This preserves lineage for
future chains such as image-to-video, voice-conditioned speech, or image-to-3D.

T3 Code's existing attachment and signed asset systems continue to own chat
uploads and browser delivery. Compute does not create a competing file store:
inline base64 outputs up to 1 MiB are materialized into the existing attachment
store and expose an `AssetResource` for authenticated asset delivery. File ids
are stable across reconciliation retries. An artifact id cannot be reassigned
to another job. Attachment files are written before the database transaction;
a failed transaction may leave an unreferenced file, never a committed job
pointing at an unwritten attachment.

Adapters may also return durable external URIs. Native connectors must implement
safe import/resolution for those outputs; the core does not fetch arbitrary URLs.
Expiring signed URLs and credentials must not be used as persistent locators.
Thread context is preserved, but adding a visible chat message or a specialized
generation view remains a separate product integration.
