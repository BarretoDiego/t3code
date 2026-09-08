import * as Schema from "effect/Schema";
import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
  ProjectId,
} from "./baseSchemas.ts";
import { ProjectSyncManifestEntry } from "./projectSync.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

export const ThreadHandoffId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-zA-Z0-9_-]+$/),
).pipe(Schema.brand("ThreadHandoffId"));
export type ThreadHandoffId = typeof ThreadHandoffId.Type;

export const ThreadHandoffPhase = Schema.Literals([
  "preflighting",
  "pausing",
  "checkpointing",
  "syncingProjects",
  "transferringSession",
  "verifying",
  "ready",
  "committed",
  "completed",
  "rollingBack",
  "failed",
  "cancelled",
]);
export type ThreadHandoffPhase = typeof ThreadHandoffPhase.Type;

/** A prepared destination cannot execute. Only a durable source commit grants
 * the next generation. A network timeout never grants ownership to either side. */
export const ThreadExecutionOwner = Schema.Struct({
  threadId: ThreadId,
  environmentId: EnvironmentId,
  generation: NonNegativeInt,
});
export type ThreadExecutionOwner = typeof ThreadExecutionOwner.Type;

export const ThreadHandoffRecord = Schema.Struct({
  handoffId: ThreadHandoffId,
  owner: ThreadExecutionOwner,
  destinationEnvironmentId: EnvironmentId,
  localEnvironmentId: Schema.optional(EnvironmentId),
  phase: ThreadHandoffPhase,
  revision: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  failure: Schema.NullOr(TrimmedNonEmptyString),
});
export type ThreadHandoffRecord = typeof ThreadHandoffRecord.Type;

const GitObjectId = Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/));
const ContentHash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));

/** Git's index and working tree are independent snapshots. Native history and
 * repository bytes travel as hash-verified files through Project Sync. */
export const ThreadHandoffGitState = Schema.Struct({
  head: GitObjectId,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  indexTree: GitObjectId,
  sourceWasWorktree: Schema.Boolean,
  checkpointRefs: Schema.Array(TrimmedNonEmptyString),
  bundle: Schema.NullOr(TrimmedNonEmptyString),
  stagedPatch: TrimmedNonEmptyString,
  workingPatch: TrimmedNonEmptyString,
  untracked: Schema.Array(
    Schema.Struct({
      path: TrimmedNonEmptyString,
      hash: ContentHash,
      mode: NonNegativeInt,
      size: NonNegativeInt,
    }),
  ),
});

export const ThreadHandoffManifest = Schema.Struct({
  version: Schema.Literal(1),
  handoffId: ThreadHandoffId,
  owner: ThreadExecutionOwner,
  destinationEnvironmentId: EnvironmentId,
  createdAt: IsoDateTime,
  projects: Schema.Array(
    Schema.Struct({
      projectId: ProjectId,
      directory: TrimmedNonEmptyString,
      git: ThreadHandoffGitState,
    }),
  ),
  provider: Schema.Struct({
    driver: ProviderDriverKind,
    mode: Schema.Literals(["native", "context"]),
    sessionId: Schema.optional(TrimmedNonEmptyString),
    directory: Schema.Literal("provider"),
    resumeCursor: Schema.optional(Schema.Unknown),
    version: Schema.optional(TrimmedNonEmptyString),
  }),
  threadFile: Schema.Literal("thread.json"),
  files: Schema.Array(ProjectSyncManifestEntry),
});
export type ThreadHandoffManifest = typeof ThreadHandoffManifest.Type;

export const ThreadHandoffErrorCode = Schema.Literals([
  "conflict",
  "notOwner",
  "busy",
  "offline",
  "unsupported",
  "incompatible",
  "verificationFailed",
  "transferFailed",
  "recoveryRequired",
]);
export class ThreadHandoffError extends Schema.TaggedError<ThreadHandoffError>()(
  "ThreadHandoffError",
  {
    code: ThreadHandoffErrorCode,
    message: TrimmedNonEmptyString,
  },
) {}
