import { useEffect, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  EnvironmentId,
  ThreadId,
  ThreadHandoffId,
  WS_METHODS,
  type ThreadHandoffDestination,
  type ThreadHandoffSource,
  type ProjectId,
  type ModelSelection,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import {
  runThreadHandoff,
  recoverThreadHandoff,
  type ThreadHandoffDeps,
  type ThreadHandoffProgress,
} from "@t3tools/client-runtime/operations/thread-handoff";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { AppText as Text } from "../../components/AppText";
import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentSession } from "../../state/session";
import { useProjects, useServerConfigs } from "../../state/entities";
import { useWorkspaceState } from "../../state/workspace";
import { buildModelOptions } from "../../lib/modelOptions";
import { uuidv4 } from "../../lib/uuid";
import { useEnvironmentQuery } from "../../state/query";
import { writeFileAtomically } from "../../lib/atomic-file";

const watchHandoff = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "thread-handoff:watch",
  tag: WS_METHODS.threadHandoffWatch,
  idleTtlMs: 0,
});
export function useThreadHandoffWatch(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
) {
  return useEnvironmentQuery(
    environmentId && threadId ? watchHandoff({ environmentId, input: { threadId } }) : null,
  );
}
const command = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "thread-handoff",
  tag: WS_METHODS.threadHandoffRequest,
});
const deps: ThreadHandoffDeps = {
  request: async (environmentId, input) => {
    const result = await runAtomCommand(
      appAtomRegistry,
      command,
      { environmentId, input },
      { reportFailure: false },
    );
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    return result.value;
  },
  fetch: (url, init) => fetch(url, init),
  streamingUploadSupported: false,
  resolveUrl: (environmentId, relativeUrl) => {
    const connection = appAtomRegistry.get(
      environmentSession.preparedConnectionValueAtom(environmentId),
    );
    return Option.isNone(connection)
      ? null
      : resolveAssetUrl(connection.value.httpBaseUrl, relativeUrl);
  },
};
const Recovery = Schema.Struct({
  handoffId: ThreadHandoffId,
  threadId: ThreadId,
  sourceEnvironmentId: EnvironmentId,
  destinationEnvironmentId: EnvironmentId,
});
type Recovery = typeof Recovery.Type;
const decodeRecovery = Schema.decodeUnknownSync(Schema.fromJsonString(Recovery));
async function recoveryFile(environmentId: EnvironmentId, threadId: ThreadId) {
  const { File, Paths } = await import("expo-file-system");
  return new File(
    Paths.document,
    "thread-handoffs",
    `${encodeURIComponent(environmentId)}-${encodeURIComponent(threadId)}.json`,
  );
}
export const threadHandoffPhaseLabels: Record<ThreadHandoffProgress["phase"], string> = {
  preflighting: "Checking destination / waiting for current turn",
  pausing: "Pausing agent",
  checkpointing: "Created checkpoint",
  syncingProjects: "Transferring project and conversation state",
  transferringSession: "Transferring conversation state",
  verifying: "Verifying destination",
  ready: "Destination ready",
  committed: "Switching execution owner",
  completed: "Transfer completed",
  rollingBack: "Restoring source ownership",
  failed: "Source remains resumable",
  cancelled: "Transfer cancelled",
};

export function ThreadHandoffSheet(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  onClose: () => void;
  onComplete: (environmentId: EnvironmentId) => void;
}) {
  const { environments } = useWorkspaceState();
  const watched = useThreadHandoffWatch(props.environmentId, props.threadId);
  const configs = useServerConfigs();
  const projects = useProjects();
  const [source, setSource] = useState<ThreadHandoffSource | null>(null);
  const [destination, setDestination] = useState<Omit<ThreadHandoffDestination, "source"> | null>(
    null,
  );
  const [transferMode, setTransferMode] = useState<"native" | "context">("native");
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<ProjectId | null>(null);
  const [mode, setMode] = useState<"idle" | "afterTurn" | "interrupt">("idle");
  const [progress, setProgress] = useState<ThreadHandoffProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<readonly string[]>([]);
  const [pending, setPending] = useState<Recovery | null>(null);
  const [busy, setBusy] = useState(false);
  const [cancellable, setCancellable] = useState(false);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const abort = useRef<AbortController | null>(null);
  const initializedTransferMode = useRef(false);
  useEffect(() => {
    let active = true;
    void (async () => {
      const file = await recoveryFile(props.environmentId, props.threadId);
      if (file.exists) {
        const saved = decodeRecovery(await file.text());
        if (saved.sourceEnvironmentId !== props.environmentId || saved.threadId !== props.threadId)
          throw new Error("Saved handoff does not match this thread.");
        if (active) setPending(saved);
      }
      const result = await deps.request(props.environmentId, {
        operation: "inspect",
        threadId: props.threadId,
      });
      if (active) {
        setSource(result.source ?? null);
      }
    })()
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [props.environmentId, props.threadId]);
  const sourceProject = projects.find(
    (project) => project.environmentId === props.environmentId && project.id === source?.projectId,
  );
  const selectedConfig = selectedEnvironmentId ? configs.get(selectedEnvironmentId) : null;
  const sourceConfig = configs.get(props.environmentId);
  const supportsNative =
    source?.supportsNativeHandoff ??
    (!!source?.sessionId &&
      sourceConfig?.providers.some(
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
  const selectedProjects = projects.filter(
    (project) => project.environmentId === selectedEnvironmentId,
  );
  const modelOptions = buildModelOptions(selectedConfig, null).filter((option) =>
    selectedConfig?.providers.some(
      (provider) =>
        provider.instanceId === option.selection.instanceId && provider.supportsContextHandoff,
    ),
  );
  const nativeProviders =
    selectedConfig?.providers.filter(
      (provider) =>
        provider.enabled && provider.supportsSessionHandoff && provider.driver === source?.driver,
    ) ?? [];
  const destinationProvider = selectedConfig?.providers.find(
    (provider) => provider.instanceId === destination?.providerInstanceId,
  );
  const destinationUnavailable =
    environments.find((entry) => entry.environmentId === selectedEnvironmentId)?.connectionState !==
    "connected"
      ? "Destination offline"
      : !selectedConfig?.environment.capabilities.threadHandoff
        ? "Destination handoff is unavailable"
        : transferMode === "context" &&
            (!sourceConfig?.environment.capabilities.threadHandoffContext ||
              !selectedConfig.environment.capabilities.threadHandoffContext)
          ? "Both environments must support Conversation context"
          : !destinationProvider ||
              !destinationProvider.enabled ||
              destinationProvider.availability === "unavailable" ||
              destinationProvider.status === "disabled"
            ? "Destination provider unavailable"
            : !destinationProvider.installed
              ? "Destination provider missing"
              : destinationProvider.auth.status === "unauthenticated"
                ? "Destination authentication required"
                : destinationProvider.status === "error"
                  ? "Destination provider is not ready"
                  : transferMode === "native" &&
                      (!supportsNative ||
                        !destinationProvider.supportsSessionHandoff ||
                        destinationProvider.driver !== source?.driver)
                    ? "Native session compatibility unavailable"
                    : transferMode === "context" &&
                        (!destinationProvider.supportsContextHandoff ||
                          !destinationProvider.models.some(
                            (model) => model.slug === destination?.modelSelection?.model,
                          ))
                      ? "Selected model is no longer available"
                      : !selectedProjects.some((project) => project.id === selectedProjectId)
                        ? "Destination project unavailable"
                        : null;
  const destinationReady = ready && destinationUnavailable === null;
  const checkDestination = (
    providerInstanceId: ProviderInstanceId,
    modelSelection?: ModelSelection,
  ) => {
    if (!source || !selectedEnvironmentId || !selectedProjectId || busy) return;
    if (
      transferMode === "context" &&
      (!sourceConfig?.environment.capabilities.threadHandoffContext ||
        !selectedConfig?.environment.capabilities.threadHandoffContext)
    )
      return;
    const next = {
      environmentId: selectedEnvironmentId,
      providerInstanceId,
      transferMode,
      ...(modelSelection ? { modelSelection } : {}),
      projects: [{ sourceProjectId: source.projectId, destinationProjectId: selectedProjectId }],
    };
    setDestination(next);
    setReady(false);
    setBusy(true);
    setError(null);
    setWarnings([]);
    void deps
      .request(selectedEnvironmentId, { operation: "preflight", destination: { ...next, source } })
      .then((result) => {
        setReady(true);
        setWarnings(result.warnings ?? []);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };
  const remoteRecord = watched.data;
  const remoteRecovery =
    remoteRecord && remoteRecord.owner.environmentId === props.environmentId
      ? {
          handoffId: remoteRecord.handoffId,
          threadId: remoteRecord.owner.threadId,
          sourceEnvironmentId: remoteRecord.owner.environmentId,
          destinationEnvironmentId: remoteRecord.destinationEnvironmentId,
        }
      : null;
  const effectivePending =
    pending ??
    (watched.data && !["completed", "failed", "cancelled"].includes(watched.data.phase)
      ? remoteRecovery
      : null);
  const perform = async (recover: boolean) => {
    if (!recover && (!destination || !destinationReady)) return;
    const operation = recover
      ? (pending ?? remoteRecovery)
      : destination
        ? {
            handoffId: ThreadHandoffId.make(uuidv4()),
            threadId: props.threadId,
            sourceEnvironmentId: props.environmentId,
            destinationEnvironmentId: destination.environmentId,
          }
        : null;
    if (!operation) return;
    setBusy(true);
    setError(null);
    try {
      const file = await recoveryFile(props.environmentId, props.threadId);
      await writeFileAtomically(file, JSON.stringify(operation));
      setPending(operation);
      abort.current = new AbortController();
      setCancellable(!recover);
      const result = recover
        ? await recoverThreadHandoff(deps, { ...operation, onProgress: setProgress })
        : await runThreadHandoff(deps, {
            ...operation,
            destination: destination!,
            mode,
            signal: abort.current.signal,
            onProgress: setProgress,
          });
      file.delete();
      setPending(null);
      if (result.phase === "completed") props.onComplete(operation.destinationEnvironmentId);
    } catch (cause) {
      if (
        !recover &&
        !(
          typeof cause === "object" &&
          cause !== null &&
          "code" in cause &&
          cause.code === "recoveryRequired"
        )
      ) {
        try {
          const saved = await recoveryFile(props.environmentId, props.threadId);
          if (saved.exists) saved.delete();
          setPending(null);
        } catch {
          /* Keep the durable record if local cleanup fails. */
        }
      }
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
      abort.current = null;
      setCancellable(false);
    }
  };
  return (
    <Modal
      presentationStyle="pageSheet"
      animationType="slide"
      onRequestClose={() => {
        if (!busy) props.onClose();
      }}
    >
      <ScrollView
        className="bg-screen flex-1"
        contentContainerStyle={{ padding: 24, paddingTop: 48, gap: 18 }}
      >
        <Text className="text-foreground text-xl font-semibold">Continue thread on…</Text>
        <Text className="text-muted-foreground">
          Running services stay on the source. Keep this app open during transfer.
        </Text>
        {effectivePending ? (
          <Text className="text-foreground">
            Pending transfer to{" "}
            {environments.find(
              (item) => item.environmentId === effectivePending.destinationEnvironmentId,
            )?.environmentLabel ?? effectivePending.destinationEnvironmentId}
            . Recover its authoritative ownership before starting another transfer.
          </Text>
        ) : (
          <View className="gap-4">
            {(
              [
                ["native", "Native session"],
                ["context", "Conversation context"],
              ] as const
            ).map(([value, label]) => {
              const supported =
                value === "native"
                  ? supportsNative
                  : sourceConfig?.environment.capabilities.threadHandoffContext;
              return (
                <Pressable
                  key={value}
                  accessibilityRole="radio"
                  accessibilityState={{
                    checked: transferMode === value,
                    disabled: !supported || busy,
                  }}
                  disabled={!supported || busy}
                  onPress={() => {
                    setTransferMode(value);
                    setDestination(null);
                    setSelectedEnvironmentId(null);
                    setSelectedProjectId(null);
                    setReady(false);
                  }}
                >
                  <Text className="text-foreground">
                    {transferMode === value ? "●" : "○"} {label}
                    {!supported ? " · Unavailable" : ""}
                  </Text>
                </Pressable>
              );
            })}
            <Text className="text-muted-foreground">
              {transferMode === "native"
                ? "Continue the same native session on a compatible provider."
                : "Create a new provider session and preserve the full T3 conversation. History is delivered with your next message; no continuation message is sent automatically."}
            </Text>
            {!sourceConfig?.environment.capabilities.threadHandoffContext && (
              <Text className="text-muted-foreground">
                Update the source environment to use Conversation context with all providers.
              </Text>
            )}
            {environments
              .filter((item) => item.environmentId !== props.environmentId)
              .map((item) => {
                const config = configs.get(item.environmentId);
                const reason =
                  item.connectionState !== "connected"
                    ? "Offline"
                    : !config?.environment.capabilities.threadHandoff
                      ? "Handoff unavailable"
                      : transferMode === "context" &&
                          !config.environment.capabilities.threadHandoffContext
                        ? "Update required for conversation context"
                        : "Select environment";
                const enabled = !busy && !loading && !!source && reason === "Select environment";
                return (
                  <Pressable
                    key={item.environmentId}
                    accessibilityRole="button"
                    disabled={!enabled}
                    className="rounded-xl bg-surface p-4"
                    onPress={() => {
                      setSelectedEnvironmentId(item.environmentId);
                      const matches = projects.filter(
                        (project) =>
                          project.environmentId === item.environmentId &&
                          project.title === sourceProject?.title,
                      );
                      setSelectedProjectId(matches.length === 1 ? matches[0]!.id : null);
                      setDestination(null);
                      setReady(false);
                      setError(null);
                    }}
                  >
                    <Text className="text-foreground font-semibold">
                      {selectedEnvironmentId === item.environmentId ? "● " : ""}
                      {item.environmentLabel}
                    </Text>
                    <Text className="text-muted-foreground">{reason}</Text>
                  </Pressable>
                );
              })}
            {selectedEnvironmentId && (
              <>
                <Text className="text-foreground font-semibold">Destination project</Text>
                {selectedProjects.map((project) => (
                  <Pressable
                    key={project.id}
                    disabled={busy}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: selectedProjectId === project.id }}
                    onPress={() => {
                      setSelectedProjectId(project.id);
                      setDestination(null);
                      setReady(false);
                    }}
                  >
                    <Text className="text-foreground">
                      {selectedProjectId === project.id ? "●" : "○"} {project.title}
                    </Text>
                  </Pressable>
                ))}
                {selectedProjects.length === 0 && (
                  <Text className="text-muted-foreground">
                    Add the matching repository to this environment first.
                  </Text>
                )}
                <Text className="text-foreground font-semibold">
                  {transferMode === "context"
                    ? "Destination provider and model"
                    : "Destination provider"}
                </Text>
                {transferMode === "context"
                  ? modelOptions.map((option) => (
                      <Pressable
                        key={option.key}
                        disabled={busy || !selectedProjectId || option.isUnavailable}
                        accessibilityRole="radio"
                        accessibilityState={{
                          checked:
                            destination?.modelSelection?.instanceId ===
                              option.selection.instanceId &&
                            destination.modelSelection.model === option.selection.model,
                        }}
                        className="rounded-xl bg-surface p-3"
                        onPress={() =>
                          checkDestination(option.selection.instanceId, option.selection)
                        }
                      >
                        <Text className="text-foreground">
                          {option.providerLabel} · {option.label}
                        </Text>
                        <Text className="text-muted-foreground">
                          {option.subtitle} {option.selection.model}
                        </Text>
                      </Pressable>
                    ))
                  : nativeProviders.map((provider) => (
                      <Pressable
                        key={provider.instanceId}
                        disabled={
                          busy ||
                          !selectedProjectId ||
                          !provider.installed ||
                          provider.auth.status === "unauthenticated" ||
                          provider.status === "error"
                        }
                        accessibilityRole="button"
                        onPress={() => checkDestination(provider.instanceId)}
                      >
                        <Text className="text-foreground">
                          {provider.displayName ?? provider.instanceId}
                          {!provider.installed
                            ? " · Provider missing"
                            : provider.auth.status === "unauthenticated"
                              ? " · Authentication required"
                              : ""}
                        </Text>
                      </Pressable>
                    ))}
                {transferMode === "native" && nativeProviders.length === 0 && (
                  <Text className="text-muted-foreground">
                    No compatible native provider is configured in this environment.
                  </Text>
                )}
                {transferMode === "context" && modelOptions.length === 0 && (
                  <Text className="text-muted-foreground">
                    No models are available. Install and authenticate a provider, then configure its
                    models.
                  </Text>
                )}
                {destinationReady && (
                  <Text accessibilityLiveRegion="polite" className="text-foreground">
                    Destination ready ·{" "}
                    {transferMode === "native"
                      ? "Native session compatible"
                      : "New session with conversation context"}
                  </Text>
                )}
              </>
            )}
          </View>
        )}
        {!effectivePending &&
          (
            [
              ["idle", "Transfer when idle"],
              ["afterTurn", "Transfer after current turn"],
              ["interrupt", "Stop and transfer now"],
            ] as const
          ).map(([value, label]) => (
            <Pressable
              key={value}
              disabled={busy}
              accessibilityRole="radio"
              accessibilityState={{ checked: mode === value }}
              onPress={() => setMode(value)}
            >
              <Text className="text-foreground">
                {mode === value ? "●" : "○"} {label}
              </Text>
            </Pressable>
          ))}
        {!busy && destination && destinationUnavailable && (
          <Text accessibilityRole="alert" className="text-destructive">
            {destinationUnavailable}
          </Text>
        )}
        {watched.data && !progress ? (
          <Text accessibilityLiveRegion="polite" className="text-foreground">
            {threadHandoffPhaseLabels[watched.data.phase]}
            {watched.data.failure ? `: ${watched.data.failure}` : ""}
          </Text>
        ) : null}
        {watched.error ? <Text className="text-destructive">{watched.error}</Text> : null}
        {progress ? (
          <Text accessibilityLiveRegion="polite" className="text-foreground">
            {threadHandoffPhaseLabels[progress.phase]}
          </Text>
        ) : null}
        {destinationReady &&
          warnings.map((warning) => (
            <Text key={warning} className="text-muted-foreground">
              {warning}
            </Text>
          ))}
        {error ? (
          <Text accessibilityRole="alert" className="text-destructive">
            {error}
          </Text>
        ) : null}
        <View className="gap-4">
          {effectivePending ? (
            <Pressable disabled={busy} onPress={() => void perform(true)}>
              <Text className="text-primary">Recover transfer</Text>
            </Pressable>
          ) : (
            <Pressable disabled={busy || !destinationReady} onPress={() => void perform(false)}>
              <Text className="text-primary">Continue on selected environment</Text>
            </Pressable>
          )}
          {busy &&
          cancellable &&
          progress?.phase !== "committed" &&
          progress?.phase !== "completed" ? (
            <Pressable onPress={() => abort.current?.abort()}>
              <Text className="text-primary">Cancel transfer</Text>
            </Pressable>
          ) : null}
          {!busy ? (
            <Pressable onPress={props.onClose}>
              <Text className="text-foreground">Close</Text>
            </Pressable>
          ) : null}
        </View>
      </ScrollView>
    </Modal>
  );
}
