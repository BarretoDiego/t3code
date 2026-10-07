import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  formatAutomationAge,
  inboxEntryPreview,
  orchestratorStateActions,
  type OrchestratorView,
  presentAutomationActivity,
  presentDelegatedTasks,
  presentObservation,
  presentOrchestratorBudget,
  presentOrchestratorState,
  presentResponsibility,
  resolveEnvironmentReachability,
  resolveOrchestratorView,
  summarizeOrchestratorInbox,
} from "@t3tools/client-runtime/state/automation-presentation";
import type { EnvironmentId, InboxEntry, ThreadId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import {
  BanIcon,
  OctagonXIcon,
  PauseIcon,
  PlayIcon,
  RotateCcwIcon,
  Settings2Icon,
  XIcon,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

import { cn } from "../../lib/utils";
import { automationEnvironment, useThreadOrchestrator } from "../../state/automation";
import { useThreadShells } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import {
  AutomationStatusBadge,
  AutomationStatusGlyph,
  automationSeverityTextClass,
  ObservationLabel,
} from "../automation/AutomationStatus";
import { reportAutomationFailure } from "../automation/automationCommands";
import { useRelativeTimeTick } from "../settings/settingsLayout";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS } from "./threadDetailsPanelStyles";

const INBOX_PAGE_SIZE = 50;
const ACTIVITY_ROWS = 6;
const TASK_ROWS = 8;
const INBOX_STATUSES = ["reserved", "unknown"] as const;
const ACTIVITY_TYPES = [
  "task.*",
  "request.*",
  "turn.*",
  "orchestrator.*",
  "orchestrator.changed",
  "orchestrator.turn.finished",
] as const;

function Subheading({ children }: { readonly children: string }) {
  return (
    <h4 className="px-2.5 pt-2 pb-0.5 text-2xs font-medium text-muted-foreground select-none">
      {children}
    </h4>
  );
}

function Line({ children }: { readonly children: ReactNode }) {
  return <p className="px-2.5 py-0.5 text-2xs text-muted-foreground">{children}</p>;
}

type OrchestratorAction = "pause" | "resume" | "disable" | "interrupt";

/**
 * The orchestrator section of the thread details panel, shown on an
 * orchestrator's main thread. Identity, state and its controls are always
 * there; the inbox, budget, child tasks, requests and activity load only at
 * full density, when there is room to read them.
 */
export function ThreadOrchestratorPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly density: "full" | "compact" | "essential";
}) {
  const threadRef = useMemo(
    () => scopeThreadRef(props.environmentId, props.threadId),
    [props.environmentId, props.threadId],
  );
  const view = useThreadOrchestrator(threadRef);
  if (view === null || props.density === "essential") return null;
  return <OrchestratorSection view={view} detailed={props.density === "full"} />;
}

function OrchestratorSection({
  view,
  detailed,
}: {
  readonly view: OrchestratorView;
  readonly detailed: boolean;
}) {
  const { orchestrator, environmentId } = view;
  const navigate = useNavigate();
  const nowMs = useRelativeTimeTick(60_000);
  const { environments } = useEnvironments();
  const setState = useAtomCommand(automationEnvironment.setOrchestratorState, {
    label: "orchestrator set state",
    reportFailure: false,
  });
  const [busy, setBusy] = useState<OrchestratorAction | null>(null);
  const [lastOutcome, setLastOutcome] = useState<string | null>(null);

  const state = presentOrchestratorState(orchestrator.effectiveState);
  const actions = orchestratorStateActions(view);
  const host = environments.find((entry) => entry.environmentId === orchestrator.hostEnvironmentId);
  const observation = view.hostedHere
    ? null
    : presentObservation({
        observedAt: orchestrator.observedAt,
        nowMs,
        reachable: resolveEnvironmentReachability({
          clientConnectionPhase: host?.connection.phase ?? null,
        }),
      });

  const run = async (action: OrchestratorAction) => {
    if (busy !== null) return;
    setBusy(action);
    setLastOutcome(null);
    const result = await setState({
      environmentId,
      input: {
        orchestratorId: orchestrator.id,
        desiredState:
          action === "pause"
            ? "paused"
            : action === "resume"
              ? "active"
              : action === "disable"
                ? "disabled"
                : orchestrator.desiredState,
        ...(action === "interrupt" ? { interruptActiveTurn: true } : {}),
      },
    });
    setBusy(null);
    const error = reportAutomationFailure("Could not change the orchestrator", result);
    // An unknown outcome stays on screen: it is neither the failure nor the success the toast implies.
    if (error?.outcomeUnknown) setLastOutcome(error.message);
  };

  return (
    <ThreadDetailsSection
      headingId="thread-details-orchestrator-heading"
      title="Orchestrator"
      data-thread-orchestrator-panel
      actions={
        <Tooltip>
          <TooltipTrigger
            render={
              <ThreadDetailsControl
                size="icon-xs"
                variant="ghost"
                part="icon"
                aria-label="Open orchestrator settings"
                onClick={() =>
                  void navigate({
                    to: "/settings/automation",
                    search: { environmentId, orchestratorId: orchestrator.id },
                    hash: "automation-orchestrators",
                  })
                }
              >
                <Settings2Icon className="size-3.5" />
              </ThreadDetailsControl>
            }
          />
          <TooltipPopup>Orchestrator settings</TooltipPopup>
        </Tooltip>
      }
    >
      <div className={cn("flex flex-col gap-1 py-1", THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS)}>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="min-w-0 truncate text-sm font-medium text-foreground/80">
            {orchestrator.name}
          </span>
          <Badge variant="outline">{orchestrator.scope === "global" ? "Global" : "Local"}</Badge>
          <AutomationStatusBadge status={state} />
        </div>
        {orchestrator.stateReason ? (
          <p className="text-2xs text-muted-foreground">{orchestrator.stateReason}</p>
        ) : null}
        <p className="truncate text-2xs text-muted-foreground">
          {view.hostedHere ? "Hosted on" : "Hosted elsewhere, on"}{" "}
          {host?.label ?? orchestrator.hostEnvironmentId} · {orchestrator.modelSelection.model}
        </p>
        {observation !== null ? <ObservationLabel observation={observation} /> : null}
        {lastOutcome !== null ? (
          <p className="text-2xs text-foreground" role="status">
            Outcome unknown: {lastOutcome}
          </p>
        ) : null}
      </div>

      {view.hostedHere ? (
        <div className="flex flex-wrap items-center gap-1 px-1.5 py-1">
          {actions.canResume ? (
            <ThreadDetailsControl
              size="xs"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => void run("resume")}
            >
              <PlayIcon className="size-3.5" />
              Resume
            </ThreadDetailsControl>
          ) : null}
          {actions.canPause ? (
            <ThreadDetailsControl
              size="xs"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => void run("pause")}
            >
              <PauseIcon className="size-3.5" />
              Pause
            </ThreadDetailsControl>
          ) : null}
          {actions.canDisable ? (
            <ThreadDetailsControl
              size="xs"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => void run("disable")}
            >
              <BanIcon className="size-3.5" />
              Disable
            </ThreadDetailsControl>
          ) : null}
          <ThreadDetailsControl
            size="xs"
            variant="ghost"
            tone="destructive"
            disabled={busy !== null || !actions.canInterruptTurn}
            onClick={() => void run("interrupt")}
          >
            <OctagonXIcon className="size-3.5" />
            Interrupt current turn
          </ThreadDetailsControl>
        </div>
      ) : (
        <Line>Pause, resume and disable it from the environment that hosts it.</Line>
      )}

      {detailed ? <OrchestratorDetails view={view} nowMs={nowMs} /> : null}
    </ThreadDetailsSection>
  );
}

function OrchestratorDetails({
  view,
  nowMs,
}: {
  readonly view: OrchestratorView;
  readonly nowMs: number;
}) {
  const { orchestrator, environmentId } = view;
  const budgetLines = presentOrchestratorBudget(orchestrator.budget, orchestrator.usage);
  const checkpointAge =
    orchestrator.lastCheckpointAt === null
      ? null
      : presentObservation({
          observedAt: orchestrator.lastCheckpointAt,
          nowMs,
          verb: "Last checkpoint",
          staleAfterMs: Number.POSITIVE_INFINITY,
        });
  return (
    <>
      <OrchestratorInbox view={view} />

      <Subheading>Budget and usage</Subheading>
      <dl className="m-0 px-2.5">
        {budgetLines.map((line) => (
          <div key={line.key} className="flex items-baseline justify-between gap-2 py-0.5 text-2xs">
            <dt className="min-w-0 truncate text-muted-foreground">{line.label}</dt>
            <dd
              className={cn(
                "m-0 shrink-0 tabular-nums",
                line.exceeded === true ? "text-warning" : "text-foreground/80",
              )}
            >
              {line.usedLabel === null ? line.limitLabel : `${line.usedLabel} / ${line.limitLabel}`}
              {line.exceeded === true ? " · limit reached" : ""}
            </dd>
            {line.note ? <dd className="sr-only">{line.note}</dd> : null}
          </div>
        ))}
      </dl>
      {budgetLines.some((line) => line.note !== null) ? (
        <Line>{budgetLines.find((line) => line.note !== null)?.note}</Line>
      ) : null}
      <Line>
        {checkpointAge?.label ?? "No checkpoint yet"}
        {orchestrator.lastTurnAt !== null
          ? ` · last turn ${formatAutomationAge(Math.max(0, nowMs - Date.parse(orchestrator.lastTurnAt)))}`
          : ""}
      </Line>

      <OrchestratorTasks view={view} nowMs={nowMs} />
      <OrchestratorRequests view={view} nowMs={nowMs} />
      <OrchestratorActivity
        environmentId={environmentId}
        orchestratorId={orchestrator.id}
        nowMs={nowMs}
      />
    </>
  );
}

function OrchestratorInbox({ view }: { readonly view: OrchestratorView }) {
  const { orchestrator, environmentId } = view;
  const inboxQuery = useEnvironmentQuery(
    automationEnvironment.orchestratorInbox({
      environmentId,
      input: {
        orchestratorId: orchestrator.id,
        statuses: [...INBOX_STATUSES],
        limit: INBOX_PAGE_SIZE,
      },
    }),
  );
  const resolveEntry = useAtomCommand(automationEnvironment.resolveInboxEntry, {
    label: "orchestrator inbox resolve",
    reportFailure: false,
  });
  const [busyEntryId, setBusyEntryId] = useState<string | null>(null);
  const summary = summarizeOrchestratorInbox({
    inboxPending: orchestrator.inboxPending,
    entries: inboxQuery.data?.entries ?? null,
    limit: INBOX_PAGE_SIZE,
  });
  const resolve = async (entry: InboxEntry, resolution: "requeue" | "dismiss") => {
    if (busyEntryId !== null) return;
    setBusyEntryId(entry.id);
    const result = await resolveEntry({
      environmentId,
      input: { orchestratorId: orchestrator.id, entryId: entry.id, resolution },
    });
    setBusyEntryId(null);
    if (reportAutomationFailure("Could not settle the inbox entry", result) === null) {
      inboxQuery.refresh();
    }
  };
  return (
    <>
      <Subheading>Inbox</Subheading>
      <Line>
        {summary.pending} pending · {summary.reserved}
        {summary.partial && inboxQuery.data !== null ? "+" : ""} being read · {summary.unknown}
        {summary.partial && inboxQuery.data !== null ? "+" : ""} with unknown outcome
        {inboxQuery.data === null && inboxQuery.error === null ? " · loading…" : ""}
      </Line>
      {inboxQuery.error !== null ? (
        <p className="px-2.5 py-0.5 text-2xs text-destructive">
          Could not load the inbox: {inboxQuery.error}
        </p>
      ) : null}
      {summary.unknownEntries.length > 0 ? (
        <ul className="m-0 list-none p-0">
          {summary.unknownEntries.map((entry) => (
            <li
              key={entry.id}
              className={cn("flex items-center py-1", THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS)}
            >
              <div className="min-w-0 flex-1">
                <span className="block truncate text-2xs text-foreground/80">
                  {inboxEntryPreview(entry)}
                </span>
                <span className="block text-2xs text-foreground">
                  Outcome unknown · it was not run again
                </span>
              </div>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <ThreadDetailsControl
                      size="icon-xs"
                      variant="ghost"
                      part="icon"
                      aria-label="Requeue this entry"
                      disabled={busyEntryId !== null}
                      onClick={() => void resolve(entry, "requeue")}
                    >
                      <RotateCcwIcon className="size-3.5" />
                    </ThreadDetailsControl>
                  }
                />
                <TooltipPopup>Requeue: let the orchestrator read it again</TooltipPopup>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <ThreadDetailsControl
                      size="icon-xs"
                      variant="ghost"
                      part="icon"
                      aria-label="Dismiss this entry"
                      disabled={busyEntryId !== null}
                      onClick={() => void resolve(entry, "dismiss")}
                    >
                      <XIcon className="size-3.5" />
                    </ThreadDetailsControl>
                  }
                />
                <TooltipPopup>Dismiss: drop it without another turn</TooltipPopup>
              </Tooltip>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

function OrchestratorTasks({
  view,
  nowMs,
}: {
  readonly view: OrchestratorView;
  readonly nowMs: number;
}) {
  const { orchestrator, environmentId } = view;
  const navigate = useNavigate();
  const { environments } = useEnvironments();
  const threadShells = useThreadShells();
  const tasksQuery = useEnvironmentQuery(
    automationEnvironment.tasks({
      environmentId,
      input: { orchestratorId: orchestrator.id, includeTerminal: true },
    }),
  );
  const peersQuery = useEnvironmentQuery(automationEnvironment.peers({ environmentId, input: {} }));
  const rows = useMemo(
    () => presentDelegatedTasks({ tasks: tasksQuery.data?.tasks ?? [], environmentId }),
    [environmentId, tasksQuery.data],
  );
  const loadedThreadKeys = useMemo(
    () => new Set(threadShells.map((thread) => `${thread.environmentId}:${thread.id}`)),
    [threadShells],
  );
  if (tasksQuery.error === null && rows.length === 0) return null;
  const shown = rows.slice(0, TASK_ROWS);
  return (
    <>
      <Subheading>Child tasks</Subheading>
      {tasksQuery.error !== null ? (
        <p className="px-2.5 py-0.5 text-2xs text-destructive">
          Could not load child tasks: {tasksQuery.error}
        </p>
      ) : null}
      <ul className="m-0 list-none p-0">
        {shown.map((row) => {
          const executionEnvironmentId = row.task.executionEnvironmentId;
          const reachable = row.remote
            ? resolveEnvironmentReachability({
                peerStatus: peersQuery.data?.peers.find(
                  (peer) => peer.environmentId === executionEnvironmentId,
                )?.status,
                clientConnectionPhase:
                  environments.find((entry) => entry.environmentId === executionEnvironmentId)
                    ?.connection.phase ?? null,
              })
            : null;
          const canOpen =
            row.threadRef !== null &&
            loadedThreadKeys.has(`${row.threadRef.environmentId}:${row.threadRef.threadId}`);
          return (
            <li key={row.task.id} className="flex items-center rounded-lg">
              <ThreadDetailsControl
                size="sm"
                variant="ghost"
                part="row"
                multiline
                disabled={!canOpen}
                aria-label={`${row.task.contract.title}: ${row.status.label}${
                  canOpen ? ". Open its thread" : ""
                }`}
                onClick={() => {
                  if (row.threadRef === null) return;
                  void navigate({
                    to: "/$environmentId/$threadId",
                    params: buildThreadRouteParams(
                      scopeThreadRef(row.threadRef.environmentId, row.threadRef.threadId),
                    ),
                  });
                }}
              >
                <AutomationStatusGlyph status={row.status} className="size-4" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground/80">
                    {row.task.contract.title}
                  </span>
                  <span
                    className={cn(
                      "block truncate text-2xs",
                      automationSeverityTextClass(row.status.severity),
                    )}
                  >
                    {row.status.label}
                    {row.awaitingValidation ? " · not validated yet" : ""}
                    {row.criteriaLabel ? ` · ${row.criteriaLabel}` : ""}
                    {row.task.statusReason ? ` · ${row.task.statusReason}` : ""}
                  </span>
                  {row.remote ? (
                    <ObservationLabel
                      observation={presentObservation({
                        observedAt: row.task.observedAt,
                        nowMs,
                        reachable,
                      })}
                    />
                  ) : null}
                </span>
              </ThreadDetailsControl>
            </li>
          );
        })}
      </ul>
      {rows.length > shown.length ? <Line>{rows.length - shown.length} more not shown</Line> : null}
    </>
  );
}

function OrchestratorRequests({
  view,
  nowMs,
}: {
  readonly view: OrchestratorView;
  readonly nowMs: number;
}) {
  const { orchestrator, environmentId } = view;
  const navigate = useNavigate();
  const views = useAtomValue(automationEnvironment.orchestratorViewsAtom);
  const threadShells = useThreadShells();
  const requestsQuery = useEnvironmentQuery(
    automationEnvironment.pendingRequests({
      environmentId,
      input: { orchestratorId: orchestrator.id },
    }),
  );
  const requests = requestsQuery.data?.requests ?? [];
  if (requestsQuery.error === null && requests.length === 0) return null;
  const lookup = {
    orchestratorName: (orchestratorId: string, hostEnvironmentId: string) =>
      resolveOrchestratorView(views, orchestratorId, hostEnvironmentId)?.orchestrator.name ?? null,
    threadTitle: (threadId: string) =>
      threadShells.find(
        (thread) => thread.environmentId === environmentId && thread.id === threadId,
      )?.title ?? null,
  };
  return (
    <>
      <Subheading>Pending requests it tracks</Subheading>
      {requestsQuery.error !== null ? (
        <p className="px-2.5 py-0.5 text-2xs text-destructive">
          Could not load pending requests: {requestsQuery.error}
        </p>
      ) : null}
      <ul className="m-0 list-none p-0">
        {requests.map((request) => {
          const responsibility = presentResponsibility(request, lookup, nowMs);
          return (
            <li key={`${request.threadId}:${request.requestId}`} className="flex items-center">
              <ThreadDetailsControl
                size="sm"
                variant="ghost"
                part="row"
                multiline
                aria-label={`${request.threadTitle}: ${responsibility.summary}. Open the thread`}
                onClick={() =>
                  void navigate({
                    to: "/$environmentId/$threadId",
                    params: buildThreadRouteParams(
                      scopeThreadRef(request.environmentId, request.threadId),
                    ),
                  })
                }
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground/80">
                    {request.threadTitle || "Untitled thread"}
                  </span>
                  <span className="block truncate text-2xs text-muted-foreground">
                    {request.kind === "approval"
                      ? "Approval"
                      : request.kind === "user_input"
                        ? "Question"
                        : "Request"}{" "}
                    · {responsibility.summary}
                    {responsibility.ruleLabel && responsibility.delegated
                      ? ` · because ${responsibility.ruleLabel}`
                      : ""}
                    {responsibility.leaseExpired ? " · lease expired" : ""}
                  </span>
                </span>
              </ThreadDetailsControl>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function OrchestratorActivity(props: {
  readonly environmentId: EnvironmentId;
  readonly orchestratorId: OrchestratorView["orchestrator"]["id"];
  readonly nowMs: number;
}) {
  const activityQuery = useEnvironmentQuery(
    automationEnvironment.activity({
      environmentId: props.environmentId,
      input: {
        filter: { types: [...ACTIVITY_TYPES], orchestratorIds: [props.orchestratorId] },
        limit: 400,
      },
    }),
  );
  const rows = presentAutomationActivity(activityQuery.data?.entries ?? [], ACTIVITY_ROWS);
  if (activityQuery.error === null && rows.length === 0) return null;
  return (
    <>
      <Subheading>Recent activity</Subheading>
      {activityQuery.error !== null ? (
        <p className="px-2.5 py-0.5 text-2xs text-destructive">
          Could not load activity: {activityQuery.error}
        </p>
      ) : null}
      <ul className="m-0 list-none px-2.5 py-0">
        {rows.map((row) => (
          <li key={row.key} className="flex items-baseline justify-between gap-2 py-0.5 text-2xs">
            <span className={cn("min-w-0 truncate", automationSeverityTextClass(row.severity))}>
              {row.label}
            </span>
            <span className="shrink-0 text-muted-foreground tabular-nums">
              {formatAutomationAge(Math.max(0, props.nowMs - Date.parse(row.occurredAt)))}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}
