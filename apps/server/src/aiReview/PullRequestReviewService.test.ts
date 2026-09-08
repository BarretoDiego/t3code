import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import {
  DEFAULT_SERVER_SETTINGS,
  SourceControlHubError,
  ProviderInstanceId,
  ProjectId,
  type AiReviewRun,
  type RemotePullRequestDetail,
  type PullRequestActivity,
} from "@t3tools/contracts";
import * as Config from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { SourceControlHubService } from "../sourceControl/SourceControlHubService.ts";
import { RemotePullRequestService } from "../sourceControl/RemotePullRequestService.ts";
import type { SourceControlRepositoryBrowser } from "../sourceControl/SourceControlRepositoryBrowser.ts";
import { ReviewAgentExecutor } from "./ReviewAgentExecutor.ts";
import { make } from "./PullRequestReviewService.ts";
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const base = "a".repeat(40),
  firstHead = "b".repeat(40),
  secondHead = "c".repeat(40);
const reference = {
  provider: "github" as const,
  host: "github.com",
  repository: "owner/repo",
  number: 1,
};
const instanceId = ProviderInstanceId.make("review-test");
const patch = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
it.effect(
  "runs a verified local draft, persists history and incrementally compares the last reviewed head",
  () => {
    let head = firstHead;
    let pause = false;
    let truncated = false;
    let publicationFails = false;
    const gitCommands: string[][] = [];
    const worktrees: { path: string; refName: string }[] = [];
    const removed: string[] = [];
    const projectId = ProjectId.make("local-project");
    const comparisons: Parameters<SourceControlRepositoryBrowser["compare"]>[0][] = [];
    const prompts: string[] = [];
    const publications: Parameters<RemotePullRequestService["Service"]["review"]>[0][] = [];
    const instance = {
      instanceId,
      enabled: true,
      snapshot: { getSnapshot: Effect.succeed({ models: [{ slug: "test-model" }] }) },
    } as unknown as ProviderInstance;
    const browser: SourceControlRepositoryBrowser = {
      revisions: () =>
        Effect.sync(() => ({ baseSha: base, headSha: head, headRepository: reference.repository })),
      compare: (input) =>
        Effect.sync(() => {
          comparisons.push(input);
          return { patch, truncated };
        }),
      listRepositories: () => Effect.die("Unexpected catalog"),
      listRefs: () => Effect.die("Unexpected refs"),
      createPullRequest: () => Effect.die("Review must not create PRs"),
    };
    const dependencies = Layer.mergeAll(
      Config.layerTest(process.cwd(), { prefix: "t3-review-run-test-" }),
      Layer.mock(ServerSettingsService)({
        getSettings: Effect.succeed({
          ...DEFAULT_SERVER_SETTINGS,
          sourceControlReview: {
            ...DEFAULT_SERVER_SETTINGS.sourceControlReview,
            prompt: "Prioritize database migrations and concurrency. No fixed finding quota.",
          },
        }),
      }),
      Layer.mock(ProviderInstanceRegistry)({ getInstance: () => Effect.succeed(instance) }),
      Layer.mock(GitVcsDriver)({
        execute: (input) =>
          Effect.sync(() => {
            gitCommands.push([...input.args]);
            return {
              stdout: input.args[0] === "merge-base" ? base : patch,
              stderr: "",
              exitCode: ChildProcessSpawner.ExitCode(0),
              stdoutTruncated: false,
              stderrTruncated: false,
            };
          }),
        resolveCommit: () => Effect.succeed({ commitSha: head }),
        createWorktree: (input) =>
          Effect.sync(() => {
            worktrees.push({ path: input.path!, refName: input.refName });
            return { worktree: { path: input.path!, refName: input.refName } };
          }),
        removeWorktree: (input) =>
          Effect.sync(() => {
            removed.push(input.path);
          }),
      }),
      Layer.mock(SourceControlHubService)({
        browser: () => Effect.succeed(browser),
        clones: Effect.succeed([
          {
            ...reference,
            projectId,
            cwd: "/user-primary-checkout",
            title: "Local",
            remoteName: "origin",
          },
        ]),
      }),
      Layer.mock(RemotePullRequestService)({
        refresh: Effect.void,
        detail: () =>
          Effect.succeed({
            number: 1,
            title: "Change",
            body: "Description",
            headBranch: "feature",
            baseBranch: "main",
            checks: [],
          } as unknown as RemotePullRequestDetail),
        activity: () =>
          Effect.succeed({
            commits: [],
            comments: [],
            reviewThreads: [],
          } as unknown as PullRequestActivity),
        review: (input) =>
          publicationFails
            ? Effect.fail(new SourceControlHubError({ message: "Connection lost" }))
            : Effect.sync(() => {
                publications.push(input);
              }),
      }),
      Layer.succeed(
        ReviewAgentExecutor,
        ReviewAgentExecutor.of({
          execute: (input) =>
            pause
              ? Effect.never
              : Effect.sync(() => {
                  prompts.push(input.prompt);
                  return encodeJson({
                    summary: "Review summary",
                    risk: "medium",
                    walkthrough: [],
                    findings: [
                      {
                        id: "candidate",
                        severity: "major",
                        category: "Correctness",
                        title: "Actionable bug",
                        description: "Impact and evidence",
                        filePath: "a.ts",
                        line: 1,
                      },
                    ],
                  });
                }).pipe(
                  Effect.tap(() => TestClock.adjust("1 second")),
                  Effect.tap(
                    () =>
                      input.onActivity?.({
                        id: "reasoning",
                        kind: "task",
                        label: "Reasoning",
                        status: "running",
                        text: "Processing review",
                      }) ?? Effect.void,
                  ),
                  Effect.tap(
                    () =>
                      input.onActivity?.({
                        id: "output",
                        kind: "agent",
                        label: "Reviewer",
                        status: "running",
                        text: "Public draft",
                      }) ?? Effect.void,
                  ),
                ),
        }),
      ),
    ).pipe(Layer.provideMerge(NodeServices.layer));
    return Effect.gen(function* () {
      const service = yield* make;
      const completed = yield* Queue.unbounded<AiReviewRun>();
      yield* service.changes.pipe(
        Stream.filter((run) => ["draft", "failed", "cancelled"].includes(run.stage)),
        Stream.runForEach((run) => Queue.offer(completed, run)),
        Effect.forkScoped({ startImmediately: true }),
      );
      const input = {
        reference,
        tier: "standard" as const,
        mode: "full" as const,
        scope: "changed-files" as const,
        agent: { modelSelection: { instanceId, model: "test-model" }, miniSkillIds: [] },
        includeGenerated: false,
        includeExistingComments: true,
      };
      yield* service.start(input);
      const first = yield* Queue.take(completed);
      expect(first.stage).toBe("draft");
      expect(first.headSha).toBe(firstHead);
      expect(first.durationMs).toBeGreaterThanOrEqual(2000);
      expect(first.activity?.every((item) => item.status !== "running")).toBe(true);
      expect(first.activity).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "agent", status: "completed", text: "Public draft" }),
        ]),
      );
      expect(
        prompts.every((prompt) =>
          prompt.includes(
            "Prioritize database migrations and concurrency. No fixed finding quota.",
          ),
        ),
      ).toBe(true);
      expect(prompts).toHaveLength(2); // Generation and independent verification.
      expect(publications).toEqual([]);
      head = secondHead;
      yield* service.start({ ...input, mode: "incremental" });
      const second = yield* Queue.take(completed);
      expect(second.stage).toBe("draft");
      expect(second.comparisonBaseSha).toBe(firstHead);
      expect(comparisons[1]).toMatchObject({
        baseSha: firstHead,
        headSha: secondHead,
        mode: "incremental",
      });
      expect(yield* service.history(reference)).toHaveLength(2);
      const stale = yield* service
        .publish({ id: first.id, findingIds: ["finding-1"], includeSummary: false })
        .pipe(Effect.flip);
      expect(stale.message).toContain("PR changed");
      expect(publications).toEqual([]);
      yield* service.edit({
        id: second.id,
        findings: second.analysis!.findings.map((f) => ({ ...f, description: "Human edited" })),
        dismissedIds: [],
        summary: "Edited summary",
      });
      yield* service.publish({ id: second.id, findingIds: ["finding-1"], includeSummary: true });
      expect(publications).toHaveLength(1);
      expect(publications[0]).toMatchObject({
        verdict: "comment",
        expectedHeadSha: secondHead,
        body: "## AI-assisted review\n\nEdited summary",
      });
      expect(publications[0]?.comments[0]?.body).toContain("Human edited");
      yield* service
        .publish({ id: second.id, findingIds: ["finding-1"], includeSummary: true })
        .pipe(Effect.flip);
      expect(publications).toHaveLength(1);
      const takeRun = Effect.fn(function* (id: string) {
        for (;;) {
          const value = yield* Queue.take(completed);
          if (value.id === id) return value;
        }
      });
      const beforeQuick = prompts.length;
      const quick = yield* service.start({ ...input, tier: "quick" });
      expect((yield* takeRun(quick.id)).stage).toBe("draft");
      expect(prompts.length - beforeQuick).toBe(1);
      const deep = yield* service.start({
        ...input,
        tier: "deep",
        scope: "full-context",
        projectId,
      });
      expect((yield* takeRun(deep.id)).stage).toBe("draft");
      // Drain the executor through cancel's join before inspecting finalizer-owned cleanup.
      yield* service.cancel(deep.id);
      expect(worktrees[0]?.refName).toBe(secondHead);
      expect(worktrees[0]?.path).not.toBe("/user-primary-checkout");
      expect(removed).toContain(worktrees[0]?.path);
      const beforeExhaustive = prompts.length;
      const exhaustive = yield* service.start({ ...input, tier: "exhaustive", projectId });
      expect((yield* takeRun(exhaustive.id)).stage).toBe("draft");
      yield* service.cancel(exhaustive.id);
      expect(prompts.length - beforeExhaustive).toBe(3);
      const beforeMetadata = comparisons.length;
      const metadata = yield* service.start({ ...input, tier: "deep", scope: "metadata" });
      expect((yield* takeRun(metadata.id)).stage).toBe("draft");
      yield* service.cancel(metadata.id);
      expect(comparisons).toHaveLength(beforeMetadata);
      truncated = true;
      const large = yield* service.start({ ...input, projectId });
      expect((yield* takeRun(large.id)).stage).toBe("draft");
      yield* service.cancel(large.id);
      yield* service.publish({ id: large.id, findingIds: ["finding-1"], includeSummary: false });
      expect(gitCommands.filter((args) => args[0] === "diff")).toHaveLength(2);
      expect(publications).toHaveLength(2);
      truncated = false;
      const uncertain = yield* service.start(input);
      expect((yield* takeRun(uncertain.id)).stage).toBe("draft");
      yield* service.cancel(uncertain.id);
      publicationFails = true;
      yield* service
        .publish({ id: uncertain.id, findingIds: ["finding-1"], includeSummary: true })
        .pipe(Effect.flip);
      publicationFails = false;
      const retry = yield* service
        .publish({ id: uncertain.id, findingIds: ["finding-1"], includeSummary: true })
        .pipe(Effect.flip);
      expect(retry.message).toContain("previous publication");
      expect(publications).toHaveLength(2);
      pause = true;
      const cancelling = yield* service.start(input);
      yield* service.cancel(cancelling.id);
      expect((yield* takeRun(cancelling.id)).stage).toBe("cancelled");
    }).pipe(Effect.scoped, Effect.provide(dependencies));
  },
);
