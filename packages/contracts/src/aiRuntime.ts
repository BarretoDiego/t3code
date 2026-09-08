import * as Schema from "effect/Schema";
import { EnvironmentId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const AiRuntimeId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),
);
export const AiRuntimeProtocol = Schema.Literals([
  "ollama",
  "openai",
  "anthropic",
  "transcription",
  "custom",
]);
export const AiRuntimeCapability = Schema.Literals([
  "text",
  "vision",
  "tools",
  "reasoning",
  "audio-input",
  "stt",
  "tts",
  "embeddings",
]);
export const AiRuntimeModel = Schema.Struct({
  id: TrimmedNonEmptyString,
  capabilities: Schema.Array(AiRuntimeCapability),
  capabilitiesKnown: Schema.Boolean,
});
export type AiRuntimeModel = typeof AiRuntimeModel.Type;
export const AiRuntimeConfig = Schema.Struct({
  id: AiRuntimeId,
  origin: Schema.optionalKey(
    Schema.Struct({ environmentId: EnvironmentId, runtimeId: AiRuntimeId }),
  ),
  name: TrimmedNonEmptyString,
  runtimeKind: TrimmedNonEmptyString,
  protocol: AiRuntimeProtocol,
  baseUrl: TrimmedNonEmptyString,
  /** Explicit operator-provided address. Discovery never opens a listener. */
  networkBaseUrl: Schema.optionalKey(TrimmedNonEmptyString),
  /** Explicitly allow a managed process to bind this node's verified Tailnet address. */
  listenOnTailnet: Schema.optionalKey(Schema.Boolean),
  authentication: Schema.Literals(["none", "bearer", "api-key"]),
  configuredModels: Schema.Array(TrimmedNonEmptyString),
});
export type AiRuntimeConfig = typeof AiRuntimeConfig.Type;
export const AiRuntimeOperation = Schema.Struct({
  id: Schema.String,
  action: Schema.String,
  phase: Schema.Literals(["running", "succeeded", "failed", "cancelled"]),
  message: Schema.String,
  completed: Schema.Number,
  total: Schema.NullOr(Schema.Number),
});
export type AiRuntimeOperation = typeof AiRuntimeOperation.Type;
export const AiRuntime = Schema.Struct({
  ...AiRuntimeConfig.fields,
  environmentId: EnvironmentId,
  source: Schema.Literals(["discovered", "configured"]),
  installation: Schema.Literals(["absent", "external", "managed"]),
  ownedProcess: Schema.Boolean,
  status: Schema.Literals(["available", "unavailable", "authentication-required"]),
  version: Schema.NullOr(Schema.String),
  models: Schema.Array(AiRuntimeModel),
  checkedAt: Schema.NullOr(Schema.String),
  hasApiKey: Schema.Boolean,
  operation: Schema.NullOr(AiRuntimeOperation),
});
export type AiRuntime = typeof AiRuntime.Type;
export const AiRuntimeSnapshot = Schema.Struct({ runtimes: Schema.Array(AiRuntime) });
export type AiRuntimeSnapshot = typeof AiRuntimeSnapshot.Type;
export const AiRuntimeSaveInput = Schema.Struct({
  runtime: AiRuntimeConfig,
  /** Omitted preserves the existing secret; empty clears it. Never echoed. */
  apiKey: Schema.optionalKey(Schema.String),
});
export const AiRuntimeActionInput = Schema.Struct({
  runtimeId: AiRuntimeId,
  action: Schema.Literals([
    "install",
    "update",
    "start",
    "stop",
    "remove-installation",
    "pull",
    "remove-model",
    "cancel",
  ]),
  model: Schema.optionalKey(TrimmedNonEmptyString),
  operationId: Schema.optionalKey(Schema.String),
});
export type AiRuntimeActionInput = typeof AiRuntimeActionInput.Type;
export const AiRuntimeBindInput = Schema.Struct({
  runtimeId: AiRuntimeId,
  instanceId: ProviderInstanceId,
  driver: Schema.Literals(["opencode", "codex", "claudeAgent"]),
  model: TrimmedNonEmptyString,
});
export type AiRuntimeBindInput = typeof AiRuntimeBindInput.Type;
export class AiRuntimeError extends Schema.TaggedError<AiRuntimeError>()("AiRuntimeError", {
  message: Schema.String,
}) {}
