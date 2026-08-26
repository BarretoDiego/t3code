import {
  buildAgentBoard,
  nextAgentBoardSnoozeWakeAt,
  type AgentBoardCard,
  type AgentBoardFilters,
  type BoardConnectivity,
  type BoardEnvironmentSource,
  type BoardProviderSource,
  EMPTY_AGENT_BOARD_FILTERS,
} from "@t3tools/client-runtime/agent-board";
import { canSettle } from "@t3tools/client-runtime/state/thread-settled";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useNavigation } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { useProjects, useServerConfigs, useThreadShells } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useWorkspaceState } from "../../state/workspace";
import { useThemeColor } from "../../lib/useThemeColor";
import { NativeStackScreenOptions } from "../../native/StackHeader";

const COLUMNS = [
  { key: "needsYou", label: "Needs You" },
  { key: "working", label: "Working" },
  { key: "review", label: "Review" },
  { key: "settled", label: "Settled" },
  { key: "issue", label: "Issue" },
  { key: "idle", label: "Idle" },
] as const;

type ColumnKey = (typeof COLUMNS)[number]["key"];

function connectivityFor(phase: string, hasShell: boolean): BoardConnectivity {
  if (phase === "connected") return "connected";
  if (hasShell) return "cached";
  if (phase === "error") return "error";
  if (phase === "connecting" || phase === "reconnecting") return "loading";
  return "disconnected";
}

function useSnoozeWakeTick(threads: ReturnType<typeof useThreadShells>): number {
  const [tick, bumpTick] = useState(0);
  const nextWakeAt = useMemo(() => {
    void tick;
    return nextAgentBoardSnoozeWakeAt(threads, Date.now());
  }, [threads, tick]);
  useEffect(() => {
    if (nextWakeAt === null) return;
    const delayMs = Math.min(Math.max(0, nextWakeAt - Date.now()) + 50, 2_147_483_647);
    const id = setTimeout(() => bumpTick((current) => current + 1), delayMs);
    return () => clearTimeout(id);
  }, [nextWakeAt, tick]);
  return tick;
}

export function AgentBoardRouteScreen() {
  const navigation = useNavigation();
  const threads = useThreadShells();
  const projects = useProjects();
  const configs = useServerConfigs();
  const { environments } = useEnvironments();
  const { state: workspaceState } = useWorkspaceState();
  const snoozeWakeTick = useSnoozeWakeTick(threads);
  const [column, setColumn] = useState<ColumnKey>("needsYou");
  const [onlyActive, setOnlyActive] = useState(true);
  const [environmentId, setEnvironmentId] = useState<string | null>(null);
  const [projectKey, setProjectKey] = useState<string | null>(null);
  const stop = useAtomCommand(threadEnvironment.interruptTurn, { reportFailure: false });
  const archive = useAtomCommand(threadEnvironment.archive, { reportFailure: false });
  const settle = useAtomCommand(threadEnvironment.settle, { reportFailure: false });
  const unsettle = useAtomCommand(threadEnvironment.unsettle, { reportFailure: false });
  const iconColor = useThemeColor("--color-icon");

  const environmentIdsWithShells = useMemo(
    () => new Set(threads.map((thread) => thread.environmentId)),
    [threads],
  );
  const boardEnvironments = useMemo<readonly BoardEnvironmentSource[]>(
    () =>
      environments.map((environment) => ({
        environmentId: environment.environmentId,
        label: environment.label || null,
        platform:
          environment.serverConfig === null
            ? null
            : `${environment.serverConfig.environment.platform.os} ${environment.serverConfig.environment.platform.arch}`,
        connectivity: connectivityFor(
          environment.connection.phase,
          environmentIdsWithShells.has(environment.environmentId),
        ),
        cachedAt: null,
      })),
    [environmentIdsWithShells, environments],
  );
  const providers = useMemo<readonly BoardProviderSource[]>(
    () =>
      [...configs].flatMap(([scopedEnvironmentId, config]) =>
        config.providers.map((provider) => ({
          environmentId: scopedEnvironmentId,
          instanceId: provider.instanceId,
          driver: provider.driver,
          label: provider.displayName ?? provider.badgeLabel ?? null,
        })),
      ),
    [configs],
  );
  const filters = useMemo<AgentBoardFilters>(
    () => ({
      ...EMPTY_AGENT_BOARD_FILTERS,
      environmentIds: environmentId === null ? [] : [environmentId],
      projectKeys: projectKey === null ? [] : [projectKey],
      onlyActive,
    }),
    [environmentId, onlyActive, projectKey],
  );
  const classificationNow = useMemo(() => {
    void snoozeWakeTick;
    return new Date().toISOString();
  }, [filters, snoozeWakeTick, threads]);
  const model = useMemo(
    () =>
      buildAgentBoard({
        threads,
        projects,
        environments: boardEnvironments,
        providers,
        filters,
        now: classificationNow,
      }),
    [boardEnvironments, classificationNow, filters, projects, providers, threads],
  );
  const shellsByKey = useMemo(
    () => new Map(threads.map((thread) => [`${thread.environmentId}:${thread.id}`, thread])),
    [threads],
  );
  const selectedCards = model.columns[column];
  const disconnected = boardEnvironments.some(
    (environment) => environment.connectivity !== "connected",
  );

  const runAction = useCallback(
    async (card: AgentBoardCard, action: "stop" | "archive" | "settle" | "unsettle") => {
      if (card.environment.connectivity !== "connected") return;
      const shell = shellsByKey.get(`${card.ref.environmentId}:${card.ref.threadId}`);
      if (shell === undefined) return;
      const scoped = {
        environmentId: card.ref.environmentId,
        input: { threadId: card.ref.threadId },
      };
      const result =
        action === "stop"
          ? await stop({
              environmentId: scoped.environmentId,
              input: {
                ...scoped.input,
                ...(shell.session?.activeTurnId != null
                  ? { turnId: shell.session.activeTurnId }
                  : {}),
              },
            })
          : action === "archive"
            ? await archive(scoped)
            : action === "settle"
              ? await settle(scoped)
              : await unsettle({
                  environmentId: scoped.environmentId,
                  input: { ...scoped.input, reason: "user" },
                });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const cause = squashAtomCommandFailure(result);
        Alert.alert(
          `Could not ${action} thread`,
          cause instanceof Error ? cause.message : "The environment rejected the action.",
        );
      }
    },
    [archive, settle, shellsByKey, stop, unsettle],
  );

  return (
    <>
      <NativeStackScreenOptions options={{ title: "Agent Operations" }} />
      <ScrollView
        className="flex-1 bg-screen"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-4 px-4 pb-10 pt-3"
      >
        <View className="flex-row items-center justify-between gap-3">
          <View className="min-w-0 flex-1">
            <Text className="text-sm font-t3-bold text-foreground">Global agent state</Text>
            <Text className="text-xs text-foreground-muted">
              {model.totalVisible} visible across {boardEnvironments.length} environments
            </Text>
          </View>
          <Pressable
            accessibilityLabel="Only active agents"
            accessibilityRole="switch"
            accessibilityState={{ checked: onlyActive }}
            className={
              onlyActive ? "rounded-full bg-primary px-3 py-2" : "rounded-full bg-subtle px-3 py-2"
            }
            onPress={() => {
              setOnlyActive((value) => {
                if (!value && column === "idle") setColumn("needsYou");
                return !value;
              });
            }}
          >
            <Text
              className={
                onlyActive
                  ? "text-xs font-t3-bold text-primary-foreground"
                  : "text-xs font-t3-bold text-foreground"
              }
            >
              Only active
            </Text>
          </Pressable>
        </View>

        {environmentId !== null || projectKey !== null ? (
          <Pressable
            accessibilityRole="button"
            className="self-start rounded-full bg-subtle px-3 py-2"
            onPress={() => {
              setEnvironmentId(null);
              setProjectKey(null);
            }}
          >
            <Text className="text-xs font-t3-bold text-foreground">Clear scope</Text>
          </Pressable>
        ) : null}

        {disconnected ? (
          <View className="flex-row items-start gap-2 rounded-2xl border border-border bg-subtle p-3">
            <SymbolView name="wifi.slash" size={15} tintColor={iconColor} type="monochrome" />
            <Text className="min-w-0 flex-1 text-xs text-foreground-muted">
              Cached cards stay in place while environments reconnect. Connectivity does not change
              agent state.
            </Text>
          </View>
        ) : null}

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerClassName="gap-2"
        >
          {COLUMNS.filter((entry) => entry.key !== "idle" || !onlyActive).map((entry) => (
            <Pressable
              key={entry.key}
              accessibilityRole="tab"
              accessibilityState={{ selected: column === entry.key }}
              className={
                column === entry.key
                  ? "rounded-full bg-foreground px-3 py-2"
                  : "rounded-full bg-subtle px-3 py-2"
              }
              onPress={() => setColumn(entry.key)}
            >
              <Text
                className={
                  column === entry.key
                    ? "text-xs font-t3-bold text-background"
                    : "text-xs font-t3-bold text-foreground"
                }
              >
                {entry.label} {model.columns[entry.key].length}
              </Text>
            </Pressable>
          ))}
        </ScrollView>

        {!workspaceState.hasLoadedShellSnapshot && threads.length === 0 ? (
          <View className="items-center gap-2 py-16">
            <Text className="text-base font-t3-bold text-foreground">
              Loading agent operations…
            </Text>
            <Text className="text-center text-sm text-foreground-muted">
              Waiting for environment snapshots.
            </Text>
          </View>
        ) : selectedCards.length === 0 ? (
          <View className="items-center gap-2 py-16">
            <Text className="text-base font-t3-bold text-foreground">Nothing in this state</Text>
            <Text className="text-center text-sm text-foreground-muted">
              Choose another state or clear the current scope.
            </Text>
          </View>
        ) : (
          selectedCards.map((card) => (
            <MobileBoardCard
              key={`${card.ref.environmentId}:${card.ref.threadId}`}
              card={card}
              supportsSettlement={
                configs.get(card.ref.environmentId)?.environment.capabilities.threadSettlement ===
                true
              }
              shell={shellsByKey.get(`${card.ref.environmentId}:${card.ref.threadId}`) ?? null}
              onArchive={() => void runAction(card, "archive")}
              onOpen={() =>
                navigation.navigate("Thread", {
                  environmentId: card.ref.environmentId,
                  threadId: card.ref.threadId,
                })
              }
              onScopeEnvironment={() => {
                setEnvironmentId(card.ref.environmentId);
                setProjectKey(null);
              }}
              onScopeProject={() => {
                if (card.project !== null) {
                  setEnvironmentId(null);
                  setProjectKey(
                    `${encodeURIComponent(card.ref.environmentId)}/${encodeURIComponent(card.project.projectId)}`,
                  );
                }
              }}
              onSettle={() => void runAction(card, "settle")}
              onStop={() => void runAction(card, "stop")}
              onUnsettle={() => void runAction(card, "unsettle")}
            />
          ))
        )}
      </ScrollView>
    </>
  );
}

function MobileBoardCard(props: {
  readonly card: AgentBoardCard;
  readonly supportsSettlement: boolean;
  readonly shell: ReturnType<typeof useThreadShells>[number] | null;
  readonly onOpen: () => void;
  readonly onScopeEnvironment: () => void;
  readonly onScopeProject: () => void;
  readonly onStop: () => void;
  readonly onArchive: () => void;
  readonly onSettle: () => void;
  readonly onUnsettle: () => void;
}) {
  const { card } = props;
  const connected = card.environment.connectivity === "connected";
  const isWorking = card.runtime.kind === "working";
  const canQuietAction = connected && !isWorking && card.runtime.kind !== "needs-you";
  const isLifecycleSettled =
    props.shell?.settledOverride === "settled" || props.shell?.settledAt != null;
  const canSettleCard =
    props.shell !== null && canSettle(props.shell, { now: new Date().toISOString() });
  return (
    <View className="gap-2 rounded-2xl border border-border bg-surface p-4">
      <Pressable accessibilityRole="link" onPress={props.onOpen}>
        <Text className="text-base font-t3-bold text-foreground">{card.threadTitle}</Text>
        <Text className="mt-1 text-sm font-t3-medium text-foreground-muted">
          {card.attention?.label ?? card.currentOperation ?? card.runtime.kind}
        </Text>
      </Pressable>
      <View className="flex-row flex-wrap items-center gap-1.5">
        <Pressable
          accessibilityLabel={`Filter by environment ${card.environment.label ?? card.environment.environmentId}`}
          onPress={props.onScopeEnvironment}
        >
          <Text className="text-xs text-accent">
            {card.environment.label ?? card.environment.environmentId}
          </Text>
        </Pressable>
        {card.project === null ? null : (
          <>
            <Text className="text-xs text-foreground-muted">·</Text>
            <Pressable
              accessibilityLabel={`Filter by project ${card.project.title}`}
              onPress={props.onScopeProject}
            >
              <Text className="text-xs text-accent">{card.project.title}</Text>
            </Pressable>
          </>
        )}
      </View>
      <Text className="text-xs text-foreground-muted">
        {card.providerLabel ?? card.providerInstanceId} · {card.model}
      </Text>
      {card.branch === null ? null : (
        <Text className="text-xs text-foreground-muted" numberOfLines={1}>
          {card.branch}
          {card.worktreePath === null ? "" : " · worktree"}
        </Text>
      )}
      <View className="mt-1 flex-row flex-wrap gap-2">
        <CardAction label="Open thread" onPress={props.onOpen} />
        {connected && isWorking ? <CardAction label="Stop" onPress={props.onStop} /> : null}
        {canQuietAction ? <CardAction label="Archive" onPress={props.onArchive} /> : null}
        {canQuietAction && props.supportsSettlement && isLifecycleSettled ? (
          <CardAction label="Unsettle" onPress={props.onUnsettle} />
        ) : null}
        {canQuietAction && props.supportsSettlement && !isLifecycleSettled && canSettleCard ? (
          <CardAction label="Settle" onPress={props.onSettle} />
        ) : null}
      </View>
    </View>
  );
}

function CardAction({ label, onPress }: { readonly label: string; readonly onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      className="rounded-full bg-subtle px-3 py-2"
      onPress={onPress}
    >
      <Text className="text-xs font-t3-bold text-foreground">{label}</Text>
    </Pressable>
  );
}
