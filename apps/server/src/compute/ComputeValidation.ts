import * as NodeUtil from "node:util";

import {
  ArtifactReference,
  ComputeError,
  ComputeProviderConfig,
  GenerationRequest,
  type ComputeCapability,
  type ComputeProviderSnapshot,
  type ParameterDefinition,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const decodeConfig = Schema.decodeUnknownEffect(ComputeProviderConfig);
const encodeConfig = Schema.encodeEffect(Schema.fromJsonString(ComputeProviderConfig));
const isArtifact = Schema.is(ArtifactReference);
const decodeRequest = Schema.decodeUnknownEffect(GenerationRequest);
const invalid = (code: string, message: string) => new ComputeError({ code, message });
const forbiddenKeys = new Set([
  "token",
  "apikey",
  "password",
  "secret",
  "secretaccesskey",
  "accesskeyid",
  "authorization",
  "credentials",
  "privatekey",
  "clientsecret",
  "sessiontoken",
]);
function hasCredentials(value: Schema.Json): boolean {
  if (Array.isArray(value)) return value.some(hasCredentials);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, item]) =>
      forbiddenKeys.has(key.toLowerCase().replace(/[_-]/g, "")) || hasCredentials(item),
  );
}

export const validateProviderConfiguration = Effect.fn("compute.validateConfiguration")(function* (
  input: ComputeProviderConfig,
) {
  const config = yield* decodeConfig(input).pipe(
    Effect.mapError(() => invalid("config-invalid", "Invalid compute provider configuration.")),
  );
  const serialized = yield* encodeConfig(config).pipe(
    Effect.mapError(() => invalid("config-invalid", "Configuration must be JSON serializable.")),
  );
  if (serialized.length > 65_536 || hasCredentials(config.configuration))
    return yield* invalid(
      "config-invalid",
      "Configuration exceeds 64 KiB or contains credential fields. Use secret references instead.",
    );
  if (
    config.authentication &&
    "secretRef" in config.authentication &&
    !/^[a-zA-Z0-9_-]{1,128}$/.test(config.authentication.secretRef)
  )
    return yield* invalid("invalid-secret-ref", "Invalid compute credential reference.");
  if (config.execution?.kind === "managed" && config.nodeId)
    return yield* invalid("config-invalid", "Managed execution must not claim a physical node.");
  if (config.endpoint) {
    const url = URL.parse(config.endpoint);
    if (!url || url.username || url.password || url.search || url.hash)
      return yield* invalid(
        "config-invalid",
        "Provider endpoints must be absolute URLs without embedded credentials, queries or fragments.",
      );
  }
  return config;
});

export function validCapabilityCatalog(capabilities: ReadonlyArray<ComputeCapability>): boolean {
  const unique = (ids: ReadonlyArray<string>) => new Set(ids).size === ids.length;
  return (
    unique(capabilities.map((capability) => capability.id)) &&
    capabilities.every(
      (capability) =>
        capability.operations.length > 0 &&
        unique(capability.operations) &&
        unique((capability.models ?? []).map((model) => model.id)) &&
        (capability.models ?? []).every(
          (model) =>
            model.operations.length > 0 &&
            model.operations.every((operation) => capability.operations.includes(operation)) &&
            unique((model.parameters ?? []).map((parameter) => parameter.id)) &&
            unique((model.presets ?? []).map((preset) => preset.id)) &&
            (model.parameters ?? []).every(
              (parameter) =>
                !["__proto__", "constructor", "prototype"].includes(parameter.id) &&
                !(
                  parameter.min !== undefined &&
                  parameter.max !== undefined &&
                  parameter.min > parameter.max
                ) &&
                (!["select", "multiselect"].includes(parameter.type) ||
                  (parameter.options?.length ?? 0) > 0),
            ),
        ),
    )
  );
}

function parameterValid(
  parameter: ParameterDefinition,
  value: Schema.Json,
  request: GenerationRequest,
): boolean {
  switch (parameter.type) {
    case "string":
    case "text":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "number":
    case "integer": {
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        (parameter.type === "integer" && !Number.isInteger(value))
      )
        return false;
      if (
        (parameter.min !== undefined && value < parameter.min) ||
        (parameter.max !== undefined && value > parameter.max)
      )
        return false;
      const ticks = (value - (parameter.min ?? 0)) / (parameter.step ?? 1);
      return parameter.step === undefined || Math.abs(ticks - Math.round(ticks)) < 1e-8;
    }
    case "select":
      return (
        parameter.options?.some((option) => NodeUtil.isDeepStrictEqual(option.value, value)) ??
        false
      );
    case "multiselect":
      return (
        Array.isArray(value) &&
        value.every((item) =>
          parameter.options?.some((option) => NodeUtil.isDeepStrictEqual(option.value, item)),
        )
      );
    case "file":
    case "image":
    case "audio":
    case "video": {
      const artifact =
        typeof value === "string"
          ? request.inputs?.find((input) => input.id === value)
          : isArtifact(value)
            ? value
            : undefined;
      return (
        !!artifact &&
        (parameter.type === "file" || artifact.mimeType.startsWith(`${parameter.type}/`))
      );
    }
    case "json":
      return true;
  }
}

/** Only applies advertised defaults/presets. No runtime-specific parameter names or evaluation. */
export const normalizeGenerationRequest = Effect.fn("compute.normalizeRequest")(function* (
  input: GenerationRequest,
  destination: ComputeProviderSnapshot,
) {
  const request = yield* decodeRequest(input).pipe(
    Effect.mapError(() => invalid("request-invalid", "Invalid compute request.")),
  );
  const capability = destination.capabilities.find(
    (candidate) => candidate.id === request.capability,
  )!;
  const models = (capability.models ?? []).filter(
    (model) =>
      model.operations.includes(request.operation) &&
      ["available", "ready", "loaded"].includes(model.status),
  );
  const model = request.model
    ? models.find((candidate) => candidate.id === request.model)
    : models.length === 1
      ? models[0]
      : undefined;
  if (models.length > 1 && !request.model)
    return yield* invalid("model-required", "Select an advertised model for this capability.");
  const preset = request.preset
    ? model?.presets?.find((candidate) => candidate.id === request.preset)
    : undefined;
  if (request.preset && !preset)
    return yield* invalid("preset-invalid", "Preset is not advertised by the selected model.");
  const definitions = model?.parameters;
  const defaults = Object.fromEntries(
    (definitions ?? [])
      .filter((parameter) => parameter.default !== undefined)
      .map((parameter) => [parameter.id, parameter.default!]),
  ) as Record<string, Schema.Json>;
  const parameters = { ...defaults, ...preset?.parameters, ...request.parameters };
  if (definitions) {
    if (
      Object.keys(parameters).some(
        (key) => !definitions.some((definition) => definition.id === key),
      )
    )
      return yield* invalid(
        "parameter-invalid",
        "Request contains parameters not advertised by the model.",
      );
    for (const definition of definitions) {
      const value = parameters[definition.id];
      if (value === undefined && !definition.required) continue;
      if (value === undefined || !parameterValid(definition, value, request))
        return yield* invalid(
          "parameter-invalid",
          `Invalid or missing parameter: ${definition.id}.`,
        );
    }
  }
  return {
    ...request,
    ...(model ? { model: model.id } : {}),
    parameters,
  } satisfies GenerationRequest;
});
