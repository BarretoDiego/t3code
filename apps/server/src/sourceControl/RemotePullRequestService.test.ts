import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "../config.ts";
import {
  PullRequestProviderRegistry,
  fromProviders,
} from "../pullRequest/PullRequestProviderRegistry.ts";
import type { PullRequestProviderApi } from "../pullRequest/PullRequestProvider.ts";
import { SourceControlHubService } from "./SourceControlHubService.ts";
import * as SourceControlRateLimit from "./SourceControlRateLimit.ts";
import { make } from "./RemotePullRequestService.ts";
const ref = {
  provider: "github" as const,
  host: "github.com",
  repository: "owner/repo",
  number: 1,
};
const sha = "a".repeat(40);
function dependencies(input: {
  head?: string;
  allowed?: boolean;
  publish: PullRequestProviderApi["submitReview"];
}) {
  const provider: PullRequestProviderApi = {
    kind: "github",
    capabilities: {
      diff: true,
      comment: true,
      actions: ["merge"],
      mergeMethods: ["merge"],
      search: true,
      reactions: false,
      review: {
        inlineComment: true,
        reply: true,
        resolve: true,
        verdicts: ["comment", "approve", "request-changes"],
      },
      reviewers: { request: true, listCandidates: true },
      edit: { changeRequest: true, comment: true },
    },
    getViewer: () => Effect.succeed("dev"),
    getViewerPermissions: () =>
      Effect.succeed({
        actions: [],
        comment: input.allowed !== false,
        resolve: false,
        verdicts: input.allowed === false ? [] : ["comment", "approve", "request-changes"],
        requestReviewers: false,
      }),
    listChangeRequests: () => Effect.succeed({ items: [], truncated: false, continues: false }),
    getChangeRequest: () => Effect.die("Unexpected detail request"),
    getChangeRequestActivity: () => Effect.die("Unexpected activity request"),
    getDiff: () => Effect.die("Unexpected diff request"),
    runAction: () => Effect.die("Review must never merge"),
    comment: () => Effect.die("Review must use submission port"),
    submitReview: input.publish,
    replyToThread: () => Effect.void,
    setThreadResolution: () => Effect.void,
    setReaction: () => Effect.void,
    listReviewerCandidates: () => Effect.succeed({ candidates: [], truncated: false }),
    setReviewerRequest: () => Effect.void,
  };
  return Layer.mergeAll(
    Layer.succeed(PullRequestProviderRegistry, fromProviders([provider])),
    Layer.mock(SourceControlHubService)({
      browser: () =>
        Effect.succeed({
          revisions: () =>
            Effect.succeed({
              baseSha: sha,
              headSha: input.head ?? sha,
              headRepository: ref.repository,
            }),
          listRepositories: () => Effect.die("Unexpected catalog"),
          listRefs: () => Effect.die("Unexpected refs"),
          compare: () => Effect.die("Unexpected compare"),
          createPullRequest: () => Effect.die("Unexpected creation"),
        }),
    }),
    SourceControlRateLimit.layer,
    Config.layerTest(process.cwd(), { prefix: "remote-pr-service-test-" }),
  ).pipe(Layer.provideMerge(NodeServices.layer));
}
it.effect("blocks stale reviews before sending anything to the provider", () => {
  let calls = 0;
  return Effect.gen(function* () {
    const service = yield* make;
    const error = yield* service
      .review({ ...ref, expectedHeadSha: sha, verdict: "comment", body: "Review", comments: [] })
      .pipe(Effect.flip);
    expect(error.message).toContain("PR changed");
    expect(calls).toBe(0);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      dependencies({
        head: "b".repeat(40),
        publish: () =>
          Effect.sync(() => {
            calls++;
          }),
      }),
    ),
  );
});
it.effect("read access alone cannot publish comments or approvals", () => {
  let calls = 0;
  return Effect.gen(function* () {
    const service = yield* make;
    for (const verdict of ["comment", "approve"] as const) {
      const error = yield* service
        .review({ ...ref, expectedHeadSha: sha, verdict, body: "Review", comments: [] })
        .pipe(Effect.flip);
      expect(error.message).toContain("cannot submit");
    }
    expect(calls).toBe(0);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      dependencies({
        allowed: false,
        publish: () =>
          Effect.sync(() => {
            calls++;
          }),
      }),
    ),
  );
});
it.effect("submits the user-edited body and pinned SHA only on explicit publication", () => {
  const sent: Parameters<PullRequestProviderApi["submitReview"]>[0][] = [];
  return Effect.gen(function* () {
    const service = yield* make;
    expect(sent).toEqual([]);
    yield* service.review({
      ...ref,
      expectedHeadSha: sha,
      verdict: "comment",
      body: "User edited text",
      comments: [{ path: "a.ts", position: { kind: "added", newLine: 2 }, body: "Edited inline" }],
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      expectedHeadSha: sha,
      verdict: "comment",
      body: "User edited text",
    });
  }).pipe(
    Effect.scoped,
    Effect.provide(
      dependencies({
        publish: (input) =>
          Effect.sync(() => {
            sent.push(input);
          }),
      }),
    ),
  );
});
