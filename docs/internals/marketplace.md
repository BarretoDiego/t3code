# Marketplace architecture

The marketplace is an environment-owned, open package catalog. It deliberately separates generic
distribution from type-specific installation: sources, package metadata, integrity, compatibility,
RPCs, persistence, and client presentation work for every package type; a server handler owns the
meaning of one package payload.

## Format

`packages/contracts/src/marketplace.ts` is the wire contract. Both the catalog and package manifest
use `schemaVersion: 1`:

```text
t3-marketplace.json
  id, name, homepage
  packages[]
    id, type, exact version, browse metadata
    relative or absolute manifest URL
    optional sha256 digest and compatibility

package.json
  id, type, exact version, publisher, permissions
  compatibility
  payload (opaque until decoded by its type handler)
```

`type` is a validated open string, not an enum. Unknown types decode, cross RPC, render in every
client, and receive `unsupported-type` availability. This is the compatibility rule that lets a
community publish future `skill`, `mcp`, `tool`, or plugin-like types without a catalog schema bump.
The package manifest repeats identity, type, and version; the server rejects a manifest that does
not match its catalog entry.

The root `t3-marketplace.json`, `marketplace/packages`, and `marketplace/schemas` form the official
static repository and reference implementation. Hosting requires only HTTP(S). The server also
normalizes GitHub repository and tree URLs to their raw root catalog, so no registry service or
GitHub API credential is required.

## Server boundary

`apps/server/src/marketplace/MarketplaceService.ts` owns:

- source normalization and validation;
- bounded fetches with timeouts, response-size limits, and optional SHA-256 verification;
- environment-local source and installation state;
- compatibility checks against T3 version and host platform;
- serialized add/remove/install/update/uninstall mutations; and
- the package handler registry.

`MARKETPLACE_PACKAGE_HANDLER_TYPES` is the capability set used for catalog availability. The runtime
registry maps the same type to `install`, `update`, and `uninstall` operations. A new package kind
adds one payload schema and one handler; it does not add RPC methods or marketplace-specific client
state. Its installation returns a generic target (`provider-instance` today, `package-reference` for
future resource types) plus the non-secret input values safe to persist.

Marketplace state lives below T3 home, while materialized package files live in a separate
T3-owned packages directory. State never stores password inputs. Provider secrets flow through the
existing `ServerSettingsService` secret-store behavior.

## Provider-template handler

`provider-template` is intentionally declarative. Its payload selects an existing built-in provider
driver and may declare:

- dynamic text, password, or select inputs;
- driver configuration with `{{input.id}}` interpolation;
- environment variables, including sensitive variables;
- an isolated provider home and managed files within it; and
- display metadata.

The handler decodes the interpolated config with the selected driver's own schema before it updates
settings. Sensitive inputs may only feed sensitive environment variables; they cannot be inserted
into config objects or generated files. Managed paths are resolved and checked against the
installation directory before any write.

## Remote and client behavior

Marketplace RPCs use the authenticated environment WebSocket and existing scopes:

- list and package detail require read access;
- source and installation mutations require operate access.

The shared Atom families in `packages/client-runtime` take an `EnvironmentId`, so web, desktop, and
mobile execute against the selected server. Catalogs and installations are not client-global and
do not assume localhost. The web/desktop settings route and mobile settings route are separate
presentations over the same contracts and RPC cache.

## Evolution rules

- Add optional fields within schema version 1; bump the version for breaking interpretation.
- Keep catalog package types open and preserve unknown packages in snapshots.
- Give every installed type install, update, and uninstall behavior before marking it available.
- Declare every effect as a permission before install.
- Persist references and non-sensitive answers, never credentials.
- Constrain writes to T3-owned locations and avoid arbitrary package scripts.
- Use exact package SemVer; compatibility ranges belong only in `compatibility`.
