import { parseListCursor, nextListCursor } from "../pullRequest/pullRequestPagination.ts";
import {
  SourceControlHubError,
  RemotePullRequestDetail,
  RemotePullRequestListInput,
  RemotePullRequestRef,
  RemotePullRequestDiffInput,
  type RemotePullRequestPage,
  type RemotePullRequestReviewInput,
  type RemotePullRequestMergeInput,
  type PullRequestActivity,
  type PullRequestDiffResult,
} from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ServerConfig } from "../config.ts";
import { PullRequestProviderRegistry } from "../pullRequest/PullRequestProviderRegistry.ts";
import type { PullRequestProviderError } from "../pullRequest/PullRequestProvider.ts";
import { SourceControlHubService } from "./SourceControlHubService.ts";
import { SourceControlRateLimit } from "./SourceControlRateLimit.ts";

const decodeRemoteDetail = Schema.decodeUnknownEffect(RemotePullRequestDetail);

export class RemotePullRequestService extends Context.Service<
  RemotePullRequestService,
  {
    readonly list: (
      input: RemotePullRequestListInput,
    ) => Effect.Effect<RemotePullRequestPage, SourceControlHubError>;
    readonly detail: (
      input: RemotePullRequestRef,
    ) => Effect.Effect<RemotePullRequestDetail, SourceControlHubError>;
    readonly activity: (
      input: RemotePullRequestRef,
    ) => Effect.Effect<PullRequestActivity, SourceControlHubError>;
    readonly diff: (
      input: RemotePullRequestDiffInput,
    ) => Effect.Effect<PullRequestDiffResult, SourceControlHubError>;
    readonly review: (
      input: RemotePullRequestReviewInput,
    ) => Effect.Effect<void, SourceControlHubError>;
    readonly merge: (
      input: RemotePullRequestMergeInput,
    ) => Effect.Effect<void, SourceControlHubError>;
    readonly refresh: Effect.Effect<void>;
  }
>()("t3/sourceControl/RemotePullRequestService") {}

export const make = Effect.gen(function* () {
  const registry = yield* PullRequestProviderRegistry;
  const hub = yield* SourceControlHubService;
  const config = yield* ServerConfig;
  const limits = yield* SourceControlRateLimit;
  const resolve = (input: Pick<RemotePullRequestRef, "provider" | "host">) => {
    const api = registry.get(input.provider);
    const host =
      input.provider === "github"
        ? "github.com"
        : input.provider === "bitbucket"
          ? "bitbucket.org"
          : null;
    return api && input.host === host
      ? Effect.succeed(api)
      : Effect.fail(
          new SourceControlHubError({
            message: "This source control account does not support the selected host.",
          }),
        );
  };
  const request = <A>(
    input: Pick<RemotePullRequestRef, "provider" | "host">,
    effect: Effect.Effect<A, PullRequestProviderError>,
  ) =>
    Effect.gen(function* () {
      const lease = yield* limits.check(input).pipe(
        Effect.mapError(
          () =>
            new SourceControlHubError({
              message: "Source control rate limit reached. Retry after the provider limit resets.",
            }),
        ),
      );
      return yield* effect.pipe(
        Effect.tap(() => limits.recordSuccess({ ...input, lease })),
        Effect.catch((error) =>
          Effect.gen(function* () {
            if (error.reason === "rate-limited")
              yield* limits.recordRateLimit({
                ...input,
                lease,
                ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
              });
            return yield* new SourceControlHubError({
              message:
                error.reason === "unauthenticated"
                  ? "Authentication required. Manage this account in Settings → Source Control."
                  : error.reason === "rate-limited"
                    ? "Source control rate limit reached. Please retry later."
                    : "The source control operation failed. Check repository permissions and refresh.",
            });
          }),
        ),
      );
    });
  const listUncached = Effect.fn(function* (
    input: RemotePullRequestListInput,
  ): Effect.fn.Return<RemotePullRequestPage, SourceControlHubError> {
    const api = yield* resolve(input);
    const viewer = yield* request(input, api.getViewer({ cwd: config.cwd }));
    const cursor = input.cursor ? parseListCursor(input.cursor) : undefined;
    if (cursor === null)
      return yield* new SourceControlHubError({
        message: "Invalid pagination cursor. Refresh the PR list.",
      });
    const page = yield* request(
      input,
      api.listChangeRequests({ ...input, cursor, cwd: config.cwd, viewer, limit: 50 }),
    );
    return {
      items: page.items
        .filter(
          (item) =>
            !cursor ||
            item.updatedAt !== cursor.updatedBefore ||
            !cursor.seenAt.includes(item.number),
        )
        .map((item) => ({
          ...item,
          provider: input.provider,
          host: input.host,
          repository: input.repository,
          viewerReviewRequested: item.reviewRequestLogins.includes(viewer),
          ...(item.reviewDecision
            ? { reviewDecision: item.reviewDecision }
            : { reviewDecision: undefined }),
          ...(item.checksState ? { checksState: item.checksState } : { checksState: undefined }),
        })),
      nextCursor:
        page.continues && page.truncated
          ? nextListCursor(
              cursor,
              page.items,
              page.items.filter(
                (item) =>
                  !cursor ||
                  item.updatedAt !== cursor.updatedBefore ||
                  !cursor.seenAt.includes(item.number),
              ),
              page.cursorAdvance,
            )
          : null,
      truncated: page.truncated,
    };
  });
  const detailUncached = Effect.fn(function* (input: RemotePullRequestRef) {
    const api = yield* resolve(input);
    const detail = yield* request(input, api.getChangeRequest({ ...input, cwd: config.cwd }));
    return yield* decodeRemoteDetail({
      ...detail,
      provider: input.provider,
      repository: input.repository,
      capabilities: api.capabilities,
    }).pipe(
      Effect.mapError(
        () =>
          new SourceControlHubError({ message: "The provider returned an invalid pull request." }),
      ),
    );
  });
  const cached = <S extends Schema.Top, A>(
    schema: S & { readonly DecodingServices: never },
    fn: (input: S["Type"]) => Effect.Effect<A, SourceControlHubError>,
  ) =>
    Cache.makeWith(
      (key: string) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(key).pipe(
          Effect.mapError(
            () => new SourceControlHubError({ message: "Invalid source control request." }),
          ),
          Effect.flatMap(fn),
        ),
      {
        capacity: 256,
        timeToLive: Exit.match({
          onSuccess: () => Duration.seconds(30),
          onFailure: () => Duration.zero,
        }),
      },
    );
  const listings = yield* cached(RemotePullRequestListInput, listUncached);
  const details = yield* cached(RemotePullRequestRef, detailUncached);
  const activities = yield* cached(
    RemotePullRequestRef,
    Effect.fn(function* (input) {
      const api = yield* resolve(input);
      return yield* request(input, api.getChangeRequestActivity({ ...input, cwd: config.cwd }));
    }),
  );
  const diffs = yield* cached(
    RemotePullRequestDiffInput,
    Effect.fn(function* (input) {
      const api = yield* resolve(input);
      return yield* request(input, api.getDiff({ ...input, cwd: config.cwd }));
    }),
  );
  const refresh = Effect.all(
    [
      Cache.invalidateAll(listings),
      Cache.invalidateAll(details),
      Cache.invalidateAll(activities),
      Cache.invalidateAll(diffs),
    ],
    { discard: true },
  );
  const assertCurrent = Effect.fn(function* (
    input: RemotePullRequestRef & { expectedHeadSha: string },
  ) {
    const revisions = yield* (yield* hub.browser(input.provider)).revisions(input);
    if (revisions.headSha !== input.expectedHeadSha)
      return yield* new SourceControlHubError({
        message:
          "PR changed since this review was generated. Refresh or run an incremental review before publishing.",
      });
  });
  return RemotePullRequestService.of({
    list: (input) => Cache.get(listings, JSON.stringify(input)),
    detail: (input) => Cache.get(details, JSON.stringify(input)),
    activity: (input) => Cache.get(activities, JSON.stringify(input)),
    diff: (input) => Cache.get(diffs, JSON.stringify(input)),
    refresh,
    review: Effect.fn(function* (input) {
      const api = yield* resolve(input);
      const permission = yield* request(
        input,
        api.getViewerPermissions({ ...input, cwd: config.cwd }),
      );
      if (
        !api.capabilities.review.verdicts.includes(input.verdict) ||
        !permission.verdicts.includes(input.verdict)
      )
        return yield* new SourceControlHubError({
          message: "This account cannot submit the selected review verdict.",
        });
      if (input.comments.length && (!api.capabilities.review.inlineComment || !permission.comment))
        return yield* new SourceControlHubError({
          message: "This account cannot publish inline comments.",
        });
      if (input.verdict !== "approve" && !input.body.trim() && !input.comments.length)
        return yield* new SourceControlHubError({
          message: "Write a summary or select at least one comment.",
        });
      yield* assertCurrent(input);
      yield* request(input, api.submitReview({ ...input, cwd: config.cwd }));
      yield* refresh;
    }),
    merge: Effect.fn(function* (input) {
      const api = yield* resolve(input);
      const detail = yield* detailUncached(input);
      if (
        !api.capabilities.actions.includes("merge") ||
        !detail.viewerPermissions.actions.includes("merge") ||
        !api.capabilities.mergeMethods.includes(input.method) ||
        !detail.mergeCapabilities[input.method] ||
        detail.state !== "open" ||
        detail.isDraft
      )
        return yield* new SourceControlHubError({
          message: "This pull request cannot be merged with the selected strategy and account.",
        });
      yield* assertCurrent(input);
      yield* request(
        input,
        api.runAction({ ...input, cwd: config.cwd, action: "merge", mergeMethod: input.method }),
      );
      yield* refresh;
    }),
  });
});
export const layer = Layer.effect(RemotePullRequestService, make);
