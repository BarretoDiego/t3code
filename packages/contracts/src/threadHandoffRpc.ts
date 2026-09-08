import * as Schema from "effect/Schema";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  NonNegativeInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderInstanceId, ProviderDriverKind } from "./providerInstance.ts";
import { ModelSelection } from "./orchestration.ts";
import { ProjectSyncManifestEntry, ProjectSyncExportEntry } from "./projectSync.ts";
import {
  ThreadExecutionOwner,
  ThreadHandoffId,
  ThreadHandoffManifest,
  ThreadHandoffRecord,
} from "./threadHandoff.ts";

export const ThreadHandoffRepository = Schema.Struct({
  projectId: ProjectId,
  head: TrimmedNonEmptyString,
  rootCommits: Schema.Array(TrimmedNonEmptyString),
  remoteIds: Schema.Array(TrimmedNonEmptyString),
});
export type ThreadHandoffRepository = typeof ThreadHandoffRepository.Type;

export const ThreadHandoffSource = Schema.Struct({
  owner: ThreadExecutionOwner,
  projectId: ProjectId,
  providerInstanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  version: TrimmedNonEmptyString,
  sessionId: Schema.optional(TrimmedNonEmptyString),
  supportsNativeHandoff: Schema.optional(Schema.Boolean),
  repositories: Schema.optional(Schema.Array(ThreadHandoffRepository)),
});
export type ThreadHandoffSource = typeof ThreadHandoffSource.Type;

export const ThreadHandoffDestinationProject = Schema.Struct({
  sourceProjectId: ProjectId,
  destinationProjectId: ProjectId,
  availableHead: Schema.optional(TrimmedNonEmptyString),
});
export const ThreadHandoffDestination = Schema.Struct({
  transferMode: Schema.optional(Schema.Literals(["native", "context"])),
  modelSelection: Schema.optional(ModelSelection),
  environmentId: EnvironmentId,
  providerInstanceId: ProviderInstanceId,
  source: ThreadHandoffSource,
  projects: Schema.Array(ThreadHandoffDestinationProject),
});
export type ThreadHandoffDestination = typeof ThreadHandoffDestination.Type;
export const ThreadHandoffReadyReceipt = Schema.Struct({
  handoffId: ThreadHandoffId,
  environmentId: EnvironmentId,
  sessionId: Schema.optional(TrimmedNonEmptyString),
  manifestHash: TrimmedNonEmptyString,
});
export type ThreadHandoffReadyReceipt = typeof ThreadHandoffReadyReceipt.Type;

export const ThreadHandoffRequest = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("inspect"),
    threadId: ThreadId,
    projectIds: Schema.optional(Schema.Array(ProjectId)),
  }),
  Schema.Struct({ operation: Schema.Literal("preflight"), destination: ThreadHandoffDestination }),
  Schema.Struct({
    operation: Schema.Literal("prepareSource"),
    handoffId: ThreadHandoffId,
    destination: ThreadHandoffDestination,
    mode: Schema.Literals(["idle", "afterTurn", "interrupt"]),
  }),
  Schema.Struct({
    operation: Schema.Literal("prepareDestination"),
    manifest: ThreadHandoffManifest,
    destination: ThreadHandoffDestination,
  }),
  Schema.Struct({
    operation: Schema.Literal("export"),
    handoffId: ThreadHandoffId,
    entries: Schema.Array(ProjectSyncExportEntry),
  }),
  Schema.Struct({
    operation: Schema.Literal("import"),
    handoffId: ThreadHandoffId,
    fileCount: NonNegativeInt,
    totalBytes: NonNegativeInt,
  }),
  Schema.Struct({
    operation: Schema.Literals(["status", "manifest", "verify", "complete", "reject", "rollback"]),
    handoffId: ThreadHandoffId,
  }),
  Schema.Struct({
    operation: Schema.Literal("beginRollback"),
    handoffId: ThreadHandoffId,
    threadId: ThreadId,
    destinationEnvironmentId: EnvironmentId,
  }),
  Schema.Struct({ operation: Schema.Literal("commit"), receipt: ThreadHandoffReadyReceipt }),
  Schema.Struct({ operation: Schema.Literal("activate"), record: ThreadHandoffRecord }),
]);
export type ThreadHandoffRequest = typeof ThreadHandoffRequest.Type;

export const ThreadHandoffResponse = Schema.Struct({
  source: Schema.optional(ThreadHandoffSource),
  destination: Schema.optional(ThreadHandoffDestination),
  record: Schema.optional(ThreadHandoffRecord),
  manifest: Schema.optional(ThreadHandoffManifest),
  files: Schema.optional(Schema.Array(ProjectSyncManifestEntry)),
  url: Schema.optional(Schema.String),
  expiresAt: Schema.optional(NonNegativeInt),
  warnings: Schema.optional(Schema.Array(Schema.String)),
  ready: Schema.optional(ThreadHandoffReadyReceipt),
});
export type ThreadHandoffResponse = typeof ThreadHandoffResponse.Type;
