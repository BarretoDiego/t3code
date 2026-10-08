import {
  AUTOMATION_WS_METHODS,
  AuthFederationPeerScope,
  AutomationRpcGroup,
  type AuthEnvironmentScope,
  type EnvironmentAuthorizationError,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";

import * as AutomationDiagnosticsService from "./AutomationDiagnosticsService.ts";
import { type AutomationCaller, PEER_SESSION_SUBJECT_PREFIX } from "./Caller.ts";
import * as DelegatedTaskService from "./DelegatedTaskService.ts";
import * as EventJournal from "./EventJournal.ts";
import * as HookService from "./HookService.ts";
import * as JobService from "./JobService.ts";
import { orchestratorCallerFromSession } from "./orchestrator/CredentialRegistry.ts";
import { makeAutomationMethodGate } from "./orchestrator/RpcGate.ts";
import { makeStore } from "./orchestrator/Store.ts";
import * as OrchestratorService from "./OrchestratorService.ts";
import * as PeerService from "./PeerService.ts";
import * as ResponsibilityService from "./ResponsibilityService.ts";

const M = AUTOMATION_WS_METHODS;
type AutomationRpcMethod = RpcGroup.Rpcs<typeof AutomationRpcGroup>["_tag"];
const traceAttributes = { "rpc.aggregate": "automation" } as const;

/**
 * A session is a peer only when it holds the federation scope and its subject
 * names the peer environment; it is an orchestrator's agent only when the
 * orchestrator runtime issued that very session. Both are decided by the server
 * when it issues the credential, so a client cannot claim to be either. A
 * session that carries an orchestrator's subject without having been issued by
 * the runtime holds no scopes at all.
 */
export const callerFromSession = (session: {
  readonly sessionId: string;
  readonly subject: string;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
}): AutomationCaller =>
  orchestratorCallerFromSession(session) ??
  (session.scopes.includes(AuthFederationPeerScope) &&
  session.subject.startsWith(PEER_SESSION_SUBJECT_PREFIX)
    ? {
        kind: "peer",
        environmentId: EnvironmentId.make(
          session.subject.slice(PEER_SESSION_SUBJECT_PREFIX.length),
        ),
        subject: session.subject,
        scopes: session.scopes,
      }
    : { kind: "client", subject: session.subject, scopes: session.scopes });

/** Thin WebSocket handlers for the automation RPC group: one service call each. */
export const makeAutomationRpcHandlers = Effect.fn("makeAutomationRpcHandlers")(function* (input: {
  readonly caller: AutomationCaller;
  readonly observeEffect: <A, E, R>(
    method: string,
    effect: Effect.Effect<A, E, R>,
    traceAttributes?: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<A, E | EnvironmentAuthorizationError, R>;
  readonly observeStream: <A, E, R>(
    method: string,
    stream: Stream.Stream<A, E, R>,
    traceAttributes?: Readonly<Record<string, unknown>>,
  ) => Stream.Stream<A, E | EnvironmentAuthorizationError, R>;
}) {
  const journal = yield* EventJournal.EventJournal;
  const hooks = yield* HookService.HookService;
  const responsibility = yield* ResponsibilityService.ResponsibilityService;
  const orchestrators = yield* OrchestratorService.OrchestratorService;
  const tasks = yield* DelegatedTaskService.DelegatedTaskService;
  const jobs = yield* JobService.JobService;
  const peers = yield* PeerService.PeerService;
  const diagnostics = yield* AutomationDiagnosticsService.AutomationDiagnosticsService;
  const { caller } = input;
  const sql = yield* SqlClient.SqlClient;
  const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  // What an orchestrator's agent may call at all; the services check the rest.
  const admit = makeAutomationMethodGate(makeStore(sql), yield* identity.getEnvironmentId);
  const run = <A, E, R>(
    method: AutomationRpcMethod,
    effect: Effect.Effect<A, E, R>,
    payload?: unknown,
  ) =>
    input.observeEffect(
      method,
      Effect.andThen(admit(caller, method, payload), effect),
      traceAttributes,
    );
  const stream = <A, E, R>(method: AutomationRpcMethod, value: Stream.Stream<A, E, R>) =>
    input.observeStream(
      method,
      Stream.unwrap(Effect.as(admit(caller, method, undefined), value)),
      traceAttributes,
    );
  const removed = (value: boolean) => ({ removed: value });

  return AutomationRpcGroup.of({
    [M.eventsStatus]: () => run(M.eventsStatus, journal.status),
    [M.eventsRead]: (payload) => run(M.eventsRead, journal.read(caller, payload)),
    [M.eventsSubscribe]: (payload) => stream(M.eventsSubscribe, journal.subscribe(caller, payload)),
    [M.eventsEmit]: (payload) => run(M.eventsEmit, journal.emit(caller, payload)),
    [M.consumersList]: () =>
      run(
        M.consumersList,
        Effect.map(journal.listConsumers(caller), (consumers) => ({ consumers })),
      ),
    [M.consumersAck]: (payload) => run(M.consumersAck, journal.ackConsumer(caller, payload)),
    [M.consumersDelete]: (payload) =>
      run(
        M.consumersDelete,
        Effect.map(journal.deleteConsumer(caller, payload.consumerId), removed),
      ),

    [M.hooksList]: () =>
      run(
        M.hooksList,
        Effect.map(hooks.list(caller), (list) => ({ hooks: list })),
      ),
    [M.hooksUpsert]: (payload) => run(M.hooksUpsert, hooks.upsert(caller, payload)),
    [M.hooksSetEnabled]: (payload) => run(M.hooksSetEnabled, hooks.setEnabled(caller, payload)),
    [M.hooksDelete]: (payload) =>
      run(M.hooksDelete, Effect.map(hooks.delete(caller, payload.hookId), removed)),
    [M.hooksTest]: (payload) => run(M.hooksTest, hooks.test(caller, payload)),
    [M.hooksDeliveries]: (payload) =>
      run(
        M.hooksDeliveries,
        Effect.map(hooks.deliveries(caller, payload), (deliveries) => ({ deliveries })),
      ),
    [M.hooksRedeliver]: (payload) =>
      run(M.hooksRedeliver, hooks.redeliver(caller, payload.deliveryId)),
    [M.hooksDismissDelivery]: (payload) =>
      run(M.hooksDismissDelivery, hooks.dismissDelivery(caller, payload.deliveryId)),

    [M.requestsList]: (payload) =>
      run(
        M.requestsList,
        Effect.map(responsibility.listRequests(caller, payload), (requests) => ({ requests })),
      ),
    [M.requestsRespond]: (payload) =>
      run(M.requestsRespond, responsibility.respond(caller, payload)),
    [M.claimsTransfer]: (payload) =>
      run(M.claimsTransfer, responsibility.transferClaim(caller, payload)),

    [M.orchestratorsList]: () =>
      run(
        M.orchestratorsList,
        Effect.map(orchestrators.list(caller), (list) => ({ orchestrators: list })),
      ),
    [M.orchestratorsSubscribe]: () =>
      stream(
        M.orchestratorsSubscribe,
        Stream.map(orchestrators.subscribe(caller), (list) => ({ orchestrators: list })),
      ),
    [M.orchestratorsUpsert]: (payload) =>
      run(M.orchestratorsUpsert, orchestrators.upsert(caller, payload)),
    [M.orchestratorsSetState]: (payload) =>
      run(M.orchestratorsSetState, orchestrators.setState(caller, payload)),
    [M.orchestratorsDelete]: (payload) =>
      run(
        M.orchestratorsDelete,
        Effect.map(orchestrators.delete(caller, payload.orchestratorId), removed),
      ),
    [M.orchestratorsSend]: (payload) =>
      run(M.orchestratorsSend, orchestrators.send(caller, payload), payload),
    [M.orchestratorsInbox]: (payload) =>
      run(
        M.orchestratorsInbox,
        Effect.map(orchestrators.inbox(caller, payload), (entries) => ({ entries })),
      ),
    [M.orchestratorsResolveInbox]: (payload) =>
      run(M.orchestratorsResolveInbox, orchestrators.resolveInbox(caller, payload)),
    [M.orchestratorsCheckpoints]: (payload) =>
      run(
        M.orchestratorsCheckpoints,
        Effect.map(orchestrators.checkpoints(caller, payload), (checkpoints) => ({
          checkpoints,
        })),
      ),
    [M.orchestratorsHandoff]: (payload) =>
      run(M.orchestratorsHandoff, orchestrators.handoff(caller, payload)),
    [M.orchestratorsHandoffStatus]: (payload) =>
      run(
        M.orchestratorsHandoffStatus,
        Effect.map(orchestrators.handoffStatus(caller, payload.orchestratorId), (handoff) => ({
          handoff,
        })),
      ),

    [M.tasksDelegate]: (payload) => run(M.tasksDelegate, tasks.delegate(caller, payload)),
    [M.tasksGet]: (payload) => run(M.tasksGet, tasks.get(caller, payload.taskId)),
    [M.tasksList]: (payload) =>
      run(
        M.tasksList,
        Effect.map(tasks.list(caller, payload), (list) => ({ tasks: list })),
      ),
    [M.tasksUpdate]: (payload) => run(M.tasksUpdate, tasks.update(caller, payload)),
    [M.threadTree]: (payload) =>
      run(
        M.threadTree,
        Effect.map(tasks.threadTree(caller, payload.threadId), (nodes) => ({ nodes })),
      ),

    [M.nodesList]: () =>
      run(
        M.nodesList,
        Effect.map(jobs.listNodes(caller), (nodes) => ({ nodes })),
      ),
    [M.nodesUpsert]: (payload) => run(M.nodesUpsert, jobs.upsertNode(caller, payload)),
    [M.nodesRemove]: (payload) =>
      run(M.nodesRemove, Effect.map(jobs.removeNode(caller, payload.nodeId), removed)),
    [M.nodesProbe]: (payload) => run(M.nodesProbe, jobs.probeNode(caller, payload.nodeId)),
    [M.jobsSubmit]: (payload) => run(M.jobsSubmit, jobs.submit(caller, payload)),
    [M.jobsGet]: (payload) => run(M.jobsGet, jobs.get(caller, payload.jobId)),
    [M.jobsList]: (payload) =>
      run(
        M.jobsList,
        Effect.map(jobs.list(caller, payload), (list) => ({ jobs: list })),
      ),
    [M.jobsCancel]: (payload) => run(M.jobsCancel, jobs.cancel(caller, payload.jobId)),
    [M.jobsReconcile]: (payload) => run(M.jobsReconcile, jobs.reconcile(caller, payload.jobId)),
    [M.jobsLogs]: (payload) => run(M.jobsLogs, jobs.logs(caller, payload)),
    [M.jobsWatch]: (payload) => stream(M.jobsWatch, jobs.watch(caller, payload.jobId)),

    [M.peersList]: () =>
      run(
        M.peersList,
        Effect.map(peers.list(caller), (list) => ({ peers: list })),
      ),
    [M.peersAdd]: (payload) => run(M.peersAdd, peers.add(caller, payload)),
    [M.peersUpdate]: (payload) => run(M.peersUpdate, peers.update(caller, payload)),
    [M.peersRemove]: (payload) =>
      run(M.peersRemove, Effect.map(peers.remove(caller, payload.environmentId), removed)),
    [M.peersOutbox]: (payload) =>
      run(
        M.peersOutbox,
        Effect.map(peers.outbox(caller, payload), (entries) => ({ entries })),
      ),
    [M.peerHello]: (payload) => run(M.peerHello, peers.hello(caller, payload)),
    [M.peerDeliver]: (payload) => run(M.peerDeliver, peers.deliver(caller, payload)),

    [M.diagnostics]: () => run(M.diagnostics, diagnostics.read),
  });
});
