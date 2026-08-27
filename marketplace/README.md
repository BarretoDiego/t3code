# T3 Code marketplace

This directory contains the first-party packages listed by the root
`t3-marketplace.json`. The same static format can be hosted from any public or
private HTTP(S) location; T3 Code does not require a registry service.

Each marketplace has one small catalog and one manifest per package. Catalog
entries provide browse metadata and point to a relative or absolute package
manifest. Publishers may add a `sha256-<hex>` integrity value calculated from
the exact package manifest bytes.

Package `type` is open-ended. T3 Code v1 ships a `provider-template` handler and
keeps unknown types visible as unsupported. Future `skill`, `tool`, and `mcp`
handlers can reuse the same catalog and install lifecycle.

Provider templates are declarative. They may configure an existing provider
driver, declare user inputs and environment variables, and materialize files
inside a T3-owned provider home. They cannot execute install scripts or write
outside that managed directory. Password inputs may only flow to sensitive
environment variables, which are persisted by the environment secret store.

To publish a community marketplace:

1. Copy the schemas from `marketplace/schemas` and create `t3-marketplace.json`.
2. Add package manifests and reference them from the catalog.
3. Serve the files over HTTP(S), or put them in a GitHub repository root.
4. Add the manifest or GitHub repository URL in Settings → Marketplace.

The canonical examples in `marketplace/packages` are validation fixtures as
well as installable packages. Bump a package's exact SemVer whenever its
manifest changes.
