import type {
  AutomationJournalEntry,
  DelegatedTask,
  EnvironmentId,
  InboxEntry,
  Orchestrator,
  OrchestratorBudget,
  OrchestratorId,
  OrchestratorUsage,
  PendingRequestSummary,
  ResponsibilityClaim,
  ResponsibilityOwner,
  ThreadId,
} from "@t3tools/contracts";

/**
 * View models for durable automation: orchestrators, delegated tasks, jobs,
 * hooks, peers and responsibility claims. Web and mobile render from these so
 * a status reads the same on every client.
 *
 * Every mapping accepts a plain string. A server newer than this client can
 * send a status this file has never heard of, and that must read as a generic
 * label rather than break the screen it is on.
 */

export type AutomationSeverity = "neutral" | "info" | "success" | "warning" | "error" | "unknown";

/** A semantic glyph name. Each client maps it to its own icon set. */
export type AutomationStatusIcon =
  | "idle"
  | "queued"
  | "running"
  | "waiting"
  | "paused"
  | "disabled"
  | "limit"
  | "transfer"
  | "remote"
  | "error"
  | "done"
  | "reported"
  | "cancelled"
  | "unknown"
  | "offline"
  | "generic";

export interface AutomationStatusPresentation {
  /** The raw status the server sent. */
  readonly key: string;
  readonly label: string;
  readonly icon: AutomationStatusIcon;
  readonly severity: AutomationSeverity;
  /** One sentence for a tooltip or a detail line. Null when the label says it all. */
  readonly description: string | null;
  /** False when this client has no entry for the status and shows a generic label. */
  readonly known: boolean;
}

type StatusTable = Readonly<
  Record<
    string,
    readonly [
      label: string,
      icon: AutomationStatusIcon,
      severity: AutomationSeverity,
      description?: string,
    ]
  >
>;

/** "budget_exceeded" reads as "Budget exceeded" when no table knows the status. */
function humanizeAutomationStatus(status: string): string {
  const words = status
    .replace(/[_.-]+/g, " ")
    .trim()
    .toLowerCase();
  if (words.length === 0) return "Unknown";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function makeStatusPresenter(table: StatusTable) {
  const known = new Map<string, AutomationStatusPresentation>();
  for (const key of Object.keys(table)) {
    const [label, icon, severity, description] = table[key]!;
    known.set(key, {
      key,
      label,
      icon,
      severity,
      description: description ?? null,
      known: true,
    });
  }
  return (status: string): AutomationStatusPresentation =>
    known.get(status) ?? {
      key: status,
      label: humanizeAutomationStatus(status),
      icon: "generic",
      severity: "neutral",
      description: null,
      known: false,
    };
}

const UNKNOWN_OUTCOME =
  "The outcome could not be established, for example after a restart. It was not run again.";

const ORCHESTRATOR_STATES = {
  idle: ["Idle", "idle", "neutral", "Nothing in its inbox needs a turn."],
  queued: ["Queued", "queued", "info", "A turn is about to start."],
  running: ["Running", "running", "info", "Taking a turn now."],
  waiting: ["Waiting", "waiting", "info", "Waiting on a request or a child task."],
  paused: ["Paused", "paused", "neutral", "Keeps its inbox. Running child tasks continue."],
  disabled: ["Disabled", "disabled", "neutral", "Takes no turns and receives nothing from hooks."],
  budget_exceeded: [
    "Budget exceeded",
    "limit",
    "warning",
    "A limit was reached. New turns wait and the backlog is kept.",
  ],
  handing_off: ["Handing off", "transfer", "info", "Moving to another environment."],
  not_hosted_here: [
    "Not hosted here",
    "remote",
    "neutral",
    "Runs in another environment. This is a read-only copy.",
  ],
  error: ["Error", "error", "error"],
} as const satisfies Record<Orchestrator["effectiveState"], StatusTable[string]>;

const DELEGATED_TASK_STATUSES = {
  pending_delivery: [
    "Waiting for delivery",
    "queued",
    "neutral",
    "The destination environment has not confirmed it yet.",
  ],
  accepted: ["Accepted", "queued", "info", "The destination stored it and has a thread for it."],
  running: ["Running", "running", "info"],
  blocked: ["Blocked", "waiting", "warning", "Waiting on a request, a dependency or a permission."],
  reported: [
    "Reported",
    "reported",
    "info",
    "The child finished its turn. Nobody has checked the acceptance criteria yet.",
  ],
  validated: ["Validated", "done", "success", "The acceptance criteria were checked."],
  failed: ["Failed", "error", "error"],
  cancel_requested: ["Cancelling", "waiting", "warning", "Asked to stop; not confirmed yet."],
  cancelled: ["Cancelled", "cancelled", "neutral"],
  unknown: ["Outcome unknown", "unknown", "unknown", UNKNOWN_OUTCOME],
  expired: ["Expired", "cancelled", "warning", "Its deadline passed before it could start."],
} as const satisfies Record<DelegatedTask["status"], StatusTable[string]>;

const JOB_STATUSES = {
  accepted: ["Accepted", "queued", "neutral", "Stored; not handed to the node yet."],
  started: ["Running", "running", "info"],
  succeeded: ["Succeeded", "done", "success"],
  failed: ["Failed", "error", "error"],
  timed_out: ["Timed out", "error", "error"],
  cancel_requested: [
    "Cancelling",
    "waiting",
    "warning",
    "Asked to stop; the process has not ended.",
  ],
  cancelled: ["Cancelled", "cancelled", "neutral"],
  unknown: ["Outcome unknown", "unknown", "unknown", UNKNOWN_OUTCOME],
} as const satisfies StatusTable;

const HOOK_DELIVERY_STATUSES = {
  pending: ["Pending", "queued", "neutral"],
  delivering: ["Delivering", "running", "info"],
  delivered: [
    "Delivered",
    "done",
    "success",
    "Stored at its destination. This says nothing about the work it triggers.",
  ],
  retrying: ["Retrying", "waiting", "warning"],
  failed: ["Failed", "error", "error", "Attempts are exhausted. Redeliver or dismiss it."],
  suppressed: [
    "Suppressed",
    "paused",
    "warning",
    "Held back by a loop, a cooldown or a per-task limit. Not dropped.",
  ],
} as const satisfies StatusTable;

const HOOK_SUPPRESSED_REASONS: Readonly<Record<string, string>> = {
  hop_limit: "it would loop",
  cooldown: "it is cooling down",
  task_limit: "the per-task limit was reached",
  self_turn: "it came from the orchestrator's own turn",
  backpressure: "the destination is backed up",
};

const PEER_CONNECTION_STATUSES = {
  connected: ["Connected", "done", "success"],
  connecting: ["Connecting", "queued", "info"],
  offline: ["Offline", "offline", "warning", "Messages for it wait and are sent when it returns."],
  incompatible: [
    "Incompatible",
    "error",
    "error",
    "The two environments share no protocol version, so nothing is sent.",
  ],
  revoked: ["Revoked", "error", "error", "The peer refuses this environment."],
} as const satisfies StatusTable;

const INBOX_ENTRY_STATUSES = {
  pending: ["Pending", "queued", "neutral", "Stored; not shown to the model yet."],
  reserved: ["Being read", "running", "info", "Reserved by the turn that is reading it."],
  processed: ["Processed", "done", "success"],
  absorbed: ["Absorbed", "done", "neutral", "Recorded as state without opening a turn."],
  unknown: ["Outcome unknown", "unknown", "unknown", UNKNOWN_OUTCOME],
  dismissed: ["Dismissed", "cancelled", "neutral"],
} as const satisfies Record<InboxEntry["status"], StatusTable[string]>;

const NODE_AVAILABILITY_STATUSES = {
  available: ["Available", "done", "success"],
  unavailable: ["Unavailable", "offline", "warning"],
  unknown: ["Not probed", "unknown", "unknown", "No probe has reported yet."],
} as const satisfies StatusTable;

export const presentOrchestratorState = makeStatusPresenter(ORCHESTRATOR_STATES);
export const presentDelegatedTaskStatus = makeStatusPresenter(DELEGATED_TASK_STATUSES);
export const presentJobStatus = makeStatusPresenter(JOB_STATUSES);
export const presentHookDeliveryStatus = makeStatusPresenter(HOOK_DELIVERY_STATUSES);
export const presentPeerConnectionStatus = makeStatusPresenter(PEER_CONNECTION_STATUSES);
export const presentInboxEntryStatus = makeStatusPresenter(INBOX_ENTRY_STATUSES);
export const presentNodeAvailability = makeStatusPresenter(NODE_AVAILABILITY_STATUSES);

export function hookSuppressedReasonLabel(reason: string | null): string | null {
  if (reason === null) return null;
  return HOOK_SUPPRESSED_REASONS[reason] ?? humanizeAutomationStatus(reason).toLowerCase();
}

export function orchestratorScopeLabel(scope: string): string {
  if (scope === "local") return "Local";
  if (scope === "global") return "Global";
  return humanizeAutomationStatus(scope);
}

/** Older servers omit the capability, so only an explicit `true` shows automation. */
export function environmentSupportsAutomation(
  config:
    | {
        readonly environment: { readonly capabilities: { readonly automation?: boolean } };
      }
    | null
    | undefined,
): boolean {
  return config?.environment.capabilities.automation === true;
}

// ---------------------------------------------------------------------------
// Orchestrators joined to threads
// ---------------------------------------------------------------------------

/** The orchestrator list one environment reported. */
export interface OrchestratorEnvironmentSnapshot {
  readonly environmentId: EnvironmentId;
  readonly orchestrators: ReadonlyArray<Orchestrator>;
}

/** An orchestrator as seen from one environment. */
export interface OrchestratorView {
  /** `environmentId:orchestratorId`, unique per observing environment. */
  readonly key: string;
  /** The environment whose list this record came from. */
  readonly environmentId: EnvironmentId;
  readonly orchestrator: Orchestrator;
  /** False on a projection: the runtime lives in `orchestrator.hostEnvironmentId`. */
  readonly hostedHere: boolean;
  /** `environmentId:threadId` of the main thread, or null on a projection without one. */
  readonly threadKey: string | null;
}

export function automationThreadKey(environmentId: string, threadId: string): string {
  return `${environmentId}:${threadId}`;
}

function orchestratorViewKey(environmentId: string, orchestratorId: string): string {
  return `${environmentId}:${orchestratorId}`;
}

function timestampMillis(value: string | null | undefined): number {
  if (value === null || value === undefined) return Number.NEGATIVE_INFINITY;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : Number.NEGATIVE_INFINITY;
}

/** Positive when `left` is the better record of the two. */
function compareOrchestratorAuthority(left: OrchestratorView, right: OrchestratorView): number {
  if (left.hostedHere !== right.hostedHere) return left.hostedHere ? 1 : -1;
  const generation = left.orchestrator.hostGeneration - right.orchestrator.hostGeneration;
  if (generation !== 0) return generation;
  const revision = left.orchestrator.revision - right.orchestrator.revision;
  if (revision !== 0) return revision;
  const observed =
    timestampMillis(left.orchestrator.observedAt) - timestampMillis(right.orchestrator.observedAt);
  if (observed !== 0) return observed;
  // Total order, so the same input always picks the same record.
  return left.key < right.key ? 1 : left.key > right.key ? -1 : 0;
}

/**
 * Every orchestrator each environment knows, one view per (environment,
 * orchestrator). A list that repeats an id keeps its most authoritative copy.
 */
export function buildOrchestratorViews(
  snapshots: ReadonlyArray<OrchestratorEnvironmentSnapshot>,
): ReadonlyArray<OrchestratorView> {
  const byKey = new Map<string, OrchestratorView>();
  for (const snapshot of snapshots) {
    for (const orchestrator of snapshot.orchestrators) {
      const view: OrchestratorView = {
        key: orchestratorViewKey(snapshot.environmentId, orchestrator.id),
        environmentId: snapshot.environmentId,
        orchestrator,
        hostedHere: orchestrator.hostEnvironmentId === snapshot.environmentId,
        threadKey:
          orchestrator.threadId === null
            ? null
            : automationThreadKey(snapshot.environmentId, orchestrator.threadId),
      };
      const existing = byKey.get(view.key);
      if (existing === undefined || compareOrchestratorAuthority(view, existing) > 0) {
        byKey.set(view.key, view);
      }
    }
  }
  return [...byKey.values()];
}

/**
 * What a thread row or header shows about the orchestrator that owns the
 * thread. Flat on purpose: two markers with equal fields are the same marker,
 * so a list refresh that changes nothing re-renders nothing.
 */
export interface OrchestratorThreadMarker {
  readonly threadKey: string;
  readonly environmentId: EnvironmentId;
  readonly orchestratorId: OrchestratorId;
  readonly name: string;
  readonly scope: string;
  readonly scopeLabel: string;
  readonly state: AutomationStatusPresentation;
  readonly stateReason: string | null;
  readonly desiredState: string;
  readonly hostEnvironmentId: EnvironmentId;
  readonly hostedHere: boolean;
  readonly model: string;
  readonly inboxPending: number;
  /** Text for screen readers; the row shows an icon and a short label. */
  readonly accessibleLabel: string;
}

function toOrchestratorThreadMarker(
  view: OrchestratorView,
  threadKey: string,
): OrchestratorThreadMarker {
  const { orchestrator } = view;
  const state = presentOrchestratorState(orchestrator.effectiveState);
  const scopeLabel = orchestratorScopeLabel(orchestrator.scope);
  return {
    threadKey,
    environmentId: view.environmentId,
    orchestratorId: orchestrator.id,
    name: orchestrator.name,
    scope: orchestrator.scope,
    scopeLabel,
    state,
    stateReason: orchestrator.stateReason,
    desiredState: orchestrator.desiredState,
    hostEnvironmentId: orchestrator.hostEnvironmentId,
    hostedHere: view.hostedHere,
    model: orchestrator.modelSelection.model,
    inboxPending: orchestrator.inboxPending,
    accessibleLabel: `${scopeLabel} orchestrator ${orchestrator.name}: ${state.label}`,
  };
}

function orchestratorThreadMarkersEqual(
  left: OrchestratorThreadMarker,
  right: OrchestratorThreadMarker,
): boolean {
  return (
    left.threadKey === right.threadKey &&
    left.environmentId === right.environmentId &&
    left.orchestratorId === right.orchestratorId &&
    left.name === right.name &&
    left.scope === right.scope &&
    left.state.key === right.state.key &&
    left.stateReason === right.stateReason &&
    left.desiredState === right.desiredState &&
    left.hostEnvironmentId === right.hostEnvironmentId &&
    left.hostedHere === right.hostedHere &&
    left.model === right.model &&
    left.inboxPending === right.inboxPending
  );
}

export interface OrchestratorThreadIndex {
  readonly viewByThreadKey: ReadonlyMap<string, OrchestratorView>;
  readonly markerByThreadKey: ReadonlyMap<string, OrchestratorThreadMarker>;
}

export const EMPTY_ORCHESTRATOR_THREAD_INDEX: OrchestratorThreadIndex = {
  viewByThreadKey: new Map(),
  markerByThreadKey: new Map(),
};

/**
 * Finds the orchestrator behind each main thread.
 *
 * The join is `(observing environment, Orchestrator.threadId)`. A projection
 * with no thread marks nothing. When two orchestrators of one environment name
 * the same thread, the one hosted there wins, then the newer record. Pass
 * `previous` to keep the markers that did not change.
 */
export function buildOrchestratorThreadIndex(
  snapshots: ReadonlyArray<OrchestratorEnvironmentSnapshot>,
  previous: OrchestratorThreadIndex = EMPTY_ORCHESTRATOR_THREAD_INDEX,
): OrchestratorThreadIndex {
  const viewByThreadKey = new Map<string, OrchestratorView>();
  for (const view of buildOrchestratorViews(snapshots)) {
    if (view.threadKey === null) continue;
    const existing = viewByThreadKey.get(view.threadKey);
    if (existing === undefined || compareOrchestratorAuthority(view, existing) > 0) {
      viewByThreadKey.set(view.threadKey, view);
    }
  }
  const markerByThreadKey = new Map<string, OrchestratorThreadMarker>();
  let markersChanged = viewByThreadKey.size !== previous.markerByThreadKey.size;
  for (const [threadKey, view] of viewByThreadKey) {
    const next = toOrchestratorThreadMarker(view, threadKey);
    const before = previous.markerByThreadKey.get(threadKey);
    if (before !== undefined && orchestratorThreadMarkersEqual(before, next)) {
      markerByThreadKey.set(threadKey, before);
    } else {
      markerByThreadKey.set(threadKey, next);
      markersChanged = true;
    }
  }
  return {
    viewByThreadKey,
    markerByThreadKey: markersChanged ? markerByThreadKey : previous.markerByThreadKey,
  };
}

/**
 * The record to trust for an orchestrator named from elsewhere, such as the
 * owner of a claim: its host's copy when that environment is loaded, otherwise
 * the freshest projection.
 */
export function resolveOrchestratorView(
  views: ReadonlyArray<OrchestratorView>,
  orchestratorId: string,
  hostEnvironmentId?: string | null,
): OrchestratorView | null {
  let best: OrchestratorView | null = null;
  for (const view of views) {
    if (view.orchestrator.id !== orchestratorId) continue;
    if (
      hostEnvironmentId !== undefined &&
      hostEnvironmentId !== null &&
      view.environmentId === hostEnvironmentId &&
      view.hostedHere
    ) {
      return view;
    }
    if (best === null || compareOrchestratorAuthority(view, best) > 0) best = view;
  }
  return best;
}

export type OrchestratorThreadLink = "linked" | "missing" | "none";

export interface OrchestratorListRow<T> {
  readonly view: OrchestratorView;
  readonly state: AutomationStatusPresentation;
  /** `none`: a projection with no thread here. `missing`: a thread id with no loaded shell. */
  readonly threadLink: OrchestratorThreadLink;
  readonly thread: T | null;
}

/** One environment's orchestrators beside their main threads, by name. */
export function joinOrchestratorsToThreads<
  T extends { readonly environmentId: string; readonly id: string },
>(input: {
  readonly snapshot: OrchestratorEnvironmentSnapshot;
  readonly threads: ReadonlyArray<T>;
}): ReadonlyArray<OrchestratorListRow<T>> {
  const threadByKey = new Map<string, T>();
  for (const thread of input.threads) {
    const key = automationThreadKey(thread.environmentId, thread.id);
    // The first shell is authoritative, as in the thread relationship graph.
    if (!threadByKey.has(key)) threadByKey.set(key, thread);
  }
  return buildOrchestratorViews([input.snapshot])
    .map((view): OrchestratorListRow<T> => {
      const thread = view.threadKey === null ? null : (threadByKey.get(view.threadKey) ?? null);
      return {
        view,
        state: presentOrchestratorState(view.orchestrator.effectiveState),
        threadLink: view.threadKey === null ? "none" : thread === null ? "missing" : "linked",
        thread,
      };
    })
    .sort((left, right) => {
      const leftName = left.view.orchestrator.name.toLowerCase();
      const rightName = right.view.orchestrator.name.toLowerCase();
      if (leftName !== rightName) return leftName < rightName ? -1 : 1;
      return left.view.key < right.view.key ? -1 : left.view.key > right.view.key ? 1 : 0;
    });
}

/** Which state buttons an orchestrator offers. A projection offers none. */
export function orchestratorStateActions(view: OrchestratorView): {
  readonly canPause: boolean;
  readonly canResume: boolean;
  readonly canDisable: boolean;
  readonly canInterruptTurn: boolean;
} {
  if (!view.hostedHere) {
    return { canPause: false, canResume: false, canDisable: false, canInterruptTurn: false };
  }
  const { desiredState, effectiveState } = view.orchestrator;
  return {
    canPause: desiredState === "active",
    canResume: desiredState !== "active",
    canDisable: desiredState !== "disabled",
    canInterruptTurn: effectiveState === "running",
  };
}

// ---------------------------------------------------------------------------
// Budget and usage
// ---------------------------------------------------------------------------

function formatAutomationCount(value: number): string {
  return String(Math.trunc(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatAutomationDuration(ms: number): string {
  if (ms < 1_000) return `${ms} ms`;
  const seconds = ms / 1_000;
  if (seconds < 60) return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)} min`;
  const hours = minutes / 60;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} h`;
}

export interface OrchestratorBudgetLine {
  readonly key: string;
  readonly label: string;
  /** Null when the provider does not report it: unknown, never zero. */
  readonly used: number | null;
  /** Null when no limit is set. */
  readonly limit: number | null;
  readonly usedLabel: string | null;
  readonly limitLabel: string;
  /** Null when usage is unknown and a limit exists: it cannot be told. */
  readonly exceeded: boolean | null;
  readonly note: string | null;
}

const NO_LIMIT = "No limit";

/**
 * Usage beside its limit where the runtime counts something, and the limit
 * alone where it only enforces one.
 */
export function presentOrchestratorBudget(
  budget: OrchestratorBudget,
  usage: OrchestratorUsage,
): ReadonlyArray<OrchestratorBudgetLine> {
  const counted = (
    key: string,
    label: string,
    used: number | null,
    limit: number | null,
    note: string | null = null,
  ): OrchestratorBudgetLine => ({
    key,
    label,
    used,
    limit,
    usedLabel: used === null ? "Unknown" : formatAutomationCount(used),
    limitLabel: limit === null ? NO_LIMIT : formatAutomationCount(limit),
    exceeded: limit === null ? false : used === null ? null : used >= limit,
    note,
  });
  const limitOnly = (
    key: string,
    label: string,
    limit: number | null,
    format: (value: number) => string = formatAutomationCount,
  ): OrchestratorBudgetLine => ({
    key,
    label,
    used: null,
    limit,
    usedLabel: null,
    limitLabel: limit === null ? NO_LIMIT : format(limit),
    exceeded: false,
    note: null,
  });
  const tokens = counted(
    "tokens",
    "Tokens",
    usage.tokens,
    budget.maxTokens,
    usage.tokens === null
      ? "The provider does not report token usage."
      : usage.tokensComplete
        ? null
        : "Some turns did not report usage, so the real total is higher.",
  );
  return [
    usage.tokens !== null && !usage.tokensComplete
      ? { ...tokens, usedLabel: `At least ${tokens.usedLabel}` }
      : tokens,
    counted("turnsLastHour", "Turns in the last hour", usage.turnsLastHour, budget.maxTurnsPerHour),
    counted(
      "activeChildren",
      "Child tasks running",
      usage.activeChildren,
      budget.maxConcurrentChildren,
    ),
    counted("turns", "Turns in total", usage.turns, null),
    limitOnly("maxTurnsPerTask", "Turns per task", budget.maxTurnsPerTask),
    limitOnly("maxChildrenPerTask", "Child tasks per task", budget.maxChildrenPerTask),
    limitOnly("maxTaskAttempts", "Attempts per task", budget.maxTaskAttempts),
    limitOnly(
      "maxTurnDurationMs",
      "Turn duration",
      budget.maxTurnDurationMs,
      formatAutomationDuration,
    ),
  ];
}

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------

export interface OrchestratorInboxSummary {
  readonly pending: number;
  readonly reserved: number;
  readonly unknown: number;
  /** Entries whose outcome is unknown: each needs a requeue or a dismiss. */
  readonly unknownEntries: ReadonlyArray<InboxEntry>;
  /** The entry list hit its limit, so `reserved` and `unknown` are lower bounds. */
  readonly partial: boolean;
}

/**
 * `inboxPending` is the server's own count and is always complete. Reserved
 * and unknown entries are counted from the loaded page.
 */
export function summarizeOrchestratorInbox(input: {
  readonly inboxPending: number;
  readonly entries: ReadonlyArray<InboxEntry> | null;
  readonly limit: number;
}): OrchestratorInboxSummary {
  const entries = input.entries ?? [];
  const unknownEntries = entries.filter((entry) => entry.status === "unknown");
  return {
    pending: input.inboxPending,
    reserved: entries.filter((entry) => entry.status === "reserved").length,
    unknown: unknownEntries.length,
    unknownEntries,
    partial: input.entries === null || entries.length >= input.limit,
  };
}

export function inboxEntryPreview(entry: InboxEntry): string {
  const text = entry.text?.trim();
  if (text) return text;
  const types = [...new Set(entry.entries.map((item) => item.event.type))];
  if (types.length > 0) return types.join(", ");
  return humanizeAutomationStatus(entry.kind);
}

// ---------------------------------------------------------------------------
// Staleness and reachability
// ---------------------------------------------------------------------------

/** After this, something read from another environment is shown as stale. */
export const AUTOMATION_STALE_AFTER_MS = 2 * 60_000;

export type ObservationFreshness = "fresh" | "stale" | "never";

export interface ObservationPresentation {
  readonly freshness: ObservationFreshness;
  readonly ageMs: number | null;
  /** "Observed 5m ago" or "Never observed". */
  readonly label: string;
  /** Null when nothing says whether the environment can be reached. */
  readonly reachable: boolean | null;
  readonly reachabilityLabel: string | null;
}

export function formatAutomationAge(ageMs: number): string {
  if (ageMs < 45_000) return "just now";
  const minutes = Math.round(ageMs / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * How old a record from another environment is, and whether that environment
 * answers right now. A timestamp ahead of this clock counts as just observed:
 * the two machines' clocks differ, the record is not from the future.
 */
export function presentObservation(input: {
  readonly observedAt: string | null | undefined;
  readonly nowMs: number;
  readonly reachable?: boolean | null;
  readonly verb?: string;
  readonly staleAfterMs?: number;
}): ObservationPresentation {
  const verb = input.verb ?? "Observed";
  const reachable = input.reachable ?? null;
  const reachabilityLabel =
    reachable === null ? null : reachable ? "Reachable now" : "Not reachable now";
  const observedMs = timestampMillis(input.observedAt);
  if (observedMs === Number.NEGATIVE_INFINITY) {
    return {
      freshness: "never",
      ageMs: null,
      label: `Never ${verb.toLowerCase()}`,
      reachable,
      reachabilityLabel,
    };
  }
  const ageMs = Math.max(0, input.nowMs - observedMs);
  return {
    freshness: ageMs >= (input.staleAfterMs ?? AUTOMATION_STALE_AFTER_MS) ? "stale" : "fresh",
    ageMs,
    label: `${verb} ${formatAutomationAge(ageMs)}`,
    reachable,
    reachabilityLabel,
  };
}

/**
 * Whether an environment can be reached, from the best source available: the
 * host's own peer link when it reports one, otherwise this client's
 * connection to that environment. Null when neither knows it.
 */
export function resolveEnvironmentReachability(input: {
  readonly peerStatus?: string | null | undefined;
  readonly clientConnectionPhase?: string | null | undefined;
}): boolean | null {
  if (input.peerStatus !== undefined && input.peerStatus !== null) {
    return input.peerStatus === "connected";
  }
  if (input.clientConnectionPhase !== undefined && input.clientConnectionPhase !== null) {
    return input.clientConnectionPhase === "connected";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Responsibility
// ---------------------------------------------------------------------------

const RESPONSIBILITY_RULES: Readonly<Record<string, string>> = {
  explicit_owner: "it was assigned explicitly",
  managing_parent: "it manages this thread",
  local_orchestrator: "it is this environment's local orchestrator",
  global_orchestrator: "it is the global orchestrator",
  user: "no automated owner applies",
};

function responsibilityRuleLabel(rule: string): string {
  return RESPONSIBILITY_RULES[rule] ?? humanizeAutomationStatus(rule).toLowerCase();
}

export interface ResponsibilityLookup {
  readonly orchestratorName: (
    orchestratorId: OrchestratorId,
    environmentId: EnvironmentId,
  ) => string | null;
  readonly threadTitle: (threadId: ThreadId) => string | null;
}

export type ResponsibilityOwnerKind = "user" | "orchestrator" | "thread" | "unassigned";

export interface ResponsibilityPresentation {
  readonly ownerKind: ResponsibilityOwnerKind;
  /** "You", "Orchestrator Release bot", "Parent thread Fix build". */
  readonly ownerLabel: string;
  /** Why the runtime picked the owner, or null when nothing was claimed. */
  readonly ruleLabel: string | null;
  /** True when something other than the user is responsible. */
  readonly delegated: boolean;
  readonly reservedForUser: boolean;
  /** One line to show beside the request. */
  readonly summary: string;
  /** Says who may answer. Being able to see a request is not permission to answer it. */
  readonly note: string | null;
  /** The owner's lease ran out. That does not prove the owner stopped. */
  readonly leaseExpired: boolean;
}

function responsibilityOwnerLabel(
  owner: ResponsibilityOwner,
  lookup: ResponsibilityLookup,
): string {
  // Read through a string so an owner kind from a newer server still gets a label.
  const kind: string = owner.kind;
  if (owner.kind === "user") return "You";
  if (owner.kind === "orchestrator") {
    const name = lookup.orchestratorName(owner.orchestratorId, owner.environmentId);
    return name === null ? "An orchestrator" : `Orchestrator ${name}`;
  }
  if (owner.kind === "thread") {
    const title = lookup.threadTitle(owner.threadId);
    return title === null ? "A parent thread" : `Thread ${title}`;
  }
  return humanizeAutomationStatus(kind);
}

/**
 * Who answers a pending request and why.
 *
 * `reservedForUser` wins over the claim: an approval guards an action, so an
 * orchestrator that tracks it still cannot decide it without a
 * pre-authorization.
 */
export function presentResponsibility(
  request: {
    readonly claim: ResponsibilityClaim | null;
    readonly reservedForUser: boolean;
  },
  lookup: ResponsibilityLookup,
  nowMs?: number,
): ResponsibilityPresentation {
  const { claim, reservedForUser } = request;
  if (claim === null) {
    return {
      ownerKind: "unassigned",
      ownerLabel: reservedForUser ? "You" : "Nobody yet",
      ruleLabel: null,
      delegated: false,
      reservedForUser,
      summary: reservedForUser ? "Reserved for you" : "Not assigned yet",
      note: reservedForUser
        ? "Only you, or a pre-authorization you set, can decide this."
        : "No owner has been assigned yet.",
      leaseExpired: false,
    };
  }
  const ownerLabel = responsibilityOwnerLabel(claim.owner, lookup);
  const ruleLabel = responsibilityRuleLabel(claim.rule);
  const delegated = claim.owner.kind !== "user";
  const leaseExpired =
    nowMs !== undefined &&
    claim.leaseExpiresAt !== null &&
    timestampMillis(claim.leaseExpiresAt) <= nowMs;
  const ownerKind: ResponsibilityOwnerKind =
    claim.owner.kind === "user"
      ? "user"
      : claim.owner.kind === "orchestrator"
        ? "orchestrator"
        : claim.owner.kind === "thread"
          ? "thread"
          : "unassigned";
  if (!delegated) {
    return {
      ownerKind,
      ownerLabel,
      ruleLabel,
      delegated,
      reservedForUser,
      summary: reservedForUser ? "Reserved for you" : "Waiting on you",
      note: reservedForUser ? "Only you, or a pre-authorization you set, can decide this." : null,
      leaseExpired,
    };
  }
  return {
    ownerKind,
    ownerLabel,
    ruleLabel,
    delegated,
    reservedForUser,
    summary: reservedForUser
      ? `Reserved for you · ${ownerLabel} is tracking it`
      : `${ownerLabel} is responsible`,
    note: reservedForUser
      ? `${ownerLabel} is tracking this because ${ruleLabel}, but only you, or a pre-authorization you set, can decide it.`
      : `${ownerLabel} answers this because ${ruleLabel}. Seeing it here does not make it yours to answer.`,
    leaseExpired,
  };
}

/** What a thread row says about the requests waiting on that thread. */
export interface ThreadResponsibilityMarker {
  readonly threadKey: string;
  /** Requests something other than the user is responsible for. */
  readonly delegatedCount: number;
  /** Requests only the user may decide. */
  readonly reservedForUserCount: number;
  readonly total: number;
  /** The single delegated owner's label, or null when there are none or several. */
  readonly ownerLabel: string | null;
  readonly accessibleLabel: string;
}

function threadResponsibilityMarkersEqual(
  left: ThreadResponsibilityMarker,
  right: ThreadResponsibilityMarker,
): boolean {
  return (
    left.delegatedCount === right.delegatedCount &&
    left.reservedForUserCount === right.reservedForUserCount &&
    left.total === right.total &&
    left.ownerLabel === right.ownerLabel
  );
}

/**
 * Per thread, whether its pending requests belong to something other than the
 * user. Threads whose requests are all plainly the user's get no marker: the
 * existing needs-you indicator already says that.
 */
export function buildThreadResponsibilityIndex(
  requests: ReadonlyArray<PendingRequestSummary>,
  lookup: ResponsibilityLookup,
  previous: ReadonlyMap<string, ThreadResponsibilityMarker> = new Map(),
): ReadonlyMap<string, ThreadResponsibilityMarker> {
  const drafts = new Map<
    string,
    { delegated: number; reserved: number; total: number; owners: Set<string> }
  >();
  for (const request of requests) {
    const key = automationThreadKey(request.environmentId, request.threadId);
    const draft = drafts.get(key) ?? { delegated: 0, reserved: 0, total: 0, owners: new Set() };
    draft.total += 1;
    if (request.reservedForUser) draft.reserved += 1;
    if (request.claim !== null && request.claim.owner.kind !== "user") {
      draft.delegated += 1;
      draft.owners.add(responsibilityOwnerLabel(request.claim.owner, lookup));
    }
    drafts.set(key, draft);
  }
  const next = new Map<string, ThreadResponsibilityMarker>();
  let changed = false;
  for (const [threadKey, draft] of drafts) {
    if (draft.delegated === 0) continue;
    const ownerLabel = draft.owners.size === 1 ? [...draft.owners][0]! : null;
    const who = ownerLabel ?? "Several owners";
    const marker: ThreadResponsibilityMarker = {
      threadKey,
      delegatedCount: draft.delegated,
      reservedForUserCount: draft.reserved,
      total: draft.total,
      ownerLabel,
      accessibleLabel:
        draft.reserved > 0
          ? `${who} tracking ${draft.delegated} of ${draft.total} pending requests; ${draft.reserved} reserved for you`
          : `${who} responsible for ${draft.delegated} of ${draft.total} pending requests`,
    };
    const before = previous.get(threadKey);
    if (before !== undefined && threadResponsibilityMarkersEqual(before, marker)) {
      next.set(threadKey, before);
    } else {
      next.set(threadKey, marker);
      changed = true;
    }
  }
  return changed || next.size !== previous.size ? next : previous;
}

// ---------------------------------------------------------------------------
// Delegated tasks
// ---------------------------------------------------------------------------

const DELEGATED_TASK_SETTLED = new Set(["validated", "failed", "cancelled", "expired"]);

export interface DelegatedTaskRow {
  readonly task: DelegatedTask;
  readonly status: AutomationStatusPresentation;
  /** Reported is not validated: this is true only once the criteria were checked. */
  readonly validated: boolean;
  /** The child said it finished and nobody has checked the criteria. */
  readonly awaitingValidation: boolean;
  /** "2 of 3 criteria met", or null before any criterion was checked. */
  readonly criteriaLabel: string | null;
  /** Runs in an environment other than the one that listed it. */
  readonly remote: boolean;
  /** Where the child thread lives, or null until the destination accepted it. */
  readonly threadRef: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId } | null;
}

function delegatedTaskCriteriaLabel(task: DelegatedTask): string | null {
  const criteria = task.result?.criteria ?? [];
  const checked = criteria.filter((criterion) => criterion.met !== null);
  if (checked.length === 0) return null;
  const met = checked.filter((criterion) => criterion.met === true).length;
  const unchecked = criteria.length - checked.length;
  return `${met} of ${criteria.length} criteria met${unchecked > 0 ? `, ${unchecked} not checked` : ""}`;
}

/** Child tasks for a panel: work still open first, then the most recently changed. */
export function presentDelegatedTasks(input: {
  readonly tasks: ReadonlyArray<DelegatedTask>;
  /** The environment that returned the list. */
  readonly environmentId: EnvironmentId;
}): ReadonlyArray<DelegatedTaskRow> {
  const byId = new Map<string, DelegatedTask>();
  for (const task of input.tasks) {
    const existing = byId.get(task.id);
    if (existing === undefined || task.revision > existing.revision) byId.set(task.id, task);
  }
  return [...byId.values()]
    .map((task): DelegatedTaskRow => ({
      task,
      status: presentDelegatedTaskStatus(task.status),
      validated: task.status === "validated",
      awaitingValidation: task.status === "reported",
      criteriaLabel: delegatedTaskCriteriaLabel(task),
      remote: task.executionEnvironmentId !== input.environmentId,
      threadRef:
        task.threadId === null
          ? null
          : { environmentId: task.executionEnvironmentId, threadId: task.threadId },
    }))
    .sort((left, right) => {
      const leftSettled = DELEGATED_TASK_SETTLED.has(left.task.status);
      const rightSettled = DELEGATED_TASK_SETTLED.has(right.task.status);
      if (leftSettled !== rightSettled) return leftSettled ? 1 : -1;
      const updated = timestampMillis(right.task.updatedAt) - timestampMillis(left.task.updatedAt);
      if (updated !== 0 && Number.isFinite(updated)) return updated;
      return left.task.id < right.task.id ? -1 : left.task.id > right.task.id ? 1 : 0;
    });
}

// ---------------------------------------------------------------------------
// Activity and live changes
// ---------------------------------------------------------------------------

const AUTOMATION_EVENT_LABELS: Readonly<Record<string, string>> = {
  "thread.created": "Thread created",
  "thread.organized": "Thread organized",
  "thread.deleted": "Thread deleted",
  "turn.started": "Turn started",
  "turn.completed": "Turn completed",
  "turn.failed": "Turn failed",
  "turn.interrupted": "Turn interrupted",
  "request.opened": "Request opened",
  "request.resolved": "Request resolved",
  "task.delegated": "Task delegated",
  "task.accepted": "Task accepted",
  "task.progress": "Task progress",
  "task.blocked": "Task blocked",
  "task.reported": "Task reported",
  "task.validated": "Task validated",
  "task.failed": "Task failed",
  "task.cancelled": "Task cancelled",
  "task.unknown": "Task outcome unknown",
  "artifact.produced": "Artifact produced",
  "job.accepted": "Job accepted",
  "job.started": "Job started",
  "job.finished": "Job finished",
  "job.cancelled": "Job cancelled",
  "job.unknown": "Job outcome unknown",
  "node.availability": "Node availability changed",
  "peer.availability": "Peer availability changed",
  "peer.message.received": "Peer message received",
  "orchestrator.changed": "Orchestrator changed",
  "orchestrator.message.received": "Message received",
  "orchestrator.turn.finished": "Orchestrator turn finished",
  "claim.changed": "Responsibility changed",
  "hook.changed": "Hook changed",
  "hook.delivery.failed": "Hook delivery failed",
  "tool.called": "Tool called",
};

export function automationEventLabel(type: string): string {
  return AUTOMATION_EVENT_LABELS[type] ?? type;
}

export interface AutomationActivityRow {
  readonly key: string;
  readonly label: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly severity: AutomationSeverity;
}

function automationEventSeverity(type: string): AutomationSeverity {
  if (type.endsWith(".unknown")) return "unknown";
  if (type.endsWith(".failed")) return "error";
  if (type.endsWith(".blocked")) return "warning";
  return "neutral";
}

/** The newest journal entries first, at most `limit`. */
export function presentAutomationActivity(
  entries: ReadonlyArray<AutomationJournalEntry>,
  limit: number,
): ReadonlyArray<AutomationActivityRow> {
  return [...entries]
    .sort((left, right) => right.cursor - left.cursor)
    .slice(0, Math.max(0, limit))
    .map((entry) => ({
      key: `${entry.cursor}:${entry.event.eventId}`,
      label: automationEventLabel(entry.event.type),
      type: entry.event.type,
      occurredAt: entry.event.occurredAt,
      severity: automationEventSeverity(entry.event.type),
    }));
}

/** Lists a client keeps live by re-reading them when a matching event arrives. */
export type AutomationChangeKind =
  | "hooks"
  | "deliveries"
  | "peers"
  | "nodes"
  | "jobs"
  | "tasks"
  | "requests"
  | "inbox"
  | "activity";

export type AutomationChangeCounters = Readonly<Record<AutomationChangeKind, number>>;

export const EMPTY_AUTOMATION_CHANGE_COUNTERS: AutomationChangeCounters = {
  hooks: 0,
  deliveries: 0,
  peers: 0,
  nodes: 0,
  jobs: 0,
  tasks: 0,
  requests: 0,
  inbox: 0,
  activity: 0,
};

/**
 * The event types the change subscription asks for. Administrative types are
 * named one by one because a filter matches them only when it names them.
 */
export const AUTOMATION_CHANGE_EVENT_TYPES: ReadonlyArray<string> = [
  "hook.*",
  "hook.changed",
  "hook.delivery.failed",
  "peer.*",
  "node.*",
  "job.*",
  "task.*",
  "request.*",
  "claim.*",
  "claim.changed",
  "orchestrator.*",
  "orchestrator.changed",
  "orchestrator.turn.finished",
  "turn.*",
];

/** Which lists an event of this type makes stale. */
export function automationChangeKinds(type: string): ReadonlyArray<AutomationChangeKind> {
  if (type === "hook.changed") return ["hooks"];
  if (type.startsWith("hook.")) return ["deliveries"];
  if (type.startsWith("peer.")) return ["peers"];
  if (type.startsWith("node.")) return ["nodes"];
  if (type.startsWith("job.")) return ["jobs", "activity"];
  if (type.startsWith("task.")) return ["tasks", "requests", "activity"];
  if (type.startsWith("request.") || type.startsWith("claim.")) return ["requests", "activity"];
  if (type.startsWith("orchestrator.")) return ["inbox", "deliveries", "activity"];
  if (type.startsWith("turn.")) return ["inbox", "activity"];
  return [];
}

/** Bumps the counter of every list an event touches. Returns `counters` when it touches none. */
export function applyAutomationChange(
  counters: AutomationChangeCounters,
  type: string,
): AutomationChangeCounters {
  const kinds = automationChangeKinds(type);
  if (kinds.length === 0) return counters;
  const next: Record<AutomationChangeKind, number> = { ...counters };
  for (const kind of kinds) next[kind] += 1;
  return next;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const AUTOMATION_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  NOT_FOUND: "It no longer exists. Reload the list.",
  INVALID_INPUT: "The server rejected these values.",
  CONFLICT: "It conflicts with something that already exists.",
  REVISION_MISMATCH: "It was changed elsewhere. Reload it, then make your change again.",
  PERMISSION_DENIED: "This session is not allowed to do that.",
  REQUEST_ALREADY_RESOLVED: "The request was already answered.",
  REQUEST_EXPIRED: "The request expired.",
  NOT_OWNER: "Something else is responsible for this, so it cannot be answered from here.",
  ENVIRONMENT_UNAVAILABLE: "The environment that owns this cannot be reached right now.",
  NODE_UNAVAILABLE: "The node cannot be reached right now.",
  CAPABILITY_UNSUPPORTED: "This environment's server does not support that. Update it.",
  VERSION_INCOMPATIBLE: "The two environments share no compatible version.",
  CURSOR_EXPIRED: "That history is no longer kept. Reload to read from the current state.",
  BACKPRESSURE: "The server is busy with earlier work. Try again shortly.",
  BUDGET_EXCEEDED: "A budget limit was reached.",
  PAUSED: "The orchestrator is paused.",
  RESULT_UNKNOWN:
    "The outcome is unknown: the request may or may not have taken effect. Reload before retrying.",
  INTERNAL: "The server failed to do that.",
};

export interface AutomationErrorPresentation {
  /** The stable `AutomationError.code`, or null for any other failure. */
  readonly code: string | null;
  readonly message: string;
  /** The outcome is not known, which is neither a failure nor a success. */
  readonly outcomeUnknown: boolean;
  /** The edit lost to a newer revision; reloading is the fix. */
  readonly stale: boolean;
}

/**
 * Chooses the message for a failed command from `AutomationError.code`, with
 * the server's own text as detail. Anything that is not an automation error
 * falls back to its message.
 */
export function presentAutomationError(error: unknown): AutomationErrorPresentation {
  const record =
    typeof error === "object" && error !== null ? (error as Record<string, unknown>) : null;
  const code = record !== null && typeof record.code === "string" ? record.code : null;
  const serverMessage =
    record !== null && typeof record.message === "string" && record.message.trim().length > 0
      ? record.message.trim()
      : null;
  if (code === null || record?._tag !== "AutomationError") {
    return {
      code: null,
      message: serverMessage ?? (typeof error === "string" ? error : "The request failed."),
      outcomeUnknown: false,
      stale: false,
    };
  }
  const known = AUTOMATION_ERROR_MESSAGES[code];
  return {
    code,
    message:
      known === undefined
        ? (serverMessage ?? humanizeAutomationStatus(code))
        : serverMessage === null || code === "REVISION_MISMATCH" || code === "RESULT_UNKNOWN"
          ? known
          : `${known} (${serverMessage})`,
    outcomeUnknown: code === "RESULT_UNKNOWN",
    stale: code === "REVISION_MISMATCH" || code === "NOT_FOUND",
  };
}
