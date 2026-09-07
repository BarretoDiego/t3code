import * as Schema from "effect/Schema";
import { AgentProfileId } from "./agentProfiles.ts";
import { MiniSkillId } from "./miniSkills.ts";
import { IsoDateTime, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./orchestration.ts";
import { RemotePullRequestRef } from "./sourceControlHub.ts";

export const AiReviewTier = Schema.Literals(["quick", "standard", "deep", "exhaustive"]);
export type AiReviewTier = typeof AiReviewTier.Type;
export const AiReviewSeverity = Schema.Literals([
  "critical",
  "major",
  "minor",
  "suggestion",
  "info",
]);
export const AiReviewFinding = Schema.Struct({
  id: TrimmedNonEmptyString,
  severity: AiReviewSeverity,
  category: Schema.String,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(300)),
  description: TrimmedNonEmptyString.check(Schema.isMaxLength(16_384)),
  rationale: Schema.optional(Schema.String),
  filePath: Schema.optional(Schema.String),
  line: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  suggestedFix: Schema.optional(Schema.String),
  confidence: Schema.optional(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
});
export type AiReviewFinding = typeof AiReviewFinding.Type;
export const AiReviewAnalysis = Schema.Struct({
  summary: Schema.String,
  risk: Schema.Literals(["low", "medium", "high", "unknown"]),
  walkthrough: Schema.Array(
    Schema.Struct({
      title: Schema.String,
      description: Schema.String,
      files: Schema.Array(Schema.String),
    }),
  ),
  findings: Schema.Array(AiReviewFinding).check(Schema.isMaxLength(100)),
});
export type AiReviewAnalysis = typeof AiReviewAnalysis.Type;
export const AiReviewAgentSelection = Schema.Struct({
  modelSelection: ModelSelection,
  profileId: Schema.optional(AgentProfileId),
  miniSkillIds: Schema.Array(MiniSkillId),
});
export type AiReviewAgentSelection = typeof AiReviewAgentSelection.Type;
export const AiReviewStartInput = Schema.Struct({
  reference: RemotePullRequestRef,
  tier: AiReviewTier,
  mode: Schema.Literals(["full", "incremental"]),
  scope: Schema.Literals(["metadata", "commits", "changed-files", "full-context"]),
  agent: AiReviewAgentSelection,
  projectId: Schema.optional(ProjectId),
  includeGenerated: Schema.Boolean,
  includeExistingComments: Schema.Boolean,
});
export type AiReviewStartInput = typeof AiReviewStartInput.Type;
export const AiReviewActivity = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["agent", "tool", "task"]),
  label: Schema.String,
  status: Schema.Literals(["running", "completed", "failed", "cancelled"]),
  text: Schema.String,
});
export type AiReviewActivity = typeof AiReviewActivity.Type;
export const AiReviewRun = Schema.Struct({
  ...AiReviewStartInput.fields,
  id: TrimmedNonEmptyString,
  baseSha: Schema.String,
  headSha: Schema.String,
  comparisonBaseSha: Schema.String,
  headRepository: Schema.optional(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  stage: Schema.Literals([
    "collecting",
    "understanding",
    "analyzing",
    "verifying",
    "consolidating",
    "draft",
    "failed",
    "cancelled",
  ]),
  progress: Schema.String,
  activity: Schema.optional(Schema.Array(AiReviewActivity)),
  analysis: Schema.NullOr(AiReviewAnalysis),
  dismissedIds: Schema.Array(Schema.String),
  publishedIds: Schema.Array(Schema.String),
  summaryPublished: Schema.Boolean,
  publicationUncertain: Schema.optional(Schema.Boolean),
  warnings: Schema.Array(Schema.String),
  filesAnalyzed: Schema.Number,
  durationMs: Schema.Number,
});
export type AiReviewRun = typeof AiReviewRun.Type;
export const AiReviewEditInput = Schema.Struct({
  id: TrimmedNonEmptyString,
  findings: Schema.Array(AiReviewFinding),
  dismissedIds: Schema.Array(Schema.String),
  summary: Schema.String,
});
export type AiReviewEditInput = typeof AiReviewEditInput.Type;
export const AiReviewPublishInput = Schema.Struct({
  id: TrimmedNonEmptyString,
  findingIds: Schema.Array(Schema.String),
  includeSummary: Schema.Boolean,
});
export type AiReviewPublishInput = typeof AiReviewPublishInput.Type;

export const SourceControlCommitPreviewInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  filePaths: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  agent: Schema.optional(AiReviewAgentSelection),
});
export type SourceControlCommitPreviewInput = typeof SourceControlCommitPreviewInput.Type;
export const SourceControlCommitPreview = Schema.Struct({
  message: Schema.String,
  modelSelection: ModelSelection,
});
export type SourceControlCommitPreview = typeof SourceControlCommitPreview.Type;
