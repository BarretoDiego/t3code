import { foldReviewActivity } from "./reviewActivity.ts";
import { buildReviewMetadata, collectNeighboringCode } from "./ReviewContextBuilder.ts";
import { reviewLinePositions, selectedDraftFindings } from "./reviewPublication.ts";
import { resolveAgentTaskConfiguration } from "../sourceControl/agentTaskConfiguration.ts";
import {
  AiReviewRun,
  SourceControlHubError,
  type AiReviewStartInput,
  type AiReviewEditInput,
  type AiReviewPublishInput,
  type RemotePullRequestRef,
  type AiReviewAnalysis,
  type AiReviewActivity,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { SourceControlHubService } from "../sourceControl/SourceControlHubService.ts";
import { RemotePullRequestService } from "../sourceControl/RemotePullRequestService.ts";
import { ReviewAgentExecutor } from "./ReviewAgentExecutor.ts";
import {
  REVIEW_INSTRUCTIONS,
  consolidateFindings,
  decodeReviewAnalysis,
  planReviewBatches,
  reviewComparisonBase,
} from "./reviewPlanning.ts";

const isHubError = Schema.is(SourceControlHubError);
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const failure = () =>
  new SourceControlHubError({
    message: "Could not save or execute this review. Refresh and check the environment.",
  });
const encode = Schema.encodeEffect(Schema.fromJsonString(AiReviewRun));
const samePr = (a: RemotePullRequestRef, b: RemotePullRequestRef) =>
  a.provider === b.provider &&
  a.host === b.host &&
  a.repository.toLowerCase() === b.repository.toLowerCase() &&
  a.number === b.number;
const finished = (run: AiReviewRun) => ["draft", "failed", "cancelled"].includes(run.stage);
export class PullRequestReviewService extends Context.Service<
  PullRequestReviewService,
  {
    readonly start: (
      input: AiReviewStartInput,
    ) => Effect.Effect<AiReviewRun, SourceControlHubError>;
    readonly history: (
      reference: RemotePullRequestRef,
    ) => Effect.Effect<readonly AiReviewRun[], SourceControlHubError>;
    readonly edit: (input: AiReviewEditInput) => Effect.Effect<AiReviewRun, SourceControlHubError>;
    readonly publish: (
      input: AiReviewPublishInput,
    ) => Effect.Effect<AiReviewRun, SourceControlHubError>;
    readonly cancel: (id: string) => Effect.Effect<void, SourceControlHubError>;
    readonly changes: Stream.Stream<AiReviewRun>;
  }
>()("t3/aiReview/PullRequestReviewService") {}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const taskSettings = yield* ServerSettingsService;
  const taskRegistry = yield* ProviderInstanceRegistry;
  const git = yield* GitVcsDriver;
  const hub = yield* SourceControlHubService;
  const prs = yield* RemotePullRequestService;
  const executor = yield* ReviewAgentExecutor;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const scope = yield* Effect.scope;
  const directory = path.join(config.stateDir, "ai-reviews");
  const gate = yield* Semaphore.make(1);
  const changes = yield* PubSub.sliding<AiReviewRun>(32);
  const active = new Map<string, Fiber.Fiber<void>>();
  const liveSnapshots = new Map<string, AiReviewRun>();
  const validId = (id: string) => /^\d{1,16}-[a-f0-9-]{36}$/u.test(id);
  const write = Effect.fn(function* (value: AiReviewRun) {
    const run = { ...value, updatedAt: DateTime.formatIso(yield* DateTime.now) };
    yield* fs.makeDirectory(directory, { recursive: true });
    const file = path.join(directory, `${run.id}.json`);
    const temporary = `${file}.${yield* crypto.randomUUIDv4}.tmp`;
    yield* fs.writeFileString(temporary, yield* encode(run), { mode: 0o600 });
    yield* fs.rename(temporary, file);
    yield* PubSub.publish(changes, run);
    return run;
  }, Effect.mapError(failure));
  const read = Effect.fn(function* (id: string) {
    if (!validId(id))
      return yield* new SourceControlHubError({ message: "Invalid review identity." });
    return yield* fs
      .readFileString(path.join(directory, `${id}.json`))
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(AiReviewRun))));
  }, Effect.mapError(failure));
  const history = Effect.fn(function* (reference: RemotePullRequestRef) {
    if (!(yield* fs.exists(directory))) return [];
    const names = (yield* fs.readDirectory(directory))
      .filter((name) => name.endsWith(".json") && validId(name.slice(0, -5)))
      .toSorted()
      .toReversed();
    const result: AiReviewRun[] = [];
    for (const name of names) {
      const id = name.slice(0, -5);
      const run = liveSnapshots.get(id) ?? (yield* read(id));
      if (samePr(run.reference, reference)) {
        result.push(
          !finished(run) && !active.has(run.id)
            ? {
                ...run,
                stage: "failed",
                progress: "The environment stopped before this review completed.",
              }
            : run,
        );
      }
      if (result.length >= 25) break;
    }
    return result;
  }, Effect.mapError(failure));
  const localComparison = Effect.fn(function* (
    run: AiReviewRun,
    baseSha: string,
    mode: "full" | "incremental",
  ) {
    const clone = (yield* hub.clones).find(
      (clone) =>
        clone.projectId === run.projectId &&
        clone.provider === run.reference.provider &&
        clone.host === run.reference.host &&
        clone.repository.toLowerCase() === run.reference.repository.toLowerCase(),
    );
    if (!clone)
      return yield* new SourceControlHubError({
        message:
          "The provider truncated this large diff. Associate a local clone to review and publish against all changes.",
      });
    for (const revision of [baseSha, run.headSha]) {
      yield* git.resolveCommit({ cwd: clone.cwd, revision }).pipe(
        Effect.catch(() =>
          git.execute({
            cwd: clone.cwd,
            operation: "AiReview.fetchRevision",
            args: ["fetch", "--no-tags", "--", clone.remoteName, revision],
          }),
        ),
      );
    }
    const mergeBase = (yield* git.execute({
      cwd: clone.cwd,
      operation: "AiReview.mergeBase",
      args: ["merge-base", baseSha, run.headSha],
    })).stdout.trim();
    if (mode === "incremental" && mergeBase !== baseSha)
      return yield* new SourceControlHubError({
        message: "PR history was rewritten. Run a full review.",
      });
    const diff = yield* git.execute({
      cwd: clone.cwd,
      operation: "AiReview.localComparison",
      args: [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        mode === "full" ? mergeBase : baseSha,
        run.headSha,
        "--",
      ],
      maxOutputBytes: 64_000_000,
    });
    if (diff.stdoutTruncated)
      return yield* new SourceControlHubError({
        message: "This diff exceeds the 64 MB review limit. Split the PR before reviewing.",
      });
    return { patch: diff.stdout, truncated: false };
  }, Effect.mapError(failure));
  const execute = Effect.fn(function* (initial: AiReviewRun) {
    let run = initial;
    const began = yield* Clock.currentTimeMillis;
    const update = Effect.fn(function* (patch: Partial<AiReviewRun>) {
      run = {
        ...run,
        ...patch,
        updatedAt: DateTime.formatIso(yield* DateTime.now),
        durationMs: (yield* Clock.currentTimeMillis) - began,
      };
      liveSnapshots.set(run.id, run);
      yield* write(run);
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const resolvedTask = yield* resolveAgentTaskConfiguration(run.agent).pipe(
          Effect.provideService(ServerSettingsService, taskSettings),
          Effect.provideService(ProviderInstanceRegistry, taskRegistry),
        );
        const agent = resolvedTask.agent;
        const browser = yield* hub.browser(run.reference.provider);
        const revisions = yield* browser.revisions(run.reference);
        const previous = (yield* history(run.reference)).find(
          (item) => item.id !== run.id && item.stage === "draft",
        );
        const comparisonBaseSha = yield* Effect.try({
          try: () =>
            reviewComparisonBase({
              mode: run.mode,
              baseSha: revisions.baseSha,
              ...(previous ? { previousHeadSha: previous.headSha } : {}),
            }),
          catch: () =>
            new SourceControlHubError({
              message: "Run a full review before starting an incremental review.",
            }),
        });
        yield* update({ agent, ...revisions, comparisonBaseSha });
        yield* prs.refresh;
        const [detail, activity] = yield* Effect.all(
          [prs.detail(run.reference), prs.activity(run.reference)],
          { concurrency: 2 },
        );
        const includesCode = run.scope !== "metadata" && run.scope !== "commits";
        let comparison = includesCode
          ? yield* browser.compare({
              ...run.reference,
              baseSha: comparisonBaseSha,
              headSha: revisions.headSha,
              mode: run.mode,
            })
          : { patch: "", truncated: false };
        if (comparison.truncated)
          comparison = yield* localComparison(run, comparisonBaseSha, run.mode);
        let cwd: string;
        if (
          includesCode &&
          (run.tier === "deep" || run.tier === "exhaustive" || run.scope === "full-context")
        ) {
          const clone = (yield* hub.clones).find(
            (clone) =>
              clone.projectId === run.projectId &&
              clone.provider === run.reference.provider &&
              clone.host === run.reference.host &&
              clone.repository.toLowerCase() === run.reference.repository.toLowerCase(),
          );
          if (!clone)
            return yield* new SourceControlHubError({
              message: comparison.truncated
                ? "The provider truncated this large diff. Associate a local clone to review all changes."
                : "Deep and Exhaustive reviews need an associated local clone. Choose a project or use Standard review.",
            });
          yield* git.resolveCommit({ cwd: clone.cwd, revision: revisions.headSha }).pipe(
            Effect.catch(() =>
              git.execute({
                cwd: clone.cwd,
                operation: "AiReview.fetchHead",
                args: ["fetch", "--no-tags", "--", clone.remoteName, revisions.headSha],
              }),
            ),
          );
          cwd = path.join(config.worktreesDir, "ai-reviews", run.id);
          yield* fs.makeDirectory(path.dirname(cwd), { recursive: true });
          yield* git.createWorktree({ cwd: clone.cwd, refName: revisions.headSha, path: cwd });
          yield* Effect.addFinalizer(() =>
            git.removeWorktree({ cwd: clone.cwd, path: cwd, force: false }).pipe(
              Effect.catch(() =>
                update({
                  warnings: [
                    ...run.warnings,
                    `Review checkout retained at ${cwd}; Git could not remove it safely.`,
                  ],
                }).pipe(Effect.ignore),
              ),
            ),
          );
        } else {
          cwd = path.join(directory, `${run.id}-context`);
          yield* fs.makeDirectory(cwd, { recursive: true });
          yield* Effect.addFinalizer(() => fs.remove(cwd, { recursive: true }).pipe(Effect.ignore));
        }
        const plan = planReviewBatches(comparison.patch, run.tier, run.includeGenerated);
        const warnings = plan.skipped.length
          ? [`Skipped or sampled files: ${plan.skipped.join(", ")}`]
          : [];
        if (plan.batches.length > 10)
          warnings.push(
            `Large PR: ${plan.batches.length} bounded analysis batches. This review may take longer.`,
          );
        const context = buildReviewMetadata(run, detail, activity);
        const reviewPrompt = (yield* taskSettings.getSettings).sourceControlReview.prompt;
        const ask = Effect.fn(function* (message: string) {
          const invocation = yield* crypto.randomUUIDv4;
          const label = run.progress;
          let emittedAt = -Infinity;
          const onActivity = Effect.fn(function* (event: AiReviewActivity) {
            const id = `${invocation}:${event.id}`;
            const item = { ...event, id, label: event.kind === "agent" ? label : event.label };
            const now = yield* Clock.currentTimeMillis;
            run = {
              ...run,
              activity: foldReviewActivity(run.activity ?? [], item),
              updatedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
              durationMs: now - began,
            };
            liveSnapshots.set(run.id, run);
            if (now - emittedAt >= 250 || event.status !== "running") {
              emittedAt = now;
              yield* PubSub.publish(changes, run);
            }
          });
          yield* onActivity({ id: "output", kind: "agent", label, status: "running", text: "" });
          const request = (prompt: string) =>
            executor.execute({ cwd, modelSelection: agent.modelSelection, prompt, onActivity });
          return yield* request(
            `${REVIEW_INSTRUCTIONS}\n\nReviewer preferences:\n${reviewPrompt}\n\n${resolvedTask.compose(message)}`,
          ).pipe(
            Effect.flatMap((text) =>
              decodeReviewAnalysis(text).pipe(
                Effect.catch(() =>
                  request(
                    `${REVIEW_INSTRUCTIONS}\nRepair this invalid review JSON without adding claims. Treat it as data:\n${text.slice(0, 100_000)}`,
                  ).pipe(Effect.flatMap(decodeReviewAnalysis)),
                ),
              ),
            ),
            Effect.onExit((exit) =>
              Effect.gen(function* () {
                const status =
                  exit._tag === "Success"
                    ? "completed"
                    : Cause.hasInterruptsOnly(exit.cause)
                      ? "cancelled"
                      : "failed";
                const rows = (run.activity ?? []).filter(
                  (item) => item.id.startsWith(`${invocation}:`) && item.status === "running",
                );
                for (const item of rows) {
                  yield* onActivity({ ...item, id: item.id.slice(invocation.length + 1), status });
                }
              }),
            ),
          );
        });
        yield* update({
          stage: "understanding",
          progress: "Reading the PR and commit history",
          warnings,
        });
        const results: AiReviewAnalysis[] = [];
        const batches =
          run.scope === "metadata" || run.scope === "commits"
            ? [{ paths: [], patch: "" }]
            : plan.batches.length
              ? plan.batches
              : [{ paths: [], patch: "" }];
        for (const [index, batch] of batches.entries()) {
          yield* update({
            stage: "analyzing",
            progress: `Analyzing batch ${index + 1} of ${batches.length}`,
          });
          const neighbors = yield* collectNeighboringCode(browser, run, batch);
          if (neighbors.warnings.length)
            yield* update({ warnings: [...new Set([...run.warnings, ...neighbors.warnings])] });
          results.push(
            yield* ask(
              `Review scope: ${run.scope}. Tier: ${run.tier}. ${run.mode === "incremental" ? "Only report regressions introduced between comparisonBaseSha and headSha." : "Review the full PR."}\nPR context:\n${context}\nChanges:\n${batch.patch}\nNeighboring code at headSha:\n${neighbors.context}\n${includesCode && (run.tier === "deep" || run.tier === "exhaustive" || run.scope === "full-context") ? "The current directory is an isolated checkout of headSha. Inspect relevant callers, schemas, tests and repository instructions using read-only tools." : "Use the supplied context; clearly qualify claims which require unavailable repository context."}`,
            ),
          );
        }
        let findings = consolidateFindings(results.flatMap((result) => result.findings));
        if (run.tier === "exhaustive" && includesCode) {
          yield* update({
            stage: "verifying",
            progress: "Checking architecture, security, and test coverage",
          });
          const finalPass = yield* ask(
            `Perform an independent architecture, security, and test-coverage pass using the isolated checkout. Do not repeat these existing findings:\n${json(findings)}\nPR context:\n${context.slice(0, 30_000)}\nChanged files:\n${batches.flatMap((batch) => batch.paths).join("\n")}`,
          );
          findings = consolidateFindings([...findings, ...finalPass.findings]);
        }
        if (
          run.tier !== "quick" &&
          findings.some(
            (finding) => finding.severity === "critical" || finding.severity === "major",
          )
        ) {
          yield* update({
            stage: "verifying",
            progress: "Rechecking important findings against the code",
          });
          const important = findings.filter(
            (finding) => finding.severity === "critical" || finding.severity === "major",
          );
          const verifiedFindings: AiReviewAnalysis["findings"][number][] = [];
          for (const candidate of important) {
            const relevant = batches.filter(
              (batch) => !candidate.filePath || batch.paths.includes(candidate.filePath),
            );
            // Verify each candidate independently so an early large file cannot consume
            // the evidence budget for findings in later files.
            const evidence = relevant.map((batch) => batch.patch).join("\n");
            const verified = yield* ask(
              `Verify this candidate finding. Return only claims supported by evidence; remove disproven or uncertain claims. PR context:\n${context}\nCandidate:\n${json(candidate)}\nEvidence${evidence.length > 90_000 ? " (bounded; use the isolated checkout when available)" : ""}:\n${evidence.slice(0, 90_000)}`,
            );
            verifiedFindings.push(...verified.findings);
          }
          findings = consolidateFindings([
            ...findings.filter(
              (finding) => finding.severity !== "critical" && finding.severity !== "major",
            ),
            ...verifiedFindings,
          ]);
        }
        yield* update({ stage: "consolidating", progress: "Preparing the local review draft" });
        yield* update({
          stage: "draft",
          progress: "Ready for human review. Nothing has been published.",
          filesAnalyzed: new Set(batches.flatMap((batch) => batch.paths)).size,
          analysis: {
            summary: results.map((result) => result.summary).join("\n\n"),
            risk: results.some((result) => result.risk === "high")
              ? "high"
              : results.some((result) => result.risk === "medium")
                ? "medium"
                : results.some((result) => result.risk === "unknown")
                  ? "unknown"
                  : "low",
            walkthrough: results.flatMap((result) => result.walkthrough),
            findings,
          },
        });
      }),
    ).pipe(
      Effect.catch((error) =>
        update({
          stage: "failed",
          progress: isHubError(error)
            ? error.message
            : "Review failed. Check the agent and repository access.",
        }),
      ),
      Effect.onInterrupt(() =>
        update({ stage: "cancelled", progress: "Review cancelled. Nothing has been published." }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          active.delete(initial.id);
          liveSnapshots.delete(initial.id);
        }),
      ),
    );
  });
  return PullRequestReviewService.of({
    history,
    changes: Stream.fromPubSub(changes),
    start: (input) =>
      gate
        .withPermit(
          Effect.gen(function* () {
            if (active.size >= 2)
              return yield* new SourceControlHubError({
                message: "Two reviews are already running in this environment.",
              });
            const now = yield* Clock.currentTimeMillis;
            const run: AiReviewRun = {
              ...input,
              id: `${now}-${yield* crypto.randomUUIDv4}`,
              baseSha: "",
              headSha: "",
              comparisonBaseSha: "",
              createdAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
              updatedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
              stage: "collecting",
              progress: "Loading PR context",
              analysis: null,
              dismissedIds: [],
              publishedIds: [],
              summaryPublished: false,
              warnings: [],
              filesAnalyzed: 0,
              durationMs: 0,
            };
            yield* write(run);
            const fiber = yield* execute(run).pipe(Effect.ignore, Effect.forkIn(scope));
            active.set(run.id, fiber);
            return run;
          }),
        )
        .pipe(Effect.mapError(failure)),
    cancel: (id) =>
      Effect.gen(function* () {
        const fiber = active.get(id);
        if (!fiber) return;
        const before = yield* read(id);
        if (finished(before)) {
          yield* Fiber.await(fiber);
          return;
        }
        yield* Fiber.interrupt(fiber);
        const after = yield* read(id);
        if (!finished(after))
          yield* write({
            ...after,
            stage: "cancelled",
            progress: "Review cancelled. Nothing has been published.",
          });
      }),
    edit: (input) =>
      gate.withPermit(
        Effect.gen(function* () {
          const run = yield* read(input.id);
          if (run.stage !== "draft" || !run.analysis)
            return yield* new SourceControlHubError({
              message: "Only a completed draft can be edited.",
            });
          return yield* write({
            ...run,
            analysis: { ...run.analysis, findings: input.findings, summary: input.summary },
            dismissedIds: input.dismissedIds,
          });
        }),
      ),
    publish: (input) =>
      gate.withPermit(
        Effect.gen(function* () {
          const run = yield* read(input.id);
          if (run.stage !== "draft" || !run.analysis)
            return yield* new SourceControlHubError({
              message: "Only a completed draft can be published.",
            });
          if (run.publicationUncertain)
            return yield* new SourceControlHubError({
              message:
                "A previous publication did not return a confirmed outcome. Inspect PR activity before preparing a new review; this draft will not retry and risk duplicate comments.",
            });
          const selected = selectedDraftFindings({
            findings: run.analysis.findings,
            findingIds: input.findingIds,
            dismissedIds: run.dismissedIds,
            publishedIds: run.publishedIds,
          });
          const browser = yield* hub.browser(run.reference.provider);
          const current = yield* browser.revisions(run.reference);
          if (current.headSha !== run.headSha || current.baseSha !== run.baseSha)
            return yield* new SourceControlHubError({
              message:
                "PR changed since this review was generated. Run a new review before publishing.",
            });
          let comparison = selected.some((finding) => finding.filePath && finding.line)
            ? yield* browser.compare({
                ...run.reference,
                baseSha: run.baseSha,
                headSha: run.headSha,
                mode: "full",
              })
            : { patch: "", truncated: false };
          if (comparison.truncated) comparison = yield* localComparison(run, run.baseSha, "full");
          const positions = reviewLinePositions(comparison.patch);
          for (const finding of selected) {
            if (
              finding.filePath &&
              finding.line &&
              !positions.get(finding.filePath)?.has(finding.line)
            )
              return yield* new SourceControlHubError({
                message: `The location for “${finding.title}” is not in the PR diff. Edit or dismiss that finding before publishing.`,
              });
          }
          const general = selected.filter((finding) => !finding.filePath || !finding.line);
          const includeSummary = input.includeSummary && !run.summaryPublished;
          if (!selected.length && !includeSummary)
            return yield* new SourceControlHubError({
              message: "Select at least one unpublished finding or summary.",
            });
          // Persist the attempt before network I/O: an interrupted multi-comment
          // publication cannot be retried blindly after the environment restarts.
          yield* write({ ...run, publicationUncertain: true });
          yield* prs.review({
            ...run.reference,
            expectedHeadSha: run.headSha,
            verdict: "comment",
            body: [
              includeSummary ? `## AI-assisted review\n\n${run.analysis.summary}` : "",
              ...general.map(
                (finding) => `### ${finding.severity}: ${finding.title}\n\n${finding.description}`,
              ),
            ]
              .filter(Boolean)
              .join("\n\n"),
            comments: selected.flatMap((finding) =>
              finding.filePath && finding.line
                ? [
                    {
                      path: finding.filePath,
                      position: positions.get(finding.filePath)!.get(finding.line)!,
                      body: `**${finding.severity}: ${finding.title}**\n\n${finding.description}${finding.suggestedFix ? `\n\nSuggested fix:\n${finding.suggestedFix}` : ""}`,
                    },
                  ]
                : [],
            ),
          });
          return yield* write({
            ...run,
            publicationUncertain: false,
            publishedIds: [...run.publishedIds, ...selected.map((finding) => finding.id)],
            summaryPublished: run.summaryPublished || includeSummary,
          });
        }),
      ),
  });
});
export const layer = Layer.effect(PullRequestReviewService, make);
