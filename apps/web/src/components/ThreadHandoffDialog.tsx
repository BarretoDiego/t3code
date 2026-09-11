import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { randomUUID } from "../lib/utils";
import { buildThreadRouteParams } from "../threadRoutes";
import * as Schema from "effect/Schema";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ScopedThreadRef,
  ThreadHandoffId,
  ThreadId,
  type ThreadHandoffDestination,
  type ThreadHandoffSource,
} from "@t3tools/contracts";
import {
  runThreadHandoff,
  recoverThreadHandoff,
  type ThreadHandoffProgress,
} from "@t3tools/client-runtime/operations/thread-handoff";
import { useEnvironments } from "../state/environments";
import { useProjects, useThreadShell } from "../state/entities";
import { THREAD_HANDOFF_EVENT, useThreadHandoffDeps } from "../state/threadHandoff";
import { useThreadWorkspaceStore } from "../threadWorkspaceStore";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogPopup,
  DialogPanel,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "./ui/select";

const Recovery = Schema.Struct({
  handoffId: ThreadHandoffId,
  threadId: ThreadId,
  sourceEnvironmentId: EnvironmentId,
  destinationEnvironmentId: EnvironmentId,
});
type Recovery = typeof Recovery.Type;
const decodeRecovery = Schema.decodeUnknownSync(Schema.fromJsonString(Recovery));
const encodeRecovery = Schema.encodeSync(Schema.fromJsonString(Recovery));
const isThreadRef = Schema.is(ScopedThreadRef);
const recoveryKey = (ref: ScopedThreadRef) =>
  `t3:thread-handoff:${ref.environmentId}:${ref.threadId}`;
const clearRecovery = (ref: ScopedThreadRef) => {
  try {
    localStorage.removeItem(recoveryKey(ref));
  } catch {
    /* Recovery is idempotent if storage retains a completed descriptor. */
  }
};
const message = (error: unknown) =>
  error instanceof Error ? error.message : "The environment could not complete this request.";
const phaseLabels: Record<ThreadHandoffProgress["phase"], string> = {
  preflighting: "Checking environments / waiting for the current turn",
  pausing: "Pausing agent",
  checkpointing: "Creating a consistent checkpoint",
  syncingProjects: "Transferring projects and conversation state",
  transferringSession: "Transferring conversation state",
  verifying: "Verifying destination",
  ready: "Destination ready",
  committed: "Activating destination",
  completed: "Transfer completed",
  rollingBack: "Restoring source ownership",
  failed: "Transfer failed; source retained",
  cancelled: "Transfer cancelled; source retained",
};
type RunState =
  | { status: "idle" }
  | { status: "running"; progress: ThreadHandoffProgress | null }
  | { status: "completed"; destinationEnvironmentId: EnvironmentId }
  | { status: "error"; message: string; recovery: Recovery | null };

export interface ThreadHandoffDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly threadRef: ScopedThreadRef;
  readonly onTransferred?: (destination: ScopedThreadRef) => void;
}

export function ThreadHandoffDialog({
  open,
  onOpenChange,
  threadRef,
  onTransferred,
}: ThreadHandoffDialogProps) {
  const router = useRouter();
  const deps = useThreadHandoffDeps();
  const { environments } = useEnvironments();
  const projects = useProjects();
  const thread = useThreadShell(threadRef);
  const [source, setSource] = useState<ThreadHandoffSource | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [destinationId, setDestinationId] = useState<EnvironmentId | null>(null);
  const [providerId, setProviderId] = useState<ProviderInstanceId | null>(null);
  const [projectId, setProjectId] = useState<ProjectId | null>(null);
  const [transferMode, setTransferMode] = useState<"native" | "context">("native");
  const [model, setModel] = useState<string | null>(null);
  const [mode, setMode] = useState<"idle" | "afterTurn" | "interrupt">("idle");
  const [run, setRun] = useState<RunState>(() => {
    try {
      const stored = localStorage.getItem(recoveryKey(threadRef));
      if (!stored) return { status: "idle" };
      const recovery = decodeRecovery(stored);
      if (
        recovery.threadId !== threadRef.threadId ||
        recovery.sourceEnvironmentId !== threadRef.environmentId
      )
        throw new Error("Saved recovery belongs to another thread.");
      return {
        status: "error",
        message: "A previous transfer needs its ownership checked before continuing.",
        recovery,
      };
    } catch (error) {
      return { status: "error", message: message(error), recovery: null };
    }
  });
  const [readiness, setReadiness] = useState<{
    key: string;
    status: "checking" | "ready" | "error";
    message?: string;
    warnings?: readonly string[];
  } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const initializedTransferMode = useRef(false);
  const inFlight = useRef(false);
  const sourceEnvironment = environments.find(
    (entry) => entry.environmentId === threadRef.environmentId,
  );
  const supportsNative =
    source?.supportsNativeHandoff ??
    (!!source?.sessionId &&
      sourceEnvironment?.serverConfig?.providers.some(
        (provider) =>
          provider.instanceId === source.providerInstanceId &&
          provider.supportsSessionHandoff === true,
      )) ??
    false;
  useEffect(() => {
    if (!source || initializedTransferMode.current) return;
    initializedTransferMode.current = true;
    // Initialize from the completed inspection without making provider snapshots retrigger it.
    setTransferMode(supportsNative ? "native" : "context");
  }, [source, supportsNative]);
  const selectedEnvironment = environments.find((entry) => entry.environmentId === destinationId);
  const destinationProjects = projects.filter((project) => project.environmentId === destinationId);
  const providers =
    selectedEnvironment?.serverConfig?.providers.filter(
      (provider) =>
        provider.enabled &&
        (transferMode === "native"
          ? provider.driver === source?.driver && provider.supportsSessionHandoff === true
          : provider.supportsContextHandoff === true),
    ) ?? [];
  const selectedProvider = providers.find((provider) => provider.instanceId === providerId);
  const destination = useMemo<Omit<ThreadHandoffDestination, "source"> | null>(
    () =>
      source && destinationId && providerId && projectId && (transferMode === "native" || model)
        ? {
            transferMode,
            ...(transferMode === "context" && model
              ? { modelSelection: { instanceId: providerId, model } }
              : {}),
            environmentId: destinationId,
            providerInstanceId: providerId,
            projects: [{ sourceProjectId: source.projectId, destinationProjectId: projectId }],
          }
        : null,
    [source, destinationId, providerId, projectId, transferMode, model],
  );
  const selectionKey = JSON.stringify([destinationId, providerId, projectId, transferMode, model]);
  const busy = run.status === "running";
  const destinationOnline = selectedEnvironment?.connection.phase === "connected";
  const destinationUnavailable = !destinationOnline
    ? "Destination offline"
    : selectedEnvironment?.serverConfig?.environment.capabilities.threadHandoff !== true
      ? "Destination handoff is unavailable"
      : transferMode === "native" && !supportsNative
        ? "Native session transfer is unavailable for this thread"
        : transferMode === "context" &&
            (sourceEnvironment?.serverConfig?.environment.capabilities.threadHandoffContext !==
              true ||
              selectedEnvironment?.serverConfig?.environment.capabilities.threadHandoffContext !==
                true)
          ? "Both environments must support Conversation context"
          : !selectedProvider ||
              !selectedProvider.enabled ||
              selectedProvider.availability === "unavailable" ||
              selectedProvider.status === "disabled"
            ? "Destination provider unavailable"
            : !selectedProvider.installed
              ? "Destination provider missing"
              : selectedProvider.auth.status === "unauthenticated"
                ? "Destination authentication required"
                : selectedProvider.status === "error"
                  ? "Destination provider is not ready"
                  : transferMode === "context" &&
                      !selectedProvider.models.some((entry) => entry.slug === model)
                    ? "Selected model is no longer available"
                    : !destinationProjects.some((project) => project.id === projectId)
                      ? "Destination project unavailable"
                      : null;
  const eligible = destinationUnavailable === null;
  const visibleReadiness =
    destination && destinationUnavailable
      ? { key: selectionKey, status: "error" as const, message: destinationUnavailable }
      : readiness?.key === selectionKey
        ? readiness
        : destination
          ? { key: selectionKey, status: "checking" as const }
          : null;
  const complete = useCallback(
    (recovery: Recovery) => {
      useThreadWorkspaceStore.getState().remapThreadEnvironment(recovery);
      setRun({ status: "completed", destinationEnvironmentId: recovery.destinationEnvironmentId });
      const destinationRef = {
        threadId: recovery.threadId,
        environmentId: recovery.destinationEnvironmentId,
      };
      const sourcePath = router.buildLocation({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams({
          threadId: recovery.threadId,
          environmentId: recovery.sourceEnvironmentId,
        }),
      }).pathname;
      if (router.state.location.pathname === sourcePath) {
        void router.navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(destinationRef),
          replace: true,
        });
      }
      onTransferred?.(destinationRef);
    },
    [onTransferred, router],
  );

  useEffect(() => {
    if (!open || inFlight.current) return;
    let active = true;
    void deps
      .request(threadRef.environmentId, { operation: "inspect", threadId: threadRef.threadId })
      .then((response) => {
        if (!active) return;
        if (!response.source) throw new Error("Source did not return the thread state.");
        setSource(response.source);
        setSourceError(null);
      })
      .catch((error: unknown) => {
        if (active) setSourceError(message(error));
      });
    return () => {
      active = false;
    };
  }, [open, deps, threadRef.environmentId, threadRef.threadId]);

  useEffect(() => {
    if (!open || busy || !source || !destination || !eligible) return;
    let active = true;
    void deps
      .request(destination.environmentId, {
        operation: "preflight",
        destination: { ...destination, source },
      })
      .then((response) => {
        if (active)
          setReadiness({ key: selectionKey, status: "ready", warnings: response.warnings ?? [] });
      })
      .catch((error: unknown) => {
        if (active) setReadiness({ key: selectionKey, status: "error", message: message(error) });
      });
    return () => {
      active = false;
    };
  }, [open, busy, source, destination, eligible, selectionKey, deps]);

  const execute = async (recovery?: Recovery) => {
    if (
      inFlight.current ||
      (!recovery &&
        (!destination ||
          !eligible ||
          readiness?.key !== selectionKey ||
          readiness.status !== "ready"))
    )
      return;
    const descriptor: Recovery = recovery ?? {
      handoffId: ThreadHandoffId.make(randomUUID()),
      threadId: threadRef.threadId,
      sourceEnvironmentId: threadRef.environmentId,
      destinationEnvironmentId: destination!.environmentId,
    };
    inFlight.current = true;
    const controller = new AbortController();
    abort.current = controller;
    const onProgress = (progress: ThreadHandoffProgress) => setRun({ status: "running", progress });
    try {
      localStorage.setItem(recoveryKey(threadRef), encodeRecovery(descriptor));
      setRun({ status: "running", progress: null });
      const result = recovery
        ? await recoverThreadHandoff(deps, { ...descriptor, onProgress })
        : await runThreadHandoff(deps, {
            ...descriptor,
            destination: destination!,
            mode,
            signal: controller.signal,
            onProgress,
          });
      clearRecovery(threadRef);
      if (result.phase === "completed") complete(descriptor);
      else
        setRun({
          status: "error",
          message: "Transfer rolled back. The thread remains on its source environment.",
          recovery: null,
        });
    } catch (error) {
      const needsRecovery =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "recoveryRequired";
      if (!needsRecovery) clearRecovery(threadRef);
      setRun({
        status: "error",
        message: message(error),
        recovery: needsRecovery ? descriptor : null,
      });
    } finally {
      abort.current = null;
      inFlight.current = false;
    }
  };
  const recovery = run.status === "error" ? run.recovery : null;
  const canCancel =
    busy &&
    run.progress?.phase !== "committed" &&
    run.progress?.phase !== "completed" &&
    run.progress?.phase !== "rollingBack";
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogPopup className="max-w-lg" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>Continue on another environment</DialogTitle>
          <DialogDescription>
            Move this thread and its working changes, choosing how the provider continues.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="grid gap-4 text-sm">
          <div className="rounded-md border bg-muted/30 p-3">
            <p className="font-medium">{thread?.title ?? "Development thread"}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Execution owner: {sourceEnvironment?.label ?? threadRef.environmentId}
            </p>
          </div>
          {run.status !== "completed" && !recovery && (
            <>
              <label className="grid gap-1.5">
                <span className="text-xs font-medium">Continuation type</span>
                <Select
                  value={transferMode}
                  disabled={busy || !source}
                  onValueChange={(value) => {
                    if (value !== "native" && value !== "context") return;
                    setReadiness(null);
                    setTransferMode(value);
                    setProviderId(null);
                    setModel(null);
                  }}
                >
                  <SelectTrigger aria-label="Continuation type">
                    <SelectValue>
                      {transferMode === "native" ? "Native session" : "Conversation context"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="native" disabled={!supportsNative}>
                      Native session
                    </SelectItem>
                    <SelectItem
                      value="context"
                      disabled={
                        sourceEnvironment?.serverConfig?.environment.capabilities
                          .threadHandoffContext !== true
                      }
                    >
                      Conversation context
                    </SelectItem>
                  </SelectPopup>
                </Select>
              </label>
              <p className="text-xs text-muted-foreground">
                {transferMode === "native"
                  ? "Preserve the same provider-native session on a compatible provider."
                  : "Create a new provider session while preserving the full T3 conversation. Its history is delivered with your next message; no continuation message is sent automatically."}
              </p>
              {!supportsNative && source && (
                <p className="text-xs text-muted-foreground">
                  Native session transfer is unavailable for this thread. Choose Conversation
                  context to continue with another provider.
                </p>
              )}
              {sourceEnvironment?.serverConfig?.environment.capabilities.threadHandoffContext !==
                true && (
                <p role="alert">
                  Update the source environment to support Conversation context handoff.
                </p>
              )}
              <label className="grid gap-1.5">
                <span className="text-xs font-medium">Destination environment</span>
                <Select
                  value={destinationId ?? ""}
                  disabled={busy}
                  onValueChange={(value) => {
                    setReadiness(null);
                    setDestinationId(EnvironmentId.make(String(value)));
                    setProjectId(null);
                    setProviderId(null);
                    setModel(null);
                  }}
                >
                  <SelectTrigger aria-label="Destination environment">
                    <SelectValue placeholder="Choose an environment">
                      {selectedEnvironment?.label}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {environments
                      .filter((entry) => entry.environmentId !== threadRef.environmentId)
                      .map((entry) => (
                        <SelectItem
                          key={entry.environmentId}
                          value={entry.environmentId}
                          disabled={
                            entry.connection.phase !== "connected" ||
                            entry.serverConfig?.environment.capabilities.threadHandoff !== true ||
                            (transferMode === "context" &&
                              entry.serverConfig?.environment.capabilities.threadHandoffContext !==
                                true)
                          }
                        >
                          {entry.label}
                          {entry.connection.phase !== "connected"
                            ? " · Offline"
                            : entry.serverConfig?.environment.capabilities.threadHandoff !== true
                              ? " · Handoff unavailable"
                              : transferMode === "context" &&
                                  entry.serverConfig?.environment.capabilities
                                    .threadHandoffContext !== true
                                ? " · Update required for conversation context"
                                : ""}
                        </SelectItem>
                      ))}
                  </SelectPopup>
                </Select>
              </label>
              <label className="grid gap-1.5">
                <span className="text-xs font-medium">Destination provider</span>
                <Select
                  value={providerId ?? ""}
                  disabled={busy || !destinationId || !source}
                  onValueChange={(value) => {
                    setReadiness(null);
                    setProviderId(ProviderInstanceId.make(String(value)));
                    setModel(null);
                  }}
                >
                  <SelectTrigger aria-label="Destination provider">
                    <SelectValue
                      placeholder={
                        source
                          ? transferMode === "native"
                            ? `Choose a ${source.driver} instance`
                            : "Choose a provider"
                          : "Inspecting source thread…"
                      }
                    >
                      {selectedProvider?.displayName}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {providers.map((provider) => (
                      <SelectItem
                        key={provider.instanceId}
                        value={provider.instanceId}
                        disabled={
                          !provider.installed ||
                          provider.status === "error" ||
                          provider.auth.status === "unauthenticated"
                        }
                      >
                        {provider.displayName ?? provider.instanceId}
                        {!provider.installed
                          ? " · Provider missing"
                          : provider.auth.status === "unauthenticated"
                            ? " · Authentication required"
                            : provider.status === "error"
                              ? " · Incompatible"
                              : ""}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </label>
              {destinationId && source && providers.length === 0 && (
                <p role="status">No compatible provider is available in this environment.</p>
              )}
              {transferMode === "context" && (
                <label className="grid gap-1.5">
                  <span className="text-xs font-medium">Destination model</span>
                  <Select
                    value={model ?? ""}
                    disabled={busy || !selectedProvider}
                    onValueChange={(value) => {
                      setReadiness(null);
                      setModel(String(value));
                    }}
                  >
                    <SelectTrigger aria-label="Destination model">
                      <SelectValue placeholder="Choose a model">
                        {selectedProvider?.models.find((entry) => entry.slug === model)?.name}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {selectedProvider?.models.map((entry) => (
                        <SelectItem key={entry.slug} value={entry.slug}>
                          {entry.name}
                          {entry.subProvider ? ` · ${entry.subProvider}` : ""} · {entry.slug}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                  {selectedProvider && selectedProvider.models.length === 0 && (
                    <span className="text-xs text-muted-foreground">
                      This provider reports no models. Configure a model in the destination
                      environment.
                    </span>
                  )}
                </label>
              )}
              <label className="grid gap-1.5">
                <span className="text-xs font-medium">Destination project</span>
                <Select
                  value={projectId ?? ""}
                  disabled={busy || !destinationId}
                  onValueChange={(value) => {
                    setReadiness(null);
                    setProjectId(ProjectId.make(String(value)));
                  }}
                >
                  <SelectTrigger aria-label="Destination project">
                    <SelectValue placeholder="Choose the matching repository">
                      {destinationProjects.find((project) => project.id === projectId)?.title}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {destinationProjects.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.title}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </label>
              <label className="grid gap-1.5">
                <span className="text-xs font-medium">Safe point</span>
                <Select
                  value={mode}
                  disabled={busy}
                  onValueChange={(value) => {
                    if (value === "idle" || value === "afterTurn" || value === "interrupt")
                      setMode(value);
                  }}
                >
                  <SelectTrigger aria-label="Transfer safe point">
                    <SelectValue>
                      {mode === "idle"
                        ? "Transfer when already idle"
                        : mode === "afterTurn"
                          ? "Transfer after the current turn"
                          : "Stop and transfer now"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="idle">Transfer when already idle</SelectItem>
                    <SelectItem value="afterTurn">Transfer after the current turn</SelectItem>
                    <SelectItem value="interrupt">Stop and transfer now</SelectItem>
                  </SelectPopup>
                </Select>
              </label>
              <p className="text-xs text-muted-foreground">
                Working changes and staging are transferred. Development servers, terminals and
                local services must be recreated separately.
              </p>
            </>
          )}
          {sourceError && !recovery && (
            <p role="alert" className="text-destructive">
              {sourceError}
            </p>
          )}
          {!busy && visibleReadiness && !recovery && (
            <div role="status" className="rounded-md border p-3">
              <p>
                {visibleReadiness.status === "ready"
                  ? transferMode === "native"
                    ? "Destination ready · Native session compatible"
                    : "Destination ready · New provider session with conversation context"
                  : visibleReadiness.status === "checking"
                    ? "Verifying destination…"
                    : "message" in visibleReadiness
                      ? visibleReadiness.message
                      : undefined}
              </p>
              {("warnings" in visibleReadiness ? visibleReadiness.warnings : undefined)?.map(
                (warning) => (
                  <p key={warning} className="mt-1 text-xs text-muted-foreground">
                    {warning}
                  </p>
                ),
              )}
            </div>
          )}
          {busy && (
            <div role="status" aria-live="polite" className="rounded-md border p-3">
              <p className="font-medium">
                {run.progress ? phaseLabels[run.progress.phase] : "Checking transfer ownership…"}
              </p>
              {run.progress?.transfer && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {run.progress.transfer.transferredFiles} of {run.progress.transfer.totalFiles}{" "}
                  files · {Math.round(run.progress.transfer.transferredBytes / 1024)} KiB
                  transferred
                </p>
              )}
            </div>
          )}
          {run.status === "error" && (
            <p role="alert" className="text-destructive">
              {run.message}
            </p>
          )}
          {run.status === "completed" && (
            <p role="status" className="rounded-md border p-3">
              Thread now belongs to{" "}
              {environments.find((entry) => entry.environmentId === run.destinationEnvironmentId)
                ?.label ?? run.destinationEnvironmentId}
              . Continue this thread there with your next message.
            </p>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={busy && !canCancel}
            onClick={() => (busy ? abort.current?.abort() : onOpenChange(false))}
          >
            {busy ? "Cancel transfer" : "Close"}
          </Button>
          {run.status !== "completed" && (
            <Button
              disabled={
                busy ||
                (!recovery &&
                  (!source ||
                    !!sourceError ||
                    !destination ||
                    !eligible ||
                    !selectedProvider ||
                    (transferMode === "context" &&
                      !selectedProvider.models.some((entry) => entry.slug === model)) ||
                    readiness?.key !== selectionKey ||
                    readiness.status !== "ready"))
              }
              onClick={() => {
                void execute(recovery ?? undefined);
              }}
            >
              {recovery ? "Recover transfer" : "Continue on destination"}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function ThreadHandoffDialogHost() {
  const [threadRef, setThreadRef] = useState<ScopedThreadRef | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const listener = (event: Event) => {
      if (!open && event instanceof CustomEvent && isThreadRef(event.detail)) {
        setThreadRef(event.detail);
        setOpen(true);
      }
    };
    window.addEventListener(THREAD_HANDOFF_EVENT, listener);
    return () => window.removeEventListener(THREAD_HANDOFF_EVENT, listener);
  }, [open]);
  return open && threadRef ? (
    <ThreadHandoffDialog
      key={`${threadRef.environmentId}:${threadRef.threadId}`}
      open={open}
      onOpenChange={setOpen}
      threadRef={threadRef}
    />
  ) : null;
}
