import { reviewLinePositions } from "./reviewPublication.ts";
import type { AiReviewRun, PullRequestActivity, RemotePullRequestDetail } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { SourceControlRepositoryBrowser } from "../sourceControl/SourceControlRepositoryBrowser.ts";
import type { ReviewPatchBatch } from "./reviewPlanning.ts";

const encodeContext = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
/** Keep JSON structurally intact while bounding independent, untrusted context sources. */
export function buildReviewMetadata(
  run: AiReviewRun,
  detail: RemotePullRequestDetail,
  activity: PullRequestActivity,
): string {
  return encodeContext({
    repository: run.reference.repository,
    number: detail.number,
    title: detail.title,
    description: detail.body.slice(0, 12_000),
    source: detail.headBranch,
    target: detail.baseBranch,
    baseSha: run.baseSha,
    headSha: run.headSha,
    comparisonBaseSha: run.comparisonBaseSha,
    checks: detail.checks.slice(0, 30),
    ...(run.scope === "metadata"
      ? {}
      : {
          commits: activity.commits
            .slice(0, 100)
            .map((commit) => ({ oid: commit.oid, message: commit.messageHeadline.slice(0, 500) })),
        }),
    ...(run.includeExistingComments
      ? {
          existingComments: activity.comments
            .slice(-40)
            .map((comment) => ({ path: comment.path, body: comment.body.slice(0, 500) })),
          existingReviewThreads: activity.reviewThreads.slice(-40).map((thread) => ({
            path: thread.path,
            line: thread.line,
            comments: thread.comments.slice(-3).map((comment) => comment.body.slice(0, 500)),
          })),
        }
      : {}),
    contextLimits: {
      descriptionTruncated: detail.body.length > 12_000,
      commitsTruncated: activity.commits.length > 100,
      commentsTruncated:
        activity.comments.length > 40 ||
        activity.commentsTruncated ||
        activity.reviewThreads.length > 40,
    },
  });
}

/** Fetch immutable head-side neighbors only for files in the current cohort. */
export const collectNeighboringCode = Effect.fn(function* (
  browser: SourceControlRepositoryBrowser,
  run: AiReviewRun,
  batch: ReviewPatchBatch,
) {
  if (!browser.readFile || run.tier === "quick" || !batch.paths.length)
    return { context: "", warnings: [] as string[] };
  const read = browser.readFile;
  const files = yield* Effect.forEach(
    batch.paths.slice(0, 12),
    (path) =>
      read({
        ...run.reference,
        repository: run.headRepository ?? run.reference.repository,
        sha: run.headSha,
        path,
      }).pipe(
        Effect.map((result) => ({
          path,
          content: result.content,
          truncated: result.truncated,
          unavailable: false,
        })),
        Effect.orElseSucceed(() => ({ path, content: "", truncated: false, unavailable: true })),
      ),
    { concurrency: 3 },
  );
  let remaining = 30_000;
  const warnings: string[] =
    batch.paths.length > 12
      ? [
          "Neighboring code limited to 12 files per cohort; all selected patches are still analyzed.",
        ]
      : [];
  const positions = reviewLinePositions(batch.patch);
  const excerpts = files.map((file) => {
    if (file.unavailable) {
      warnings.push(`Neighboring code unavailable: ${file.path}`);
      return { path: file.path, unavailable: true };
    }
    const firstLine = positions.get(file.path)?.keys().next().value ?? 1;
    const start = Math.max(0, firstLine - 21);
    const excerpt = file.content
      .split("\n")
      .slice(start, start + 160)
      .map((line, index) => `${start + index + 1}: ${line}`)
      .join("\n")
      .slice(0, remaining);
    remaining -= excerpt.length;
    if (file.truncated || !remaining) warnings.push(`Neighboring code bounded: ${file.path}`);
    return { path: file.path, excerpt };
  });
  return { context: encodeContext(excerpts), warnings };
});
