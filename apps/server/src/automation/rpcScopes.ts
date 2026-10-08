import {
  AUTOMATION_WS_METHODS,
  AuthFederationPeerScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type AuthEnvironmentScope,
  type AutomationRpcGroup,
} from "@t3tools/contracts";
import type * as RpcGroup from "effect/rpc/RpcGroup";

type AutomationRpcMethod = RpcGroup.Rpcs<typeof AutomationRpcGroup>["_tag"];
const M = AUTOMATION_WS_METHODS;
const read = AuthOrchestrationReadScope;
const operate = AuthOrchestrationOperateScope;

/**
 * Reads and management ride on the existing orchestration scopes so paired
 * clients keep working. The peer-facing methods need the federation scope,
 * which only a peer's service credential carries. Shell jobs additionally need
 * `automation:execute`, which the job service checks against the action.
 */
export const AUTOMATION_RPC_REQUIRED_SCOPES = {
  [M.eventsStatus]: read,
  [M.eventsRead]: read,
  [M.eventsSubscribe]: read,
  [M.eventsEmit]: operate,
  [M.consumersList]: read,
  [M.consumersAck]: operate,
  [M.consumersDelete]: operate,
  [M.hooksList]: read,
  [M.hooksUpsert]: operate,
  [M.hooksSetEnabled]: operate,
  [M.hooksDelete]: operate,
  [M.hooksTest]: operate,
  [M.hooksDeliveries]: read,
  [M.hooksRedeliver]: operate,
  [M.hooksDismissDelivery]: operate,
  [M.requestsList]: read,
  [M.requestsRespond]: operate,
  [M.claimsTransfer]: operate,
  [M.orchestratorsList]: read,
  [M.orchestratorsSubscribe]: read,
  [M.orchestratorsUpsert]: operate,
  [M.orchestratorsSetState]: operate,
  [M.orchestratorsDelete]: operate,
  [M.orchestratorsSend]: operate,
  [M.orchestratorsInbox]: read,
  [M.orchestratorsResolveInbox]: operate,
  [M.orchestratorsCheckpoints]: read,
  [M.orchestratorsHandoff]: operate,
  [M.orchestratorsHandoffStatus]: read,
  [M.tasksDelegate]: operate,
  [M.tasksGet]: read,
  [M.tasksList]: read,
  [M.tasksUpdate]: operate,
  [M.threadTree]: read,
  [M.nodesList]: read,
  [M.nodesUpsert]: operate,
  [M.nodesRemove]: operate,
  [M.nodesProbe]: operate,
  [M.jobsSubmit]: operate,
  [M.jobsGet]: read,
  [M.jobsList]: read,
  [M.jobsCancel]: operate,
  [M.jobsReconcile]: operate,
  [M.jobsLogs]: read,
  [M.jobsWatch]: read,
  [M.peersList]: read,
  [M.peersAdd]: operate,
  [M.peersUpdate]: operate,
  [M.peersRemove]: operate,
  [M.peersOutbox]: read,
  [M.peerHello]: AuthFederationPeerScope,
  [M.peerDeliver]: AuthFederationPeerScope,
  [M.diagnostics]: read,
} as const satisfies Readonly<Record<AutomationRpcMethod, AuthEnvironmentScope>>;
