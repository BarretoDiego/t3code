import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import type { AiReviewRun, PullRequestActivity, RemotePullRequestDetail } from "@t3tools/contracts";
import type { SourceControlRepositoryBrowser } from "../sourceControl/SourceControlRepositoryBrowser.ts";
import { buildReviewMetadata, collectNeighboringCode } from "./ReviewContextBuilder.ts";
const parseContext = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Array(Schema.Struct({ path: Schema.String, excerpt: Schema.String })),
  ),
);
const run = {
  reference: { provider: "github", host: "github.com", repository: "upstream/repo", number: 4 },
  headRepository: "fork/repo",
  headSha: "b".repeat(40),
  baseSha: "a".repeat(40),
  comparisonBaseSha: "a".repeat(40),
  tier: "standard",
  scope: "changed-files",
  includeExistingComments: true,
} as AiReviewRun;
it("bounds metadata without breaking JSON and excludes comments when requested", () => {
  const detail = {
    number: 4,
    title: "Change",
    body: "x".repeat(15_000),
    headBranch: "feature",
    baseBranch: "main",
    checks: [],
  } as unknown as RemotePullRequestDetail;
  const activity = {
    commits: [{ oid: "abc", messageHeadline: "Fix bug" }],
    comments: [{ body: "Existing human finding", path: "a.ts" }],
    reviewThreads: [],
    commentsTruncated: false,
  } as unknown as PullRequestActivity;
  const result = JSON.parse(buildReviewMetadata(run, detail, activity));
  expect(result.description).toHaveLength(12_000);
  expect(result.contextLimits.descriptionTruncated).toBe(true);
  expect(result.existingComments[0].body).toBe("Existing human finding");
  const metadata = JSON.parse(
    buildReviewMetadata(
      { ...run, scope: "metadata", includeExistingComments: false },
      detail,
      activity,
    ),
  );
  expect(metadata).not.toHaveProperty("commits");
  expect(metadata).not.toHaveProperty("existingComments");
});
it.effect("loads neighboring code from the fork at the reviewed SHA and skips it for Quick", () =>
  Effect.gen(function* () {
    const requests: unknown[] = [];
    const browser = {
      readFile: (input) =>
        Effect.sync(() => {
          requests.push(input);
          return { content: "first\nsecond", truncated: false };
        }),
    } as Pick<SourceControlRepositoryBrowser, "readFile">;
    const batch = {
      paths: ["a.ts"],
      patch: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+first\n",
    };
    const result = yield* collectNeighboringCode(
      browser as SourceControlRepositoryBrowser,
      run,
      batch,
    );
    expect(requests).toEqual([
      { ...run.reference, repository: "fork/repo", sha: run.headSha, path: "a.ts" },
    ]);
    expect(parseContext(result.context)[0]?.excerpt).toContain("1: first");
    yield* collectNeighboringCode(
      browser as SourceControlRepositoryBrowser,
      { ...run, tier: "quick" },
      batch,
    );
    expect(requests).toHaveLength(1);
  }),
);
