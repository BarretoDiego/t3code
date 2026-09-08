import * as Struct from "effect/Struct";
import {
  PullRequestListState,
  PullRequestInvolvement,
  PullRequestListEntry,
  PullRequestDetail,
  PullRequestReviewVerdict,
  PullRequestReviewCommentDraft,
  PullRequestMergeMethod,
} from "./pullRequest.ts";
import * as Schema from "effect/Schema";
import { IsoDateTime, PositiveInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { SourceControlProviderKind, SourceControlRepositoryInfo } from "./sourceControl.ts";

/** Account identity is independent of a checkout. Credentials only cross the write boundary. */
export const SourceControlAccountConfig = Schema.Struct({
  provider: Schema.Literals(["github", "bitbucket"]),
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  username: Schema.String.check(Schema.isMaxLength(320)),
  workspace: Schema.String.check(Schema.isMaxLength(200)),
  repository: Schema.optional(
    Schema.String.check(Schema.isMaxLength(200), Schema.isPattern(/^[A-Za-z0-9_.-]*$/u)),
  ),
});
export type SourceControlAccountConfig = typeof SourceControlAccountConfig.Type;
export const SourceControlAccount = Schema.Struct({
  ...SourceControlAccountConfig.fields,
  hasCredential: Schema.Boolean,
  credentialSource: Schema.optional(Schema.Literals(["stored", "environment"])),
});
export type SourceControlAccount = typeof SourceControlAccount.Type;
export const SourceControlAccountSaveInput = Schema.Struct({
  account: SourceControlAccountConfig,
  token: Schema.optional(Schema.String.check(Schema.isMaxLength(16_384))),
});
export type SourceControlAccountSaveInput = typeof SourceControlAccountSaveInput.Type;

export const RemoteRepositoryRef = Schema.Struct({
  provider: SourceControlProviderKind,
  host: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString.check(
    Schema.isMaxLength(400),
    Schema.isPattern(/^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/u),
  ),
});
export type RemoteRepositoryRef = typeof RemoteRepositoryRef.Type;
export const RemoteRepository = Schema.Struct({
  ...SourceControlRepositoryInfo.fields,
  host: TrimmedNonEmptyString,
  defaultBranch: Schema.NullOr(Schema.String),
  description: Schema.String,
  private: Schema.Boolean,
});
export type RemoteRepository = typeof RemoteRepository.Type;
export const SourceControlRepositoryMapping = Schema.Struct({
  projectId: ProjectId,
  remoteName: TrimmedNonEmptyString,
  reference: RemoteRepositoryRef,
});
export type SourceControlRepositoryMapping = typeof SourceControlRepositoryMapping.Type;
export const SourceControlRepositoryMappingInput = Schema.Struct({
  projectId: ProjectId,
  remoteName: TrimmedNonEmptyString,
  reference: Schema.NullOr(RemoteRepositoryRef),
});
export type SourceControlRepositoryMappingInput = typeof SourceControlRepositoryMappingInput.Type;
export const SourceControlLocalClone = Schema.Struct({
  manuallyMapped: Schema.optional(Schema.Boolean),
  projectId: ProjectId,
  title: Schema.String,
  cwd: TrimmedNonEmptyString,
  remoteName: Schema.String,
  ...RemoteRepositoryRef.fields,
});
export type SourceControlLocalClone = typeof SourceControlLocalClone.Type;
export const RemoteRepositoryListInput = Schema.Struct({
  provider: SourceControlProviderKind,
  query: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  cursor: Schema.optional(Schema.String.check(Schema.isMaxLength(2_048))),
});
export type RemoteRepositoryListInput = typeof RemoteRepositoryListInput.Type;
export const RemoteRepositoryPage = Schema.Struct({
  items: Schema.Array(RemoteRepository),
  nextCursor: Schema.NullOr(Schema.String),
});
export type RemoteRepositoryPage = typeof RemoteRepositoryPage.Type;
export const RemoteGitRef = Schema.Struct({
  name: TrimmedNonEmptyString,
  sha: TrimmedNonEmptyString,
  kind: Schema.Literals(["branch", "tag"]),
  author: Schema.NullOr(Schema.String),
  createdAt: Schema.NullOr(IsoDateTime),
});
export type RemoteGitRef = typeof RemoteGitRef.Type;
export const RemoteGitRefListInput = Schema.Struct({
  ...RemoteRepositoryRef.fields,
  kind: Schema.Literals(["branch", "tag"]),
  cursor: Schema.optional(Schema.String.check(Schema.isMaxLength(2_048))),
});
export type RemoteGitRefListInput = typeof RemoteGitRefListInput.Type;
export const RemoteGitRefPage = Schema.Struct({
  items: Schema.Array(RemoteGitRef),
  nextCursor: Schema.NullOr(Schema.String),
});
export type RemoteGitRefPage = typeof RemoteGitRefPage.Type;

export const PullRequestRevisions = Schema.Struct({
  baseSha: TrimmedNonEmptyString.check(Schema.isPattern(/^[a-f0-9]{40,64}$/i)),
  headSha: TrimmedNonEmptyString.check(Schema.isPattern(/^[a-f0-9]{40,64}$/i)),
  headRepository: TrimmedNonEmptyString,
});
export type PullRequestRevisions = typeof PullRequestRevisions.Type;
export const RemotePullRequestCreateInput = Schema.Struct({
  ...RemoteRepositoryRef.fields,
  source: TrimmedNonEmptyString.check(Schema.isMaxLength(250)),
  target: TrimmedNonEmptyString.check(Schema.isMaxLength(250)),
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(250)),
  body: Schema.String.check(Schema.isMaxLength(65_536)),
  draft: Schema.Boolean,
  reviewers: Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(20)),
});
export type RemotePullRequestCreateInput = typeof RemotePullRequestCreateInput.Type;
export const RemotePullRequestCreated = Schema.Struct({
  number: PositiveInt,
  url: Schema.String,
  warnings: Schema.Array(Schema.String),
});
export type RemotePullRequestCreated = typeof RemotePullRequestCreated.Type;

export class SourceControlHubError extends Schema.TaggedErrorClass<SourceControlHubError>()(
  "SourceControlHubError",
  { message: Schema.String },
) {}

/** Git state belongs to an environment-local clone, never to the remote repository. */
export const SourceControlWorktree = Schema.Struct({
  path: Schema.String,
  headSha: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  bare: Schema.Boolean,
  locked: Schema.Boolean,
  prunable: Schema.Boolean,
});
export type SourceControlWorktree = typeof SourceControlWorktree.Type;
export const SourceControlCloneState = Schema.Struct({
  projectId: ProjectId,
  cwd: Schema.String,
  branch: Schema.NullOr(Schema.String),
  headSha: Schema.NullOr(Schema.String),
  upstream: Schema.NullOr(Schema.String),
  ahead: Schema.Number,
  behind: Schema.Number,
  worktrees: Schema.Array(SourceControlWorktree),
});
export type SourceControlCloneState = typeof SourceControlCloneState.Type;

/** Remote PR identity has no implied local checkout. */
export const RemotePullRequestRef = Schema.Struct({
  ...RemoteRepositoryRef.fields,
  number: PositiveInt,
});
export type RemotePullRequestRef = typeof RemotePullRequestRef.Type;

const RemotePullRequestCursor = TrimmedNonEmptyString.check(Schema.isMaxLength(4_096));
export const RemotePullRequestListInput = Schema.Struct({
  ...RemoteRepositoryRef.fields,
  state: PullRequestListState,
  involvement: PullRequestInvolvement,
  query: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  cursor: Schema.optional(RemotePullRequestCursor),
});
export type RemotePullRequestListInput = typeof RemotePullRequestListInput.Type;
export const RemotePullRequestListEntry = PullRequestListEntry.mapFields(
  Struct.omit(["projectId", "projectTitle"]),
);
export const RemotePullRequestPage = Schema.Struct({
  items: Schema.Array(RemotePullRequestListEntry),
  nextCursor: Schema.NullOr(RemotePullRequestCursor),
  truncated: Schema.Boolean,
});
export type RemotePullRequestPage = typeof RemotePullRequestPage.Type;
export const RemotePullRequestDetail = PullRequestDetail.mapFields(
  Struct.omit(["projectId", "projectTitle", "workspaceRoot"]),
);
export type RemotePullRequestDetail = typeof RemotePullRequestDetail.Type;
export const RemotePullRequestDiffInput = Schema.Struct({
  ...RemotePullRequestRef.fields,
  cursor: Schema.optional(Schema.String),
});
export type RemotePullRequestDiffInput = typeof RemotePullRequestDiffInput.Type;
export const RemotePullRequestReviewInput = Schema.Struct({
  ...RemotePullRequestRef.fields,
  expectedHeadSha: PullRequestRevisions.fields.headSha,
  verdict: PullRequestReviewVerdict,
  body: Schema.String.check(Schema.isMaxLength(65_536)),
  comments: Schema.Array(PullRequestReviewCommentDraft).check(Schema.isMaxLength(100)),
});
export type RemotePullRequestReviewInput = typeof RemotePullRequestReviewInput.Type;
export const RemotePullRequestMergeInput = Schema.Struct({
  ...RemotePullRequestRef.fields,
  expectedHeadSha: PullRequestRevisions.fields.headSha,
  method: PullRequestMergeMethod,
});
export type RemotePullRequestMergeInput = typeof RemotePullRequestMergeInput.Type;
