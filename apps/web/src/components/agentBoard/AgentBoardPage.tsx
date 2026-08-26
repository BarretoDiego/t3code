import {
  buildAgentBoard,
  nextAgentBoardSnoozeWakeAt,
  type AgentBoardCard,
  type AgentBoardFilterOption,
  type AgentBoardFilters,
  type BoardConnectivity,
  type BoardEnvironmentSource,
  type BoardProviderSource,
} from "@t3tools/client-runtime/agent-board";
import { canSettle } from "@t3tools/client-runtime/state/thread-settled";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { Link, useNavigate } from "@tanstack/react-router";
import type { OrchestrationThreadShell } from "@t3tools/contracts";
import {
  AlertCircleIcon,
  ArchiveIcon,
  BotIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  CircleDotIcon,
  Clock3Icon,
  EllipsisIcon,
  ExternalLinkIcon,
  GitBranchIcon,
  HandIcon,
  ListChecksIcon,
  MonitorIcon,
  OctagonXIcon,
  PlayIcon,
  RotateCcwIcon,
  SquareIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import {
  encodeAgentBoardFilterList,
  filtersFromAgentBoardSearch,
  type AgentBoardSearch,
} from "../../agentBoardSearch";
import { isElectron } from "../../env";
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useServerConfigs,
  useThreadShells,
} from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { SidebarInset } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { Route } from "../../routes/_chat.board";
import {
  resolveAgentBoardActionAvailability,
  resolveAgentBoardPageState,
} from "./AgentBoardPage.logic";

const COLUMN_DEFINITIONS = [
  {
    key: "needsYou",
    label: "Needs You",
    icon: HandIcon,
    tone: "text-amber-600 dark:text-amber-300",
  },
  { key: "working", label: "Working", icon: PlayIcon, tone: "text-sky-600 dark:text-sky-300" },
  {
    key: "review",
    label: "Review",
    icon: ListChecksIcon,
    tone: "text-violet-600 dark:text-violet-300",
  },
  {
    key: "settled",
    label: "Settled",
    icon: CheckCircle2Icon,
    tone: "text-emerald-600 dark:text-emerald-300",
  },
  { key: "issue", label: "Issue", icon: OctagonXIcon, tone: "text-rose-600 dark:text-rose-300" },
] as const;

type FilterDimension =
  | "environmentIds"
  | "projectKeys"
  | "providerDrivers"
  | "providerInstanceKeys"
  | "models";

function connectivityFor(phase: string, hasCachedCards: boolean): BoardConnectivity {
  if (phase === "connected") return "connected";
  if (hasCachedCards) return "cached";
  if (phase === "error") return "error";
  if (phase === "connecting" || phase === "reconnecting") return "loading";
  return "disconnected";
}

function useBoardSources() {
  const threads = useThreadShells();
  const projects = useProjects();
  const configs = useServerConfigs();
  const { environments } = useEnvironments();
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
      [...configs].flatMap(([environmentId, config]) =>
        config.providers.map((provider) => ({
          environmentId,
          instanceId: provider.instanceId,
          driver: provider.driver,
          label: provider.displayName ?? provider.badgeLabel ?? null,
        })),
      ),
    [configs],
  );
  const shellsByKey = useMemo(
    () => new Map(threads.map((thread) => [`${thread.environmentId}:${thread.id}`, thread])),
    [threads],
  );
  return { threads, projects, configs, environments: boardEnvironments, providers, shellsByKey };
}

function updateSearchForFilters(filters: AgentBoardFilters): AgentBoardSearch {
  const environments = encodeAgentBoardFilterList(filters.environmentIds);
  const projects = encodeAgentBoardFilterList(filters.projectKeys);
  const providers = encodeAgentBoardFilterList(filters.providerDrivers);
  const instances = encodeAgentBoardFilterList(filters.providerInstanceKeys);
  const models = encodeAgentBoardFilterList(filters.models);
  return {
    ...(environments === undefined ? {} : { environments }),
    ...(projects === undefined ? {} : { projects }),
    ...(providers === undefined ? {} : { providers }),
    ...(instances === undefined ? {} : { instances }),
    ...(models === undefined ? {} : { models }),
    ...(filters.onlyActive ? {} : { active: false }),
  };
}

function useCoarseNow(enabled: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [enabled]);
  return now;
}

function useSnoozeWakeTick(threads: readonly OrchestrationThreadShell[]): number {
  const [tick, bumpTick] = useState(0);
  const nextWakeAt = useMemo(() => {
    void tick;
    return nextAgentBoardSnoozeWakeAt(threads, Date.now());
  }, [threads, tick]);
  useEffect(() => {
    if (nextWakeAt === null) return;
    const delayMs = Math.min(Math.max(0, nextWakeAt - Date.now()) + 50, 2_147_483_647);
    const id = window.setTimeout(() => bumpTick((current) => current + 1), delayMs);
    return () => window.clearTimeout(id);
  }, [nextWakeAt, tick]);
  return tick;
}

function formatElapsed(since: string | null, now: number): string | null {
  if (since === null) return null;
  const start = Date.parse(since);
  if (!Number.isFinite(start)) return null;
  const seconds = Math.max(0, Math.floor((now - start) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d`;
}

export function AgentBoardPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const sources = useBoardSources();
  const actions = useBoardActionController(sources);
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const filters = useMemo(() => filtersFromAgentBoardSearch(search), [search]);
  const snoozeWakeTick = useSnoozeWakeTick(sources.threads);
  const classificationNow = useMemo(() => {
    void snoozeWakeTick;
    return new Date().toISOString();
  }, [sources.threads, filters, snoozeWakeTick]);
  const model = useMemo(
    () =>
      buildAgentBoard({
        threads: sources.threads,
        projects: sources.projects,
        environments: sources.environments,
        providers: sources.providers,
        filters,
        now: classificationNow,
      }),
    [
      classificationNow,
      filters,
      sources.environments,
      sources.projects,
      sources.providers,
      sources.threads,
    ],
  );
  const visibleCards = useMemo(
    () => [...COLUMN_DEFINITIONS.flatMap(({ key }) => model.columns[key]), ...model.columns.idle],
    [model.columns],
  );
  const elapsedNow = useCoarseNow(
    visibleCards.some(
      (card) => card.runtime.kind === "working" || card.runtime.kind === "needs-you",
    ),
  );
  const disconnectedCount = sources.environments.filter(
    (environment) => environment.connectivity !== "connected",
  ).length;
  const pageState = resolveAgentBoardPageState({
    bootstrapped,
    shellCount: sources.threads.length,
    visibleCount: model.totalVisible,
  });

  const setFilters = useCallback(
    (next: AgentBoardFilters) => {
      void navigate({ search: updateSearchForFilters(next), replace: true });
    },
    [navigate],
  );
  const toggleFilter = useCallback(
    (dimension: FilterDimension, value: string) => {
      const selected = filters[dimension];
      setFilters({
        ...filters,
        [dimension]: selected.includes(value)
          ? selected.filter((entry) => entry !== value)
          : [...selected, value],
      });
    },
    [filters, setFilters],
  );
  const clearFilters = useCallback(
    () =>
      setFilters({
        ...filters,
        environmentIds: [],
        projectKeys: [],
        providerDrivers: [],
        providerInstanceKeys: [],
        models: [],
      }),
    [filters, setFilters],
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <BotIcon className="size-4 shrink-0 text-muted-foreground" />
            <h1 className="truncate text-sm font-semibold">Agent Operations</h1>
            <span className="text-xs tabular-nums text-muted-foreground">{model.totalVisible}</span>
          </div>
          <Button
            size="sm"
            variant={filters.onlyActive ? "secondary" : "outline"}
            onClick={() => setFilters({ ...filters, onlyActive: !filters.onlyActive })}
          >
            Only active
          </Button>
        </WorkspacePageHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <WorkspacePageContainer width="expanded" className="max-w-none gap-4 px-3 sm:px-5">
            <div className="flex flex-wrap items-center gap-2" aria-label="Board filters">
              <BoardFilter
                label="Environment"
                options={model.options.environments}
                selected={filters.environmentIds}
                onToggle={(value) => toggleFilter("environmentIds", value)}
              />
              <BoardFilter
                label="Project"
                options={model.options.projects}
                selected={filters.projectKeys}
                onToggle={(value) => toggleFilter("projectKeys", value)}
              />
              <BoardFilter
                label="Provider"
                options={model.options.providers}
                selected={filters.providerDrivers}
                onToggle={(value) => toggleFilter("providerDrivers", value)}
              />
              <BoardFilter
                label="Account"
                options={model.options.providerInstances}
                selected={filters.providerInstanceKeys}
                onToggle={(value) => toggleFilter("providerInstanceKeys", value)}
              />
              <BoardFilter
                label="Model"
                options={model.options.models}
                selected={filters.models}
                onToggle={(value) => toggleFilter("models", value)}
              />
              {Object.values(filters).some((value) => Array.isArray(value) && value.length > 0) ? (
                <Button size="sm" variant="ghost" onClick={clearFilters}>
                  Clear filters
                </Button>
              ) : null}
            </div>

            {model.staleFilterCount > 0 ? (
              <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/8 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                <AlertCircleIcon className="size-4" />
                {model.staleFilterCount} unavailable filter{" "}
                {model.staleFilterCount === 1 ? "was" : "were"} ignored.
                <Button size="xs" variant="ghost" onClick={clearFilters}>
                  Clear
                </Button>
              </div>
            ) : null}
            {disconnectedCount > 0 ? (
              <p className="text-xs text-muted-foreground" role="status">
                Cached work remains visible for {disconnectedCount} unavailable{" "}
                {disconnectedCount === 1 ? "environment" : "environments"}; connectivity never
                changes agent state.
              </p>
            ) : null}

            {pageState === "loading" ? (
              <BoardLoading />
            ) : pageState === "empty" ? (
              <Empty className="min-h-72">
                <EmptyHeader>
                  <EmptyTitle>No matching agent work</EmptyTitle>
                  <EmptyDescription>
                    {bootstrapped
                      ? "Adjust filters or turn off Only active to include quiet history."
                      : "Environment snapshots are still loading."}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <>
                <div
                  className="grid grid-flow-col auto-cols-[minmax(17rem,85vw)] gap-3 overflow-x-auto pb-3 xl:grid-flow-row xl:auto-cols-auto xl:grid-cols-5 xl:overflow-visible"
                  aria-label="Agent operations board"
                >
                  {COLUMN_DEFINITIONS.map((definition) => (
                    <BoardColumn
                      key={definition.key}
                      definition={definition}
                      cards={model.columns[definition.key]}
                      elapsedNow={elapsedNow}
                      sources={sources}
                      actions={actions}
                    />
                  ))}
                </div>
                {!filters.onlyActive && model.columns.idle.length > 0 ? (
                  <details className="rounded-xl border border-border bg-card/30">
                    <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
                      Idle history{" "}
                      <span className="ml-1 text-muted-foreground">
                        {model.columns.idle.length}
                      </span>
                    </summary>
                    <div className="grid gap-2 border-t border-border p-3 sm:grid-cols-2 lg:grid-cols-3">
                      {model.columns.idle.map((card) => (
                        <BoardCard
                          key={`${card.ref.environmentId}:${card.ref.threadId}`}
                          card={card}
                          elapsedNow={elapsedNow}
                          sources={sources}
                          actions={actions}
                        />
                      ))}
                    </div>
                  </details>
                ) : null}
              </>
            )}
          </WorkspacePageContainer>
        </div>
      </div>
    </SidebarInset>
  );
}

function BoardFilter(props: {
  readonly label: string;
  readonly options: readonly AgentBoardFilterOption[];
  readonly selected: readonly string[];
  readonly onToggle: (value: string) => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={<Button size="sm" variant={props.selected.length > 0 ? "secondary" : "outline"} />}
      >
        {props.label}
        {props.selected.length > 0 ? ` · ${props.selected.length}` : ""}
        <ChevronDownIcon className="size-3.5" />
      </MenuTrigger>
      <MenuPopup align="start" className="max-w-72">
        {props.options.length === 0 ? (
          <MenuItem disabled>No options loaded</MenuItem>
        ) : (
          props.options.map((option) => (
            <MenuCheckboxItem
              key={option.value}
              checked={props.selected.includes(option.value)}
              onCheckedChange={() => props.onToggle(option.value)}
            >
              <span className="flex min-w-0 items-center justify-between gap-4">
                <span className="truncate">{option.label}</span>
                <span className="text-xs tabular-nums text-muted-foreground">{option.count}</span>
              </span>
            </MenuCheckboxItem>
          ))
        )}
      </MenuPopup>
    </Menu>
  );
}

function BoardLoading() {
  return (
    <div
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5"
      aria-label="Loading agent operations"
    >
      {COLUMN_DEFINITIONS.map(({ key, label }) => (
        <section key={key} className="min-h-48 rounded-xl border border-border bg-card/20 p-3">
          <h2 className="text-sm font-semibold">{label}</h2>
          <div className="mt-3 h-24 animate-pulse rounded-lg bg-muted/40" />
        </section>
      ))}
    </div>
  );
}

function BoardColumn(props: {
  readonly definition: (typeof COLUMN_DEFINITIONS)[number];
  readonly cards: readonly AgentBoardCard[];
  readonly elapsedNow: number;
  readonly sources: ReturnType<typeof useBoardSources>;
  readonly actions: BoardActionController;
}) {
  const Icon = props.definition.icon;
  return (
    <section
      className="flex min-h-56 min-w-0 flex-col rounded-xl border border-border bg-muted/15"
      aria-labelledby={`board-column-${props.definition.key}`}
    >
      <h2
        id={`board-column-${props.definition.key}`}
        className="flex items-center gap-2 border-b border-border px-3 py-2.5 text-sm font-semibold"
      >
        <Icon className={`size-4 ${props.definition.tone}`} />
        <span>{props.definition.label}</span>
        <span className="ml-auto tabular-nums text-muted-foreground">{props.cards.length}</span>
      </h2>
      <div className="flex flex-1 flex-col gap-2 p-2">
        {props.cards.length === 0 ? (
          <p className="m-auto py-8 text-xs text-muted-foreground">Nothing here</p>
        ) : (
          props.cards.map((card) => (
            <BoardCard
              key={`${card.ref.environmentId}:${card.ref.threadId}`}
              card={card}
              elapsedNow={props.elapsedNow}
              sources={props.sources}
              actions={props.actions}
            />
          ))
        )}
      </div>
    </section>
  );
}

const STATE_LABELS: Record<AgentBoardCard["runtime"]["kind"], string> = {
  "needs-you": "Needs you",
  working: "Working",
  review: "Review",
  settled: "Settled",
  issue: "Issue",
  idle: "Idle",
};

function BoardCard(props: {
  readonly card: AgentBoardCard;
  readonly elapsedNow: number;
  readonly sources: ReturnType<typeof useBoardSources>;
  readonly actions: BoardActionController;
}) {
  const { card } = props;
  const elapsed = formatElapsed(card.runtime.since, props.elapsedNow);
  return (
    <article className="group rounded-lg border border-border bg-card p-3 shadow-sm/5 focus-within:ring-2 focus-within:ring-ring">
      <div className="flex min-w-0 items-start gap-2">
        <Link
          to="/$environmentId/$threadId"
          params={{ environmentId: card.ref.environmentId, threadId: card.ref.threadId }}
          className="min-w-0 flex-1 truncate text-sm font-semibold outline-none hover:underline"
        >
          {card.threadTitle}
        </Link>
        <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {STATE_LABELS[card.runtime.kind]}
        </span>
        <CardActions card={card} sources={props.sources} actions={props.actions} />
      </div>
      {card.attention !== null || card.currentOperation !== null ? (
        <p className="mt-1.5 line-clamp-2 text-xs font-medium text-foreground/85">
          {card.attention?.label ?? card.currentOperation}
        </p>
      ) : null}
      {card.planProgress !== null ? (
        <p className="mt-1 text-[11px] tabular-nums text-muted-foreground">
          Step {card.planProgress.completedSteps + 1} of {card.planProgress.totalSteps}
        </p>
      ) : null}
      <CardMeta icon={<MonitorIcon />}>
        <Link
          to="/environments/$environmentId"
          params={{ environmentId: card.ref.environmentId }}
          className="truncate hover:underline"
        >
          {card.environment.label ?? card.environment.environmentId}
        </Link>
        {card.project === null ? null : (
          <>
            <span>·</span>
            <Link
              to="/environments/$environmentId/projects/$projectId"
              params={{ environmentId: card.ref.environmentId, projectId: card.project.projectId }}
              className="truncate hover:underline"
            >
              {card.project.title}
            </Link>
          </>
        )}
      </CardMeta>
      <CardMeta icon={<BotIcon />}>
        <span className="truncate">{card.providerLabel ?? card.providerInstanceId}</span>
        <span>·</span>
        <span className="truncate">{card.model}</span>
      </CardMeta>
      {card.branch === null ? null : (
        <CardMeta icon={<GitBranchIcon />}>
          <span className="truncate">{card.branch}</span>
          {card.worktreePath === null ? null : (
            <Tooltip>
              <TooltipTrigger
                render={<span className="rounded bg-muted px-1 text-[10px] uppercase" />}
              >
                worktree
              </TooltipTrigger>
              <TooltipPopup side="top">{card.worktreePath}</TooltipPopup>
            </Tooltip>
          )}
        </CardMeta>
      )}
      <div className="mt-2 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
        <ConnectivityBadge connectivity={card.environment.connectivity} />
        {elapsed === null ? null : (
          <span className="flex items-center gap-1 tabular-nums">
            <Clock3Icon className="size-3" />
            {elapsed}
          </span>
        )}
      </div>
    </article>
  );
}

function CardMeta({ icon, children }: { readonly icon: ReactNode; readonly children: ReactNode }) {
  return (
    <div className="mt-1.5 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground [&>svg]:size-3 [&>svg]:shrink-0">
      {icon}
      {children}
    </div>
  );
}

function ConnectivityBadge({ connectivity }: { readonly connectivity: BoardConnectivity }) {
  if (connectivity === "connected")
    return (
      <span className="flex items-center gap-1">
        <CircleDotIcon className="size-3 text-emerald-500" />
        Connected
      </span>
    );
  const label =
    connectivity === "cached"
      ? "Cached"
      : connectivity === "loading"
        ? "Connecting"
        : connectivity === "error"
          ? "Connection issue"
          : "Disconnected";
  return (
    <span className="flex items-center gap-1">
      <CircleDotIcon className="size-3 text-muted-foreground" />
      {label}
    </span>
  );
}

type CardAction = "interrupt" | "archive" | "settle" | "unsettle";

interface BoardActionController {
  readonly errors: ReadonlyMap<string, string>;
  readonly run: (card: AgentBoardCard, action: CardAction) => Promise<void>;
}

function cardKey(card: AgentBoardCard): string {
  return `${card.ref.environmentId}:${card.ref.threadId}`;
}

function useBoardActionController(
  sources: ReturnType<typeof useBoardSources>,
): BoardActionController {
  const interrupt = useAtomCommand(threadEnvironment.interruptTurn, { reportFailure: false });
  const archive = useAtomCommand(threadEnvironment.archive, { reportFailure: false });
  const settle = useAtomCommand(threadEnvironment.settle, { reportFailure: false });
  const unsettle = useAtomCommand(threadEnvironment.unsettle, { reportFailure: false });
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const run = useCallback(
    async (card: AgentBoardCard, action: CardAction) => {
      const key = cardKey(card);
      const shell = sources.shellsByKey.get(key) ?? null;
      if (shell === null) return;
      setErrors((current) => {
        if (!current.has(key)) return current;
        const next = new Map(current);
        next.delete(key);
        return next;
      });
      const scoped = {
        environmentId: card.ref.environmentId,
        input: { threadId: card.ref.threadId },
      };
      const result =
        action === "interrupt"
          ? await interrupt({
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
        setErrors((current) =>
          new Map(current).set(
            key,
            cause instanceof Error ? cause.message : `Could not ${action} thread.`,
          ),
        );
      }
    },
    [archive, interrupt, settle, sources.shellsByKey, unsettle],
  );
  return { errors, run };
}

function CardActions(props: {
  readonly card: AgentBoardCard;
  readonly sources: ReturnType<typeof useBoardSources>;
  readonly actions: BoardActionController;
}) {
  const { card, sources, actions } = props;
  const shell = sources.shellsByKey.get(cardKey(card)) ?? null;
  const config = sources.configs.get(card.ref.environmentId);
  const supportsSettlement = config?.environment.capabilities.threadSettlement === true;
  const isLifecycleSettled = shell?.settledOverride === "settled" || shell?.settledAt != null;
  const error = actions.errors.get(cardKey(card)) ?? null;
  const availability = resolveAgentBoardActionAvailability({
    runtimeKind: card.runtime.kind,
    connected: card.environment.connectivity === "connected",
    supportsSettlement,
    lifecycleSettled: isLifecycleSettled,
    canSettle:
      shell !== null &&
      canSettle(shell as OrchestrationThreadShell, { now: new Date().toISOString() }),
  });
  const hasMutatingAction = Object.values(availability).some(Boolean);

  return (
    <div className="shrink-0">
      <Menu>
        <MenuTrigger
          render={
            <Button aria-label={`Actions for ${card.threadTitle}`} size="icon-xs" variant="ghost" />
          }
        >
          <EllipsisIcon />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuItem
            render={
              <Link
                to="/$environmentId/$threadId"
                params={{ environmentId: card.ref.environmentId, threadId: card.ref.threadId }}
              />
            }
          >
            <ExternalLinkIcon />
            Open thread
          </MenuItem>
          {card.project === null ? null : (
            <MenuItem
              render={
                <Link
                  to="/environments/$environmentId/projects/$projectId"
                  params={{
                    environmentId: card.ref.environmentId,
                    projectId: card.project.projectId,
                  }}
                />
              }
            >
              <ExternalLinkIcon />
              Open project
            </MenuItem>
          )}
          <MenuItem
            render={
              <Link
                to="/environments/$environmentId"
                params={{ environmentId: card.ref.environmentId }}
              />
            }
          >
            <ExternalLinkIcon />
            Open environment
          </MenuItem>
          {hasMutatingAction ? <MenuSeparator /> : null}
          {availability.interrupt ? (
            <MenuItem onClick={() => void actions.run(card, "interrupt")}>
              <SquareIcon />
              Stop
            </MenuItem>
          ) : null}
          {availability.archive ? (
            <MenuItem onClick={() => void actions.run(card, "archive")}>
              <ArchiveIcon />
              Archive
            </MenuItem>
          ) : null}
          {availability.unsettle ? (
            <MenuItem onClick={() => void actions.run(card, "unsettle")}>
              <RotateCcwIcon />
              Unsettle
            </MenuItem>
          ) : null}
          {availability.settle ? (
            <MenuItem onClick={() => void actions.run(card, "settle")}>
              <CheckCircle2Icon />
              Settle
            </MenuItem>
          ) : null}
        </MenuPopup>
      </Menu>
      {error === null ? null : (
        <p className="mt-1 max-w-52 text-[10px] text-destructive-foreground" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
