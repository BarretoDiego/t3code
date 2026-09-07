import type { CodeViewHandle } from "@pierre/diffs/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CodeViewItem, DiffLineAnnotation, SelectedLineRange } from "@pierre/diffs";
import type {
  EnvironmentId,
  PullRequestReviewCommentDraft,
  PullRequestReviewThread,
  PullRequestReviewVerdict,
  PullRequestMergeMethod,
  RemotePullRequestRef,
} from "@t3tools/contracts";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useTheme } from "../../hooks/useTheme";
import {
  buildFileDiffRenderKey,
  getRenderablePatch,
  resolveFileDiffPath,
  resolveFileDiffPreviousPath,
  resolveDiffThemeName,
} from "../../lib/diffRendering";
import { resolveDiffReviewPosition } from "../../reviewCommentContext";
import { StyledDiffCodeView } from "../diffs/StyledDiffCodeView";
import { DiffFileTree } from "../diffs/DiffFileTree";
import { diffFileTreeEntries } from "../diffs/diffFileTree.logic";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogClose,
} from "../ui/alert-dialog";
import { HubSelect } from "./HubSelect";
import { AiReviewPanel } from "./AiReviewPanel";
import { useHubQuery } from "./useHubQuery";

export function RemotePullRequestPanel({
  environmentId,
  reference,
  onClose,
  onOpenReviewPanel,
  refreshKey = 0,
}: {
  environmentId: EnvironmentId;
  reference: RemotePullRequestRef;
  onClose: () => void;
  onOpenReviewPanel?: () => void;
  refreshKey?: number;
}) {
  const detail = useHubQuery(serverEnvironment.sourceControlHubPullRequest, {
    environmentId,
    input: reference,
  });
  const revisions = useHubQuery(serverEnvironment.sourceControlHubRevisions, {
    environmentId,
    input: reference,
  });
  const activity = useHubQuery(serverEnvironment.sourceControlHubActivity, {
    environmentId,
    input: reference,
  });
  const refresh = useAtomCommand(serverEnvironment.sourceControlHubRefresh);
  const review = useAtomCommand(serverEnvironment.sourceControlHubSubmitReview);
  const merge = useAtomCommand(serverEnvironment.sourceControlHubMerge);
  const [tab, setTab] = useState<"overview" | "changes" | "commits" | "review" | "activity">(
    "overview",
  );
  const [reviewVisited, setReviewVisited] = useState(false);
  const [file, setFile] = useState<string | null>(null);
  const [line, setLine] = useState<number | undefined>();
  const [diffRevision, setDiffRevision] = useState(0);
  const [body, setBody] = useState("");
  const [draftHeadSha, setDraftHeadSha] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<PullRequestReviewVerdict>("comment");
  const [comments, setComments] = useState<PullRequestReviewCommentDraft[]>([]);
  const [confirmation, setConfirmation] = useState<"merge" | "review" | null>(null);
  const [method, setMethod] = useState<PullRequestMergeMethod>("squash");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pr = detail.data;
  const reload = async () => {
    await refresh({ environmentId, input: {} });
    detail.refresh();
    activity.refresh();
    revisions.refresh();
    setDiffRevision((value) => value + 1);
  };
  const refreshDetail = detail.refresh,
    refreshActivity = activity.refresh,
    refreshRevisions = revisions.refresh;
  useEffect(() => {
    if (refreshKey > 0) {
      refreshDetail();
      refreshActivity();
      refreshRevisions();
    }
  }, [refreshKey, refreshDetail, refreshActivity, refreshRevisions]);
  const mergeMethods =
    pr?.capabilities.mergeMethods.filter((method) => pr.mergeCapabilities[method]) ?? [];
  const effectiveMethod = mergeMethods.includes(method) ? method : mergeMethods[0];
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="space-y-3 border-b p-4 sm:p-6">
        <div className="flex flex-wrap justify-between gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            ← Repository
          </Button>
          {onOpenReviewPanel && (
            <Button variant="outline" size="sm" onClick={onOpenReviewPanel}>
              Open review panel
            </Button>
          )}
          <Button variant="outline" size="sm" disabled={pending} onClick={() => void reload()}>
            Refresh
          </Button>
        </div>
        <h1 className="break-words text-lg font-semibold">
          #{reference.number} {pr?.title}
        </h1>
        <p className="break-all text-xs text-muted-foreground">
          {pr
            ? `${pr.headBranch} → ${pr.baseBranch} · ${pr.isDraft ? "Draft" : pr.state} · ${pr.changedFiles} files · +${pr.additions} −${pr.deletions}`
            : "Loading pull request…"}
        </p>
        <div className="flex flex-wrap gap-1">
          {(["overview", "changes", "commits", "review", "activity"] as const).map((value) => (
            <Button
              key={value}
              size="sm"
              variant={tab === value ? "secondary" : "ghost"}
              onClick={() => {
                setTab(value);
                if (value === "review") setReviewVisited(true);
              }}
              className="capitalize"
            >
              {value}
            </Button>
          ))}
        </div>
        {(error || detail.error) && (
          <p role="alert" className="text-sm text-destructive">
            {error ?? detail.error}
          </p>
        )}
      </header>
      {reviewVisited && (
        <div className={tab === "review" ? "min-h-0 flex-1 overflow-auto" : "hidden"}>
          <AiReviewPanel
            environmentId={environmentId}
            reference={reference}
            onFinding={(path, line) => {
              setFile(path);
              setLine(line);
              setTab("changes");
            }}
          />
        </div>
      )}
      {tab === "review" ? null : tab === "changes" ? (
        <RemoteDiff
          selectedLine={line}
          key={`${reference.repository}:${reference.number}:${diffRevision}:${refreshKey}`}
          environmentId={environmentId}
          reference={reference}
          threads={activity.data?.reviewThreads ?? []}
          selectedPath={file}
          onSelectPath={setFile}
          canComment={
            !!revisions.data &&
            pr?.capabilities.review.inlineComment === true &&
            pr.viewerPermissions.comment
          }
          onComment={(comment) => {
            setDraftHeadSha((current) => current ?? revisions.data?.headSha ?? null);
            setComments((current) => [...current, comment]);
          }}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="space-y-5 p-4 sm:p-6">
            {tab === "overview" && pr && (
              <>
                <p className="whitespace-pre-wrap break-words text-sm">
                  {pr.body || "No description."}
                </p>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                  <dt className="text-muted-foreground">Author</dt>
                  <dd>{pr.author?.login ?? "Unknown"}</dd>
                  <dt className="text-muted-foreground">Reviewers</dt>
                  <dd>{pr.reviewers.map((reviewer) => reviewer.login).join(", ") || "None"}</dd>
                  <dt className="text-muted-foreground">Mergeability</dt>
                  <dd>{pr.mergeability}</dd>
                  <dt className="text-muted-foreground">Created</dt>
                  <dd>{pr.createdAt}</dd>
                  <dt className="text-muted-foreground">Updated</dt>
                  <dd>{pr.updatedAt}</dd>
                </dl>
                <section className="space-y-2">
                  <h2 className="font-medium">Checks</h2>
                  {pr.checks.length ? (
                    pr.checks.map((check) => (
                      <p key={check.url ?? check.name} className="text-sm">
                        {check.name} · {check.status}
                      </p>
                    ))
                  ) : (
                    <p className="text-sm text-muted-foreground">No checks reported.</p>
                  )}
                </section>
                {pr.viewerPermissions.actions.includes("merge") &&
                  pr.capabilities.actions.includes("merge") &&
                  effectiveMethod && (
                    <div className="flex flex-wrap gap-2">
                      <HubSelect
                        label="Merge strategy"
                        value={effectiveMethod}
                        options={mergeMethods.map((method) => ({ value: method, label: method }))}
                        onChange={setMethod}
                      />
                      <Button
                        disabled={pr.state !== "open" || pr.isDraft || pending}
                        onClick={() => setConfirmation("merge")}
                      >
                        Merge pull request
                      </Button>
                    </div>
                  )}
              </>
            )}
            {tab === "commits" &&
              activity.data?.commits.map((commit) => (
                <article key={commit.oid} className="space-y-2 rounded-lg border p-4">
                  <p className="whitespace-pre-wrap break-words text-sm">
                    {commit.messageHeadline}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {commit.oid.slice(0, 10)} · {commit.committedDate}
                  </p>
                </article>
              ))}
            {tab === "activity" && (
              <>
                {activity.error && <p role="alert">{activity.error}</p>}
                {activity.data?.commentsTruncated && (
                  <p className="text-sm text-muted-foreground">
                    Showing a bounded activity snapshot ({activity.data.comments.length} of{" "}
                    {activity.data.commentCount} comments).
                  </p>
                )}
                {activity.data?.comments.map((comment) => (
                  <article
                    key={`${comment.kind}:${comment.id}`}
                    className="space-y-2 rounded-lg border p-4"
                  >
                    <p className="text-xs text-muted-foreground">
                      {comment.author?.login ?? "Unknown"} · {comment.createdAt}{" "}
                      {comment.reviewState}
                    </p>
                    <p className="whitespace-pre-wrap break-words text-sm">{comment.body}</p>
                    {comment.path && (
                      <Button
                        size="xs"
                        variant="link"
                        onClick={() => {
                          setFile(comment.path);
                          setTab("changes");
                        }}
                      >
                        {comment.path}
                      </Button>
                    )}
                  </article>
                ))}
              </>
            )}
          </div>
        </div>
      )}
      {pr && tab !== "review" && pr.viewerPermissions.verdicts.length > 0 && (
        <details className="shrink-0 border-t p-3">
          <summary className="cursor-pointer text-sm">
            Manual review {comments.length ? `· ${comments.length} draft inline comments` : ""}
          </summary>
          <div className="max-h-64 space-y-3 overflow-auto pt-3">
            {draftHeadSha && revisions.data && draftHeadSha !== revisions.data.headSha && (
              <p role="alert" className="text-sm text-destructive">
                The PR changed after this draft started. Inspect the new diff and discard this
                outdated draft before publishing.
              </p>
            )}
            <Textarea
              aria-label="Review comment"
              disabled={!revisions.data}
              rows={3}
              placeholder="Write a general review comment…"
              value={body}
              onChange={(event) => {
                setBody(event.target.value);
                setDraftHeadSha((current) => current ?? revisions.data?.headSha ?? null);
              }}
            />
            {comments.map((comment) => (
              <div
                key={`${comment.path}:${JSON.stringify(comment.position)}:${comment.body}`}
                className="flex gap-2 text-xs"
              >
                <span className="min-w-0 flex-1 break-words">
                  {comment.path}: {comment.body}
                </span>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() =>
                    setComments((current) => current.filter((item) => item !== comment))
                  }
                >
                  Remove
                </Button>
              </div>
            ))}
            <div className="flex flex-wrap gap-2">
              <HubSelect
                label="Review verdict"
                value={verdict}
                options={pr.capabilities.review.verdicts
                  .filter((verdict) => pr.viewerPermissions.verdicts.includes(verdict))
                  .map((verdict) => ({ value: verdict, label: verdict }))}
                onChange={setVerdict}
              />
              <Button
                variant="ghost"
                disabled={pending}
                onClick={() => {
                  setBody("");
                  setComments([]);
                  setDraftHeadSha(null);
                }}
              >
                Discard draft
              </Button>
              <Button
                disabled={pending || (verdict !== "approve" && !body.trim() && !comments.length)}
                onClick={() => setConfirmation("review")}
              >
                Publish manual review
              </Button>
            </div>
          </div>
        </details>
      )}
      {confirmation && pr && (
        <AlertDialog
          open
          onOpenChange={(open) => {
            if (!open && !pending) setConfirmation(null);
          }}
        >
          <AlertDialogPopup>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {confirmation === "merge" ? "Merge pull request" : "Publish manual review"}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {confirmation === "merge"
                  ? `${pr.headBranch} → ${pr.baseBranch}. Strategy: ${effectiveMethod}. Mergeability: ${pr.mergeability}. Checks: ${pr.checks.map((check) => `${check.name}: ${check.status}`).join(", ") || "None reported"}. Reviewers: ${pr.reviewers.map((reviewer) => reviewer.login).join(", ") || "None"}.`
                  : `${verdict}: ${comments.length} inline comments${body.trim() ? " and one summary" : ""}. This publishes to your source control account.`}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="outline" disabled={pending} />}>
                Cancel
              </AlertDialogClose>
              <Button
                disabled={pending || !revisions.data}
                onClick={async () => {
                  if (!revisions.data) return;
                  setPending(true);
                  setError(null);
                  try {
                    const result =
                      confirmation === "merge" && effectiveMethod
                        ? await merge({
                            environmentId,
                            input: {
                              ...reference,
                              expectedHeadSha: revisions.data.headSha,
                              method: effectiveMethod,
                            },
                          })
                        : await review({
                            environmentId,
                            input: {
                              ...reference,
                              expectedHeadSha: draftHeadSha ?? revisions.data.headSha,
                              verdict,
                              body,
                              comments,
                            },
                          });
                    if (result._tag === "Success") {
                      setConfirmation(null);
                      setBody("");
                      setComments([]);
                      setDraftHeadSha(null);
                      await reload();
                    } else {
                      setConfirmation(null);
                      setError(
                        "Operation failed. Refresh to check permissions, checks, and whether the PR head changed.",
                      );
                    }
                  } finally {
                    setPending(false);
                  }
                }}
              >
                Confirm {confirmation === "merge" ? "merge" : "publication"}
              </Button>
            </AlertDialogFooter>
          </AlertDialogPopup>
        </AlertDialog>
      )}
    </section>
  );
}

function RemoteDiff({
  environmentId,
  reference,
  threads,
  selectedPath,
  selectedLine,
  onSelectPath,
  canComment,
  onComment,
}: {
  environmentId: EnvironmentId;
  reference: RemotePullRequestRef;
  threads: readonly PullRequestReviewThread[];
  selectedPath: string | null;
  selectedLine?: number | undefined;
  onSelectPath: (path: string | null) => void;
  canComment: boolean;
  onComment: (comment: PullRequestReviewCommentDraft) => void;
}) {
  const [cursor, setCursor] = useState<string | undefined>();
  const query = useHubQuery(serverEnvironment.sourceControlHubDiff, {
    environmentId,
    input: { ...reference, ...(cursor ? { cursor } : {}) },
  });
  const [layout, setLayout] = useState<"split" | "unified">("split");
  const [draft, setDraft] = useState<Omit<PullRequestReviewCommentDraft, "body"> | null>(null);
  const [body, setBody] = useState("");
  const { resolvedTheme } = useTheme();
  const parsed = useMemo(
    () =>
      getRenderablePatch(
        query.data?.patch,
        `hub:${reference.repository}:${reference.number}:${cursor ?? "first"}`,
      ),
    [query.data?.patch, reference.repository, reference.number, cursor],
  );
  const files = parsed?.kind === "files" ? parsed.files : [];
  const selected = selectedPath
    ? files.find((file) => resolveFileDiffPath(file) === selectedPath)
    : files[0];
  const viewer = useRef<CodeViewHandle<PullRequestReviewThread>>(null);
  const selectedId = selected ? buildFileDiffRenderKey(selected) : null;
  const nextCursor = query.data?.nextCursor;
  useEffect(() => {
    // Follow a remote page receipt to locate the requested finding without loading every file.
    // eslint-disable-next-line react/set-state-in-effect
    if (selectedPath && !selectedId && nextCursor && nextCursor !== cursor) setCursor(nextCursor);
  }, [selectedPath, selectedId, nextCursor, cursor]);
  useEffect(() => {
    if (selectedId && selectedLine)
      viewer.current?.scrollTo({
        type: "line",
        id: selectedId,
        lineNumber: selectedLine,
        side: "additions",
        align: "center",
      });
  }, [selectedId, selectedLine]);
  const items = useMemo(
    () =>
      selected
        ? [
            {
              id: buildFileDiffRenderKey(selected),
              type: "diff" as const,
              fileDiff: selected,
              annotations: threads
                .filter(
                  (thread) =>
                    !thread.isOutdated &&
                    thread.line &&
                    thread.path === resolveFileDiffPath(selected),
                )
                .map((thread) => ({
                  lineNumber: thread.line!,
                  side: thread.side === "right" ? ("additions" as const) : ("deletions" as const),
                  metadata: thread,
                })),
            },
          ]
        : [],
    [selected, threads],
  );
  const beginComment = (
    range: SelectedLineRange | null,
    context: { item: CodeViewItem<PullRequestReviewThread> },
  ) => {
    if (!range || !selected || context.item.type !== "diff" || !canComment) return;
    const position = resolveDiffReviewPosition(selected, range.end, range.endSide ?? range.side);
    if (position) {
      setDraft({
        path: resolveFileDiffPath(selected),
        oldPath: resolveFileDiffPreviousPath(selected),
        position,
      });
      setBody("");
    }
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b p-3">
        <HubSelect
          label="Diff layout"
          value={layout}
          options={[
            { value: "split", label: "Side by side" },
            { value: "unified", label: "Inline" },
          ]}
          onChange={setLayout}
        />
        {selected && (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => void navigator.clipboard.writeText(resolveFileDiffPath(selected))}
          >
            Copy path
          </Button>
        )}
        {query.data?.nextCursor && (
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              onSelectPath(null);
              setCursor(query.data?.nextCursor ?? undefined);
            }}
          >
            Next files
          </Button>
        )}
        {cursor && (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              onSelectPath(null);
              setCursor(undefined);
            }}
          >
            First files
          </Button>
        )}
        {query.data?.truncated && (
          <p className="text-xs text-muted-foreground">
            Some file content was omitted by the provider.
          </p>
        )}
      </div>
      {query.error && (
        <p role="alert" className="p-4 text-sm text-destructive">
          {query.error}
        </p>
      )}
      {query.pending && <p className="p-4 text-sm">Loading changes…</p>}
      {!query.pending && selectedPath && !selected && !nextCursor && (
        <p role="status" className="p-4 text-sm">
          {selectedPath} is not available in this diff. Refresh the PR to check whether it changed.
        </p>
      )}
      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-56 shrink-0 border-r lg:block">
          <DiffFileTree
            ariaLabel="Pull request files"
            entries={diffFileTreeEntries(files)}
            selectedPath={selected ? resolveFileDiffPath(selected) : null}
            onSelectFile={onSelectPath}
          />
        </aside>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="shrink-0 p-2 lg:hidden">
            <HubSelect
              label="Changed file"
              value={selected ? resolveFileDiffPath(selected) : ""}
              options={files.map((file) => ({
                value: resolveFileDiffPath(file),
                label: resolveFileDiffPath(file),
              }))}
              onChange={onSelectPath}
            />
          </div>
          {parsed?.kind === "raw" ? (
            <pre className="min-h-0 flex-1 overflow-auto p-4 text-xs">{query.data?.patch}</pre>
          ) : (
            <StyledDiffCodeView<PullRequestReviewThread>
              viewerRef={viewer}
              selectedLines={
                selectedId && selectedLine
                  ? {
                      id: selectedId,
                      range: { start: selectedLine, end: selectedLine, side: "additions" },
                    }
                  : null
              }
              className="h-full min-h-0 flex-1 overflow-auto"
              items={items}
              options={{
                diffStyle: layout,
                theme: resolveDiffThemeName(resolvedTheme),
                themeType: resolvedTheme,
                enableGutterUtility: canComment,
                enableLineSelection: canComment,
                onGutterUtilityClick: beginComment,
                onLineSelectionEnd: beginComment,
              }}
              renderAnnotation={(annotation: DiffLineAnnotation<PullRequestReviewThread>) => (
                <div className="space-y-2 rounded-md border bg-background p-3 font-sans text-sm text-foreground">
                  {annotation.metadata.comments.map((comment) => (
                    <p key={comment.id} className="whitespace-pre-wrap">
                      <strong>{comment.author?.login ?? "Reviewer"}</strong>: {comment.body}
                    </p>
                  ))}
                </div>
              )}
            />
          )}
        </div>
      </div>
      {draft && (
        <div className="shrink-0 space-y-2 border-t p-3">
          <p className="break-all text-xs">Draft comment · {draft.path}</p>
          <Textarea
            aria-label="Inline comment"
            rows={3}
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={!body.trim()}
              onClick={() => {
                onComment({ ...draft, body });
                setDraft(null);
              }}
            >
              Add to manual review
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
