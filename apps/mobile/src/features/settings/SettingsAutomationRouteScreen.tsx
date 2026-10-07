import {
  summarizeHookFilter,
  summarizeHookTarget,
} from "@t3tools/client-runtime/state/automation-drafts";
import {
  environmentSupportsAutomation,
  formatAutomationAge,
  inboxEntryPreview,
  joinOrchestratorsToThreads,
  orchestratorScopeLabel,
  orchestratorStateActions,
  type OrchestratorView,
  presentAutomationActivity,
  presentAutomationError,
  presentDelegatedTasks,
  presentNodeAvailability,
  presentObservation,
  presentOrchestratorBudget,
  presentOrchestratorState,
  presentPeerConnectionStatus,
  presentResponsibility,
  resolveEnvironmentReachability,
  resolveOrchestratorView,
  summarizeOrchestratorInbox,
} from "@t3tools/client-runtime/state/automation-presentation";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, OrchestratorId } from "@t3tools/contracts";
import { resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { type StaticScreenProps, useFocusEffect, useNavigation } from "@react-navigation/native";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Alert, AppState, Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { automationEnvironment, useOrchestratorView } from "../../state/automation";
import { useThreadShells } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { AutomationStatusLabel, ObservationText } from "../automation/automation-status";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "./settings-environment-filter";

const INBOX_PAGE_SIZE = 50;
const TASK_ROWS = 10;
const ACTIVITY_ROWS = 8;
const INBOX_STATUSES = ["reserved", "unknown"] as const;
const ACTIVITY_TYPES = [
  "task.*",
  "request.*",
  "turn.*",
  "orchestrator.*",
  "orchestrator.changed",
  "orchestrator.turn.finished",
] as const;

/** A clock that ticks once a minute while the screen is focused, for "5m ago" labels. */
function useMinuteClock(): number {
  const [now, setNow] = useState(Date.now);
  useFocusEffect(
    useCallback(() => {
      const update = () => setNow(Date.now());
      update();
      const timer = setInterval(update, 60_000);
      const subscription = AppState.addEventListener("change", (state) => {
        if (state === "active") update();
      });
      return () => {
        clearInterval(timer);
        subscription.remove();
      };
    }, []),
  );
  return now;
}

function reportFailure(title: string, result: AtomCommandResult<unknown, unknown>): boolean {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return false;
  const error = presentAutomationError(squashAtomCommandFailure(result));
  Alert.alert(error.outcomeUnknown ? `${title}: outcome unknown` : title, error.message);
  return true;
}

function Row(props: {
  readonly first: boolean;
  readonly children: ReactNode;
  readonly onPress?: () => void;
  readonly accessibilityLabel?: string;
}) {
  const className = props.first
    ? "gap-1 px-4 py-3"
    : "gap-1 border-t border-border-subtle px-4 py-3";
  if (!props.onPress) return <View className={className}>{props.children}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      onPress={props.onPress}
      className={`${className} active:opacity-70`}
    >
      {props.children}
    </Pressable>
  );
}

function Note(props: { readonly children: ReactNode; readonly danger?: boolean }) {
  return (
    <Text
      className={
        props.danger
          ? "p-4 text-base text-danger-foreground"
          : "p-4 text-base text-foreground-muted"
      }
    >
      {props.children}
    </Text>
  );
}

function environmentIcon(environment: SettingsTarget) {
  return (
    <EnvironmentMachineSymbol
      kind={resolveEnvironmentMachineKind(environment.serverConfig)}
      size={16}
      tintColorClassName={Platform.OS === "android" ? "accent-primary" : "accent-foreground-muted"}
    />
  );
}

/**
 * Orchestrators, hooks, peers and nodes of each connected environment.
 *
 * Read-only apart from pausing and resuming an orchestrator: creating and
 * editing these needs the long forms and JSON fields of the desktop and web
 * settings, and peers are added with a credential minted in a terminal.
 */
export function SettingsAutomationRouteScreen() {
  const now = useMinuteClock();
  const insets = useSafeAreaInsets();
  const { availableTargets, selectedTargets } = useSettingsEnvironmentFilter();
  const environments = selectedTargets.filter((target) =>
    environmentSupportsAutomation(target.serverConfig),
  );
  const labelOf = useCallback(
    (environmentId: string) =>
      availableTargets.find((target) => target.environmentId === environmentId)?.label ??
      environmentId,
    [availableTargets],
  );
  return (
    <SettingsScreen title="Automation">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {environments.length === 0 ? (
          <Text className="px-2 text-base text-foreground-muted">
            {availableTargets.length === 0
              ? "Connect an environment to see its automation."
              : "The selected environments run a T3 Code server from before automation. Update the server on that machine."}
          </Text>
        ) : (
          <>
            <Text className="px-2 text-sm text-foreground-muted">
              You can pause and resume orchestrators here. To create or edit orchestrators, hooks,
              peers and nodes, use T3 Code on desktop or web, or the t3 CLI.
            </Text>
            {environments.map((environment) => (
              <View key={environment.environmentId} className="gap-5">
                <EnvironmentOrchestrators environment={environment} now={now} labelOf={labelOf} />
                <EnvironmentHooks environment={environment} />
                <EnvironmentPeers environment={environment} now={now} />
                <EnvironmentNodes environment={environment} now={now} />
              </View>
            ))}
          </>
        )}
      </ScrollView>
    </SettingsScreen>
  );
}

function EnvironmentOrchestrators(props: {
  readonly environment: SettingsTarget;
  readonly now: number;
  readonly labelOf: (environmentId: string) => string;
}) {
  const { environment } = props;
  const environmentId = environment.environmentId;
  const navigation = useNavigation();
  const threads = useThreadShells();
  const query = useEnvironmentQuery(
    automationEnvironment.orchestratorsLive({ environmentId, input: {} }),
  );
  const rows = useMemo(
    () =>
      query.data === null
        ? null
        : joinOrchestratorsToThreads({
            snapshot: { environmentId, orchestrators: query.data.orchestrators },
            threads,
          }),
    [environmentId, query.data, threads],
  );
  return (
    <SettingsSection
      title={`${environment.label} · Orchestrators`}
      titleIcon={environmentIcon(environment)}
    >
      {rows === null ? (
        query.error ? (
          <Note danger>{query.error}</Note>
        ) : (
          <Note>Loading orchestrators…</Note>
        )
      ) : rows.length === 0 ? (
        <Note>No orchestrators.</Note>
      ) : (
        rows.map((row, index) => {
          const { orchestrator, hostedHere } = row.view;
          return (
            <Row
              key={row.view.key}
              first={index === 0}
              accessibilityLabel={`${orchestrator.name}, ${row.state.label}. Open details`}
              onPress={() =>
                navigation.navigate("SettingsSheet", {
                  screen: "SettingsContent",
                  params: {
                    screen: "SettingsAutomationOrchestrator",
                    params: { environmentId, orchestratorId: orchestrator.id },
                  },
                })
              }
            >
              <View className="flex-row items-center gap-2">
                <Text
                  className="min-w-0 flex-1 text-lg font-t3-medium text-foreground"
                  numberOfLines={1}
                >
                  {orchestrator.name}
                </Text>
                <AutomationStatusLabel status={row.state} size="base" />
                <SymbolView
                  name="chevron.right"
                  size={14}
                  tintColorClassName="accent-chevron"
                  type="monochrome"
                />
              </View>
              <Text className="text-sm text-foreground-muted" numberOfLines={2}>
                {orchestratorScopeLabel(orchestrator.scope)} ·{" "}
                {hostedHere
                  ? "hosted here"
                  : `hosted on ${props.labelOf(orchestrator.hostEnvironmentId)}`}{" "}
                · {orchestrator.modelSelection.model} · {orchestrator.inboxPending} in inbox
              </Text>
              {hostedHere ? null : (
                <ObservationText
                  observation={presentObservation({
                    observedAt: orchestrator.observedAt,
                    nowMs: props.now,
                  })}
                />
              )}
            </Row>
          );
        })
      )}
    </SettingsSection>
  );
}

function EnvironmentHooks({ environment }: { readonly environment: SettingsTarget }) {
  const environmentId = environment.environmentId;
  const hooks = useEnvironmentQuery(automationEnvironment.hooks({ environmentId, input: {} }));
  const orchestrators = useEnvironmentQuery(
    automationEnvironment.orchestratorsLive({ environmentId, input: {} }),
  );
  const nameOf = (orchestratorId: string) =>
    orchestrators.data?.orchestrators.find((entry) => entry.id === orchestratorId)?.name ?? null;
  return (
    <SettingsSection
      title={`${environment.label} · Hooks`}
      titleIcon={environmentIcon(environment)}
    >
      {hooks.data === null ? (
        hooks.error ? (
          <Note danger>{hooks.error}</Note>
        ) : (
          <Note>Loading hooks…</Note>
        )
      ) : hooks.data.hooks.length === 0 ? (
        <Note>No hooks.</Note>
      ) : (
        hooks.data.hooks.map((hook, index) => {
          const target = summarizeHookTarget(hook.target, nameOf);
          return (
            <Row key={hook.id} first={index === 0}>
              <View className="flex-row items-center gap-2">
                <Text
                  className="min-w-0 flex-1 text-lg font-t3-medium text-foreground"
                  numberOfLines={1}
                >
                  {hook.name}
                </Text>
                <Text className="text-sm text-foreground-muted">
                  {hook.enabled ? "Enabled" : "Disabled"}
                </Text>
              </View>
              <Text className="text-sm text-foreground-muted" numberOfLines={3}>
                When {summarizeHookFilter(hook.filter)} → {target.label}
              </Text>
              {target.needsOperatorAllowlist ? (
                <Text className="text-xs text-warning-foreground">
                  Works only if the server operator allowed this destination.
                </Text>
              ) : null}
            </Row>
          );
        })
      )}
    </SettingsSection>
  );
}

function EnvironmentPeers(props: { readonly environment: SettingsTarget; readonly now: number }) {
  const { environment } = props;
  const environmentId = environment.environmentId;
  const peers = useEnvironmentQuery(automationEnvironment.peers({ environmentId, input: {} }));
  return (
    <SettingsSection
      title={`${environment.label} · Peers`}
      titleIcon={environmentIcon(environment)}
    >
      {peers.data === null ? (
        peers.error ? (
          <Note danger>{peers.error}</Note>
        ) : (
          <Note>Loading peers…</Note>
        )
      ) : peers.data.peers.length === 0 ? (
        <Note>No peers.</Note>
      ) : (
        peers.data.peers.map((peer, index) => (
          <Row key={peer.environmentId} first={index === 0}>
            <View className="flex-row items-center gap-2">
              <Text
                className="min-w-0 flex-1 text-lg font-t3-medium text-foreground"
                numberOfLines={1}
              >
                {peer.name}
              </Text>
              <AutomationStatusLabel
                status={presentPeerConnectionStatus(peer.status)}
                size="base"
              />
            </View>
            <ObservationText
              observation={presentObservation({
                observedAt: peer.lastObservedAt,
                nowMs: props.now,
                reachable: peer.status === "connected",
                verb: "Seen",
              })}
            />
            <Text className="text-sm text-foreground-muted" numberOfLines={3}>
              {peer.enabled ? "" : "Disabled · "}
              {peer.outboxPending} waiting to send · may ask for{" "}
              {peer.permissions.inbound.length === 0
                ? "nothing"
                : peer.permissions.inbound.join(", ")}
              {peer.statusReason ? ` · ${peer.statusReason}` : ""}
            </Text>
          </Row>
        ))
      )}
    </SettingsSection>
  );
}

function EnvironmentNodes(props: { readonly environment: SettingsTarget; readonly now: number }) {
  const { environment } = props;
  const environmentId = environment.environmentId;
  const nodes = useEnvironmentQuery(automationEnvironment.nodes({ environmentId, input: {} }));
  return (
    <SettingsSection
      title={`${environment.label} · Nodes`}
      titleIcon={environmentIcon(environment)}
    >
      {nodes.data === null ? (
        nodes.error ? (
          <Note danger>{nodes.error}</Note>
        ) : (
          <Note>Loading nodes…</Note>
        )
      ) : nodes.data.nodes.length === 0 ? (
        <Note>No nodes.</Note>
      ) : (
        nodes.data.nodes.map((node, index) => (
          <Row key={node.id} first={index === 0}>
            <View className="flex-row items-center gap-2">
              <Text
                className="min-w-0 flex-1 text-lg font-t3-medium text-foreground"
                numberOfLines={1}
              >
                {node.label}
              </Text>
              <AutomationStatusLabel
                status={presentNodeAvailability(node.availability.status)}
                size="base"
              />
            </View>
            <ObservationText
              observation={presentObservation({
                observedAt: node.availability.observedAt,
                nowMs: props.now,
                verb: "Probed",
                staleAfterMs: 15 * 60_000,
              })}
            />
            <Text className="text-sm text-foreground-muted" numberOfLines={3}>
              {node.enabled ? "" : "Disabled · "}
              {node.workspaceRoots.length === 0
                ? "No workspace root, so it runs nothing"
                : node.workspaceRoots.join(", ")}{" "}
              · {node.allowShell ? "shell allowed" : "no shell"}
            </Text>
            {node.availability.error ? (
              <Text className="text-xs text-danger-foreground">{node.availability.error}</Text>
            ) : null}
          </Row>
        ))
      )}
    </SettingsSection>
  );
}

export function SettingsAutomationOrchestratorRouteScreen({
  route,
}: StaticScreenProps<{
  readonly environmentId: EnvironmentId;
  readonly orchestratorId: OrchestratorId;
}>) {
  const { environmentId, orchestratorId } = route.params;
  const view = useOrchestratorView(environmentId, orchestratorId);
  const insets = useSafeAreaInsets();
  return (
    <SettingsScreen title="Orchestrator">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {view === null ? (
          <Text className="px-2 text-base text-foreground-muted">
            This orchestrator is not available. Its environment may be disconnected, or it was
            deleted.
          </Text>
        ) : (
          <OrchestratorDetail key={view.key} view={view} />
        )}
      </ScrollView>
    </SettingsScreen>
  );
}

function OrchestratorDetail({ view }: { readonly view: OrchestratorView }) {
  const { orchestrator, environmentId } = view;
  const now = useMinuteClock();
  const navigation = useNavigation();
  const { availableTargets } = useSettingsEnvironmentFilter();
  const threads = useThreadShells();
  const views = useAtomValue(automationEnvironment.orchestratorViewsAtom);
  const setState = useAtomCommand(automationEnvironment.setOrchestratorState, {
    label: "orchestrator set state",
    reportFailure: false,
  });
  const [busy, setBusy] = useState(false);
  const state = presentOrchestratorState(orchestrator.effectiveState);
  const actions = orchestratorStateActions(view);
  const host = availableTargets.find(
    (target) => target.environmentId === orchestrator.hostEnvironmentId,
  );
  const inbox = useEnvironmentQuery(
    automationEnvironment.orchestratorInbox({
      environmentId,
      input: {
        orchestratorId: orchestrator.id,
        statuses: [...INBOX_STATUSES],
        limit: INBOX_PAGE_SIZE,
      },
    }),
  );
  const tasks = useEnvironmentQuery(
    automationEnvironment.tasks({
      environmentId,
      input: { orchestratorId: orchestrator.id, includeTerminal: true },
    }),
  );
  const requests = useEnvironmentQuery(
    automationEnvironment.pendingRequests({
      environmentId,
      input: { orchestratorId: orchestrator.id },
    }),
  );
  const peers = useEnvironmentQuery(automationEnvironment.peers({ environmentId, input: {} }));
  const activity = useEnvironmentQuery(
    automationEnvironment.activity({
      environmentId,
      input: {
        filter: { types: [...ACTIVITY_TYPES], orchestratorIds: [orchestrator.id] },
        limit: 400,
      },
    }),
  );
  const inboxSummary = summarizeOrchestratorInbox({
    inboxPending: orchestrator.inboxPending,
    entries: inbox.data?.entries ?? null,
    limit: INBOX_PAGE_SIZE,
  });
  const taskRows = useMemo(
    () => presentDelegatedTasks({ tasks: tasks.data?.tasks ?? [], environmentId }),
    [environmentId, tasks.data],
  );
  const activityRows = presentAutomationActivity(activity.data?.entries ?? [], ACTIVITY_ROWS);
  const budgetLines = presentOrchestratorBudget(orchestrator.budget, orchestrator.usage);
  const lookup = {
    orchestratorName: (orchestratorId: string, hostEnvironmentId: string) =>
      resolveOrchestratorView(views, orchestratorId, hostEnvironmentId)?.orchestrator.name ?? null,
    threadTitle: (threadId: string) =>
      threads.find((thread) => thread.environmentId === environmentId && thread.id === threadId)
        ?.title ?? null,
  };
  const openThread = (threadEnvironmentId: EnvironmentId, threadId: string) => {
    const thread = threads.find(
      (entry) => entry.environmentId === threadEnvironmentId && entry.id === threadId,
    );
    if (!thread) return;
    navigation.navigate("Thread", { environmentId: thread.environmentId, threadId: thread.id });
  };

  const change = async (desiredState: "active" | "paused") => {
    if (busy) return;
    setBusy(true);
    const result = await setState({
      environmentId,
      input: { orchestratorId: orchestrator.id, desiredState },
    });
    setBusy(false);
    reportFailure("Could not change the orchestrator", result);
  };

  return (
    <>
      <SettingsSection title={orchestrator.name}>
        <Row first>
          <AutomationStatusLabel
            status={state}
            prefix={`${orchestratorScopeLabel(orchestrator.scope)} orchestrator`}
            size="base"
          />
          {orchestrator.stateReason ? (
            <Text className="text-sm text-foreground-muted">{orchestrator.stateReason}</Text>
          ) : state.description ? (
            <Text className="text-sm text-foreground-muted">{state.description}</Text>
          ) : null}
          <Text className="text-sm text-foreground-muted">
            {view.hostedHere ? "Hosted on" : "Hosted elsewhere, on"}{" "}
            {host?.label ?? orchestrator.hostEnvironmentId} · {orchestrator.modelSelection.model}
          </Text>
          {view.hostedHere ? null : (
            <ObservationText
              observation={presentObservation({
                observedAt: orchestrator.observedAt,
                nowMs: now,
                reachable: resolveEnvironmentReachability({
                  clientConnectionPhase: host?.connection.phase ?? null,
                }),
              })}
            />
          )}
        </Row>
        {actions.canPause || actions.canResume ? (
          <Row
            first={false}
            accessibilityLabel={actions.canPause ? "Pause orchestrator" : "Resume orchestrator"}
            onPress={() => void change(actions.canPause ? "paused" : "active")}
          >
            <View className="flex-row items-center gap-2">
              <SymbolView
                name={actions.canPause ? "pause" : "play"}
                size={16}
                tintColorClassName="accent-icon"
                type="monochrome"
              />
              <Text className="text-lg text-foreground">
                {busy ? "Working…" : actions.canPause ? "Pause" : "Resume"}
              </Text>
            </View>
            <Text className="text-sm text-foreground-muted">
              {actions.canPause
                ? "Keeps its inbox. Running child tasks continue."
                : "Takes turns again when its inbox has something to act on."}
            </Text>
          </Row>
        ) : (
          <Row first={false}>
            <Text className="text-sm text-foreground-muted">
              Pause and resume it from the environment that hosts it.
            </Text>
          </Row>
        )}
      </SettingsSection>

      <SettingsSection title="Inbox">
        <Row first>
          <Text className="text-base text-foreground">
            {inboxSummary.pending} pending · {inboxSummary.reserved} being read ·{" "}
            {inboxSummary.unknown} with unknown outcome
          </Text>
          {inbox.error ? (
            <Text className="text-sm text-danger-foreground">{inbox.error}</Text>
          ) : null}
          {inboxSummary.partial && inbox.data !== null ? (
            <Text className="text-xs text-foreground-muted">
              Partial: only the first {INBOX_PAGE_SIZE} entries were read.
            </Text>
          ) : null}
        </Row>
        {inboxSummary.unknownEntries.map((entry) => (
          <Row key={entry.id} first={false}>
            <Text className="text-base text-foreground" numberOfLines={2}>
              {inboxEntryPreview(entry)}
            </Text>
            <Text className="text-xs text-foreground">
              Outcome unknown. It was not run again. Requeue or dismiss it on desktop, web, or with
              t3 orchestrator inbox.
            </Text>
          </Row>
        ))}
      </SettingsSection>

      <SettingsSection title="Budget and usage">
        {budgetLines.map((line, index) => (
          <Row key={line.key} first={index === 0}>
            <View className="flex-row items-center gap-3">
              <Text className="min-w-0 flex-1 text-base text-foreground">{line.label}</Text>
              <Text
                className={
                  line.exceeded === true
                    ? "text-base text-warning-foreground"
                    : "text-base text-foreground-muted"
                }
              >
                {line.usedLabel === null
                  ? line.limitLabel
                  : `${line.usedLabel} / ${line.limitLabel}`}
                {line.exceeded === true ? " · limit reached" : ""}
              </Text>
            </View>
            {line.note ? <Text className="text-xs text-foreground-muted">{line.note}</Text> : null}
          </Row>
        ))}
        <Row first={false}>
          <Text className="text-sm text-foreground-muted">
            {orchestrator.lastCheckpointAt === null
              ? "No checkpoint yet"
              : `Last checkpoint ${formatAutomationAge(Math.max(0, now - Date.parse(orchestrator.lastCheckpointAt)))}`}
          </Text>
        </Row>
      </SettingsSection>

      <SettingsSection title="Child tasks">
        {tasks.data === null ? (
          tasks.error ? (
            <Note danger>{tasks.error}</Note>
          ) : (
            <Note>Loading child tasks…</Note>
          )
        ) : taskRows.length === 0 ? (
          <Note>No child tasks.</Note>
        ) : (
          taskRows.slice(0, TASK_ROWS).map((row, index) => {
            const threadRef = row.threadRef;
            const loaded =
              threadRef !== null &&
              threads.some(
                (thread) =>
                  thread.environmentId === threadRef.environmentId &&
                  thread.id === threadRef.threadId,
              );
            return (
              <Row
                key={row.task.id}
                first={index === 0}
                {...(loaded && threadRef !== null
                  ? {
                      accessibilityLabel: `${row.task.contract.title}, ${row.status.label}. Open thread`,
                      onPress: () => openThread(threadRef.environmentId, threadRef.threadId),
                    }
                  : {})}
              >
                <View className="flex-row items-center gap-2">
                  <Text className="min-w-0 flex-1 text-base text-foreground" numberOfLines={1}>
                    {row.task.contract.title}
                  </Text>
                  <AutomationStatusLabel status={row.status} size="base" />
                </View>
                {row.awaitingValidation || row.criteriaLabel || row.task.statusReason ? (
                  <Text className="text-sm text-foreground-muted" numberOfLines={2}>
                    {[
                      row.awaitingValidation ? "Not validated yet" : null,
                      row.criteriaLabel,
                      row.task.statusReason,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </Text>
                ) : null}
                {row.remote ? (
                  <ObservationText
                    observation={presentObservation({
                      observedAt: row.task.observedAt,
                      nowMs: now,
                      reachable: resolveEnvironmentReachability({
                        peerStatus: peers.data?.peers.find(
                          (peer) => peer.environmentId === row.task.executionEnvironmentId,
                        )?.status,
                      }),
                    })}
                  />
                ) : null}
              </Row>
            );
          })
        )}
        {taskRows.length > TASK_ROWS ? (
          <Row first={false}>
            <Text className="text-xs text-foreground-muted">
              Partial: {taskRows.length - TASK_ROWS} more not shown.
            </Text>
          </Row>
        ) : null}
      </SettingsSection>

      <SettingsSection title="Pending requests it tracks">
        {requests.data === null ? (
          requests.error ? (
            <Note danger>{requests.error}</Note>
          ) : (
            <Note>Loading pending requests…</Note>
          )
        ) : requests.data.requests.length === 0 ? (
          <Note>None.</Note>
        ) : (
          requests.data.requests.map((request, index) => {
            const responsibility = presentResponsibility(request, lookup, now);
            return (
              <Row
                key={`${request.threadId}:${request.requestId}`}
                first={index === 0}
                accessibilityLabel={`${request.threadTitle}, ${responsibility.summary}. Open thread`}
                onPress={() => openThread(request.environmentId, request.threadId)}
              >
                <Text className="text-base text-foreground" numberOfLines={1}>
                  {request.threadTitle || "Untitled thread"}
                </Text>
                <Text className="text-sm text-foreground-muted" numberOfLines={3}>
                  {request.kind === "approval"
                    ? "Approval"
                    : request.kind === "user_input"
                      ? "Question"
                      : "Request"}{" "}
                  · {responsibility.summary}
                  {responsibility.note ? `. ${responsibility.note}` : ""}
                </Text>
              </Row>
            );
          })
        )}
      </SettingsSection>

      {activityRows.length > 0 || activity.error ? (
        <SettingsSection title="Recent activity">
          {activity.error ? <Note danger>{activity.error}</Note> : null}
          {activityRows.map((row, index) => (
            <Row key={row.key} first={index === 0}>
              <View className="flex-row items-center gap-3">
                <Text
                  className={
                    row.severity === "error"
                      ? "min-w-0 flex-1 text-base text-danger-foreground"
                      : "min-w-0 flex-1 text-base text-foreground"
                  }
                  numberOfLines={1}
                >
                  {row.label}
                </Text>
                <Text className="text-sm text-foreground-muted">
                  {formatAutomationAge(Math.max(0, now - Date.parse(row.occurredAt)))}
                </Text>
              </View>
            </Row>
          ))}
        </SettingsSection>
      ) : null}
    </>
  );
}
