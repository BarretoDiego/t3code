import {
  MarketplaceCatalogEntry,
  type MarketplaceCatalogPackage,
  MarketplaceError,
  type MarketplaceExportedTemplate,
  type MarketplaceExportProviderTemplateInput,
  MarketplaceId,
  type MarketplaceInstallInput,
  type MarketplaceInstallation,
  type MarketplaceInstallationTarget,
  MarketplaceInstallationId,
  type MarketplacePackageAvailability,
  type MarketplacePackageDetail,
  type MarketplacePackageManifest,
  MarketplaceManifest,
  MarketplacePackageId,
  MarketplacePackageManifest as MarketplacePackageManifestSchema,
  type MarketplaceSetAutoUpdateInput,
  type MarketplaceSnapshot,
  type MarketplaceSource,
  MarketplaceSource as MarketplaceSourceSchema,
  type MarketplaceSourceLoadError,
  type MarketplaceUpdateInput,
  PROVIDER_TEMPLATE_PACKAGE_TYPE,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
  type ProviderInstanceId,
  ProviderTemplatePayload,
  type ProviderTemplatePayload as ProviderTemplatePayloadType,
  type ServerSettingsError,
} from "@t3tools/contracts";
import { compareSemverVersions, satisfiesSemverRange } from "@t3tools/shared/semver";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as Crypto from "effect/Crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import packageJson from "../../package.json" with { type: "json" };
import { writeFileStringAtomically } from "../atomicWrite.ts";
import { ServerConfig } from "../config.ts";
import { BUILT_IN_DRIVERS } from "../provider/builtInDrivers.ts";
import { ServerSettingsService } from "../serverSettings.ts";

const OFFICIAL_SOURCE: MarketplaceSource = {
  id: MarketplaceId.make("t3-official"),
  name: "T3 Code Official",
  url: "https://raw.githubusercontent.com/BarretoDiego/t3code/main/t3-marketplace.json",
  official: true,
  removable: false,
};

const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;

const PersistedMarketplaceInstallation = Schema.Struct({
  installation: Schema.Struct({
    id: MarketplaceInstallationId,
    sourceId: MarketplaceId,
    packageId: MarketplacePackageId,
    packageType: Schema.String,
    packageName: Schema.String,
    installedVersion: Schema.String,
    installedAt: Schema.String,
    updatedAt: Schema.String,
    autoUpdate: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
    target: Schema.Union([
      Schema.Struct({ type: Schema.Literal("provider-instance"), instanceId: Schema.String }),
      Schema.Struct({
        type: Schema.Literal("package-reference"),
        packageType: Schema.String,
        reference: Schema.String,
      }),
    ]),
  }),
  inputs: Schema.Record(Schema.String, Schema.String),
});

const PersistedMarketplaceState = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sources: Schema.Array(MarketplaceSourceSchema),
  installations: Schema.Array(PersistedMarketplaceInstallation),
});
type PersistedMarketplaceState = typeof PersistedMarketplaceState.Type;
type PersistedInstallation = typeof PersistedMarketplaceInstallation.Type;

const DEFAULT_STATE: PersistedMarketplaceState = {
  schemaVersion: 1,
  sources: [],
  installations: [],
};

const decodeStateJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PersistedMarketplaceState),
);
const encodeStateJson = Schema.encodeEffect(Schema.fromJsonString(PersistedMarketplaceState));
const decodeMarketplaceJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(MarketplaceManifest),
);
const decodePackageJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(MarketplacePackageManifestSchema),
);
const decodePackageManifest = Schema.decodeUnknownEffect(MarketplacePackageManifestSchema);
const decodeProviderTemplate = Schema.decodeUnknownEffect(ProviderTemplatePayload);
const decodeUnknownRecord = Schema.decodeUnknownEffect(
  Schema.Record(Schema.String, Schema.Unknown),
);

function sameStringSet(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function sameCompatibility(
  left: MarketplaceCatalogPackage["compatibility"],
  right: MarketplacePackageManifest["compatibility"],
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.t3 === right.t3 && sameStringSet(left.platforms ?? [], right.platforms ?? []);
}

export function validateProviderTemplatePermissions(
  manifest: MarketplacePackageManifest,
): Effect.Effect<void, MarketplaceError> {
  return decodeProviderTemplate(manifest.payload).pipe(
    Effect.mapError((cause) =>
      error({
        operation: "validate",
        reason: "invalid-manifest",
        detail: `Provider template payload is invalid: ${errorDetail(cause)}`,
        packageId: manifest.id,
      }),
    ),
    Effect.flatMap((payload) => {
      const required = [
        "provider.configure",
        ...(payload.environment.length > 0 ? ["provider.environment"] : []),
        ...(payload.providerHome ? ["provider.files"] : []),
      ];
      const missing = required.filter((permission) => !manifest.permissions.includes(permission));
      return missing.length === 0
        ? Effect.void
        : Effect.fail(
            error({
              operation: "validate",
              reason: "invalid-manifest",
              detail: `Provider template is missing permissions: ${missing.join(", ")}.`,
              packageId: manifest.id,
            }),
          );
    }),
  );
}

const PACKAGE_MANIFEST_VALIDATORS: ReadonlyMap<
  string,
  (manifest: MarketplacePackageManifest) => Effect.Effect<void, MarketplaceError>
> = new Map([[PROVIDER_TEMPLATE_PACKAGE_TYPE, validateProviderTemplatePermissions]]);

/**
 * Package types are capabilities of the environment, not of the catalog format.
 * A catalog may publish any valid type; registering a handler makes that type
 * installable without changing marketplace sources, transport, or persistence.
 */
export const MARKETPLACE_PACKAGE_HANDLER_TYPES: ReadonlySet<string> = new Set(
  PACKAGE_MANIFEST_VALIDATORS.keys(),
);

function error(input: {
  readonly operation: MarketplaceError["operation"];
  readonly reason: MarketplaceError["reason"];
  readonly detail: string;
  readonly sourceId?: MarketplaceId | undefined;
  readonly packageId?: MarketplacePackageId | undefined;
  readonly installationId?: MarketplaceInstallationId | undefined;
}): MarketplaceError {
  return new MarketplaceError({
    operation: input.operation,
    reason: input.reason,
    detail: input.detail,
    ...(input.sourceId ? { sourceId: input.sourceId } : {}),
    ...(input.packageId ? { packageId: input.packageId } : {}),
    ...(input.installationId ? { installationId: input.installationId } : {}),
  });
}

function errorDetail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Render an arbitrary instance id as a valid lowercase marketplace package id. */
export function sanitizeMarketplacePackageId(raw: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/_/g, "-")
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^[.-]+/, "")
    .replace(/[.-]+$/, "")
    .slice(0, 128);
  if (slug.length === 0) return "provider-template";
  return /^[a-z0-9]/.test(slug) ? slug : `x${slug}`;
}

/** Derive a unique template input id from an environment variable name. */
function nextTemplateInputId(variableName: string, used: Set<string>): string {
  const base =
    variableName
      .toLowerCase()
      .replace(/_/g, "-")
      .replace(/^[._-]+/, "") || "value";
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

/** Accept an exact JSON URL, a directory URL, or a GitHub repository URL. */
export function normalizeMarketplaceSourceUrl(raw: string): string | null {
  const value = raw.trim();
  if (value.length === 0) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  url.hash = "";
  if (url.hostname.toLowerCase() === "github.com") {
    const segments = url.pathname.split("/").filter(Boolean);
    const owner = segments[0];
    const repository = segments[1]?.replace(/\.git$/, "");
    if (!owner || !repository) return null;
    if (segments[2] === "tree" && segments[3]) {
      const ref = segments[3];
      const directory = segments.slice(4).join("/");
      return `https://raw.githubusercontent.com/${owner}/${repository}/${ref}/${directory ? `${directory}/` : ""}t3-marketplace.json`;
    }
    if (segments.length <= 2) {
      return `https://raw.githubusercontent.com/${owner}/${repository}/HEAD/t3-marketplace.json`;
    }
  }
  if (!url.pathname.toLowerCase().endsWith(".json")) {
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/t3-marketplace.json`;
  }
  return url.toString();
}

function resolvePackageManifestUrl(sourceUrl: string, manifest: string): string | null {
  try {
    const resolved = new URL(manifest, sourceUrl);
    return resolved.protocol === "https:" || resolved.protocol === "http:"
      ? resolved.toString()
      : null;
  } catch {
    return null;
  }
}

export function marketplacePackageAvailability(
  packageType: string,
  compatibility: MarketplaceCatalogPackage["compatibility"],
  hostPlatform: NodeJS.Platform,
): MarketplacePackageAvailability {
  if (!MARKETPLACE_PACKAGE_HANDLER_TYPES.has(packageType)) return "unsupported-type";
  const platform =
    hostPlatform === "darwin" || hostPlatform === "linux" || hostPlatform === "win32"
      ? hostPlatform
      : null;
  if (
    compatibility?.platforms &&
    (platform === null || !compatibility.platforms.includes(platform))
  ) {
    return "incompatible";
  }
  if (compatibility?.t3 && !satisfiesSemverRange(packageJson.version, compatibility.t3)) {
    return "incompatible";
  }
  return "available";
}

function replaceInputMarkers(value: string, inputs: Readonly<Record<string, string>>): string {
  return value.replace(/\{\{input\.([a-z0-9._-]+)\}\}/g, (_match, inputId: string) => {
    return inputs[inputId] ?? "";
  });
}

function interpolateValue(value: unknown, inputs: Readonly<Record<string, string>>): unknown {
  if (typeof value === "string") return replaceInputMarkers(value, inputs);
  if (Array.isArray(value)) return value.map((entry) => interpolateValue(entry, inputs));
  if (Predicate.isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, interpolateValue(entry, inputs)]),
    );
  }
  return value;
}

function markerReferences(value: unknown): ReadonlySet<string> {
  const references = new Set<string>();
  const visit = (entry: unknown) => {
    if (typeof entry === "string") {
      for (const match of entry.matchAll(/\{\{input\.([a-z0-9._-]+)\}\}/g)) {
        if (match[1]) references.add(match[1]);
      }
      return;
    }
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item);
      return;
    }
    if (Predicate.isObject(entry)) {
      for (const item of Object.values(entry)) visit(item);
    }
  };
  visit(value);
  return references;
}

export function validateProviderTemplateInputs(input: {
  readonly payload: ProviderTemplatePayloadType;
  readonly supplied: Readonly<Record<string, string>>;
  readonly existingEnvironment?: ReadonlyArray<ProviderInstanceEnvironmentVariable> | undefined;
}): Effect.Effect<
  {
    readonly values: Record<string, string>;
    readonly persistedValues: Record<string, string>;
  },
  MarketplaceError
> {
  const definitions = new Map<string, (typeof input.payload.inputs)[number]>();
  for (const definition of input.payload.inputs) {
    if (definitions.has(definition.id)) {
      return Effect.fail(
        error({
          operation: "validate",
          reason: "invalid-manifest",
          detail: `Template input '${definition.id}' is declared more than once.`,
        }),
      );
    }
    definitions.set(definition.id, definition);
  }

  for (const suppliedId of Object.keys(input.supplied)) {
    if (!definitions.has(suppliedId)) {
      return Effect.fail(
        error({
          operation: "validate",
          reason: "invalid-input",
          detail: `Input '${suppliedId}' is not declared by this package.`,
        }),
      );
    }
  }

  const sensitiveInputIds = new Set<string>(
    input.payload.inputs
      .filter((definition) => definition.control === "password")
      .map((definition) => definition.id),
  );
  for (const variable of input.payload.environment) {
    if (variable.sensitive && variable.input) sensitiveInputIds.add(variable.input);
    if ((variable.input === undefined) === (variable.value === undefined)) {
      return Effect.fail(
        error({
          operation: "validate",
          reason: "invalid-manifest",
          detail: `Environment variable '${variable.name}' must declare exactly one of input or value.`,
        }),
      );
    }
    if (variable.input && !definitions.has(variable.input)) {
      return Effect.fail(
        error({
          operation: "validate",
          reason: "invalid-manifest",
          detail: `Environment variable '${variable.name}' references unknown input '${variable.input}'.`,
        }),
      );
    }
  }

  const unsafeReferences = new Set([
    ...markerReferences(input.payload.config),
    ...markerReferences(input.payload.providerHome?.files.map((file) => file.content)),
  ]);
  for (const sensitiveInputId of sensitiveInputIds) {
    if (unsafeReferences.has(sensitiveInputId)) {
      return Effect.fail(
        error({
          operation: "validate",
          reason: "invalid-manifest",
          detail: `Sensitive input '${sensitiveInputId}' may only be used by a sensitive environment variable.`,
        }),
      );
    }
  }

  const existingByName = new Map(
    (input.existingEnvironment ?? []).map((variable) => [variable.name, variable.value]),
  );
  const values: Record<string, string> = {};
  for (const definition of input.payload.inputs) {
    const supplied = input.supplied[definition.id];
    const environmentFallback = input.payload.environment
      .filter((variable) => variable.input === definition.id)
      .map((variable) => existingByName.get(variable.name))
      .find((value) => value !== undefined && value.length > 0);
    const value = supplied ?? environmentFallback ?? definition.default ?? "";
    if (definition.required && value.length === 0) {
      return Effect.fail(
        error({
          operation: "validate",
          reason: "invalid-input",
          detail: `Input '${definition.label}' is required.`,
        }),
      );
    }
    if (
      definition.control === "select" &&
      value.length > 0 &&
      !definition.options.some((option) => option.value === value)
    ) {
      return Effect.fail(
        error({
          operation: "validate",
          reason: "invalid-input",
          detail: `Input '${definition.label}' has an unsupported value.`,
        }),
      );
    }
    values[definition.id] = value;
  }
  return Effect.succeed({
    values,
    persistedValues: Object.fromEntries(
      Object.entries(values).filter(([inputId]) => !sensitiveInputIds.has(inputId)),
    ),
  });
}

export class MarketplaceService extends Context.Service<
  MarketplaceService,
  {
    readonly list: () => Effect.Effect<MarketplaceSnapshot, MarketplaceError>;
    readonly getPackage: (
      sourceId: MarketplaceId,
      packageId: MarketplacePackageId,
    ) => Effect.Effect<MarketplacePackageDetail, MarketplaceError>;
    readonly addSource: (url: string) => Effect.Effect<MarketplaceSnapshot, MarketplaceError>;
    readonly removeSource: (
      sourceId: MarketplaceId,
    ) => Effect.Effect<MarketplaceSnapshot, MarketplaceError>;
    readonly install: (
      input: MarketplaceInstallInput,
    ) => Effect.Effect<MarketplaceSnapshot, MarketplaceError | ServerSettingsError>;
    readonly update: (
      input: MarketplaceUpdateInput,
    ) => Effect.Effect<MarketplaceSnapshot, MarketplaceError | ServerSettingsError>;
    readonly uninstall: (
      installationId: MarketplaceInstallationId,
    ) => Effect.Effect<MarketplaceSnapshot, MarketplaceError | ServerSettingsError>;
    readonly setAutoUpdate: (
      input: MarketplaceSetAutoUpdateInput,
    ) => Effect.Effect<MarketplaceSnapshot, MarketplaceError>;
    readonly exportProviderTemplate: (
      input: MarketplaceExportProviderTemplateInput,
    ) => Effect.Effect<MarketplaceExportedTemplate, MarketplaceError>;
  }
>()("t3/marketplace/MarketplaceService") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const hostPlatform = yield* HostProcessPlatform;
  const httpClient = yield* HttpClient.HttpClient;
  const config = yield* ServerConfig;
  const serverSettings = yield* ServerSettingsService;
  const mutationLock = yield* Semaphore.make(1);

  const readState = Effect.fn("MarketplaceService.readState")(function* () {
    const exists = yield* fileSystem.exists(config.marketplaceStatePath).pipe(
      Effect.mapError((cause) =>
        error({
          operation: "read-state",
          reason: "state-failed",
          detail: `Could not check marketplace state: ${errorDetail(cause)}`,
        }),
      ),
    );
    if (!exists) return DEFAULT_STATE;
    const raw = yield* fileSystem.readFileString(config.marketplaceStatePath).pipe(
      Effect.mapError((cause) =>
        error({
          operation: "read-state",
          reason: "state-failed",
          detail: `Could not read marketplace state: ${errorDetail(cause)}`,
        }),
      ),
    );
    return yield* decodeStateJson(raw).pipe(
      Effect.mapError((cause) =>
        error({
          operation: "read-state",
          reason: "state-failed",
          detail: `Marketplace state is invalid: ${errorDetail(cause)}`,
        }),
      ),
    );
  });

  const writeState = Effect.fn("MarketplaceService.writeState")(function* (
    state: PersistedMarketplaceState,
  ) {
    const encoded = yield* encodeStateJson(state).pipe(
      Effect.mapError((cause) =>
        error({
          operation: "write-state",
          reason: "state-failed",
          detail: `Could not encode marketplace state: ${errorDetail(cause)}`,
        }),
      ),
    );
    yield* writeFileStringAtomically({
      filePath: config.marketplaceStatePath,
      contents: `${encoded}\n`,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError((cause) =>
        error({
          operation: "write-state",
          reason: "state-failed",
          detail: `Could not persist marketplace state: ${errorDetail(cause)}`,
        }),
      ),
    );
  });

  const fetchText = Effect.fn("MarketplaceService.fetchText")(function* (input: {
    readonly url: string;
    readonly sourceId?: MarketplaceId | undefined;
    readonly packageId?: MarketplacePackageId | undefined;
  }) {
    const response = yield* HttpClientRequest.get(input.url).pipe(
      HttpClientRequest.acceptJson,
      httpClient.execute,
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.timeout(FETCH_TIMEOUT_MS),
      Effect.mapError((cause) =>
        error({
          operation: "fetch",
          reason: "fetch-failed",
          detail: `Could not fetch '${input.url}': ${errorDetail(cause)}`,
          ...(input.sourceId ? { sourceId: input.sourceId } : {}),
          ...(input.packageId ? { packageId: input.packageId } : {}),
        }),
      ),
    );
    const boundedBody = yield* response.stream.pipe(
      Stream.mapError((cause) =>
        error({
          operation: "fetch",
          reason: "fetch-failed",
          detail: `Could not read '${input.url}': ${errorDetail(cause)}`,
          ...(input.sourceId ? { sourceId: input.sourceId } : {}),
          ...(input.packageId ? { packageId: input.packageId } : {}),
        }),
      ),
      Stream.runFoldEffect(
        () => ({ chunks: [] as Array<Uint8Array>, byteLength: 0 }),
        (accumulator, chunk) => {
          const byteLength = accumulator.byteLength + chunk.byteLength;
          return byteLength > MAX_MANIFEST_BYTES
            ? Effect.fail(
                error({
                  operation: "fetch",
                  reason: "invalid-manifest",
                  detail: `Manifest '${input.url}' exceeds ${MAX_MANIFEST_BYTES} bytes.`,
                  ...(input.sourceId ? { sourceId: input.sourceId } : {}),
                  ...(input.packageId ? { packageId: input.packageId } : {}),
                }),
              )
            : Effect.succeed({ chunks: [...accumulator.chunks, chunk], byteLength });
        },
      ),
    );
    const bytes = new Uint8Array(boundedBody.byteLength);
    let offset = 0;
    for (const chunk of boundedBody.chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  });

  const loadSource = Effect.fn("MarketplaceService.loadSource")(function* (
    source: MarketplaceSource,
  ) {
    const body = yield* fetchText({ url: source.url, sourceId: source.id });
    const manifest = yield* decodeMarketplaceJson(body).pipe(
      Effect.mapError((cause) =>
        error({
          operation: "validate",
          reason: "invalid-manifest",
          detail: `Marketplace '${source.name}' is invalid: ${errorDetail(cause)}`,
          sourceId: source.id,
        }),
      ),
    );
    if (manifest.id !== source.id) {
      return yield* error({
        operation: "validate",
        reason: "invalid-manifest",
        detail: `Marketplace id '${manifest.id}' does not match source id '${source.id}'.`,
        sourceId: source.id,
      });
    }
    const duplicateIds = manifest.packages.filter(
      (entry, index, entries) => entries.findIndex((item) => item.id === entry.id) !== index,
    );
    if (duplicateIds.length > 0) {
      return yield* error({
        operation: "validate",
        reason: "invalid-manifest",
        detail: `Marketplace '${source.name}' declares package '${duplicateIds[0]!.id}' more than once.`,
        sourceId: source.id,
      });
    }
    return manifest;
  });

  const sourcesForState = (state: PersistedMarketplaceState): ReadonlyArray<MarketplaceSource> => [
    OFFICIAL_SOURCE,
    ...state.sources.filter((source) => source.id !== OFFICIAL_SOURCE.id),
  ];

  const listFromState = Effect.fn("MarketplaceService.listFromState")(function* (
    state: PersistedMarketplaceState,
  ) {
    const sources = sourcesForState(state);
    const results = yield* Effect.forEach(
      sources,
      (source) =>
        loadSource(source).pipe(
          Effect.result,
          Effect.map((result) => ({ source, result })),
        ),
      { concurrency: 4 },
    );
    const packages: MarketplaceCatalogEntry[] = [];
    const sourceErrors: MarketplaceSourceLoadError[] = [];
    for (const { source, result } of results) {
      if (Result.isFailure(result)) {
        sourceErrors.push({
          sourceId: source.id,
          sourceName: source.name,
          detail: result.failure.detail,
        });
        continue;
      }
      for (const packageEntry of result.success.packages) {
        const installedVersions = state.installations
          .filter(
            ({ installation }) =>
              installation.sourceId === source.id && installation.packageId === packageEntry.id,
          )
          .map(({ installation }) => installation.installedVersion);
        packages.push({
          sourceId: source.id,
          sourceName: source.name,
          package: packageEntry,
          availability: marketplacePackageAvailability(
            packageEntry.type,
            packageEntry.compatibility,
            hostPlatform,
          ),
          installedVersions,
          updateAvailable: installedVersions.some(
            (version) => compareSemverVersions(packageEntry.version, version) > 0,
          ),
        });
      }
    }
    return {
      sources,
      packages,
      installations: state.installations.map(
        ({ installation }) => installation as MarketplaceInstallation,
      ),
      sourceErrors,
    } satisfies MarketplaceSnapshot;
  });

  const list = Effect.fn("MarketplaceService.list")(function* () {
    return yield* listFromState(yield* readState());
  });

  const findSource = (
    state: PersistedMarketplaceState,
    sourceId: MarketplaceId,
  ): MarketplaceSource | undefined =>
    sourcesForState(state).find((source) => source.id === sourceId);

  const getPackageFromState = Effect.fn("MarketplaceService.getPackageFromState")(function* (
    state: PersistedMarketplaceState,
    sourceId: MarketplaceId,
    packageId: MarketplacePackageId,
  ) {
    const source = findSource(state, sourceId);
    if (!source) {
      return yield* error({
        operation: "read-package",
        reason: "source-not-found",
        detail: `Marketplace source '${sourceId}' was not found.`,
        sourceId,
        packageId,
      });
    }
    const marketplace = yield* loadSource(source);
    const catalog = marketplace.packages.find((entry) => entry.id === packageId);
    if (!catalog) {
      return yield* error({
        operation: "read-package",
        reason: "package-not-found",
        detail: `Package '${packageId}' was not found in '${source.name}'.`,
        sourceId,
        packageId,
      });
    }
    const manifestUrl = resolvePackageManifestUrl(source.url, catalog.manifest);
    if (!manifestUrl) {
      return yield* error({
        operation: "validate",
        reason: "invalid-url",
        detail: `Package '${packageId}' has an invalid manifest URL.`,
        sourceId,
        packageId,
      });
    }
    const body = yield* fetchText({ url: manifestUrl, sourceId, packageId });
    if (catalog.integrity) {
      const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(body)).pipe(
        Effect.mapError((cause) =>
          error({
            operation: "validate",
            reason: "integrity-mismatch",
            detail: `Could not verify package '${packageId}': ${errorDetail(cause)}`,
            sourceId,
            packageId,
          }),
        ),
      );
      const actual = `sha256-${Encoding.encodeHex(digest)}`;
      if (actual !== catalog.integrity) {
        return yield* error({
          operation: "validate",
          reason: "integrity-mismatch",
          detail: `Package '${packageId}' did not match its catalog integrity digest.`,
          sourceId,
          packageId,
        });
      }
    }
    const manifest = yield* decodePackageJson(body).pipe(
      Effect.mapError((cause) =>
        error({
          operation: "validate",
          reason: "invalid-manifest",
          detail: `Package '${packageId}' is invalid: ${errorDetail(cause)}`,
          sourceId,
          packageId,
        }),
      ),
    );
    if (
      manifest.id !== catalog.id ||
      manifest.type !== catalog.type ||
      manifest.version !== catalog.version ||
      !sameStringSet(manifest.permissions, catalog.permissions) ||
      !sameCompatibility(manifest.compatibility, catalog.compatibility)
    ) {
      return yield* error({
        operation: "validate",
        reason: "invalid-manifest",
        detail: `Package '${packageId}' metadata does not match its catalog entry.`,
        sourceId,
        packageId,
      });
    }
    const validateManifest = PACKAGE_MANIFEST_VALIDATORS.get(manifest.type);
    if (validateManifest) {
      yield* validateManifest(manifest).pipe(
        Effect.mapError((cause) =>
          error({
            operation: "validate",
            reason: "invalid-manifest",
            detail: `Package '${packageId}' cannot be installed safely: ${errorDetail(cause)}`,
            sourceId,
            packageId,
          }),
        ),
      );
    }
    const availability = marketplacePackageAvailability(
      catalog.type,
      catalog.compatibility,
      hostPlatform,
    );
    return {
      source,
      catalog,
      manifest,
      availability,
      installations: state.installations
        .filter(
          ({ installation }) =>
            installation.sourceId === sourceId && installation.packageId === packageId,
        )
        .map(({ installation }) => installation as MarketplaceInstallation),
    } satisfies MarketplacePackageDetail;
  });

  const getPackage = Effect.fn("MarketplaceService.getPackage")(function* (
    sourceId: MarketplaceId,
    packageId: MarketplacePackageId,
  ) {
    return yield* getPackageFromState(yield* readState(), sourceId, packageId);
  });

  const materializeProviderTemplate = Effect.fn("MarketplaceService.materializeProviderTemplate")(
    function* (input: {
      readonly installationId: MarketplaceInstallationId;
      readonly manifest: MarketplacePackageManifest;
      readonly instanceId: ProviderInstanceId;
      readonly displayName?: string | undefined;
      readonly suppliedInputs: Readonly<Record<string, string>>;
      readonly existingEnvironment?: ReadonlyArray<ProviderInstanceEnvironmentVariable> | undefined;
    }) {
      const payload = yield* decodeProviderTemplate(input.manifest.payload).pipe(
        Effect.mapError((cause) =>
          error({
            operation: "validate",
            reason: "invalid-manifest",
            detail: `Provider template payload is invalid: ${errorDetail(cause)}`,
            packageId: input.manifest.id,
          }),
        ),
      );
      const driver = BUILT_IN_DRIVERS.find((entry) => entry.driverKind === payload.driver);
      if (!driver) {
        return yield* error({
          operation: "install",
          reason: "incompatible",
          detail: `This T3 Code build does not provide driver '${payload.driver}'.`,
          packageId: input.manifest.id,
        });
      }
      const resolvedInputs = yield* validateProviderTemplateInputs({
        payload,
        supplied: input.suppliedInputs,
        ...(input.existingEnvironment ? { existingEnvironment: input.existingEnvironment } : {}),
      });
      const providerHome = payload.providerHome
        ? path.join(config.marketplacePackagesDir, input.installationId, "provider-home")
        : undefined;
      if (payload.providerHome && providerHome) {
        yield* fileSystem.makeDirectory(providerHome, { recursive: true }).pipe(
          Effect.mapError((cause) =>
            error({
              operation: "materialize",
              reason: "materialization-failed",
              detail: `Could not create the managed provider home: ${errorDetail(cause)}`,
              packageId: input.manifest.id,
              installationId: input.installationId,
            }),
          ),
        );
        for (const file of payload.providerHome.files) {
          const target = path.resolve(providerHome, file.path);
          const relative = path.relative(providerHome, target);
          if (
            relative === "" ||
            relative === ".." ||
            relative.startsWith(`..${path.sep}`) ||
            path.isAbsolute(relative)
          ) {
            return yield* error({
              operation: "materialize",
              reason: "invalid-manifest",
              detail: `Managed file path '${file.path}' escapes the package directory.`,
              packageId: input.manifest.id,
              installationId: input.installationId,
            });
          }
          yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true }).pipe(
            Effect.andThen(
              fileSystem.writeFileString(
                target,
                replaceInputMarkers(file.content, resolvedInputs.values),
              ),
            ),
            Effect.mapError((cause) =>
              error({
                operation: "materialize",
                reason: "materialization-failed",
                detail: `Could not write managed file '${file.path}': ${errorDetail(cause)}`,
                packageId: input.manifest.id,
                installationId: input.installationId,
              }),
            ),
          );
        }
      }

      const interpolatedConfig = interpolateValue(payload.config ?? {}, resolvedInputs.values);
      const configRecord = yield* decodeUnknownRecord(interpolatedConfig).pipe(
        Effect.mapError((cause) =>
          error({
            operation: "validate",
            reason: "invalid-manifest",
            detail: `Provider config must be an object: ${errorDetail(cause)}`,
            packageId: input.manifest.id,
          }),
        ),
      );
      const configWithHome = providerHome
        ? { ...configRecord, [payload.providerHome!.configField]: providerHome }
        : configRecord;
      const configSchema = driver.configSchema as unknown as Schema.Codec<unknown>;
      const decodedConfig = yield* Schema.decodeUnknownEffect(configSchema)(configWithHome).pipe(
        Effect.mapError((cause) =>
          error({
            operation: "validate",
            reason: "invalid-manifest",
            detail: `Provider config does not match driver '${payload.driver}': ${errorDetail(cause)}`,
            packageId: input.manifest.id,
          }),
        ),
      );
      const encodedConfig = yield* Schema.encodeEffect(configSchema)(decodedConfig).pipe(
        Effect.mapError((cause) =>
          error({
            operation: "validate",
            reason: "invalid-manifest",
            detail: `Provider config could not be encoded: ${errorDetail(cause)}`,
            packageId: input.manifest.id,
          }),
        ),
      );
      const environment: ProviderInstanceEnvironmentVariable[] = [];
      for (const variable of payload.environment) {
        const value = variable.input
          ? (resolvedInputs.values[variable.input] ?? "")
          : replaceInputMarkers(variable.value ?? "", resolvedInputs.values);
        if (variable.required && value.length === 0) {
          return yield* error({
            operation: "validate",
            reason: "invalid-input",
            detail: `Environment variable '${variable.name}' is required.`,
            packageId: input.manifest.id,
          });
        }
        environment.push({ name: variable.name, value, sensitive: variable.sensitive });
      }
      const instance: ProviderInstanceConfig = {
        driver: payload.driver,
        displayName: input.displayName?.trim() || payload.displayName,
        ...(payload.accentColor ? { accentColor: payload.accentColor } : {}),
        ...(payload.icon ? { icon: payload.icon } : {}),
        environment,
        enabled: true,
        config: encodedConfig,
      };
      return { instance, persistedInputs: resolvedInputs.persistedValues, payload };
    },
  );

  interface PackageHandlerInstallResult {
    readonly target: MarketplaceInstallationTarget;
    readonly persistedInputs: Record<string, string>;
  }

  interface MarketplacePackageHandler {
    readonly type: string;
    readonly install: (input: {
      readonly detail: MarketplacePackageDetail;
      readonly request: MarketplaceInstallInput;
      readonly installationId: MarketplaceInstallationId;
    }) => Effect.Effect<PackageHandlerInstallResult, MarketplaceServiceError>;
    readonly update: (input: {
      readonly detail: MarketplacePackageDetail;
      readonly persisted: PersistedInstallation;
      readonly request: MarketplaceUpdateInput;
    }) => Effect.Effect<Record<string, string>, MarketplaceServiceError>;
    readonly uninstall: (
      persisted: PersistedInstallation,
    ) => Effect.Effect<void, MarketplaceServiceError>;
  }

  const providerTemplateHandler: MarketplacePackageHandler = {
    type: PROVIDER_TEMPLATE_PACKAGE_TYPE,
    install: Effect.fn("MarketplaceProviderTemplateHandler.install")(function* ({
      detail,
      request,
      installationId,
    }) {
      const payload = yield* decodeProviderTemplate(detail.manifest.payload).pipe(
        Effect.mapError((cause) =>
          error({
            operation: "validate",
            reason: "invalid-manifest",
            detail: `Provider template payload is invalid: ${errorDetail(cause)}`,
            sourceId: request.sourceId,
            packageId: request.packageId,
          }),
        ),
      );
      const instanceId = request.instanceId ?? payload.suggestedInstanceId;
      const settings = yield* serverSettings.getSettings;
      if (settings.providerInstances[instanceId]) {
        return yield* error({
          operation: "install",
          reason: "instance-conflict",
          detail: `Provider instance '${instanceId}' already exists. Choose another id.`,
          sourceId: request.sourceId,
          packageId: request.packageId,
        });
      }
      const materialized = yield* materializeProviderTemplate({
        installationId,
        manifest: detail.manifest,
        instanceId,
        ...(request.displayName ? { displayName: request.displayName } : {}),
        suppliedInputs: request.inputs,
      });
      yield* serverSettings.updateSettings({
        providerInstances: {
          ...settings.providerInstances,
          [instanceId]: materialized.instance,
        },
      });
      return {
        target: { type: "provider-instance", instanceId },
        persistedInputs: materialized.persistedInputs,
      };
    }),
    update: Effect.fn("MarketplaceProviderTemplateHandler.update")(function* ({
      detail,
      persisted,
      request,
    }) {
      if (persisted.installation.target.type !== "provider-instance") {
        return yield* error({
          operation: "update",
          reason: "installation-not-found",
          detail: "The provider template installation target is invalid.",
          installationId: request.installationId,
        });
      }
      const settings = yield* serverSettings.getSettings;
      const instanceId = persisted.installation.target.instanceId as ProviderInstanceId;
      const existing = settings.providerInstances[instanceId];
      if (!existing) {
        return yield* error({
          operation: "update",
          reason: "installation-not-found",
          detail: `Installed provider instance '${instanceId}' no longer exists.`,
          installationId: request.installationId,
        });
      }
      const materialized = yield* materializeProviderTemplate({
        installationId: request.installationId,
        manifest: detail.manifest,
        instanceId,
        ...(existing.displayName ? { displayName: existing.displayName } : {}),
        suppliedInputs: { ...persisted.inputs, ...request.inputs },
        existingEnvironment: existing.environment,
      });
      yield* serverSettings.updateSettings({
        providerInstances: {
          ...settings.providerInstances,
          [instanceId]: materialized.instance,
        },
      });
      return materialized.persistedInputs;
    }),
    uninstall: Effect.fn("MarketplaceProviderTemplateHandler.uninstall")(function* (persisted) {
      if (persisted.installation.target.type !== "provider-instance") {
        return yield* error({
          operation: "uninstall",
          reason: "installation-not-found",
          detail: "The provider template installation target is invalid.",
          installationId: persisted.installation.id,
        });
      }
      const settings = yield* serverSettings.getSettings;
      const providerInstances = { ...settings.providerInstances };
      delete providerInstances[persisted.installation.target.instanceId as ProviderInstanceId];
      yield* serverSettings.updateSettings({ providerInstances });
    }),
  };

  const packageHandlers: ReadonlyMap<string, MarketplacePackageHandler> = new Map([
    [providerTemplateHandler.type, providerTemplateHandler],
  ]);

  const addSource = (rawUrl: string) =>
    mutationLock.withPermits(1)(
      Effect.gen(function* () {
        const url = normalizeMarketplaceSourceUrl(rawUrl);
        if (!url) {
          return yield* error({
            operation: "add-source",
            reason: "invalid-url",
            detail: "Enter an HTTP(S) marketplace manifest or repository URL.",
          });
        }
        const temporarySource: MarketplaceSource = {
          id: MarketplaceId.make("pending-source"),
          name: "Pending marketplace",
          url,
          official: false,
          removable: true,
        };
        const body = yield* fetchText({ url });
        const manifest = yield* decodeMarketplaceJson(body).pipe(
          Effect.mapError((cause) =>
            error({
              operation: "add-source",
              reason: "invalid-manifest",
              detail: `Marketplace manifest is invalid: ${errorDetail(cause)}`,
            }),
          ),
        );
        const state = yield* readState();
        if (sourcesForState(state).some((source) => source.id === manifest.id)) {
          return yield* error({
            operation: "add-source",
            reason: "source-conflict",
            detail: `Marketplace '${manifest.id}' is already configured.`,
            sourceId: manifest.id,
          });
        }
        const source: MarketplaceSource = {
          ...temporarySource,
          id: manifest.id,
          name: manifest.name,
        };
        yield* writeState({ ...state, sources: [...state.sources, source] });
        return yield* listFromState({ ...state, sources: [...state.sources, source] });
      }),
    );

  const removeSource = (sourceId: MarketplaceId) =>
    mutationLock.withPermits(1)(
      Effect.gen(function* () {
        if (sourceId === OFFICIAL_SOURCE.id) {
          return yield* error({
            operation: "remove-source",
            reason: "source-in-use",
            detail: "The official T3 Code marketplace cannot be removed.",
            sourceId,
          });
        }
        const state = yield* readState();
        if (!state.sources.some((source) => source.id === sourceId)) {
          return yield* error({
            operation: "remove-source",
            reason: "source-not-found",
            detail: `Marketplace source '${sourceId}' was not found.`,
            sourceId,
          });
        }
        if (state.installations.some(({ installation }) => installation.sourceId === sourceId)) {
          return yield* error({
            operation: "remove-source",
            reason: "source-in-use",
            detail: "Uninstall packages from this marketplace before removing it.",
            sourceId,
          });
        }
        const next = {
          ...state,
          sources: state.sources.filter((source) => source.id !== sourceId),
        };
        yield* writeState(next);
        return yield* listFromState(next);
      }),
    );

  const install = (installInput: MarketplaceInstallInput) =>
    mutationLock.withPermits(1)(
      Effect.gen(function* () {
        const state = yield* readState();
        const detail = yield* getPackageFromState(
          state,
          installInput.sourceId,
          installInput.packageId,
        );
        if (detail.availability !== "available") {
          return yield* error({
            operation: "install",
            reason:
              detail.availability === "unsupported-type" ? "unsupported-type" : "incompatible",
            detail:
              detail.availability === "unsupported-type"
                ? `No handler is installed for package type '${detail.catalog.type}'.`
                : "This package is not compatible with this environment.",
            sourceId: installInput.sourceId,
            packageId: installInput.packageId,
          });
        }
        const handler = packageHandlers.get(detail.manifest.type);
        if (!handler) {
          return yield* error({
            operation: "install",
            reason: "unsupported-type",
            detail: `No handler is installed for package type '${detail.manifest.type}'.`,
            sourceId: installInput.sourceId,
            packageId: installInput.packageId,
          });
        }
        const installationId = MarketplaceInstallationId.make(
          yield* crypto.randomUUIDv4.pipe(
            Effect.mapError((cause) =>
              error({
                operation: "install",
                reason: "materialization-failed",
                detail: `Could not create an installation id: ${errorDetail(cause)}`,
                sourceId: installInput.sourceId,
                packageId: installInput.packageId,
              }),
            ),
          ),
        );
        const installed = yield* handler.install({
          detail,
          request: installInput,
          installationId,
        });
        const timestamp = DateTime.formatIso(yield* DateTime.now);
        const installation: MarketplaceInstallation = {
          id: installationId,
          sourceId: installInput.sourceId,
          packageId: installInput.packageId,
          packageType: detail.manifest.type,
          packageName: detail.manifest.name,
          installedVersion: detail.manifest.version,
          installedAt: timestamp,
          updatedAt: timestamp,
          autoUpdate: false,
          target: installed.target,
        };
        const persistedInstallation: PersistedInstallation = {
          installation,
          inputs: installed.persistedInputs,
        };
        const next: PersistedMarketplaceState = {
          ...state,
          installations: [...state.installations, persistedInstallation],
        };
        yield* writeState(next).pipe(
          Effect.tapError(() =>
            Effect.all(
              [
                handler.uninstall(persistedInstallation).pipe(Effect.ignore),
                fileSystem
                  .remove(path.join(config.marketplacePackagesDir, installationId), {
                    recursive: true,
                    force: true,
                  })
                  .pipe(Effect.ignore),
              ],
              { discard: true },
            ),
          ),
        );
        return yield* listFromState(next);
      }),
    );

  const update = (updateInput: MarketplaceUpdateInput) =>
    mutationLock.withPermits(1)(
      Effect.gen(function* () {
        const state = yield* readState();
        const persisted = state.installations.find(
          ({ installation }) => installation.id === updateInput.installationId,
        );
        if (!persisted) {
          return yield* error({
            operation: "update",
            reason: "installation-not-found",
            detail: `Installation '${updateInput.installationId}' was not found.`,
            installationId: updateInput.installationId,
          });
        }
        const handler = packageHandlers.get(persisted.installation.packageType);
        if (!handler) {
          return yield* error({
            operation: "update",
            reason: "unsupported-type",
            detail: `No update handler is installed for '${persisted.installation.packageType}'.`,
            installationId: updateInput.installationId,
          });
        }
        const detail = yield* getPackageFromState(
          state,
          persisted.installation.sourceId,
          persisted.installation.packageId,
        );
        const persistedInputs = yield* handler.update({
          detail,
          persisted,
          request: updateInput,
        });
        const updated: PersistedInstallation = {
          installation: {
            ...persisted.installation,
            packageName: detail.manifest.name,
            installedVersion: detail.manifest.version,
            updatedAt: DateTime.formatIso(yield* DateTime.now),
          },
          inputs: persistedInputs,
        };
        const next: PersistedMarketplaceState = {
          ...state,
          installations: state.installations.map((entry) =>
            entry.installation.id === updateInput.installationId ? updated : entry,
          ),
        };
        yield* writeState(next);
        return yield* listFromState(next);
      }),
    );

  const uninstall = (installationId: MarketplaceInstallationId) =>
    mutationLock.withPermits(1)(
      Effect.gen(function* () {
        const state = yield* readState();
        const persisted = state.installations.find(
          ({ installation }) => installation.id === installationId,
        );
        if (!persisted) {
          return yield* error({
            operation: "uninstall",
            reason: "installation-not-found",
            detail: `Installation '${installationId}' was not found.`,
            installationId,
          });
        }
        const handler = packageHandlers.get(persisted.installation.packageType);
        if (!handler) {
          return yield* error({
            operation: "uninstall",
            reason: "unsupported-type",
            detail: `No uninstall handler is installed for '${persisted.installation.packageType}'.`,
            installationId,
          });
        }
        const next: PersistedMarketplaceState = {
          ...state,
          installations: state.installations.filter(
            ({ installation }) => installation.id !== installationId,
          ),
        };
        yield* writeState(next);
        yield* handler
          .uninstall(persisted)
          .pipe(Effect.tapError(() => writeState(state).pipe(Effect.ignore)));
        yield* fileSystem
          .remove(path.join(config.marketplacePackagesDir, installationId), {
            recursive: true,
            force: true,
          })
          .pipe(
            Effect.mapError((cause) =>
              error({
                operation: "uninstall",
                reason: "materialization-failed",
                detail: `Package was uninstalled, but managed files could not be removed: ${errorDetail(cause)}`,
                installationId,
              }),
            ),
          );
        return yield* listFromState(next);
      }),
    );

  const setAutoUpdate = (input: MarketplaceSetAutoUpdateInput) =>
    mutationLock.withPermits(1)(
      Effect.gen(function* () {
        const state = yield* readState();
        if (
          !state.installations.some(({ installation }) => installation.id === input.installationId)
        ) {
          return yield* error({
            operation: "set-auto-update",
            reason: "installation-not-found",
            detail: `Installation '${input.installationId}' was not found.`,
            installationId: input.installationId,
          });
        }
        const next: PersistedMarketplaceState = {
          ...state,
          installations: state.installations.map((entry) =>
            entry.installation.id === input.installationId
              ? { ...entry, installation: { ...entry.installation, autoUpdate: input.autoUpdate } }
              : entry,
          ),
        };
        yield* writeState(next);
        return yield* listFromState(next);
      }),
    );

  const exportProviderTemplate = (input: MarketplaceExportProviderTemplateInput) =>
    Effect.gen(function* () {
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.mapError((cause) =>
          error({
            operation: "read-state",
            reason: "state-failed",
            detail: `Could not read provider settings: ${errorDetail(cause)}`,
          }),
        ),
      );
      const instance = settings.providerInstances[input.instanceId];
      if (!instance) {
        return yield* error({
          operation: "export",
          reason: "instance-not-found",
          detail: `Provider instance '${input.instanceId}' was not found.`,
        });
      }
      const displayName = instance.displayName?.trim() || String(instance.driver);
      const packageId = MarketplacePackageId.make(sanitizeMarketplacePackageId(input.instanceId));
      const environment = instance.environment ?? [];
      const usedInputIds = new Set<string>();
      const inputs = environment.map((variable) => {
        const inputId = nextTemplateInputId(variable.name, usedInputIds);
        return {
          id: inputId,
          label: variable.name,
          ...(variable.sensitive
            ? {
                control: "password",
                required: true,
                description: "Secret value; it is never included in an exported template.",
              }
            : {
                control: "text",
                required: false,
                ...(variable.value.length > 0 ? { default: variable.value } : {}),
              }),
        };
      });
      const rawConfig =
        instance.config !== null && typeof instance.config === "object"
          ? { ...(instance.config as Record<string, unknown>) }
          : {};
      // A managed provider home belongs to the source installation and its
      // files are not portable; exported templates isolate their own home.
      const hadManagedHome = typeof rawConfig.homePath === "string";
      delete rawConfig.homePath;
      const payload = {
        driver: instance.driver,
        suggestedInstanceId: `${input.instanceId.slice(0, 56)}_copy`,
        displayName,
        ...(instance.accentColor ? { accentColor: instance.accentColor } : {}),
        ...(instance.icon ? { icon: instance.icon } : {}),
        inputs,
        config: rawConfig,
        environment: environment.map((variable, index) => ({
          name: variable.name,
          input: inputs[index]!.id,
          sensitive: variable.sensitive,
          required: variable.sensitive,
        })),
        ...(hadManagedHome ? { providerHome: { configField: "homePath", files: [] } } : {}),
      };
      const permissions = [
        "provider.configure",
        ...(environment.length > 0 ? ["provider.environment"] : []),
        ...(hadManagedHome ? ["provider.files"] : []),
      ];
      const manifest = yield* decodePackageManifest({
        $schema:
          "https://raw.githubusercontent.com/BarretoDiego/t3code/main/marketplace/schemas/package.schema.json",
        schemaVersion: 1,
        id: packageId,
        type: PROVIDER_TEMPLATE_PACKAGE_TYPE,
        name: `${displayName} template`,
        version: "1.0.0",
        description: `Exported from the '${displayName}' provider instance. Review the generated inputs before publishing.`,
        permissions,
        payload,
      }).pipe(
        Effect.mapError((cause) =>
          error({
            operation: "export",
            reason: "invalid-manifest",
            detail: `The exported template is invalid: ${errorDetail(cause)}`,
          }),
        ),
      );
      yield* validateProviderTemplatePermissions(manifest).pipe(
        Effect.mapError((cause) =>
          error({
            operation: "export",
            reason: "invalid-manifest",
            detail: `The exported template is invalid: ${cause.detail}`,
          }),
        ),
      );
      const manifestJson = yield* Schema.encodeEffect(
        fromJsonStringPretty(MarketplacePackageManifestSchema),
      )(manifest).pipe(
        Effect.mapError((cause) =>
          error({
            operation: "export",
            reason: "invalid-manifest",
            detail: `The exported template could not be encoded: ${errorDetail(cause)}`,
          }),
        ),
      );
      return {
        packageId: manifest.id,
        fileName: `${manifest.id}.json`,
        manifestJson: `${manifestJson}\n`,
      } satisfies MarketplaceExportedTemplate;
    });

  return {
    list,
    getPackage,
    addSource,
    removeSource,
    install,
    update,
    uninstall,
    setAutoUpdate,
    exportProviderTemplate,
  };
});

export const layer = Layer.effect(MarketplaceService, make);

export type MarketplaceServiceError = MarketplaceError | ServerSettingsError;
