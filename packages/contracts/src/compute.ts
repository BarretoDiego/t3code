import * as Schema from "effect/Schema";
import { AssetResource } from "./assets.ts";

import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

const UnknownRecord = Schema.Record(Schema.String, Schema.Json);
const NonNegativeNumber = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

/** A stable identifier selected by an environment, never inferred from a runtime implementation. */
export const ComputeCapabilityId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
export type ComputeCapabilityId = typeof ComputeCapabilityId.Type;

export const ComputeProviderId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
export type ComputeProviderId = typeof ComputeProviderId.Type;

export const ComputeNodeId = TrimmedNonEmptyString;
export type ComputeNodeId = typeof ComputeNodeId.Type;

export const ComputeModelStatus = Schema.Literals([
  "available",
  "installing",
  "ready",
  "loading",
  "loaded",
  "busy",
  "error",
  "unsupported",
]);
export type ComputeModelStatus = typeof ComputeModelStatus.Type;

export const ComputeParameterType = Schema.Literals([
  "string",
  "text",
  "number",
  "integer",
  "boolean",
  "select",
  "multiselect",
  "file",
  "image",
  "audio",
  "video",
  "json",
]);
export type ComputeParameterType = typeof ComputeParameterType.Type;

export const ComputeParameterOption = Schema.Struct({
  label: TrimmedNonEmptyString,
  value: Schema.Json,
});
export type ComputeParameterOption = typeof ComputeParameterOption.Type;

/** Provider-defined form metadata. The core intentionally does not interpret parameter ids. */
export const ParameterDefinition = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  description: Schema.optionalKey(Schema.String),
  type: ComputeParameterType,
  required: Schema.optionalKey(Schema.Boolean),
  default: Schema.optionalKey(Schema.Json),
  min: Schema.optionalKey(Schema.Finite),
  max: Schema.optionalKey(Schema.Finite),
  step: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThan(0))),
  options: Schema.optionalKey(Schema.Array(ComputeParameterOption)),
  advanced: Schema.optionalKey(Schema.Boolean),
  visibleWhen: Schema.optionalKey(Schema.Json),
});
export type ParameterDefinition = typeof ParameterDefinition.Type;

export const GenerationPreset = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  parameters: UnknownRecord,
  metadata: Schema.optionalKey(UnknownRecord),
});
export type GenerationPreset = typeof GenerationPreset.Type;

export const ModelCapability = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  provider: Schema.optionalKey(TrimmedNonEmptyString),
  operations: Schema.Array(TrimmedNonEmptyString),
  presets: Schema.optionalKey(Schema.Array(GenerationPreset)),
  parameters: Schema.optionalKey(Schema.Array(ParameterDefinition)),
  status: ComputeModelStatus,
  metadata: Schema.optionalKey(UnknownRecord),
});
export type ModelCapability = typeof ModelCapability.Type;

export const CapabilityLimits = Schema.Struct({
  concurrentJobs: Schema.optionalKey(NonNegativeInt),
  queueDepth: Schema.optionalKey(NonNegativeInt),
  metadata: Schema.optionalKey(UnknownRecord),
});
export type CapabilityLimits = typeof CapabilityLimits.Type;

export const ComputeCapability = Schema.Struct({
  id: ComputeCapabilityId,
  /** A plain string keeps new modalities forward compatible. */
  category: TrimmedNonEmptyString,
  operations: Schema.Array(TrimmedNonEmptyString),
  models: Schema.optionalKey(Schema.Array(ModelCapability)),
  features: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  limits: Schema.optionalKey(CapabilityLimits),
  metadata: Schema.optionalKey(UnknownRecord),
});
export type ComputeCapability = typeof ComputeCapability.Type;

export const ComputeResources = Schema.Struct({
  cpu: Schema.optionalKey(Schema.Struct({ usage: Schema.optionalKey(NonNegativeNumber) })),
  memory: Schema.optionalKey(
    Schema.Struct({
      total: Schema.optionalKey(NonNegativeNumber),
      used: Schema.optionalKey(NonNegativeNumber),
      available: Schema.optionalKey(NonNegativeNumber),
    }),
  ),
  gpu: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.optionalKey(TrimmedNonEmptyString),
        name: Schema.optionalKey(TrimmedNonEmptyString),
        backend: Schema.optionalKey(TrimmedNonEmptyString),
        memoryTotal: Schema.optionalKey(NonNegativeNumber),
        memoryUsed: Schema.optionalKey(NonNegativeNumber),
        memoryAvailable: Schema.optionalKey(NonNegativeNumber),
      }),
    ),
  ),
  storage: Schema.optionalKey(Schema.Struct({ available: Schema.optionalKey(NonNegativeNumber) })),
});
export type ComputeResources = typeof ComputeResources.Type;

export const ComputeProviderStatus = Schema.Literals([
  "offline",
  "connecting",
  "online",
  "degraded",
  "error",
]);
export type ComputeProviderStatus = typeof ComputeProviderStatus.Type;

/** Location of execution, not the T3 environment that owns the connection. */
export const ComputeExecutionTarget = Schema.Struct({
  kind: Schema.Literals(["node", "managed"]),
  service: Schema.optionalKey(TrimmedNonEmptyString),
  region: Schema.optionalKey(TrimmedNonEmptyString),
  project: Schema.optionalKey(TrimmedNonEmptyString),
  account: Schema.optionalKey(TrimmedNonEmptyString),
});
export type ComputeExecutionTarget = typeof ComputeExecutionTarget.Type;

export const ComputeAuthentication = Schema.Union([
  Schema.Struct({ type: Schema.Literal("workload-identity") }),
  Schema.Struct({ type: TrimmedNonEmptyString, secretRef: TrimmedNonEmptyString }),
]);
export type ComputeAuthentication = typeof ComputeAuthentication.Type;

/** Declarative configuration; credentials are referenced through secret storage, never embedded. */
export const ComputeProviderConfig = Schema.Struct({
  id: ComputeProviderId,
  name: TrimmedNonEmptyString,
  type: TrimmedNonEmptyString,
  endpoint: Schema.optionalKey(TrimmedNonEmptyString),
  environmentId: Schema.optionalKey(EnvironmentId),
  nodeId: Schema.optionalKey(ComputeNodeId),
  execution: Schema.optionalKey(ComputeExecutionTarget),
  configuration: UnknownRecord,
  authentication: Schema.optionalKey(ComputeAuthentication),
});
export type ComputeProviderConfig = typeof ComputeProviderConfig.Type;

export const ComputeProvider = Schema.Struct({
  ...ComputeProviderConfig.fields,
  status: ComputeProviderStatus,
  checkedAt: Schema.optionalKey(IsoDateTime),
});
export type ComputeProvider = typeof ComputeProvider.Type;

export const ArtifactReference = Schema.Struct({
  id: TrimmedNonEmptyString,
  uri: TrimmedNonEmptyString,
  mimeType: TrimmedNonEmptyString,
  resource: Schema.optionalKey(AssetResource),
  name: Schema.optionalKey(TrimmedNonEmptyString),
  sizeBytes: Schema.optionalKey(NonNegativeInt),
  metadata: Schema.optionalKey(UnknownRecord),
});
export type ArtifactReference = typeof ArtifactReference.Type;

export const GeneratedArtifactMetadata = Schema.Struct({
  generationJobId: TrimmedNonEmptyString,
  capability: ComputeCapabilityId,
  operation: TrimmedNonEmptyString,
  providerId: ComputeProviderId,
  model: Schema.optionalKey(TrimmedNonEmptyString),
  parameters: Schema.optionalKey(UnknownRecord),
  parentArtifacts: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
});
export type GeneratedArtifactMetadata = typeof GeneratedArtifactMetadata.Type;

export const GenerationRequest = Schema.Struct({
  capability: ComputeCapabilityId,
  operation: TrimmedNonEmptyString,
  model: Schema.optionalKey(TrimmedNonEmptyString),
  preset: Schema.optionalKey(TrimmedNonEmptyString),
  providerId: Schema.optionalKey(ComputeProviderId),
  nodeId: Schema.optionalKey(ComputeNodeId),
  environmentId: Schema.optionalKey(EnvironmentId),
  parameters: UnknownRecord,
  inputs: Schema.optionalKey(Schema.Array(ArtifactReference)),
  context: Schema.optionalKey(
    Schema.Struct({
      projectId: Schema.optionalKey(ProjectId),
      threadId: Schema.optionalKey(ThreadId),
    }),
  ),
});
export type GenerationRequest = typeof GenerationRequest.Type;

export const GenerationJobStatus = Schema.Literals([
  "queued",
  "starting",
  "loading",
  "running",
  "postprocessing",
  "completed",
  "failed",
  "cancelled",
]);
export type GenerationJobStatus = typeof GenerationJobStatus.Type;

export const GenerationError = Schema.Struct({
  code: Schema.optionalKey(TrimmedNonEmptyString),
  message: TrimmedNonEmptyString,
  retryable: Schema.optionalKey(Schema.Boolean),
  metadata: Schema.optionalKey(UnknownRecord),
});
export type GenerationError = typeof GenerationError.Type;

export const GenerationMetrics = Schema.Struct({
  durationMs: Schema.optionalKey(NonNegativeNumber),
  queueDurationMs: Schema.optionalKey(NonNegativeNumber),
  metadata: Schema.optionalKey(UnknownRecord),
});
export type GenerationMetrics = typeof GenerationMetrics.Type;

/** Durable remote locator. Never store credentials or expiring signed URLs here. */
export const ComputeRemoteOperation = Schema.Struct({
  id: TrimmedNonEmptyString,
  adapterType: TrimmedNonEmptyString,
});
export type ComputeRemoteOperation = typeof ComputeRemoteOperation.Type;

export const ComputeExecutionSupport = Schema.Struct({
  cancellation: Schema.Literals(["supported", "unsupported"]),
  recovery: Schema.Literals(["operation-id", "request-id"]),
});
export type ComputeExecutionSupport = typeof ComputeExecutionSupport.Type;

export const GenerationJob = Schema.Struct({
  id: TrimmedNonEmptyString,
  request: GenerationRequest,
  providerId: ComputeProviderId,
  nodeId: Schema.optionalKey(ComputeNodeId),
  environmentId: Schema.optionalKey(EnvironmentId),
  status: GenerationJobStatus,
  remoteOperation: Schema.optionalKey(ComputeRemoteOperation),
  execution: Schema.optionalKey(ComputeExecutionTarget),
  progress: Schema.optionalKey(Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 100 }))),
  outputs: Schema.optionalKey(Schema.Array(ArtifactReference)),
  error: Schema.optionalKey(GenerationError),
  metrics: Schema.optionalKey(GenerationMetrics),
  createdAt: IsoDateTime,
  startedAt: Schema.optionalKey(IsoDateTime),
  completedAt: Schema.optionalKey(IsoDateTime),
});
export type GenerationJob = typeof GenerationJob.Type;

export const ComputeProviderSnapshot = Schema.Struct({
  provider: ComputeProvider,
  capabilities: Schema.Array(ComputeCapability),
  models: Schema.Array(ModelCapability),
  resources: Schema.optionalKey(ComputeResources),
  queueDepth: Schema.optionalKey(NonNegativeInt),
  executionSupport: Schema.optionalKey(ComputeExecutionSupport),
});
export type ComputeProviderSnapshot = typeof ComputeProviderSnapshot.Type;

export const ComputeSnapshot = Schema.Struct({
  providers: Schema.Array(ComputeProviderSnapshot),
  jobs: Schema.Array(GenerationJob),
});
export type ComputeSnapshot = typeof ComputeSnapshot.Type;

export const ComputeProviderSaveInput = Schema.Struct({ provider: ComputeProviderConfig });
export type ComputeProviderSaveInput = typeof ComputeProviderSaveInput.Type;

export const ComputeProviderRemoveInput = Schema.Struct({ providerId: ComputeProviderId });
export type ComputeProviderRemoveInput = typeof ComputeProviderRemoveInput.Type;

export const ComputeJobListInput = Schema.Struct({
  threadId: Schema.optionalKey(ThreadId),
  projectId: Schema.optionalKey(ProjectId),
  providerId: Schema.optionalKey(ComputeProviderId),
  limit: Schema.optionalKey(NonNegativeInt.check(Schema.isBetween({ minimum: 1, maximum: 500 }))),
  before: Schema.optionalKey(Schema.Struct({ createdAt: IsoDateTime, id: TrimmedNonEmptyString })),
});
export type ComputeJobListInput = typeof ComputeJobListInput.Type;

export const ComputeJobGetInput = Schema.Struct({ jobId: TrimmedNonEmptyString });
export type ComputeJobGetInput = typeof ComputeJobGetInput.Type;

export const ComputeJobCancelInput = ComputeJobGetInput;
export type ComputeJobCancelInput = typeof ComputeJobCancelInput.Type;

export const ComputeJobSubmitInput = Schema.Struct({ request: GenerationRequest });
export type ComputeJobSubmitInput = typeof ComputeJobSubmitInput.Type;

export class ComputeError extends Schema.TaggedErrorClass<ComputeError>()("ComputeError", {
  jobId: Schema.optionalKey(TrimmedNonEmptyString),
  message: Schema.String,
  code: Schema.optionalKey(TrimmedNonEmptyString),
}) {}

/** Ordered lifecycle notifications for RPC subscribers and adapter reconciliation. */
export const ComputeEvent = Schema.Union([
  Schema.TaggedStruct("provider.connected", { providerId: ComputeProviderId }),
  Schema.TaggedStruct("provider.disconnected", { providerId: ComputeProviderId }),
  Schema.TaggedStruct("capabilities.changed", { providerId: ComputeProviderId }),
  Schema.TaggedStruct("resources.changed", { providerId: ComputeProviderId }),
  Schema.TaggedStruct("job.created", { job: GenerationJob }),
  Schema.TaggedStruct("job.started", { job: GenerationJob }),
  Schema.TaggedStruct("job.progress", { job: GenerationJob }),
  Schema.TaggedStruct("job.completed", { job: GenerationJob }),
  Schema.TaggedStruct("job.failed", { job: GenerationJob }),
  Schema.TaggedStruct("job.cancelled", { job: GenerationJob }),
  Schema.TaggedStruct("artifact.created", {
    jobId: TrimmedNonEmptyString,
    artifact: ArtifactReference,
  }),
]);
export type ComputeEvent = typeof ComputeEvent.Type;
