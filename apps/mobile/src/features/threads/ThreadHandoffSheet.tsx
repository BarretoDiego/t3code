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
  syncingProjects: "Transferring project and native session",
  transferringSession: "Transferring native session",
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
  const [mode, setMode] = useState<"idle" | "afterTurn" | "interrupt">("idle");
  const [progress, setProgress] = useState<ThreadHandoffProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Recovery | null>(null);
  const [busy, setBusy] = useState(false);
  const [cancellable, setCancellable] = useState(false);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const abort = useRef<AbortController | null>(null);
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
      if (active) setSource(result.source ?? null);
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
    if (!recover && (!destination || !ready)) return;
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
          Native session handoff. Running services stay on the source. Keep this app open during
          transfer.
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
          environments
            .filter((item) => item.environmentId !== props.environmentId)
            .map((item) => {
              const config = configs.get(item.environmentId);
              const provider = config?.providers.find(
                (candidate) =>
                  candidate.driver === source?.driver && candidate.supportsSessionHandoff,
              );
              const matches = projects.filter(
                (project) =>
                  project.environmentId === item.environmentId &&
                  project.title === sourceProject?.title,
              );
              const project = matches.length === 1 ? matches[0] : null;
              const reason =
                item.connectionState !== "connected"
                  ? "Offline"
                  : !config?.environment.capabilities.threadHandoff
                    ? "Incompatible"
                    : !provider
                      ? "Provider unavailable"
                      : !project
                        ? "Matching project required"
                        : "Check readiness";
              const enabled = !busy && !loading && !!source && reason === "Check readiness";
              return (
                <Pressable
                  key={item.environmentId}
                  accessibilityRole="button"
                  disabled={!enabled}
                  className="rounded-xl bg-surface p-4"
                  onPress={() => {
                    if (!provider || !project || !source) return;
                    const next = {
                      environmentId: item.environmentId,
                      providerInstanceId: provider.instanceId,
                      projects: [
                        { sourceProjectId: source.projectId, destinationProjectId: project.id },
                      ],
                    };
                    setDestination(next);
                    setReady(false);
                    setBusy(true);
                    setError(null);
                    void deps
                      .request(item.environmentId, {
                        operation: "preflight",
                        destination: { ...next, source },
                      })
                      .then(() => setReady(true))
                      .catch((cause: unknown) =>
                        setError(cause instanceof Error ? cause.message : String(cause)),
                      )
                      .finally(() => setBusy(false));
                  }}
                >
                  <Text className="text-foreground font-semibold">{item.environmentLabel}</Text>
                  <Text className="text-muted-foreground">
                    {destination?.environmentId === item.environmentId && ready ? "Ready" : reason}
                  </Text>
                </Pressable>
              );
            })
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
            <Pressable disabled={busy || !ready} onPress={() => void perform(false)}>
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
