import { ReviewRunStatus } from "./ReviewRunStatus";
import { ReviewActivityTimeline } from "./ReviewActivityTimeline";
import { resolveAgentProfile } from "@t3tools/shared/agentProfiles";
import { useEffect, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import type {
  AiReviewFinding,
  AiReviewRun,
  AiReviewTier,
  EnvironmentId,
  RemotePullRequestRef,
  MiniSkillId,
} from "@t3tools/contracts";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { Checkbox } from "../ui/checkbox";
import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogClose,
} from "../ui/alert-dialog";
import { useHubQuery } from "./useHubQuery";
import { HubSelect } from "./HubSelect";

export function AiReviewPanel({
  environmentId,
  reference,
  onFinding,
}: {
  environmentId: EnvironmentId;
  reference: RemotePullRequestRef;
  onFinding?: (path: string, line: number | undefined, finding: AiReviewFinding) => void;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? [];
  const history = useHubQuery(serverEnvironment.sourceControlHubReviewHistory, {
    environmentId,
    input: reference,
  });
  const clones = useHubQuery(serverEnvironment.sourceControlHubClones, {
    environmentId,
    input: {},
  });
  const update = useEnvironmentQuery(
    serverEnvironment.sourceControlHubReviewChanges({ environmentId, input: {} }),
  );
  const [tier, setTier] = useState<AiReviewTier>(settings.sourceControlReview.tier);
  const [mode, setMode] = useState<"full" | "incremental">("full");
  const [scope, setScope] = useState<"metadata" | "commits" | "changed-files" | "full-context">(
    "changed-files",
  );
  const [instanceId, setInstanceId] = useState("");
  const [model, setModel] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [profileId, setProfileId] = useState<string>(settings.sourceControlReview.profileId ?? "");
  const [projectId, setProjectId] = useState("");
  const [skills, setSkills] = useState<MiniSkillId[]>([]);
  const [runId, setRunId] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [threshold, setThreshold] = useState(settings.sourceControlReview.severityThreshold);
  const [group, setGroup] = useState<"severity" | "filePath" | "category">("severity");
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [preview, setPreview] = useState(false);
  const [summary, setSummary] = useState(true);
  const [pending, setPending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = useAtomCommand(serverEnvironment.sourceControlHubReviewStart);
  const edit = useAtomCommand(serverEnvironment.sourceControlHubReviewEdit);
  const publish = useAtomCommand(serverEnvironment.sourceControlHubReviewPublish);
  const cancel = useAtomCommand(serverEnvironment.sourceControlHubReviewCancel);
  const provider =
    providers.find((item) => item.instanceId === instanceId) ??
    providers.find((item) => item.enabled);
  const selectedModel =
    provider?.models.find((item) => item.slug === model) ??
    provider?.models.find((item) => item.isDefault) ??
    provider?.models[0];
  const efforts = selectedModel?.capabilities?.optionDescriptors?.find(
    (option) => option.id === "reasoningEffort",
  );
  const selectedProfile = settings.agentProfiles.find(
    (profile) => profile.id === profileId && profile.enabled,
  );
  const resolvedProfile =
    selectedProfile && provider && selectedModel
      ? resolveAgentProfile({
          profile: selectedProfile,
          instanceId: provider.instanceId,
          availableModelSlugs: provider.models.map((model) => model.slug),
          currentModelSelection: { instanceId: provider.instanceId, model: selectedModel.slug },
          currentReasoningEffort: reasoning || null,
          getSupportedReasoningEfforts: (slug) => {
            const option = provider.models
              .find((model) => model.slug === slug)
              ?.capabilities?.optionDescriptors?.find((option) => option.id === "reasoningEffort");
            return option?.type === "select" ? option.options.map((item) => item.id) : null;
          },
          defaultWrapper: settings.agentProfileDefaultWrapper,
          knownMiniSkillIds: settings.miniSkills.map((skill) => skill.id),
        })
      : undefined;
  const localClones =
    clones.data?.filter(
      (clone) =>
        clone.provider === reference.provider &&
        clone.host === reference.host &&
        clone.repository.toLowerCase() === reference.repository.toLowerCase(),
    ) ?? [];
  const localClone = localClones.find((clone) => clone.projectId === projectId) ?? localClones[0];
  const persistedRun = history.data?.find((run) => run.id === runId) ?? history.data?.[0];
  const matchesUpdate =
    update.data?.reference.provider === reference.provider &&
    update.data.reference.host === reference.host &&
    update.data.reference.repository === reference.repository &&
    update.data.reference.number === reference.number;
  const run =
    matchesUpdate &&
    update.data &&
    update.data.id === (runId || persistedRun?.id) &&
    (!persistedRun || update.data.updatedAt >= persistedRun.updatedAt)
      ? update.data
      : persistedRun;
  const needsClone =
    scope !== "metadata" &&
    scope !== "commits" &&
    (tier === "deep" || tier === "exhaustive" || scope === "full-context");
  const ready = run?.stage === "draft";
  const refreshHistory = history.refresh;
  useEffect(() => {
    if (
      update.data?.reference.provider === reference.provider &&
      update.data.reference.host === reference.host &&
      update.data.reference.repository === reference.repository &&
      update.data.reference.number === reference.number &&
      ["draft", "failed", "cancelled"].includes(update.data.stage)
    )
      refreshHistory();
  }, [
    update.data,
    reference.provider,
    reference.host,
    reference.repository,
    reference.number,
    refreshHistory,
  ]);
  const saveFinding = async (next: AiReviewRun) => {
    if (!next.analysis) return;
    setPending(true);
    try {
      const result = await edit({
        environmentId,
        input: {
          id: next.id,
          findings: next.analysis.findings,
          summary: next.analysis.summary,
          dismissedIds: next.dismissedIds,
        },
      });
      if (result._tag === "Success") {
        setEditing(null);
        history.refresh();
      } else setError("Could not save this draft.");
    } finally {
      setPending(false);
    }
  };
  const findings = run?.analysis?.findings ?? [];
  const publishable = findings.filter(
    (finding) =>
      selected.includes(finding.id) &&
      !run?.dismissedIds.includes(finding.id) &&
      !run?.publishedIds.includes(finding.id),
  );
  const groups = new Map<string, AiReviewFinding[]>();
  const severityRank = { critical: 0, major: 1, minor: 2, suggestion: 3, info: 4 };
  for (const finding of findings.filter(
    (finding) => severityRank[finding.severity] <= severityRank[threshold],
  )) {
    const key = finding[group] ?? "General";
    groups.set(key, [...(groups.get(key) ?? []), finding]);
  }
  return (
    <div className="w-full min-w-0 space-y-4 p-4">
      <header>
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          AI-assisted review
        </p>
        <h2 className="mt-1 text-lg font-semibold">Inspect first. Publish when ready.</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Follow the agent's activity, review its findings, and choose which comments to publish.
        </p>
      </header>
      <details open={!run} className="group rounded-lg border bg-muted/10">
        <summary className="flex cursor-pointer items-center justify-between gap-3 px-4 py-3 text-sm font-medium">
          <span>Review setup</span>
          <span className="truncate text-xs font-normal capitalize text-muted-foreground">
            {tier} ·{" "}
            {settings.agentProfiles.find((profile) => profile.id === profileId)?.name ??
              "Custom agent"}
          </span>
        </summary>
        <div className="space-y-4 border-t p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <HubSelect
              showLabel
              label="Review tier"
              value={tier}
              options={["quick", "standard", "deep", "exhaustive"].map((value) => ({
                value: value as AiReviewTier,
                label: `${value[0]?.toUpperCase()}${value.slice(1)}`,
              }))}
              onChange={(value) => {
                setTier(value);
                setScope(
                  value === "deep" || value === "exhaustive" ? "full-context" : "changed-files",
                );
              }}
            />
            <HubSelect
              showLabel
              label="Review mode"
              value={mode}
              options={[
                { value: "full", label: "Full review" },
                { value: "incremental", label: "Incremental review" },
              ]}
              onChange={setMode}
            />
            <HubSelect
              showLabel
              label="Scope"
              value={scope}
              options={[
                { value: "metadata", label: "PR metadata only" },
                { value: "commits", label: "Commit messages" },
                { value: "changed-files", label: "Changed files" },
                { value: "full-context", label: "Full context" },
              ]}
              onChange={setScope}
            />
            <HubSelect
              showLabel
              label="Agent profile"
              value={profileId}
              options={[
                { value: "", label: "Custom" },
                ...settings.agentProfiles
                  .filter((profile) => profile.enabled)
                  .map((profile) => ({
                    value: profile.id,
                    label: profile.name,
                  })),
              ]}
              onChange={setProfileId}
            />
            <HubSelect
              showLabel
              label="Agent harness"
              value={provider?.instanceId ?? ""}
              options={providers
                .filter((provider) => provider.enabled)
                .map((provider) => ({
                  value: provider.instanceId,
                  label: provider.displayName ?? provider.driver,
                }))}
              onChange={(value) => {
                setInstanceId(value);
                setModel("");
                setReasoning("");
              }}
            />
            <HubSelect
              showLabel
              label="Model"
              value={selectedModel?.slug ?? ""}
              options={
                provider?.models.map((model) => ({ value: model.slug, label: model.name })) ?? []
              }
              onChange={setModel}
            />
            {efforts?.type === "select" && (
              <HubSelect
                showLabel
                label="Reasoning effort"
                value={reasoning}
                options={[
                  { value: "", label: "Default reasoning" },
                  ...efforts.options.map((option) => ({ value: option.id, label: option.label })),
                ]}
                onChange={setReasoning}
              />
            )}
            {needsClone && (
              <HubSelect
                showLabel
                label="Local clone for review worktree"
                value={localClone?.projectId ?? ""}
                options={localClones.map((clone) => ({
                  value: clone.projectId,
                  label: clone.title,
                }))}
                onChange={setProjectId}
              />
            )}
          </div>
          {resolvedProfile && (
            <p className="text-sm text-muted-foreground">
              {resolvedProfile.status === "unavailable"
                ? resolvedProfile.reason
                : `Resolved: ${provider?.displayName ?? provider?.driver} · ${resolvedProfile.modelSelection.model} · reasoning ${resolvedProfile.diagnostics.requestedReasoningEffort ?? "default"} · ${new Set([...resolvedProfile.miniSkillIds, ...skills]).size} Mini Skills`}
            </p>
          )}
          <details>
            <summary className="cursor-pointer text-sm">Request Mini Skills</summary>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {settings.miniSkills.map((skill) => (
                <label key={skill.id} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={skills.includes(skill.id)}
                    onCheckedChange={(checked) =>
                      setSkills((current) =>
                        checked ? [...current, skill.id] : current.filter((id) => id !== skill.id),
                      )
                    }
                  />
                  {skill.name}
                </label>
              ))}
            </div>
          </details>
          <p className="text-xs text-muted-foreground">
            {tier === "quick"
              ? "Sampled diffs and metadata for quick triage."
              : tier === "standard"
                ? "Changed-file batches and a verification pass for important findings."
                : "Read-only agent investigation in a separate checkout of the PR head."}{" "}
            Results stay in a local draft.
          </p>
          <Button
            disabled={
              pending ||
              !provider ||
              !selectedModel ||
              resolvedProfile?.status === "unavailable" ||
              (needsClone && !localClone)
            }
            onClick={async () => {
              if (!provider || !selectedModel || pending) return;
              setPending(true);
              setError(null);
              try {
                const profile = settings.agentProfiles.find((profile) => profile.id === profileId);
                const result = await start({
                  environmentId,
                  input: {
                    reference,
                    tier,
                    mode,
                    scope,
                    agent: {
                      modelSelection: {
                        instanceId: provider.instanceId,
                        model: selectedModel.slug,
                        ...(reasoning
                          ? { options: [{ id: "reasoningEffort", value: reasoning }] }
                          : {}),
                      },
                      ...(profile ? { profileId: profile.id } : {}),
                      miniSkillIds: skills,
                    },
                    ...(localClone ? { projectId: localClone.projectId } : {}),
                    includeGenerated: settings.sourceControlReview.includeGenerated,
                    includeExistingComments: settings.sourceControlReview.includeExistingComments,
                  },
                });
                if (result._tag === "Success") {
                  setRunId(result.value.id);
                  setSelected([]);
                  history.refresh();
                } else setError("Could not start this review.");
              } finally {
                setPending(false);
              }
            }}
          >
            Run AI review
          </Button>
        </div>
      </details>
      {(error || history.error) && (
        <p role="alert" className="text-sm text-destructive">
          {error ?? history.error}
        </p>
      )}
      {history.data?.length ? (
        <HubSelect
          showLabel
          label="Review history"
          value={run?.id ?? ""}
          options={history.data.map((item) => {
            const current = item.id === run?.id ? run : item;
            return {
              value: current.id,
              label: `${new Date(current.createdAt).toLocaleString()} · ${current.tier} · ${current.headSha.slice(0, 8)} · ${current.stage}`,
            };
          })}
          onChange={(id) => {
            setRunId(id);
            setSelected([]);
            setEditing(null);
          }}
        />
      ) : null}
      {run && (
        <section className="space-y-4 border-t pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="font-medium">{run.stage === "draft" ? "Review draft" : run.stage}</h2>
              <p className="mt-1 text-sm text-muted-foreground" role="status">
                {run.progress}
              </p>
            </div>
            {!["draft", "failed", "cancelled"].includes(run.stage) && (
              <Button
                variant="outline"
                size="sm"
                disabled={cancelling}
                onClick={() => {
                  setCancelling(true);
                  void cancel({ environmentId, input: { id: run.id } })
                    .then((result) => {
                      if (result._tag !== "Success")
                        setError(
                          "Could not cancel the review. Check the environment connection and retry.",
                        );
                      else refreshHistory();
                    })
                    .finally(() => setCancelling(false));
                }}
              >
                {cancelling ? "Cancelling…" : "Cancel review"}
              </Button>
            )}
          </div>
          <ReviewRunStatus run={run} />
          <ReviewActivityTimeline run={run} />
          {run.warnings.map((warning) => (
            <p key={warning} className="break-words text-xs text-muted-foreground">
              {warning}
            </p>
          ))}
          {run.analysis && (
            <>
              <p className="text-xs text-muted-foreground">
                Risk: {run.analysis.risk} · {run.filesAnalyzed} files analyzed ·{" "}
                {Math.round(run.durationMs / 1000)}s · {run.agent.modelSelection.model}
              </p>
              <div className="flex flex-wrap gap-3 text-xs">
                {(["critical", "major", "minor", "suggestion", "info"] as const).map((severity) => (
                  <span
                    key={severity}
                    className="min-w-20 rounded-md border bg-muted/20 px-3 py-2 capitalize"
                  >
                    <span className="block text-lg font-semibold tabular-nums">
                      {findings.filter((finding) => finding.severity === severity).length}
                    </span>
                    <span className="text-muted-foreground">{severity}</span>
                  </span>
                ))}
              </div>
              <p className="whitespace-pre-wrap text-sm">{run.analysis.summary}</p>
              <details>
                <summary className="cursor-pointer text-sm">Change walkthrough</summary>
                {run.analysis.walkthrough.map((group) => (
                  <div
                    key={`${group.title}:${group.files.join(":")}:${group.description}`}
                    className="mt-3 space-y-1 text-sm"
                  >
                    <p className="font-medium">{group.title}</p>
                    <p>{group.description}</p>
                    <p className="break-words text-xs text-muted-foreground">
                      {group.files.join(", ")}
                    </p>
                  </div>
                ))}
              </details>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => setSelected(findings.map((finding) => finding.id))}
                >
                  Select all
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() =>
                    setSelected(
                      findings
                        .filter(
                          (finding) =>
                            finding.severity === "critical" || finding.severity === "major",
                        )
                        .map((finding) => finding.id),
                    )
                  }
                >
                  Critical & major
                </Button>
                <Button size="xs" variant="ghost" onClick={() => setSelected([])}>
                  Deselect all
                </Button>
                <HubSelect
                  showLabel
                  label="Severity threshold"
                  value={threshold}
                  options={["critical", "major", "minor", "suggestion", "info"].map((value) => ({
                    value: value as typeof threshold,
                    label: value === "info" ? "All severities" : `${value} and above`,
                  }))}
                  onChange={setThreshold}
                />
                <HubSelect
                  showLabel
                  label="Group findings"
                  value={group}
                  options={[
                    { value: "severity", label: "By severity" },
                    { value: "filePath", label: "By file" },
                    { value: "category", label: "By category" },
                  ]}
                  onChange={setGroup}
                />
              </div>
              {[...groups].map(([group, entries]) => (
                <section key={group} className="space-y-2">
                  <h3 className="break-all text-sm font-semibold capitalize">{group}</h3>
                  {entries.map((finding) => {
                    const dismissed = run.dismissedIds.includes(finding.id);
                    const published = run.publishedIds.includes(finding.id);
                    return (
                      <article
                        key={finding.id}
                        className={`space-y-3 rounded-lg border p-4 ${dismissed ? "opacity-60" : ""}`}
                      >
                        <div className="flex gap-3">
                          <Checkbox
                            aria-label={`Select ${finding.title}`}
                            checked={selected.includes(finding.id)}
                            disabled={dismissed || published}
                            onCheckedChange={(checked) =>
                              setSelected((current) =>
                                checked
                                  ? [...current, finding.id]
                                  : current.filter((id) => id !== finding.id),
                              )
                            }
                          />
                          <div className="min-w-0">
                            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                              AI analysis ·{" "}
                              {published
                                ? "Published comment"
                                : dismissed
                                  ? "Dismissed"
                                  : "Draft finding"}
                            </p>
                            <p className="break-words text-sm font-medium">{finding.title}</p>
                            <p className="text-xs text-muted-foreground">
                              {finding.severity} · {finding.category}
                              {finding.confidence !== undefined
                                ? ` · confidence ${Math.round(finding.confidence * 100)}%`
                                : ""}
                            </p>
                          </div>
                        </div>
                        {editing?.id === finding.id ? (
                          <>
                            <Textarea
                              rows={5}
                              value={editing.text}
                              onChange={(event) =>
                                setEditing({ id: finding.id, text: event.target.value })
                              }
                            />
                            <Button
                              size="xs"
                              disabled={pending || !editing.text.trim()}
                              onClick={() =>
                                void saveFinding({
                                  ...run,
                                  analysis: {
                                    ...run.analysis!,
                                    findings: findings.map((item) =>
                                      item.id === finding.id
                                        ? { ...item, description: editing.text }
                                        : item,
                                    ),
                                  },
                                })
                              }
                            >
                              Save edit
                            </Button>
                            <Button size="xs" variant="ghost" onClick={() => setEditing(null)}>
                              Cancel
                            </Button>
                          </>
                        ) : (
                          <p className="whitespace-pre-wrap text-sm">{finding.description}</p>
                        )}
                        {finding.filePath && (
                          <Button
                            size="xs"
                            variant="link"
                            className="h-auto max-w-full whitespace-normal break-all p-0"
                            onClick={() => onFinding?.(finding.filePath!, finding.line, finding)}
                          >
                            {finding.filePath}
                            {finding.line ? `:${finding.line}` : ""}
                          </Button>
                        )}
                        <div className="flex gap-2">
                          {published ? (
                            <span className="text-xs text-muted-foreground">Published</span>
                          ) : (
                            <>
                              <Button
                                size="xs"
                                variant="ghost"
                                disabled={pending}
                                onClick={() =>
                                  setEditing({ id: finding.id, text: finding.description })
                                }
                              >
                                Edit
                              </Button>
                              <Button
                                size="xs"
                                variant="ghost"
                                disabled={pending}
                                onClick={() =>
                                  void saveFinding({
                                    ...run,
                                    dismissedIds: dismissed
                                      ? run.dismissedIds.filter((id) => id !== finding.id)
                                      : [...run.dismissedIds, finding.id],
                                  })
                                }
                              >
                                {dismissed ? "Restore" : "Dismiss"}
                              </Button>
                            </>
                          )}
                        </div>
                      </article>
                    );
                  })}
                </section>
              ))}
              <>
                {run.publicationUncertain && (
                  <p role="alert" className="text-sm text-destructive">
                    Publication outcome could not be confirmed. Inspect PR activity before preparing
                    a new review. Retrying this draft is disabled to avoid duplicate comments.
                  </p>
                )}
              </>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={summary}
                  disabled={run.summaryPublished}
                  onCheckedChange={setSummary}
                />
                Include summary comment
              </label>
              <Button
                disabled={
                  !ready ||
                  pending ||
                  run.publicationUncertain ||
                  (!publishable.length && (!summary || run.summaryPublished))
                }
                onClick={() => setPreview(true)}
              >
                Publish {publishable.length} findings
              </Button>
            </>
          )}
        </section>
      )}
      {preview && run && (
        <AlertDialog open onOpenChange={setPreview}>
          <AlertDialogPopup>
            <AlertDialogHeader>
              <AlertDialogTitle>Publish review</AlertDialogTitle>
              <AlertDialogDescription>
                {publishable.filter((finding) => finding.filePath && finding.line).length} inline
                comments,{" "}
                {publishable.filter((finding) => !finding.filePath || !finding.line).length +
                  (summary && !run.summaryPublished ? 1 : 0)}{" "}
                general comments, 0 approvals. Published as your source control account. The PR head
                will be checked before publication.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="outline" disabled={pending} />}>
                Cancel
              </AlertDialogClose>
              <Button
                disabled={pending}
                onClick={async () => {
                  setPending(true);
                  try {
                    const result = await publish({
                      environmentId,
                      input: { id: run.id, findingIds: selected, includeSummary: summary },
                    });
                    if (result._tag === "Success") {
                      setPreview(false);
                      setSelected([]);
                      history.refresh();
                    } else {
                      setPreview(false);
                      setError(
                        "Publication failed. The PR may have changed or your account may lack permission. Refresh before retrying.",
                      );
                    }
                  } finally {
                    setPending(false);
                  }
                }}
              >
                Confirm publication
              </Button>
            </AlertDialogFooter>
          </AlertDialogPopup>
        </AlertDialog>
      )}
    </div>
  );
}
