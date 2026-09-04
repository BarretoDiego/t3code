# Project Sync Architecture

> For maintainers. Using T3 Code? See [docs/user](../user/).

Project sync copies a project's workspace between two environments. For the user-facing flow see
[Sync Projects Between Environments](../user/project-sync.md).

## The model

There is no server-to-server communication. Every environment is just a T3 server that already
knows how to walk its own workspace, describe files, and stream bytes over HTTP; a sync is the
client asking one environment for a manifest and some file bytes, then handing those bytes to the
other environment. The client is the only thing that ever talks to both sides.

```text
┌───────────────────────────────┐        ┌───────────────────────────────┐
│ Origin environment           │        │ Destination environment      │
│  workspace root, files       │        │  workspace root, files       │
└───────────────┬───────────────┘        └───────────────┬───────────────┘
                │ manifest (WS)                           │ manifest (WS)
                │ export bytes (HTTP, signed URL)          │ import bytes (HTTP, signed URL)
                │                                          │ deletions (WS)
                └──────────────────┬───────────────────────┘
                                   │
                        ┌──────────▼──────────┐
                        │ Client              │
                        │  diff, batch, plan   │
                        │  drive both sides    │
                        └──────────────────────┘
```

Because the client owns the whole flow, project sync works over any connection mode T3 already
supports for each environment individually — local, LAN, Tailscale, T3 Connect relay, or an
SSH-launched environment. Nothing new had to be built at the transport layer, and nothing pierces
the one-server-owns-its-workspace boundary the rest of the app relies on. This also rules out
`scp`/`rsync`-style approaches: those would require either shell access to both hosts from wherever
the sync runs, or a direct network path between the two environments, neither of which T3's
connection model guarantees. Reusing the client's existing connection to each environment sidesteps
both requirements.

## Flow

1. **Manifest.** The client calls `projectSync.manifest` against both the origin and destination
   environments. Each server walks its project's workspace root and returns a flat, sorted list of
   entries — files with a sha256 hash, empty directories, and symlinks with their raw target — built
   in [`ProjectSyncManifest.ts`][manifest]. `node_modules`, `.t3`, and `.DS_Store` are always
   excluded; `.git` is included unless the caller opts out; `extraIgnores` layers exact-segment
   exclusions on top.
2. **Plan.** The client diffs the two manifests with `computeProjectSyncPlan` in
   [`operations/projectSync.ts`][client-ops]: entries missing or changed on the destination go into
   `toCopy`, destination-only paths go into `toDelete` (deepest-first, so deletion never removes a
   directory before what was inside it). `batchProjectSyncEntries` then groups `toCopy` into batches
   bounded by ~32 MiB or 500 files, so neither side ever buffers an entire project in memory.
3. **Transfer.** For each batch, the client calls `projectSync.createExportUrl` on the origin and
   `projectSync.createImportUrl` on the destination, then streams the export response body directly
   into the import request body. Content moves over HTTP, not the WebSocket, using the same signed
   short-lived URL mechanism as attachment/asset uploads (HMAC-SHA256 over a claims blob, 10-minute
   TTL) — see [`ProjectSyncTransfer.ts`][transfer]. The body itself is a small purpose-built binary
   framing (`[uint32 header length][JSON header][raw content bytes]`, repeated) defined in
   [`projectSyncFraming.ts`][framing], decoded and applied on the destination by
   [`ProjectSyncApply.ts`][apply].
4. **Deletions.** In Sync mode, once every batch has landed, the client calls
   `projectSync.applyDeletions` on the destination with `plan.toDelete`. The destination removes
   those paths and prunes any directory that deletion left empty, up to (never including) the
   workspace root. Send mode never calls this — a project it just created cannot have destination-only
   cruft that matters.

`runProjectSync` and the progress/target types in [`state/projectSync.ts`][client-state] are what
web and desktop wire up to a UI: a batch failure aborts the rest of the sync, leaving the
destination with whatever batches already landed — always a subset of the plan, never partial
destination-only leftovers.

## Contracts

[`packages/contracts/src/projectSync.ts`][contracts] defines the manifest entry shape and the four
RPC payload/result/error types. Four `WS_METHODS` entries and their `Rpc.make` definitions live in
[`rpc.ts`][rpc]:

- `projectSync.manifest` — walk a project's workspace and return its manifest.
- `projectSync.createExportUrl` — mint a signed URL to stream a set of entries out of a project.
  Each entry is a `{ path, size }` pair, not a bare path: the size is the one the client read from
  the manifest and folded into the matching import URL's `totalBytes`, so the origin can skip
  anything that no longer matches instead of overrunning the destination's budget.
- `projectSync.createImportUrl` — mint a signed URL to stream content into a project, bounded to a
  declared file count and byte total.
- `projectSync.applyDeletions` — remove a set of paths from a project's workspace.

## Security guarantees

- **Path handling.** Every wire path is validated and resolved with
  `resolveProjectSyncRelativePath` before it touches the filesystem: absolute paths, `..` segments,
  and null bytes are rejected outright. Paths are only ever accepted or refused, never rewritten —
  trailing whitespace and backslashes are legal POSIX filename characters, and normalizing either
  would point the export at a file that does not exist, silently dropping it from a sync that
  reported success. (On Windows a backslash _is_ a separator, so a segment carrying one is refused
  there.) Ancestor directories are walked and checked before any `mkdir`, and a symlinked ancestor
  aborts the write — `mkdir -p` semantics would otherwise happily follow a crafted symlink out of
  the workspace root. The export side runs the same ancestor walk read-only before opening a file,
  so a planted symlink cannot serve content from outside the root either. A symlink _entry itself_
  is still copied faithfully; only ancestors are restricted.
- **Framing headers are validated, not trusted.** `createProjectSyncFrameDecoder` structurally
  checks each JSON header before yielding it: a non-empty string path, a known kind, and a
  non-negative safe-integer size. Nothing downstream re-checks those fields — the import route adds
  `header.size` to the signed byte budget — so a header claiming a negative size would otherwise
  _credit_ the budget and let a token signed for a kilobyte write without bound.
- **Atomic writes.** Files land through a temp-file-plus-rename in the same directory
  (`writeFileRecord` in [`ProjectSyncApply.ts`][apply]), so a partial write is never observable at
  the final path and an existing symlink at the target is swapped rather than written through.
- **Import budgets.** `projectSync.createImportUrl` declares both a `totalBytes` ceiling and a
  `fileCount` up front, and `applyProjectSyncRecords` enforces both: the decode loop aborts
  mid-stream when the running byte total or the applied record count exceeds what was signed, and
  the HTTP route turns either into a 413. The record cap matters on its own, since a body of
  zero-byte `"dir"` records costs no budget bytes at all and would still exhaust the destination's
  inodes. The byte budget is enforced from the framed content as it decodes, not from
  `Content-Length`, since the body also carries header bytes.
- **Export tolerates drift.** The manifest a client diffed is a snapshot; an entry that vanished,
  that now sits under a symlinked ancestor, or whose size no longer matches the one the client
  signed for is skipped rather than failing the whole transfer — the next sync reconciles it. Each
  frame's declared size is always taken from the still-open file handle being read, so a file that
  grew mid-export cannot desynchronize the stream, and skipping the size mismatch is what keeps
  that growth from overrunning the destination's signed byte budget and 413-ing the batch.
- **Deletions stay inside the workspace.** `applyProjectSyncDeletions` re-resolves every path the
  same way writes do, so a deletion request cannot escape the project root either.
- **Signed URLs are single-purpose.** Export/import tokens follow the asset/attachment upload
  precedent exactly: HMAC-SHA256 over a base64url claims blob keyed by the `asset-access-signing-key`
  secret, a `kind` claim that keeps export and import tokens from being replayed against each
  other's routes, and a 10-minute TTL (`PROJECT_SYNC_URL_TTL_MS`). All three token families share
  one verification helper (`verifySignedClaims` in [`auth/utils.ts`][auth-utils]) so they cannot
  drift apart on what counts as valid. Export claims carry a random `requestId` whose entry list is
  kept server-side in a small in-process, TTL-bounded registry (`pendingExports` in
  [`ProjectSyncTransfer.ts`][transfer]) rather than in the URL itself, since an export can cover
  thousands of paths — far more than would fit in the 4096-character URL the contract allows. That
  registration is released the moment its stream completes, so an export URL is single-use; a
  client that needs the bytes again simply mints another.

## Capability flag and version skew

`ExecutionEnvironmentCapabilities.projectSync` (added in [`environment.ts`][environment-contract])
is set unconditionally by [`ServerEnvironment.ts`][server-environment] for any server that ships
this feature. It is `Schema.optionalKey`, so an older server simply omits it. Clients gate on this
flag being `true` rather than probing the RPCs and handling a method-not-found error — the same
pattern other version-gated capabilities use. The command palette action always appears, but the
sync dialog only offers environments with `capabilities.projectSync === true` as an origin or
destination (`selectProjectSyncEnvironmentOptions`); Project Settings goes further and disables its
**Sync…** button outright when no other connected environment qualifies.

## Authorization scopes

`RPC_REQUIRED_SCOPES` in [`RpcAuthorization.ts`][rpc-auth] assigns scopes by read/write shape, the
same way `projects.readFile`/`projects.writeFile` already split:

| Method                        | Scope                   |
| ----------------------------- | ----------------------- |
| `projectSync.manifest`        | `orchestration:read`    |
| `projectSync.createExportUrl` | `orchestration:read`    |
| `projectSync.createImportUrl` | `orchestration:operate` |
| `projectSync.applyDeletions`  | `orchestration:operate` |

Manifests and export URLs only ever read a workspace; import URLs and deletions write it. See
[environment-auth.md](./environment-auth.md) for the scope model these fit into.

## HTTP routes

The signed URLs resolve against two routes registered in [`http.ts`][http]:
`GET /api/projectSync/export/*` streams `encodeProjectSyncRecords` over the requested paths;
`POST /api/projectSync/import/*` decodes the request body with
`createProjectSyncFrameDecoder` and applies it through `applyProjectSyncRecords`. Both routes
authorize purely from the signed token — the token already carries the resolved workspace root and
either the request's path list (export) or its byte/file budget (import) — so neither route needs
the orchestration read model.

## Not event-sourced

Project sync is a filesystem operation, not a domain one: it never dispatches an orchestration
command and never produces a domain event. Copying files into a project's workspace this way is
invisible to that project's thread history and checkpoints, the same way editing a file outside T3
would be.

## Limitations

- **No glob support in ignores.** `extraIgnores` matches exact path segments only, and no
  web/desktop/mobile UI currently populates it — only the always-ignored defaults
  (`node_modules`, `.t3`, `.DS_Store`) apply in practice today.
- **No concurrency lock.** Sync does not coordinate with a running turn's checkpoint or filesystem
  activity in the same workspace. See the user-facing limitation note for the recommended
  workaround.
- **Mobile is out of scope for v1.** The capability flag and UI entry points are web/desktop only;
  nothing in the mobile client offers project sync.
- **No resume.** If a signed URL expires mid-transfer, the client has to reissue export/import URLs
  and restart the affected batch rather than resuming a partial one.

## Possible evolutions

- Glob-style `extraIgnores` patterns instead of exact-segment matching.
- Mobile support, once the UI has a place for a two-environment picker on that surface.
- Resumable transfers that can pick up a batch after a URL expires instead of restarting it.

[manifest]: ../../apps/server/src/workspace/ProjectSyncManifest.ts
[apply]: ../../apps/server/src/workspace/ProjectSyncApply.ts
[transfer]: ../../apps/server/src/workspace/ProjectSyncTransfer.ts
[framing]: ../../packages/shared/src/projectSyncFraming.ts
[contracts]: ../../packages/contracts/src/projectSync.ts
[rpc]: ../../packages/contracts/src/rpc.ts
[rpc-auth]: ../../apps/server/src/auth/RpcAuthorization.ts
[auth-utils]: ../../apps/server/src/auth/utils.ts
[environment-contract]: ../../packages/contracts/src/environment.ts
[server-environment]: ../../apps/server/src/environment/ServerEnvironment.ts
[http]: ../../apps/server/src/http.ts
[client-ops]: ../../packages/client-runtime/src/operations/projectSync.ts
[client-state]: ../../packages/client-runtime/src/state/projectSync.ts
