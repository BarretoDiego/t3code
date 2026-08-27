/**
 * Open marketplace contracts.
 *
 * A marketplace is a catalog of versioned packages. Package metadata is
 * deliberately generic and package payloads are opaque until a server-side
 * handler for their `type` decodes them. `provider-template` is the first
 * supported type; future skill, tool, and MCP handlers can use the same
 * catalog, source, installation, and RPC lifecycle without changing v1.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  ProviderDriverKind,
  ProviderInstanceEnvironmentVariableName,
  ProviderInstanceId,
} from "./providerInstance.ts";

const identifier = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-z0-9][a-z0-9._-]*$/),
);

export const MarketplaceId = identifier.pipe(Schema.brand("MarketplaceId"));
export type MarketplaceId = typeof MarketplaceId.Type;

export const MarketplacePackageId = identifier.pipe(Schema.brand("MarketplacePackageId"));
export type MarketplacePackageId = typeof MarketplacePackageId.Type;

export const MarketplaceInstallationId = identifier.pipe(Schema.brand("MarketplaceInstallationId"));
export type MarketplaceInstallationId = typeof MarketplaceInstallationId.Type;

export const MarketplaceInputId = identifier.pipe(Schema.brand("MarketplaceInputId"));
export type MarketplaceInputId = typeof MarketplaceInputId.Type;

/** Exact SemVer. Ranges are reserved for compatibility declarations. */
export const MarketplacePackageVersion = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  ),
);
export type MarketplacePackageVersion = typeof MarketplacePackageVersion.Type;

/**
 * Open package-kind string. Unknown kinds remain listable so an older client
 * can browse a newer marketplace and report that no local handler is present.
 */
export const MarketplacePackageType = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z][a-z0-9-]*$/),
);
export type MarketplacePackageType = typeof MarketplacePackageType.Type;

export const PROVIDER_TEMPLATE_PACKAGE_TYPE = "provider-template" as const;

export const MarketplacePermission = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-z][a-z0-9.-]*$/),
);
export type MarketplacePermission = typeof MarketplacePermission.Type;

export const MarketplacePackageCompatibility = Schema.Struct({
  t3: Schema.optionalKey(TrimmedNonEmptyString),
  platforms: Schema.optionalKey(Schema.Array(Schema.Literals(["darwin", "linux", "win32"]))),
});
export type MarketplacePackageCompatibility = typeof MarketplacePackageCompatibility.Type;

export const MarketplaceCatalogPackage = Schema.Struct({
  id: MarketplacePackageId,
  type: MarketplacePackageType,
  name: TrimmedNonEmptyString,
  version: MarketplacePackageVersion,
  description: TrimmedNonEmptyString,
  manifest: TrimmedNonEmptyString,
  integrity: Schema.optionalKey(
    TrimmedNonEmptyString.check(Schema.isPattern(/^sha256-[0-9a-f]{64}$/)),
  ),
  publisher: Schema.optionalKey(TrimmedNonEmptyString),
  icon: Schema.optionalKey(TrimmedNonEmptyString),
  tags: Schema.Array(TrimmedNonEmptyString).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  permissions: Schema.Array(MarketplacePermission).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  compatibility: Schema.optionalKey(MarketplacePackageCompatibility),
});
export type MarketplaceCatalogPackage = typeof MarketplaceCatalogPackage.Type;

export const MarketplaceManifest = Schema.Struct({
  $schema: Schema.optionalKey(TrimmedNonEmptyString),
  schemaVersion: Schema.Literal(1),
  id: MarketplaceId,
  name: TrimmedNonEmptyString,
  description: Schema.optionalKey(TrimmedNonEmptyString),
  homepage: Schema.optionalKey(TrimmedNonEmptyString),
  packages: Schema.Array(MarketplaceCatalogPackage),
});
export type MarketplaceManifest = typeof MarketplaceManifest.Type;

export const MarketplacePackageManifest = Schema.Struct({
  $schema: Schema.optionalKey(TrimmedNonEmptyString),
  schemaVersion: Schema.Literal(1),
  id: MarketplacePackageId,
  type: MarketplacePackageType,
  name: TrimmedNonEmptyString,
  version: MarketplacePackageVersion,
  description: TrimmedNonEmptyString,
  publisher: Schema.optionalKey(TrimmedNonEmptyString),
  license: Schema.optionalKey(TrimmedNonEmptyString),
  homepage: Schema.optionalKey(TrimmedNonEmptyString),
  repository: Schema.optionalKey(TrimmedNonEmptyString),
  readme: Schema.optionalKey(TrimmedNonEmptyString),
  permissions: Schema.Array(MarketplacePermission).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  compatibility: Schema.optionalKey(MarketplacePackageCompatibility),
  payload: Schema.Unknown,
});
export type MarketplacePackageManifest = typeof MarketplacePackageManifest.Type;

export const MarketplaceTemplateInputOption = Schema.Struct({
  value: Schema.String,
  label: TrimmedNonEmptyString,
});

export const MarketplaceTemplateInput = Schema.Struct({
  id: MarketplaceInputId,
  label: TrimmedNonEmptyString,
  description: Schema.optionalKey(TrimmedNonEmptyString),
  control: Schema.Literals(["text", "password", "select"]),
  required: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  default: Schema.optionalKey(Schema.String),
  placeholder: Schema.optionalKey(Schema.String),
  options: Schema.Array(MarketplaceTemplateInputOption).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type MarketplaceTemplateInput = typeof MarketplaceTemplateInput.Type;

export const ProviderTemplateEnvironmentVariable = Schema.Struct({
  name: ProviderInstanceEnvironmentVariableName,
  input: Schema.optionalKey(MarketplaceInputId),
  value: Schema.optionalKey(Schema.String),
  sensitive: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  required: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type ProviderTemplateEnvironmentVariable = typeof ProviderTemplateEnvironmentVariable.Type;

export const ProviderTemplateManagedFile = Schema.Struct({
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  content: Schema.String.check(Schema.isMaxLength(512 * 1024)),
});
export type ProviderTemplateManagedFile = typeof ProviderTemplateManagedFile.Type;

export const ProviderTemplatePayload = Schema.Struct({
  driver: ProviderDriverKind,
  suggestedInstanceId: ProviderInstanceId,
  displayName: TrimmedNonEmptyString,
  accentColor: Schema.optionalKey(TrimmedNonEmptyString),
  inputs: Schema.Array(MarketplaceTemplateInput).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  config: Schema.optionalKey(Schema.Unknown),
  environment: Schema.Array(ProviderTemplateEnvironmentVariable).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  providerHome: Schema.optionalKey(
    Schema.Struct({
      configField: Schema.Literals(["homePath"]),
      files: Schema.Array(ProviderTemplateManagedFile),
    }),
  ),
});
export type ProviderTemplatePayload = typeof ProviderTemplatePayload.Type;

export const MarketplaceSource = Schema.Struct({
  id: MarketplaceId,
  name: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  official: Schema.Boolean,
  removable: Schema.Boolean,
});
export type MarketplaceSource = typeof MarketplaceSource.Type;

export const MarketplacePackageAvailability = Schema.Literals([
  "available",
  "unsupported-type",
  "incompatible",
]);
export type MarketplacePackageAvailability = typeof MarketplacePackageAvailability.Type;

export const MarketplaceCatalogEntry = Schema.Struct({
  sourceId: MarketplaceId,
  sourceName: TrimmedNonEmptyString,
  package: MarketplaceCatalogPackage,
  availability: MarketplacePackageAvailability,
  installedVersions: Schema.Array(MarketplacePackageVersion),
  updateAvailable: Schema.Boolean,
});
export type MarketplaceCatalogEntry = typeof MarketplaceCatalogEntry.Type;

export const MarketplaceSourceLoadError = Schema.Struct({
  sourceId: MarketplaceId,
  sourceName: TrimmedNonEmptyString,
  detail: TrimmedNonEmptyString,
});
export type MarketplaceSourceLoadError = typeof MarketplaceSourceLoadError.Type;

export const MarketplaceInstallationTarget = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("provider-instance"),
    instanceId: ProviderInstanceId,
  }),
  Schema.Struct({
    type: Schema.Literal("package-reference"),
    packageType: MarketplacePackageType,
    reference: TrimmedNonEmptyString,
  }),
]);
export type MarketplaceInstallationTarget = typeof MarketplaceInstallationTarget.Type;

export const MarketplaceInstallation = Schema.Struct({
  id: MarketplaceInstallationId,
  sourceId: MarketplaceId,
  packageId: MarketplacePackageId,
  packageType: MarketplacePackageType,
  packageName: TrimmedNonEmptyString,
  installedVersion: MarketplacePackageVersion,
  installedAt: TrimmedNonEmptyString,
  updatedAt: TrimmedNonEmptyString,
  target: MarketplaceInstallationTarget,
});
export type MarketplaceInstallation = typeof MarketplaceInstallation.Type;

export const MarketplaceSnapshot = Schema.Struct({
  sources: Schema.Array(MarketplaceSource),
  packages: Schema.Array(MarketplaceCatalogEntry),
  installations: Schema.Array(MarketplaceInstallation),
  sourceErrors: Schema.Array(MarketplaceSourceLoadError),
});
export type MarketplaceSnapshot = typeof MarketplaceSnapshot.Type;

export const MarketplacePackageDetail = Schema.Struct({
  source: MarketplaceSource,
  catalog: MarketplaceCatalogPackage,
  manifest: MarketplacePackageManifest,
  availability: MarketplacePackageAvailability,
  installations: Schema.Array(MarketplaceInstallation),
});
export type MarketplacePackageDetail = typeof MarketplacePackageDetail.Type;

export const MarketplaceInstallInput = Schema.Struct({
  sourceId: MarketplaceId,
  packageId: MarketplacePackageId,
  instanceId: Schema.optionalKey(ProviderInstanceId),
  displayName: Schema.optionalKey(TrimmedNonEmptyString),
  inputs: Schema.Record(MarketplaceInputId, Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
});
export type MarketplaceInstallInput = typeof MarketplaceInstallInput.Type;

export const MarketplaceUpdateInput = Schema.Struct({
  installationId: MarketplaceInstallationId,
  inputs: Schema.Record(MarketplaceInputId, Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
});
export type MarketplaceUpdateInput = typeof MarketplaceUpdateInput.Type;

export const MarketplaceOperation = Schema.Literals([
  "list",
  "read-package",
  "add-source",
  "remove-source",
  "install",
  "update",
  "uninstall",
  "read-state",
  "write-state",
  "fetch",
  "validate",
  "materialize",
]);
export type MarketplaceOperation = typeof MarketplaceOperation.Type;

export const MarketplaceErrorReason = Schema.Literals([
  "invalid-url",
  "fetch-failed",
  "invalid-manifest",
  "source-conflict",
  "source-not-found",
  "source-in-use",
  "package-not-found",
  "unsupported-type",
  "incompatible",
  "integrity-mismatch",
  "invalid-input",
  "instance-conflict",
  "installation-not-found",
  "state-failed",
  "materialization-failed",
]);
export type MarketplaceErrorReason = typeof MarketplaceErrorReason.Type;

export class MarketplaceError extends Schema.TaggedErrorClass<MarketplaceError>()(
  "MarketplaceError",
  {
    operation: MarketplaceOperation,
    reason: MarketplaceErrorReason,
    detail: TrimmedNonEmptyString,
    sourceId: Schema.optionalKey(MarketplaceId),
    packageId: Schema.optionalKey(MarketplacePackageId),
    installationId: Schema.optionalKey(MarketplaceInstallationId),
  },
) {
  override get message(): string {
    return this.detail;
  }
}
