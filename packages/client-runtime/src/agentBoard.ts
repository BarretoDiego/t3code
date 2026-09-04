import type { EnvironmentThreadShell } from "./state/models.ts";
import { effectiveSnoozed } from "./state/threadSettled.ts";
import type {
  EnvironmentId,
  OrchestrationProjectShell,
  ProviderInstanceId,
  ScopedThreadRef,
} from "@t3tools/contracts";

import {
  deriveAgentOperationalState,
  type AgentOperationalState,
} from "./agentBoardStateAdapter.ts";

/**
 * Most recent timestamp on the thread's own timeline: user messages and the
 * requested/started/completed stamps of the latest turn. Drives the board's
 * last-activity sort; falls back to `updatedAt` at the call site when the
 * timeline carries no parseable stamp.
 */
function threadLastActivityAt(
  shell: Pick<EnvironmentThreadShell, "latestUserMessageAt" | "latestTurn">,
): string | null {
  const candidates = [
    shell.latestUserMessageAt,
    shell.latestTurn?.requestedAt,
    shell.latestTurn?.startedAt,
    shell.latestTurn?.completedAt,
  ];
  let latest: string | null = null;
  let latestTimestamp = Number.NEGATIVE_INFINITY;

  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined) continue;
    const timestamp = Date.parse(candidate);
    if (timestamp > latestTimestamp) {
      latest = candidate;
      latestTimestamp = timestamp;
    }
  }

  return latest;
}

export type BoardConnectivity = "connected" | "cached" | "disconnected" | "loading" | "error";

export interface BoardEnvironmentSource {
  readonly environmentId: EnvironmentId;
  readonly label: string | null;
  readonly platform: string | null;
  readonly connectivity: BoardConnectivity;
  readonly cachedAt: string | null;
}

export interface BoardProviderSource {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly driver: string;
  readonly label: string | null;
}

export interface BoardProjectSource extends OrchestrationProjectShell {
  readonly environmentId: EnvironmentId;
}

export interface BoardEnvironmentIdentity extends BoardEnvironmentSource {
  readonly removed: boolean;
}

export interface BoardProjectIdentity {
  readonly projectId: string;
  readonly title: string;
  readonly workspaceRoot: string;
}

export interface BoardAttentionSummary {
  readonly kind: "approval" | "user-input" | "actionable-plan" | "failure";
  readonly label: string;
}

export interface AgentBoardCard {
  readonly ref: ScopedThreadRef;
  readonly threadTitle: string;
  readonly environment: BoardEnvironmentIdentity;
  readonly project: BoardProjectIdentity | null;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerDriver: string | null;
  readonly providerLabel: string | null;
  readonly model: string;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly runtime: AgentOperationalState;
  readonly attention: BoardAttentionSummary | null;
  readonly currentOperation: string | null;
  readonly planProgress: { readonly completedSteps: number; readonly totalSteps: number } | null;
  readonly lastActivityAt: string | null;
  readonly archived: boolean;
}

export interface AgentBoardColumns {
  readonly needsYou: readonly AgentBoardCard[];
  readonly working: readonly AgentBoardCard[];
  readonly review: readonly AgentBoardCard[];
  readonly settled: readonly AgentBoardCard[];
  readonly issue: readonly AgentBoardCard[];
  readonly idle: readonly AgentBoardCard[];
}

export interface AgentBoardFilters {
  readonly environmentIds: readonly string[];
  readonly projectKeys: readonly string[];
  readonly providerDrivers: readonly string[];
  readonly providerInstanceKeys: readonly string[];
  readonly models: readonly string[];
  readonly onlyActive: boolean;
}

export const EMPTY_AGENT_BOARD_FILTERS: AgentBoardFilters = Object.freeze({
  environmentIds: Object.freeze([]),
  projectKeys: Object.freeze([]),
  providerDrivers: Object.freeze([]),
  providerInstanceKeys: Object.freeze([]),
  models: Object.freeze([]),
  onlyActive: true,
});

export interface AgentBoardFilterOption {
  readonly value: string;
  readonly label: string;
  readonly count: number;
}

export interface AgentBoardFilterOptions {
  readonly environments: readonly AgentBoardFilterOption[];
  readonly projects: readonly AgentBoardFilterOption[];
  readonly providers: readonly AgentBoardFilterOption[];
  readonly providerInstances: readonly AgentBoardFilterOption[];
  readonly models: readonly AgentBoardFilterOption[];
}

export interface AgentBoardModel {
  readonly columns: AgentBoardColumns;
  readonly options: AgentBoardFilterOptions;
  readonly staleFilterCount: number;
  readonly totalVisible: number;
  readonly totalEligible: number;
}

export interface AgentBoardInput {
  readonly threads: readonly EnvironmentThreadShell[];
  readonly projects: readonly BoardProjectSource[];
  readonly environments: readonly BoardEnvironmentSource[];
  readonly providers: readonly BoardProviderSource[];
  readonly filters: AgentBoardFilters;
  readonly now: string;
}

const scopedKey = (environmentId: string, id: string) =>
  `${encodeURIComponent(environmentId)}/${encodeURIComponent(id)}`;

export const boardProjectKey = (environmentId: string, projectId: string) =>
  scopedKey(environmentId, projectId);

export const boardProviderInstanceKey = (environmentId: string, instanceId: string) =>
  scopedKey(environmentId, instanceId);

function safeTimestamp(value: string | null | undefined): number {
  if (value == null) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Earliest client-derived snooze boundary that can change Board inclusion. */
export function nextAgentBoardSnoozeWakeAt(
  threads: ReadonlyArray<Pick<EnvironmentThreadShell, "snoozedUntil">>,
  nowMs: number,
): number | null {
  let nextWakeAt = Number.POSITIVE_INFINITY;
  for (const thread of threads) {
    if (thread.snoozedUntil == null) continue;
    const wakeAt = Date.parse(thread.snoozedUntil);
    if (Number.isFinite(wakeAt) && wakeAt > nowMs && wakeAt < nextWakeAt) {
      nextWakeAt = wakeAt;
    }
  }
  return Number.isFinite(nextWakeAt) ? nextWakeAt : null;
}

function compareScoped(left: AgentBoardCard, right: AgentBoardCard): number {
  return (
    left.ref.environmentId.localeCompare(right.ref.environmentId) ||
    left.ref.threadId.localeCompare(right.ref.threadId)
  );
}

function ascendingStateSince(left: AgentBoardCard, right: AgentBoardCard): number {
  return (
    safeTimestamp(left.runtime.since) - safeTimestamp(right.runtime.since) ||
    compareScoped(left, right)
  );
}

function descendingStateSince(left: AgentBoardCard, right: AgentBoardCard): number {
  return (
    safeTimestamp(right.runtime.since) - safeTimestamp(left.runtime.since) ||
    compareScoped(left, right)
  );
}

function descendingActivity(left: AgentBoardCard, right: AgentBoardCard): number {
  return (
    safeTimestamp(right.lastActivityAt) - safeTimestamp(left.lastActivityAt) ||
    compareScoped(left, right)
  );
}

function attentionFor(state: AgentOperationalState): BoardAttentionSummary | null {
  switch (state.kind) {
    case "needs-you":
      return state.reason === "approval"
        ? { kind: "approval", label: "Approval required" }
        : { kind: "user-input", label: "Input required" };
    case "review":
      return { kind: "actionable-plan", label: "Plan ready for review" };
    case "issue":
      return { kind: "failure", label: "Run failed" };
    case "working":
    case "settled":
    case "idle":
      return null;
  }
}

function operationFor(thread: EnvironmentThreadShell, state: AgentOperationalState): string | null {
  if (thread.planProgress !== null && thread.planProgress !== undefined) {
    return thread.planProgress.step;
  }
  if (state.kind !== "working") return null;
  if (state.reason === "monitoring") return "Monitoring";
  if (thread.session?.status === "starting") return "Starting agent";
  return state.reason === "background" ? "Background work" : "Working";
}

function optionList(counts: Map<string, { label: string; count: number }>) {
  return [...counts.entries()]
    .map(([value, entry]) => ({ value, ...entry }))
    .toSorted(
      (left, right) =>
        left.label.localeCompare(right.label) || left.value.localeCompare(right.value),
    );
}

function addOption(
  counts: Map<string, { label: string; count: number }>,
  value: string,
  label: string,
) {
  const current = counts.get(value);
  counts.set(value, { label, count: (current?.count ?? 0) + 1 });
}

function activeSelection(
  selected: readonly string[],
  valid: ReadonlySet<string>,
): ReadonlySet<string> {
  return new Set(selected.filter((value) => valid.has(value)));
}

function selectedMatches(selected: ReadonlySet<string>, value: string | null): boolean {
  return selected.size === 0 || (value !== null && selected.has(value));
}

export function buildAgentBoard(input: AgentBoardInput): AgentBoardModel {
  const environmentsById = new Map(
    input.environments.map((environment) => [environment.environmentId, environment]),
  );
  const projectsByKey = new Map(
    input.projects.map((project) => [boardProjectKey(project.environmentId, project.id), project]),
  );
  const providersByKey = new Map(
    input.providers.map((provider) => [
      boardProviderInstanceKey(provider.environmentId, provider.instanceId),
      provider,
    ]),
  );
  const eligible: AgentBoardCard[] = [];

  for (const thread of input.threads) {
    const legacyDeletedAt = (
      thread as EnvironmentThreadShell & { readonly deletedAt?: string | null }
    ).deletedAt;
    if (legacyDeletedAt != null || thread.archivedAt !== null) continue;
    const runtime = deriveAgentOperationalState(thread);
    if (effectiveSnoozed(thread, { now: input.now })) continue;

    const environment = environmentsById.get(thread.environmentId);
    const project = projectsByKey.get(boardProjectKey(thread.environmentId, thread.projectId));
    const providerKey = boardProviderInstanceKey(
      thread.environmentId,
      thread.modelSelection.instanceId,
    );
    const provider = providersByKey.get(providerKey);
    eligible.push({
      ref: { environmentId: thread.environmentId, threadId: thread.id },
      threadTitle: thread.title,
      environment: environment
        ? { ...environment, removed: false }
        : {
            environmentId: thread.environmentId,
            label: null,
            platform: null,
            connectivity: "disconnected",
            cachedAt: null,
            removed: true,
          },
      project: project
        ? { projectId: project.id, title: project.title, workspaceRoot: project.workspaceRoot }
        : null,
      providerInstanceId: thread.modelSelection.instanceId,
      providerDriver: provider?.driver ?? null,
      providerLabel: provider?.label ?? null,
      model: thread.modelSelection.model,
      branch: thread.branch,
      worktreePath: thread.worktreePath,
      runtime,
      attention: attentionFor(runtime),
      currentOperation: operationFor(thread, runtime),
      planProgress:
        thread.planProgress == null
          ? null
          : {
              completedSteps: thread.planProgress.completedSteps,
              totalSteps: thread.planProgress.totalSteps,
            },
      lastActivityAt: threadLastActivityAt(thread) ?? thread.updatedAt,
      archived: false,
    });
  }

  const environmentCounts = new Map<string, { label: string; count: number }>();
  const projectCounts = new Map<string, { label: string; count: number }>();
  const providerCounts = new Map<string, { label: string; count: number }>();
  const providerInstanceCounts = new Map<string, { label: string; count: number }>();
  const modelCounts = new Map<string, { label: string; count: number }>();

  for (const card of eligible) {
    addOption(
      environmentCounts,
      card.environment.environmentId,
      card.environment.label ?? card.environment.environmentId,
    );
    if (card.project !== null) {
      addOption(
        projectCounts,
        boardProjectKey(card.ref.environmentId, card.project.projectId),
        card.project.title,
      );
    }
    if (card.providerDriver !== null) {
      addOption(providerCounts, card.providerDriver, card.providerDriver);
    }
    addOption(
      providerInstanceCounts,
      boardProviderInstanceKey(card.ref.environmentId, card.providerInstanceId),
      card.providerLabel ?? card.providerInstanceId,
    );
    addOption(modelCounts, card.model, card.model);
  }

  const options: AgentBoardFilterOptions = {
    environments: optionList(environmentCounts),
    projects: optionList(projectCounts),
    providers: optionList(providerCounts),
    providerInstances: optionList(providerInstanceCounts),
    models: optionList(modelCounts),
  };
  const valid = {
    environmentIds: new Set(options.environments.map((option) => option.value)),
    projectKeys: new Set(options.projects.map((option) => option.value)),
    providerDrivers: new Set(options.providers.map((option) => option.value)),
    providerInstanceKeys: new Set(options.providerInstances.map((option) => option.value)),
    models: new Set(options.models.map((option) => option.value)),
  };
  const selected = {
    environmentIds: activeSelection(input.filters.environmentIds, valid.environmentIds),
    projectKeys: activeSelection(input.filters.projectKeys, valid.projectKeys),
    providerDrivers: activeSelection(input.filters.providerDrivers, valid.providerDrivers),
    providerInstanceKeys: activeSelection(
      input.filters.providerInstanceKeys,
      valid.providerInstanceKeys,
    ),
    models: activeSelection(input.filters.models, valid.models),
  };
  const staleFilterCount =
    input.filters.environmentIds.length -
    selected.environmentIds.size +
    input.filters.projectKeys.length -
    selected.projectKeys.size +
    input.filters.providerDrivers.length -
    selected.providerDrivers.size +
    input.filters.providerInstanceKeys.length -
    selected.providerInstanceKeys.size +
    input.filters.models.length -
    selected.models.size;
  const columns: Record<keyof AgentBoardColumns, AgentBoardCard[]> = {
    needsYou: [],
    working: [],
    review: [],
    settled: [],
    issue: [],
    idle: [],
  };

  for (const card of eligible) {
    if (input.filters.onlyActive && card.runtime.kind === "idle") continue;
    if (!selectedMatches(selected.environmentIds, card.ref.environmentId)) continue;
    if (
      !selectedMatches(
        selected.projectKeys,
        card.project === null
          ? null
          : boardProjectKey(card.ref.environmentId, card.project.projectId),
      )
    )
      continue;
    if (!selectedMatches(selected.providerDrivers, card.providerDriver)) continue;
    if (
      !selectedMatches(
        selected.providerInstanceKeys,
        boardProviderInstanceKey(card.ref.environmentId, card.providerInstanceId),
      )
    )
      continue;
    if (!selectedMatches(selected.models, card.model)) continue;

    switch (card.runtime.kind) {
      case "needs-you":
        columns.needsYou.push(card);
        break;
      case "working":
        columns.working.push(card);
        break;
      case "review":
        columns.review.push(card);
        break;
      case "settled":
        columns.settled.push(card);
        break;
      case "issue":
        columns.issue.push(card);
        break;
      case "idle":
        columns.idle.push(card);
        break;
    }
  }

  columns.needsYou.sort(ascendingStateSince);
  columns.working.sort(descendingActivity);
  columns.review.sort(ascendingStateSince);
  columns.settled.sort(descendingStateSince);
  columns.issue.sort(descendingStateSince);
  columns.idle.sort(descendingActivity);
  const totalVisible = Object.values(columns).reduce((total, cards) => total + cards.length, 0);

  return { columns, options, staleFilterCount, totalVisible, totalEligible: eligible.length };
}

/** Memoizes by source/filter identity for atom- and React-derived callers. */
export function createAgentBoardProjector() {
  let previousInput: AgentBoardInput | null = null;
  let previous: AgentBoardModel | null = null;
  return (input: AgentBoardInput): AgentBoardModel => {
    if (
      previousInput !== null &&
      previous !== null &&
      previousInput.threads === input.threads &&
      previousInput.projects === input.projects &&
      previousInput.environments === input.environments &&
      previousInput.providers === input.providers &&
      previousInput.filters === input.filters &&
      previousInput.now === input.now
    ) {
      return previous;
    }
    previousInput = input;
    previous = buildAgentBoard(input);
    return previous;
  };
}

export type { AgentOperationalState } from "./agentBoardStateAdapter.ts";
export { deriveAgentOperationalState } from "./agentBoardStateAdapter.ts";
