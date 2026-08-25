import {
  computeProjectSyncPlan,
  summarizeProjectSyncPlan,
} from "@t3tools/client-runtime/operations/project-sync";
import { getBrowseDirectoryPath } from "@t3tools/client-runtime/state/projects";
import {
  runProjectSync,
  type ProjectSyncProgress,
} from "@t3tools/client-runtime/state/project-sync";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId, type ProjectId } from "@t3tools/contracts";
import {
  AlertTriangleIcon,
  ArrowRightIcon,
  CircleCheckIcon,
  CircleXIcon,
  FolderSyncIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useUpdateEnvironmentSettings } from "../hooks/useSettings";
import { cn, newProjectId } from "../lib/utils";
import { useEnvironments } from "../state/environments";
import { useProjects } from "../state/entities";
import { projectEnvironment } from "../state/projects";
import { useProjectSyncDeps } from "../state/projectSync";
import { useAtomCommand } from "../state/use-atom-command";
import { AnimatedHeight } from "./AnimatedHeight";
import {
  buildDefaultSendDestinationPath,
  buildSyncProjectDialogSteps,
  canStartProjectSync,
  describeProjectSyncError,
  describeProjectSyncPlanSummary,
  deriveProjectSyncProgressPercent,
  describeProjectSyncStage,
  projectSyncPlanNeedsDeleteConfirmation,
  selectDestinationProjectCandidates,
  selectProjectSyncEnvironmentOptions,
  sortDestinationProjectCandidatesBySourceMatch,
  type SyncEnvironmentCandidate,
  type SyncProjectCandidate,
  type SyncProjectDialogMode,
  type SyncProjectErrorDescription,
} from "./SyncProjectDialog.logic";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { Spinner } from "./ui/spinner";

// Used only to satisfy `useUpdateEnvironmentSettings`'s non-null signature
// before a destination environment is chosen; the update it drives is only
// ever invoked once a real destination is selected, so this value is never
// actually persisted against.
const UNSET_ENVIRONMENT_ID = EnvironmentId.make("__sync-dialog-unset__");

export interface SyncProjectDialogSource {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

export interface SyncProjectDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Preselected source project. When set, the origin step is skipped —
      the caller already knows the answer (a project's own settings page, or
      the command palette's project-scoped entry). */
  readonly initialSource?: SyncProjectDialogSource;
}

type RunState = "idle" | "running" | "done" | "error" | "cancelled";

export function SyncProjectDialog({ open, onOpenChange, initialSource }: SyncProjectDialogProps) {
  const { environments } = useEnvironments();
  const allProjects = useProjects();
  const deps = useProjectSyncDeps();
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });

  const hasFixedSource = initialSource !== undefined;
  const steps = useMemo(() => buildSyncProjectDialogSteps({ hasFixedSource }), [hasFixedSource]);

  const [stepIndex, setStepIndex] = useState(0);
  const [originEnvironmentId, setOriginEnvironmentId] = useState<EnvironmentId | null>(null);
  const [originProjectId, setOriginProjectId] = useState<ProjectId | null>(null);
  const [destEnvironmentId, setDestEnvironmentId] = useState<EnvironmentId | null>(null);
  const [mode, setMode] = useState<SyncProjectDialogMode | null>(null);
  const [sendDestinationPath, setSendDestinationPath] = useState("");
  const [sendDestinationPathTouched, setSendDestinationPathTouched] = useState(false);
  const [setAsDefaultFolder, setSetAsDefaultFolder] = useState(false);
  const [existingDestProjectId, setExistingDestProjectId] = useState<ProjectId | null>(null);
  const [includeGit, setIncludeGit] = useState(true);
  const [planSummary, setPlanSummary] = useState<{
    readonly copyCount: number;
    readonly deleteCount: number;
    readonly copyBytes: number;
  } | null>(null);
  const [isLoadingPlan, setIsLoadingPlan] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [planRetryToken, setPlanRetryToken] = useState(0);
  const [deleteConfirmed, setDeleteConfirmed] = useState(false);
  const [progress, setProgress] = useState<ProjectSyncProgress | null>(null);
  const [runState, setRunState] = useState<RunState>("idle");
  const [runError, setRunError] = useState<SyncProjectErrorDescription | null>(null);
  const [finalSummary, setFinalSummary] = useState<{
    readonly copyCount: number;
    readonly deleteCount: number;
    readonly copyBytes: number;
  } | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Reset every field whenever the dialog opens, so a previous run's choices
  // never leak into the next one.
  useEffect(() => {
    if (!open) {
      return;
    }
    setStepIndex(0);
    setOriginEnvironmentId(null);
    setOriginProjectId(null);
    setDestEnvironmentId(null);
    setMode(null);
    setSendDestinationPath("");
    setSendDestinationPathTouched(false);
    setSetAsDefaultFolder(false);
    setExistingDestProjectId(null);
    setIncludeGit(true);
    setPlanSummary(null);
    setIsLoadingPlan(false);
    setPlanError(null);
    setPlanRetryToken(0);
    setDeleteConfirmed(false);
    setProgress(null);
    setRunState("idle");
    setRunError(null);
    setFinalSummary(null);
    abortControllerRef.current = null;
  }, [open]);

  // Derived from primitive fields (not the `initialSource` object itself) so
  // its identity stays stable across renders even when a caller passes a
  // freshly-literal `initialSource` prop every render (as
  // `ProjectSettingsPanel` does) — otherwise every downstream effect keyed on
  // `source` would re-run on every unrelated parent re-render.
  const fixedSourceEnvironmentId = initialSource?.environmentId ?? null;
  const fixedSourceProjectId = initialSource?.projectId ?? null;
  const source: SyncProjectDialogSource | null = useMemo(() => {
    if (hasFixedSource) {
      return fixedSourceEnvironmentId !== null && fixedSourceProjectId !== null
        ? { environmentId: fixedSourceEnvironmentId, projectId: fixedSourceProjectId }
        : null;
    }
    return originEnvironmentId !== null && originProjectId !== null
      ? { environmentId: originEnvironmentId, projectId: originProjectId }
      : null;
  }, [
    hasFixedSource,
    fixedSourceEnvironmentId,
    fixedSourceProjectId,
    originEnvironmentId,
    originProjectId,
  ]);

  const sourceProject = useMemo(
    () =>
      source
        ? (allProjects.find(
            (project) =>
              project.environmentId === source.environmentId && project.id === source.projectId,
          ) ?? null)
        : null,
    [allProjects, source],
  );

  const environmentCandidates: SyncEnvironmentCandidate[] = useMemo(
    () =>
      environments.map((environment) => ({
        environmentId: environment.environmentId,
        label: environment.label,
        connected: environment.connection.phase === "connected",
        projectSyncCapable: environment.serverConfig?.environment.capabilities.projectSync === true,
      })),
    [environments],
  );
  const eligibleEnvironments = useMemo(
    () => selectProjectSyncEnvironmentOptions(environmentCandidates),
    [environmentCandidates],
  );

  const originEnvironmentProjects = useMemo(
    () =>
      originEnvironmentId === null
        ? []
        : allProjects.filter((project) => project.environmentId === originEnvironmentId),
    [allProjects, originEnvironmentId],
  );

  const destEnvironment = useMemo(
    () =>
      environments.find((environment) => environment.environmentId === destEnvironmentId) ?? null,
    [environments, destEnvironmentId],
  );
  const destBaseDirectory = destEnvironment?.serverConfig?.settings.addProjectBaseDirectory ?? "";

  const defaultSendDestinationPath = useMemo(
    () =>
      sourceProject
        ? buildDefaultSendDestinationPath({
            baseDirectory: destBaseDirectory,
            sourceProjectTitle: sourceProject.title,
          })
        : "",
    [destBaseDirectory, sourceProject],
  );

  useEffect(() => {
    if (mode === "send" && !sendDestinationPathTouched) {
      setSendDestinationPath(defaultSendDestinationPath);
    }
  }, [mode, defaultSendDestinationPath, sendDestinationPathTouched]);

  // Any change to the destination environment or mode invalidates a
  // previously picked existing project and any plan computed against it.
  useEffect(() => {
    setExistingDestProjectId(null);
    setPlanSummary(null);
    setPlanError(null);
    setDeleteConfirmed(false);
  }, [destEnvironmentId, mode]);

  const destProjectCandidates: SyncProjectCandidate[] = useMemo(() => {
    if (source === null || destEnvironmentId === null) {
      return [];
    }
    const candidates: SyncProjectCandidate[] = allProjects.map((project) => ({
      environmentId: project.environmentId,
      projectId: project.id,
      title: project.title,
      workspaceRoot: project.workspaceRoot,
      repositoryCanonicalKey: project.repositoryIdentity?.canonicalKey ?? null,
    }));
    const filtered = selectDestinationProjectCandidates({
      allProjects: candidates,
      destinationEnvironmentId: destEnvironmentId,
      source,
    });
    return sortDestinationProjectCandidatesBySourceMatch({
      candidates: filtered,
      sourceRepositoryCanonicalKey: sourceProject?.repositoryIdentity?.canonicalKey ?? null,
    });
  }, [allProjects, destEnvironmentId, source, sourceProject]);

  const currentStep = steps[Math.min(stepIndex, steps.length - 1)]!;

  // Fetch both manifests and compute the plan once the user reaches the
  // review step in "sync" mode — this is what surfaces the delete warning
  // before anything on the destination is touched.
  useEffect(() => {
    if (
      currentStep !== "review" ||
      mode !== "sync" ||
      source === null ||
      destEnvironmentId === null
    ) {
      return;
    }
    if (existingDestProjectId === null) {
      return;
    }
    let cancelled = false;
    setIsLoadingPlan(true);
    setPlanError(null);
    setPlanSummary(null);
    (async () => {
      try {
        const [sourceManifest, destManifest] = await Promise.all([
          deps.getManifest(
            { environmentId: source.environmentId, projectId: source.projectId },
            includeGit,
          ),
          deps.getManifest(
            { environmentId: destEnvironmentId, projectId: existingDestProjectId },
            includeGit,
          ),
        ]);
        if (cancelled) return;
        const plan = computeProjectSyncPlan(sourceManifest.entries, destManifest.entries);
        setPlanSummary(summarizeProjectSyncPlan(plan));
      } catch (error) {
        if (cancelled) return;
        setPlanError(describeProjectSyncError(error).message);
      } finally {
        if (!cancelled) setIsLoadingPlan(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // `planRetryToken` has no direct use inside the effect body — bumping it
    // is how the review step's "Retry" button re-triggers this same fetch.
  }, [
    currentStep,
    mode,
    source,
    destEnvironmentId,
    existingDestProjectId,
    includeGit,
    deps,
    planRetryToken,
  ]);

  const updateDestSettings = useUpdateEnvironmentSettings(
    destEnvironmentId ?? UNSET_ENVIRONMENT_ID,
  );

  const handleStart = useCallback(async () => {
    if (source === null || destEnvironmentId === null || mode === null) {
      return;
    }
    setStepIndex(steps.length - 1);
    setRunState("running");
    setRunError(null);
    setProgress(null);
    const controller = new AbortController();
    abortControllerRef.current = controller;

    let destProjectId: ProjectId;
    if (mode === "send") {
      const trimmedPath = sendDestinationPath.trim();
      if (setAsDefaultFolder) {
        updateDestSettings({ addProjectBaseDirectory: getBrowseDirectoryPath(trimmedPath) });
      }
      const createdProjectId = newProjectId();
      const createResult = await createProject({
        environmentId: destEnvironmentId,
        input: {
          projectId: createdProjectId,
          title: sourceProject?.title ?? "Synced project",
          workspaceRoot: trimmedPath,
          createWorkspaceRootIfMissing: true,
        },
      });
      if (createResult._tag !== "Success") {
        abortControllerRef.current = null;
        if (isAtomCommandInterrupted(createResult)) {
          setRunState("idle");
          return;
        }
        setRunState("error");
        setRunError(describeProjectSyncError(squashAtomCommandFailure(createResult)));
        return;
      }
      destProjectId = createdProjectId;
      setExistingDestProjectId(createdProjectId);
    } else {
      if (existingDestProjectId === null) {
        abortControllerRef.current = null;
        return;
      }
      destProjectId = existingDestProjectId;
    }

    try {
      const summary = await runProjectSync(deps, {
        source: { environmentId: source.environmentId, projectId: source.projectId },
        dest: { environmentId: destEnvironmentId, projectId: destProjectId },
        mode,
        includeGit,
        signal: controller.signal,
        onProgress: setProgress,
      });
      setFinalSummary(summary);
      setRunState("done");
    } catch (error) {
      setRunState(controller.signal.aborted ? "cancelled" : "error");
      setRunError(describeProjectSyncError(error));
    } finally {
      abortControllerRef.current = null;
    }
  }, [
    createProject,
    deps,
    destEnvironmentId,
    existingDestProjectId,
    includeGit,
    mode,
    sendDestinationPath,
    setAsDefaultFolder,
    source,
    sourceProject,
    steps.length,
    updateDestSettings,
  ]);

  const handleCancel = useCallback(() => {
    abortControllerRef.current?.abort();
  }, []);

  const handleRetry = useCallback(() => {
    void handleStart();
  }, [handleStart]);

  const goBack = useCallback(() => setStepIndex((index) => Math.max(0, index - 1)), []);
  const goNext = useCallback(
    () => setStepIndex((index) => Math.min(steps.length - 1, index + 1)),
    [steps.length],
  );

  const canProceedOrigin = source !== null;
  const canProceedDestination = destEnvironmentId !== null;
  const canProceedMode =
    mode !== null &&
    (mode === "send" ? sendDestinationPath.trim().length > 0 : existingDestProjectId !== null);
  const needsDeleteConfirmation =
    planSummary !== null && projectSyncPlanNeedsDeleteConfirmation(planSummary);
  const canStart =
    mode !== null &&
    canStartProjectSync({
      mode,
      sendDestinationPath,
      existingDestinationProjectId: existingDestProjectId,
      planSummary: mode === "sync" ? planSummary : { deleteCount: 0 },
      deleteConfirmed,
    });

  const busy = runState === "running";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) {
          return;
        }
        onOpenChange(next);
      }}
    >
      <DialogPopup className="max-w-xl overflow-hidden" showCloseButton={!busy}>
        <div className="flex min-h-0 flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FolderSyncIcon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
              Sync project between environments
            </DialogTitle>
            <DialogDescription>
              Copy a project's files from one environment to another, or keep an existing project in
              sync with its source.
            </DialogDescription>
          </DialogHeader>

          <div
            data-slot="dialog-panel"
            className="space-y-4 bg-zinc-25/80 px-6 py-5 ring-1 ring-black/5 dark:bg-white/2 dark:ring-white/5"
          >
            <AnimatedHeight>
              {currentStep === "origin" ? (
                <OriginStep
                  eligibleEnvironments={eligibleEnvironments}
                  originEnvironmentId={originEnvironmentId}
                  onOriginEnvironmentChange={(environmentId) => {
                    setOriginEnvironmentId(environmentId);
                    setOriginProjectId(null);
                  }}
                  originProjects={originEnvironmentProjects}
                  originProjectId={originProjectId}
                  onOriginProjectChange={setOriginProjectId}
                />
              ) : null}

              {currentStep === "destination" ? (
                <DestinationStep
                  eligibleEnvironments={eligibleEnvironments}
                  destEnvironmentId={destEnvironmentId}
                  onDestEnvironmentChange={(environmentId) => {
                    setDestEnvironmentId(environmentId);
                    setSendDestinationPathTouched(false);
                  }}
                />
              ) : null}

              {currentStep === "mode" ? (
                <ModeStep
                  mode={mode}
                  onModeChange={(nextMode) => {
                    setMode(nextMode);
                    if (nextMode === "send") {
                      setSendDestinationPathTouched(false);
                    }
                  }}
                  sendDestinationPath={sendDestinationPath}
                  onSendDestinationPathChange={(value) => {
                    setSendDestinationPath(value);
                    setSendDestinationPathTouched(true);
                  }}
                  setAsDefaultFolder={setAsDefaultFolder}
                  onSetAsDefaultFolderChange={setSetAsDefaultFolder}
                  destProjectCandidates={destProjectCandidates}
                  existingDestProjectId={existingDestProjectId}
                  onExistingDestProjectChange={setExistingDestProjectId}
                  includeGit={includeGit}
                  onIncludeGitChange={setIncludeGit}
                  sourceRepositoryCanonicalKey={
                    sourceProject?.repositoryIdentity?.canonicalKey ?? null
                  }
                />
              ) : null}

              {currentStep === "review" ? (
                <ReviewStep
                  mode={mode}
                  source={source}
                  sourceProjectTitle={sourceProject?.title ?? null}
                  destEnvironmentLabel={destEnvironment?.label ?? null}
                  sendDestinationPath={sendDestinationPath}
                  existingDestProject={
                    destProjectCandidates.find(
                      (candidate) => candidate.projectId === existingDestProjectId,
                    ) ?? null
                  }
                  isLoadingPlan={isLoadingPlan}
                  planSummary={planSummary}
                  planError={planError}
                  onRetryPlan={() => setPlanRetryToken((token) => token + 1)}
                  needsDeleteConfirmation={needsDeleteConfirmation}
                  deleteConfirmed={deleteConfirmed}
                  onDeleteConfirmedChange={setDeleteConfirmed}
                />
              ) : null}

              {currentStep === "progress" ? (
                <ProgressStep
                  runState={runState}
                  progress={progress}
                  runError={runError}
                  finalSummary={finalSummary}
                />
              ) : null}
            </AnimatedHeight>
          </div>

          <DialogFooter variant="bare">
            {currentStep === "progress" ? (
              busy ? (
                <Button variant="outline" size="sm" onClick={handleCancel}>
                  Cancel
                </Button>
              ) : (
                <>
                  {runState === "error" && runError?.canRetry ? (
                    <Button variant="outline" size="sm" onClick={handleRetry}>
                      Retry
                    </Button>
                  ) : null}
                  <Button size="sm" onClick={() => onOpenChange(false)}>
                    Close
                  </Button>
                </>
              )
            ) : (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    if (stepIndex === 0) {
                      onOpenChange(false);
                      return;
                    }
                    goBack();
                  }}
                >
                  {stepIndex === 0 ? "Cancel" : "Back"}
                </Button>
                {currentStep === "review" ? (
                  <Button
                    size="sm"
                    disabled={!canStart || isLoadingPlan}
                    onClick={() => void handleStart()}
                  >
                    Start sync
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    disabled={
                      currentStep === "origin"
                        ? !canProceedOrigin
                        : currentStep === "destination"
                          ? !canProceedDestination
                          : !canProceedMode
                    }
                    onClick={goNext}
                  >
                    Next
                    <ArrowRightIcon className="size-3.5" />
                  </Button>
                )}
              </>
            )}
          </DialogFooter>
        </div>
      </DialogPopup>
    </Dialog>
  );
}

function OriginStep(props: {
  readonly eligibleEnvironments: ReadonlyArray<SyncEnvironmentCandidate>;
  readonly originEnvironmentId: EnvironmentId | null;
  readonly onOriginEnvironmentChange: (environmentId: EnvironmentId) => void;
  readonly originProjects: ReadonlyArray<{ readonly id: ProjectId; readonly title: string }>;
  readonly originProjectId: ProjectId | null;
  readonly onOriginProjectChange: (projectId: ProjectId) => void;
}) {
  return (
    <div className="grid gap-4">
      <label className="grid gap-2">
        <span className="text-xs font-medium text-foreground">From environment</span>
        <Select
          value={props.originEnvironmentId ?? ""}
          onValueChange={(value) =>
            props.onOriginEnvironmentChange(EnvironmentId.make(String(value)))
          }
        >
          <SelectTrigger aria-label="Source environment">
            <SelectValue placeholder="Choose an environment" />
          </SelectTrigger>
          <SelectPopup>
            {props.eligibleEnvironments.map((environment) => (
              <SelectItem key={environment.environmentId} value={environment.environmentId}>
                {environment.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        {props.eligibleEnvironments.length === 0 ? (
          <span className="text-[11px] text-muted-foreground">
            No connected environment supports project sync yet.
          </span>
        ) : null}
      </label>

      <label className="grid gap-2">
        <span className="text-xs font-medium text-foreground">Project</span>
        <Select
          value={props.originProjectId ?? ""}
          onValueChange={(value) => props.onOriginProjectChange(value as ProjectId)}
          disabled={props.originEnvironmentId === null}
        >
          <SelectTrigger aria-label="Source project">
            <SelectValue placeholder="Choose a project" />
          </SelectTrigger>
          <SelectPopup>
            {props.originProjects.map((project) => (
              <SelectItem key={project.id} value={project.id}>
                {project.title}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </label>
    </div>
  );
}

function DestinationStep(props: {
  readonly eligibleEnvironments: ReadonlyArray<SyncEnvironmentCandidate>;
  readonly destEnvironmentId: EnvironmentId | null;
  readonly onDestEnvironmentChange: (environmentId: EnvironmentId) => void;
}) {
  return (
    <div className="grid gap-4">
      <label className="grid gap-2">
        <span className="text-xs font-medium text-foreground">To environment</span>
        <Select
          value={props.destEnvironmentId ?? ""}
          onValueChange={(value) =>
            props.onDestEnvironmentChange(EnvironmentId.make(String(value)))
          }
        >
          <SelectTrigger aria-label="Destination environment">
            <SelectValue placeholder="Choose an environment" />
          </SelectTrigger>
          <SelectPopup>
            {props.eligibleEnvironments.map((environment) => (
              <SelectItem key={environment.environmentId} value={environment.environmentId}>
                {environment.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        {props.eligibleEnvironments.length === 0 ? (
          <span className="text-[11px] text-muted-foreground">
            No connected environment supports project sync yet.
          </span>
        ) : (
          <span className="text-[11px] text-muted-foreground">
            Only environments that are connected and support project sync are listed.
          </span>
        )}
      </label>
    </div>
  );
}

function ModeStep(props: {
  readonly mode: SyncProjectDialogMode | null;
  readonly onModeChange: (mode: SyncProjectDialogMode) => void;
  readonly sendDestinationPath: string;
  readonly onSendDestinationPathChange: (value: string) => void;
  readonly setAsDefaultFolder: boolean;
  readonly onSetAsDefaultFolderChange: (value: boolean) => void;
  readonly destProjectCandidates: ReadonlyArray<SyncProjectCandidate>;
  readonly existingDestProjectId: ProjectId | null;
  readonly onExistingDestProjectChange: (projectId: ProjectId) => void;
  readonly includeGit: boolean;
  readonly onIncludeGitChange: (value: boolean) => void;
  readonly sourceRepositoryCanonicalKey: string | null;
}) {
  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <button
          type="button"
          onClick={() => props.onModeChange("send")}
          aria-pressed={props.mode === "send"}
          className={cn(
            "rounded-lg border px-3 py-3 text-left ring-1 ring-black/5 transition-colors dark:ring-white/5",
            props.mode === "send"
              ? "border-primary bg-primary/8 dark:bg-primary/15"
              : "border-transparent bg-card hover:bg-zinc-50 dark:bg-white/3 dark:hover:bg-white/5",
          )}
        >
          <div className="text-sm font-medium text-foreground">Send as a new project</div>
          <div className="text-[13px] text-muted-foreground">
            Copies the source into a brand-new project at a folder you choose.
          </div>
        </button>
        <button
          type="button"
          onClick={() => props.onModeChange("sync")}
          aria-pressed={props.mode === "sync"}
          className={cn(
            "rounded-lg border px-3 py-3 text-left ring-1 ring-black/5 transition-colors dark:ring-white/5",
            props.mode === "sync"
              ? "border-primary bg-primary/8 dark:bg-primary/15"
              : "border-transparent bg-card hover:bg-zinc-50 dark:bg-white/3 dark:hover:bg-white/5",
          )}
        >
          <div className="text-sm font-medium text-foreground">Sync an existing project</div>
          <div className="text-[13px] text-muted-foreground">
            Mirrors the source onto an existing project — this can delete files on the destination.
          </div>
        </button>
      </div>

      {props.mode === "send" ? (
        <label className="grid gap-2">
          <span className="text-xs font-medium text-foreground">Destination folder</span>
          <Input
            className="bg-background font-mono text-sm"
            value={props.sendDestinationPath}
            onChange={(event) => props.onSendDestinationPathChange(event.target.value)}
          />
          <div className="flex items-center gap-2 pt-1">
            <Checkbox
              checked={props.setAsDefaultFolder}
              onCheckedChange={(checked) => props.onSetAsDefaultFolderChange(checked === true)}
              id="sync-project-set-default-folder"
            />
            <label
              htmlFor="sync-project-set-default-folder"
              className="text-[13px] text-muted-foreground"
            >
              Set as default projects folder for this environment
            </label>
          </div>
        </label>
      ) : null}

      {props.mode === "sync" ? (
        <label className="grid gap-2">
          <span className="text-xs font-medium text-foreground">Existing project</span>
          <Select
            value={props.existingDestProjectId ?? ""}
            onValueChange={(value) => props.onExistingDestProjectChange(value as ProjectId)}
          >
            <SelectTrigger aria-label="Destination project">
              <SelectValue placeholder="Choose a project" />
            </SelectTrigger>
            <SelectPopup>
              {props.destProjectCandidates.map((candidate) => (
                <SelectItem key={candidate.projectId} value={candidate.projectId}>
                  {candidate.title}
                  {props.sourceRepositoryCanonicalKey !== null &&
                  candidate.repositoryCanonicalKey === props.sourceRepositoryCanonicalKey
                    ? " (suggested)"
                    : ""}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          {props.destProjectCandidates.length === 0 ? (
            <span className="text-[11px] text-muted-foreground">
              No other projects exist on this environment yet — use "Send as a new project" instead.
            </span>
          ) : null}
        </label>
      ) : null}

      <div className="flex items-center gap-2 border-t border-border/60 pt-3">
        <Checkbox
          checked={props.includeGit}
          onCheckedChange={(checked) => props.onIncludeGitChange(checked === true)}
          id="sync-project-include-git"
        />
        <label htmlFor="sync-project-include-git" className="text-[13px] text-muted-foreground">
          Include <code className="font-mono">.git</code> — copies version-control history along
          with the files.
        </label>
      </div>
    </div>
  );
}

function ReviewStep(props: {
  readonly mode: SyncProjectDialogMode | null;
  readonly source: SyncProjectDialogSource | null;
  readonly sourceProjectTitle: string | null;
  readonly destEnvironmentLabel: string | null;
  readonly sendDestinationPath: string;
  readonly existingDestProject: SyncProjectCandidate | null;
  readonly isLoadingPlan: boolean;
  readonly planSummary: {
    readonly copyCount: number;
    readonly deleteCount: number;
    readonly copyBytes: number;
  } | null;
  readonly planError: string | null;
  readonly onRetryPlan: () => void;
  readonly needsDeleteConfirmation: boolean;
  readonly deleteConfirmed: boolean;
  readonly onDeleteConfirmedChange: (value: boolean) => void;
}) {
  return (
    <div className="grid gap-4">
      <div className="flex items-center gap-2 rounded-lg bg-muted/30 px-3 py-2 text-sm">
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">
          {props.sourceProjectTitle ?? "Source project"}
        </span>
        <ArrowRightIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {props.mode === "send"
            ? `${props.destEnvironmentLabel ?? "destination"} · ${props.sendDestinationPath}`
            : `${props.destEnvironmentLabel ?? "destination"} · ${props.existingDestProject?.title ?? ""}`}
        </span>
      </div>

      {props.mode === "sync" ? (
        props.isLoadingPlan ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="size-4" />
            Comparing projects…
          </div>
        ) : props.planError !== null ? (
          <div className="grid gap-2 rounded-lg border border-destructive/24 bg-destructive/6 p-3 text-sm text-destructive">
            <div className="flex items-center gap-2">
              <CircleXIcon className="size-4 shrink-0" aria-hidden />
              {props.planError}
            </div>
            <Button variant="outline" size="xs" className="w-fit" onClick={props.onRetryPlan}>
              Retry
            </Button>
          </div>
        ) : props.planSummary !== null ? (
          <div className="grid gap-2">
            <p className="text-sm text-foreground">
              {describeProjectSyncPlanSummary(props.planSummary)}
            </p>
            {props.needsDeleteConfirmation ? (
              <div className="grid gap-2 rounded-lg border border-warning/24 bg-warning/6 p-3">
                <div className="flex items-start gap-2 text-sm text-warning">
                  <AlertTriangleIcon className="size-4 shrink-0" aria-hidden />
                  <span>
                    This deletes{" "}
                    {props.planSummary.deleteCount === 1
                      ? "1 file"
                      : `${props.planSummary.deleteCount} files`}{" "}
                    on the destination to mirror the source. This cannot be undone.
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox
                    checked={props.deleteConfirmed}
                    onCheckedChange={(checked) => props.onDeleteConfirmedChange(checked === true)}
                    id="sync-project-confirm-delete"
                  />
                  <label
                    htmlFor="sync-project-confirm-delete"
                    className="text-[13px] text-foreground"
                  >
                    I understand these files will be deleted.
                  </label>
                </div>
              </div>
            ) : null}
          </div>
        ) : null
      ) : (
        <p className="text-sm text-muted-foreground">
          A new project will be created at this path, then the source's files will be copied over.
        </p>
      )}
    </div>
  );
}

function ProgressStep(props: {
  readonly runState: RunState;
  readonly progress: ProjectSyncProgress | null;
  readonly runError: SyncProjectErrorDescription | null;
  readonly finalSummary: {
    readonly copyCount: number;
    readonly deleteCount: number;
    readonly copyBytes: number;
  } | null;
}) {
  if (props.runState === "done") {
    return (
      <div className="grid gap-2">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <CircleCheckIcon className="size-4 shrink-0 text-success" aria-hidden />
          Sync complete
        </div>
        {props.finalSummary ? (
          <p className="text-sm text-muted-foreground">
            {describeProjectSyncPlanSummary(props.finalSummary)}
          </p>
        ) : null}
      </div>
    );
  }

  if (props.runState === "error" || props.runState === "cancelled") {
    return (
      <div className="grid gap-2 rounded-lg border border-destructive/24 bg-destructive/6 p-3">
        <div className="flex items-center gap-2 text-sm font-medium text-destructive">
          <CircleXIcon className="size-4 shrink-0" aria-hidden />
          {props.runError?.title ?? "Sync failed"}
        </div>
        <p className="text-sm text-destructive/90">{props.runError?.message}</p>
      </div>
    );
  }

  const percent = props.progress ? deriveProjectSyncProgressPercent(props.progress) : 0;
  const stageLabel = props.progress ? describeProjectSyncStage(props.progress.stage) : "Starting…";

  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-2 text-sm text-foreground">
        <Spinner className="size-4" />
        {stageLabel}
      </div>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-muted/60"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-200"
          style={{ width: `${percent}%` }}
        />
      </div>
      {props.progress && props.progress.totalFiles > 0 ? (
        <p className="text-[13px] text-muted-foreground">
          {props.progress.transferredFiles} of {props.progress.totalFiles} files
        </p>
      ) : null}
    </div>
  );
}
