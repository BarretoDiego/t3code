import {
  AUTOMATION_WS_METHODS,
  type AutomationEventsStreamItem,
  type EnvironmentId,
  type Orchestrator,
  type PendingRequestSummary,
  type ServerConfig,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import * as EnvironmentRegistry from "../connection/registry.ts";
import { request } from "../rpc/client.ts";
import {
  applyAutomationChange,
  AUTOMATION_CHANGE_EVENT_TYPES,
  type AutomationChangeKind,
  buildOrchestratorThreadIndex,
  buildOrchestratorViews,
  buildThreadResponsibilityIndex,
  EMPTY_AUTOMATION_CHANGE_COUNTERS,
  EMPTY_ORCHESTRATOR_THREAD_INDEX,
  environmentSupportsAutomation,
  type OrchestratorEnvironmentSnapshot,
  type OrchestratorThreadIndex,
  type OrchestratorThreadMarker,
  type OrchestratorView,
  resolveOrchestratorView,
  type ThreadResponsibilityMarker,
} from "./automationPresentation.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/** What a thread row shows about automation: either member may be null, never both. */
export interface ThreadAutomationMarkers {
  readonly orchestrator: OrchestratorThreadMarker | null;
  readonly responsibility: ThreadResponsibilityMarker | null;
}

/** How far back the activity read looks when the caller names no cursor. */
const ACTIVITY_LOOKBACK_ENTRIES = 400;

const NO_INPUT = {};

/**
 * The atoms rows and panels read, derived from one orchestrator list and one
 * pending-request list per environment. An environment whose server does not
 * advertise automation is never asked for either, so nothing subscribes to it.
 */
export function createAutomationDerivedAtoms<OrchestratorsError, RequestsError>(input: {
  /** Server configs of the enabled environments; the capability gate reads them. */
  readonly serverConfigsAtom: Atom.Atom<ReadonlyMap<EnvironmentId, ServerConfig>>;
  readonly orchestratorsAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<
    AsyncResult.AsyncResult<
      { readonly orchestrators: ReadonlyArray<Orchestrator> },
      OrchestratorsError
    >
  >;
  readonly pendingRequestsAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<
    AsyncResult.AsyncResult<
      { readonly requests: ReadonlyArray<PendingRequestSummary> },
      RequestsError
    >
  >;
}) {
  const automationEnvironmentIdsAtom = Atom.make((get) => {
    const ids: Array<EnvironmentId> = [];
    for (const [environmentId, config] of get(input.serverConfigsAtom)) {
      if (environmentSupportsAutomation(config)) ids.push(environmentId);
    }
    return ids;
  }).pipe(Atom.withLabel("environment-data:automation:environment-ids"));

  const orchestratorSnapshotsAtom = Atom.make(
    (get): ReadonlyArray<OrchestratorEnvironmentSnapshot> =>
      get(automationEnvironmentIdsAtom).flatMap((environmentId) => {
        const value = Option.getOrNull(
          AsyncResult.value(get(input.orchestratorsAtom(environmentId))),
        );
        return value === null ? [] : [{ environmentId, orchestrators: value.orchestrators }];
      }),
  ).pipe(Atom.withLabel("environment-data:automation:orchestrator-snapshots"));

  const orchestratorViewsAtom = Atom.make((get): ReadonlyArray<OrchestratorView> =>
    buildOrchestratorViews(get(orchestratorSnapshotsAtom)),
  ).pipe(Atom.withLabel("environment-data:automation:orchestrator-views"));

  let previousIndex = EMPTY_ORCHESTRATOR_THREAD_INDEX;
  const orchestratorThreadIndexAtom = Atom.make((get): OrchestratorThreadIndex => {
    previousIndex = buildOrchestratorThreadIndex(get(orchestratorSnapshotsAtom), previousIndex);
    return previousIndex;
  }).pipe(Atom.withLabel("environment-data:automation:orchestrator-thread-index"));

  /** The row marker for one thread. Changes only when what the row draws changes. */
  const orchestratorMarkerAtom = Atom.family((threadKey: string) =>
    Atom.make(
      (get): OrchestratorThreadMarker | null =>
        get(orchestratorThreadIndexAtom).markerByThreadKey.get(threadKey) ?? null,
    ).pipe(Atom.withLabel(`environment-data:automation:orchestrator-marker:${threadKey}`)),
  );

  /** The full orchestrator behind one thread, for the panel. */
  const orchestratorViewAtom = Atom.family((threadKey: string) =>
    Atom.make(
      (get): OrchestratorView | null =>
        get(orchestratorThreadIndexAtom).viewByThreadKey.get(threadKey) ?? null,
    ).pipe(Atom.withLabel(`environment-data:automation:orchestrator-view:${threadKey}`)),
  );

  const allPendingRequestsAtom = Atom.make((get): ReadonlyArray<PendingRequestSummary> =>
    get(automationEnvironmentIdsAtom).flatMap(
      (environmentId) =>
        Option.getOrNull(AsyncResult.value(get(input.pendingRequestsAtom(environmentId))))
          ?.requests ?? [],
    ),
  ).pipe(Atom.withLabel("environment-data:automation:all-pending-requests"));

  let previousResponsibility: ReadonlyMap<string, ThreadResponsibilityMarker> = new Map();
  const threadResponsibilityIndexAtom = Atom.make((get) => {
    const views = get(orchestratorViewsAtom);
    previousResponsibility = buildThreadResponsibilityIndex(
      get(allPendingRequestsAtom),
      {
        orchestratorName: (orchestratorId, environmentId) =>
          resolveOrchestratorView(views, orchestratorId, environmentId)?.orchestrator.name ?? null,
        // A row only needs "a parent thread"; the panel resolves the title.
        threadTitle: () => null,
      },
      previousResponsibility,
    );
    return previousResponsibility;
  }).pipe(Atom.withLabel("environment-data:automation:thread-responsibility-index"));

  /**
   * Everything a thread row marks, in one atom so a row holds one subscription.
   * Null for an ordinary thread, and the same object until a marker changes.
   */
  const threadMarkersAtom = Atom.family((threadKey: string) => {
    let previous: ThreadAutomationMarkers | null = null;
    return Atom.make((get): ThreadAutomationMarkers | null => {
      const orchestrator =
        get(orchestratorThreadIndexAtom).markerByThreadKey.get(threadKey) ?? null;
      const responsibility = get(threadResponsibilityIndexAtom).get(threadKey) ?? null;
      if (orchestrator === null && responsibility === null) {
        previous = null;
      } else if (
        previous?.orchestrator !== orchestrator ||
        previous.responsibility !== responsibility
      ) {
        previous = { orchestrator, responsibility };
      }
      return previous;
    }).pipe(Atom.withLabel(`environment-data:automation:thread-markers:${threadKey}`));
  });

  return {
    automationEnvironmentIdsAtom,
    orchestratorViewsAtom,
    orchestratorMarkerAtom,
    orchestratorViewAtom,
    threadMarkersAtom,
  };
}

/**
 * Automation state for every connected environment.
 *
 * Live data comes from two subscriptions per environment and no more:
 * `orchestrators.subscribe` for the orchestrator list, and one filtered
 * `events.subscribe` whose only job is to tell the query atoms below when to
 * read again. Rows and panels read derived atoms; none of them subscribes.
 */
export function createAutomationEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
  options: {
    /** Server configs of the enabled environments; the capability gate reads them. */
    readonly serverConfigsAtom: Atom.Atom<ReadonlyMap<EnvironmentId, ServerConfig>>;
  },
) {
  const orchestratorsLive = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:automation:orchestrators:live",
    tag: AUTOMATION_WS_METHODS.orchestratorsSubscribe,
  });

  const changeCounters = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:automation:changes",
    tag: AUTOMATION_WS_METHODS.eventsSubscribe,
    transform: (stream) =>
      stream.pipe(
        Stream.scan(
          EMPTY_AUTOMATION_CHANGE_COUNTERS,
          (counters, item: AutomationEventsStreamItem) =>
            item.type === "entry"
              ? applyAutomationChange(counters, item.entry.event.type)
              : counters,
        ),
        Stream.changes,
      ),
  });
  const changeInput = { filter: { types: [...AUTOMATION_CHANGE_EVENT_TYPES] } };
  const changeTick = Atom.family((key: string) => {
    const separator = key.indexOf(":");
    const kind = key.slice(0, separator) as AutomationChangeKind;
    const environmentId = key.slice(separator + 1) as EnvironmentId;
    return Atom.make(
      (get) =>
        Option.getOrNull(
          AsyncResult.value(get(changeCounters({ environmentId, input: changeInput }))),
        )?.[kind] ?? 0,
    ).pipe(Atom.withLabel(`environment-data:automation:change-tick:${key}`));
  });
  const refreshOn =
    (kind: AutomationChangeKind) =>
    ({ environmentId }: { readonly environmentId: EnvironmentId }) =>
      changeTick(`${kind}:${environmentId}`);

  const pendingRequests = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:automation:pending-requests",
    tag: AUTOMATION_WS_METHODS.requestsList,
    refreshTrigger: refreshOn("requests"),
  });

  const derived = createAutomationDerivedAtoms({
    serverConfigsAtom: options.serverConfigsAtom,
    orchestratorsAtom: (environmentId) => orchestratorsLive({ environmentId, input: NO_INPUT }),
    pendingRequestsAtom: (environmentId) => pendingRequests({ environmentId, input: NO_INPUT }),
  });

  return {
    /** Environments whose server advertises the `automation` capability. */
    ...derived,
    /** Live orchestrator list: snapshot on subscribe, fresh list after every change. */
    orchestratorsLive,
    pendingRequests,

    orchestratorInbox: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:automation:orchestrator-inbox",
      tag: AUTOMATION_WS_METHODS.orchestratorsInbox,
      refreshTrigger: refreshOn("inbox"),
    }),
    tasks: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:automation:tasks",
      tag: AUTOMATION_WS_METHODS.tasksList,
      refreshTrigger: refreshOn("tasks"),
    }),
    /**
     * Journal entries matching a filter. The journal reads oldest-first, so
     * without a cursor this starts a fixed distance behind the head to return
     * recent entries rather than the oldest retained ones.
     */
    activity: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:automation:activity",
      tag: AUTOMATION_WS_METHODS.eventsRead,
      refreshTrigger: refreshOn("activity"),
      execute: (input) =>
        input.afterCursor !== undefined
          ? request(AUTOMATION_WS_METHODS.eventsRead, input)
          : request(AUTOMATION_WS_METHODS.eventsStatus, NO_INPUT).pipe(
              Effect.flatMap((status) =>
                request(AUTOMATION_WS_METHODS.eventsRead, {
                  ...input,
                  afterCursor: Math.max(0, status.headCursor - ACTIVITY_LOOKBACK_ENTRIES),
                }),
              ),
            ),
    }),
    hooks: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:automation:hooks",
      tag: AUTOMATION_WS_METHODS.hooksList,
      refreshTrigger: refreshOn("hooks"),
    }),
    hookDeliveries: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:automation:hook-deliveries",
      tag: AUTOMATION_WS_METHODS.hooksDeliveries,
      refreshTrigger: refreshOn("deliveries"),
    }),
    peers: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:automation:peers",
      tag: AUTOMATION_WS_METHODS.peersList,
      refreshTrigger: refreshOn("peers"),
    }),
    nodes: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:automation:nodes",
      tag: AUTOMATION_WS_METHODS.nodesList,
      refreshTrigger: refreshOn("nodes"),
    }),
    jobs: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:automation:jobs",
      tag: AUTOMATION_WS_METHODS.jobsList,
      refreshTrigger: refreshOn("jobs"),
    }),

    upsertOrchestrator: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:automation:orchestrator:upsert",
      tag: AUTOMATION_WS_METHODS.orchestratorsUpsert,
    }),
    setOrchestratorState: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:automation:orchestrator:set-state",
      tag: AUTOMATION_WS_METHODS.orchestratorsSetState,
    }),
    deleteOrchestrator: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:automation:orchestrator:delete",
      tag: AUTOMATION_WS_METHODS.orchestratorsDelete,
    }),
    resolveInboxEntry: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:automation:orchestrator:resolve-inbox",
      tag: AUTOMATION_WS_METHODS.orchestratorsResolveInbox,
    }),
    upsertHook: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:automation:hook:upsert",
      tag: AUTOMATION_WS_METHODS.hooksUpsert,
    }),
    setHookEnabled: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:automation:hook:set-enabled",
      tag: AUTOMATION_WS_METHODS.hooksSetEnabled,
    }),
    deleteHook: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:automation:hook:delete",
      tag: AUTOMATION_WS_METHODS.hooksDelete,
    }),
    testHook: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:automation:hook:test",
      tag: AUTOMATION_WS_METHODS.hooksTest,
    }),
    redeliverHookDelivery: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:automation:hook:redeliver",
      tag: AUTOMATION_WS_METHODS.hooksRedeliver,
    }),
    dismissHookDelivery: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:automation:hook:dismiss-delivery",
      tag: AUTOMATION_WS_METHODS.hooksDismissDelivery,
    }),
    addPeer: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:automation:peer:add",
      tag: AUTOMATION_WS_METHODS.peersAdd,
    }),
    updatePeer: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:automation:peer:update",
      tag: AUTOMATION_WS_METHODS.peersUpdate,
    }),
    removePeer: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:automation:peer:remove",
      tag: AUTOMATION_WS_METHODS.peersRemove,
    }),
    upsertNode: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:automation:node:upsert",
      tag: AUTOMATION_WS_METHODS.nodesUpsert,
    }),
    removeNode: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:automation:node:remove",
      tag: AUTOMATION_WS_METHODS.nodesRemove,
    }),
    probeNode: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:automation:node:probe",
      tag: AUTOMATION_WS_METHODS.nodesProbe,
    }),
    readJobLogs: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:automation:job:logs",
      tag: AUTOMATION_WS_METHODS.jobsLogs,
    }),
  };
}
