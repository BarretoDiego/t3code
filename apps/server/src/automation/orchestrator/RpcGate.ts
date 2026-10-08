import {
  AUTOMATION_WS_METHODS,
  AuthOrchestrationOperateScope,
  type AutomationError,
  type AutomationRpcGroup,
  EnvironmentAuthorizationError,
  type EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2Command,
  type OrchestratorAction,
  type OrchestratorId,
  type ProjectId,
  type ThreadId,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcSchema from "effect/rpc/RpcSchema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import { type AutomationCaller, automationError, type OrchestratorCaller } from "../Caller.ts";
import * as ResponsibilityService from "../ResponsibilityService.ts";
import { makeOrchestratorAccess } from "./Access.ts";
import { makeStore, type OrchestratorStore } from "./Store.ts";

type AutomationRpcMethod = RpcGroup.Rpcs<typeof AutomationRpcGroup>["_tag"];
const M = AUTOMATION_WS_METHODS;

/**
 * What an orchestrator's agent may do with each automation RPC.
 * - `read`: observation, open to a live credential.
 * - `service`: the service behind it checks the action and its target.
 * - `operator`: configuration only the operator changes; always refused.
 * - `message`: needs `peer.message`; see `makeAutomationMethodGate`.
 *
 * Keyed by the RPC group, so a new method is a type error until it is placed.
 */
const AUTOMATION_RPC_ORCHESTRATOR_RULES = {
  [M.eventsStatus]: "read",
  [M.eventsRead]: "read",
  [M.eventsSubscribe]: "read",
  [M.eventsEmit]: "service",
  [M.consumersList]: "read",
  [M.consumersAck]: "operator",
  [M.consumersDelete]: "operator",
  [M.hooksList]: "read",
  [M.hooksUpsert]: "operator",
  [M.hooksSetEnabled]: "operator",
  [M.hooksDelete]: "operator",
  [M.hooksTest]: "operator",
  [M.hooksDeliveries]: "read",
  [M.hooksRedeliver]: "operator",
  [M.hooksDismissDelivery]: "operator",
  [M.requestsList]: "read",
  [M.requestsRespond]: "service",
  [M.claimsTransfer]: "service",
  [M.orchestratorsList]: "read",
  [M.orchestratorsSubscribe]: "read",
  [M.orchestratorsUpsert]: "operator",
  [M.orchestratorsSetState]: "operator",
  [M.orchestratorsDelete]: "operator",
  [M.orchestratorsSend]: "message",
  [M.orchestratorsInbox]: "read",
  [M.orchestratorsResolveInbox]: "operator",
  [M.orchestratorsCheckpoints]: "read",
  [M.orchestratorsHandoff]: "operator",
  [M.orchestratorsHandoffStatus]: "read",
  [M.tasksDelegate]: "service",
  [M.tasksGet]: "read",
  [M.tasksList]: "read",
  [M.tasksUpdate]: "service",
  [M.threadTree]: "read",
  [M.nodesList]: "read",
  [M.nodesUpsert]: "operator",
  [M.nodesRemove]: "operator",
  [M.nodesProbe]: "operator",
  [M.jobsSubmit]: "service",
  [M.jobsGet]: "read",
  [M.jobsList]: "read",
  [M.jobsCancel]: "service",
  [M.jobsReconcile]: "service",
  [M.jobsLogs]: "read",
  [M.jobsWatch]: "read",
  [M.peersList]: "read",
  [M.peersAdd]: "operator",
  [M.peersUpdate]: "operator",
  [M.peersRemove]: "operator",
  [M.peersOutbox]: "read",
  [M.peerHello]: "operator",
  [M.peerDeliver]: "operator",
  [M.diagnostics]: "read",
} as const satisfies Readonly<
  Record<AutomationRpcMethod, "read" | "service" | "operator" | "message">
>;

const isAutomationMethod = (method: string): method is AutomationRpcMethod =>
  Object.hasOwn(AUTOMATION_RPC_ORCHESTRATOR_RULES, method);

const V2 = ORCHESTRATION_V2_WS_METHODS;

/**
 * Every other RPC an orchestrator's agent may call; a method not listed is
 * refused. `open` is server metadata the CLI reads, `thread.read` needs that
 * action, and `payload` methods are checked against their input where the
 * handler holds it (`threadCommand`, `threadLaunch`).
 */
const CORE_RPC_ORCHESTRATOR_RULES: ReadonlyMap<string, "open" | "thread.read" | "payload"> =
  new Map([
    [V2.dispatchCommand, "payload"],
    [V2.launchThread, "payload"],
    [V2.getThreadProjection, "thread.read"],
    [V2.subscribeThread, "thread.read"],
    [V2.subscribeShell, "thread.read"],
    [V2.getArchivedShellSnapshot, "thread.read"],
    [V2.subscribeArchivedShell, "thread.read"],
    [V2.searchThreads, "thread.read"],
    [V2.getTurnDiff, "thread.read"],
    [V2.getFullThreadDiff, "thread.read"],
    [V2.getWorkflowScript, "thread.read"],
    [WS_METHODS.serverProbe, "open"],
    [WS_METHODS.serverGetConfig, "open"],
    [WS_METHODS.serverGetSettings, "open"],
    [WS_METHODS.serverGetPendingWork, "open"],
    [WS_METHODS.scheduledTasksList, "open"],
    [WS_METHODS.computeListJobs, "open"],
    [WS_METHODS.subscribeResourceTelemetry, "open"],
  ]);

/**
 * The action each thread command needs. `answer` goes through the request's
 * claim instead; a command type that is not listed is refused.
 */
const THREAD_COMMAND_ACTIONS: Partial<
  Record<OrchestrationV2Command["type"], OrchestratorAction | "answer">
> = {
  "thread.create": "thread.create",
  "thread.fork": "thread.create",
  "message.dispatch": "thread.send",
  "queued-message.promote-to-steer": "thread.send",
  "queued-run.edit": "thread.send",
  "queued-run.reorder": "thread.send",
  "queued-run.cancel": "thread.send",
  "queue.resume": "thread.send",
  "thread.interaction-mode.set": "thread.send",
  "run.interrupt": "thread.interrupt",
  "thread.archive": "thread.organize",
  "thread.unarchive": "thread.organize",
  "thread.settle": "thread.organize",
  "thread.unsettle": "thread.organize",
  "thread.snooze": "thread.organize",
  "thread.unsnooze": "thread.organize",
  "thread.pin": "thread.organize",
  "thread.unpin": "thread.organize",
  "thread.metadata.update": "thread.organize",
  "thread.mark-unread": "thread.organize",
  "runtime-request.respond": "answer",
  "thread.user-input.dismiss": "answer",
};

const refusal = (error: AutomationError) =>
  new EnvironmentAuthorizationError({
    message: `${error.code}: ${error.message}`,
    requiredScope: AuthOrchestrationOperateScope,
  });

/** Whether an RPC answers with a stream, and whether it can carry an authorization error. */
const rpcShape = (method: string) => {
  const rpc = WsRpcGroup.requests.get(method);
  const success = rpc?.successSchema;
  const stream = success !== undefined && RpcSchema.isStreamSchema(success);
  // A stream's errors travel in the stream's own schema, not in the RPC's.
  const errorSchema = stream ? success.error : rpc?.errorSchema;
  return {
    stream,
    carries: (error: EnvironmentAuthorizationError) =>
      errorSchema !== undefined && Schema.is(errorSchema)(error),
  };
};

const denied = (caller: OrchestratorCaller, message: string) =>
  automationError("PERMISSION_DENIED", message, { orchestratorId: caller.orchestratorId });

/**
 * The rule of one automation RPC, applied before its service runs. The
 * services repeat the finer checks against the action's real target.
 */
export const makeAutomationMethodGate = (
  store: Pick<OrchestratorStore, "getOrchestrator" | "requireOrchestrator">,
  environmentId: EnvironmentId,
) => {
  const access = makeOrchestratorAccess(store, environmentId);
  return (
    caller: AutomationCaller,
    method: AutomationRpcMethod,
    payload: unknown,
  ): Effect.Effect<void, AutomationError> => {
    if (caller.kind !== "orchestrator") return Effect.void;
    const rule = AUTOMATION_RPC_ORCHESTRATOR_RULES[method];
    switch (rule) {
      case "read":
      case "service":
        return Effect.asVoid(access.requireLive(caller));
      case "operator":
        return Effect.fail(
          denied(
            caller,
            `An orchestrator's agent may not call ${method}. That is the operator's decision.`,
          ),
        );
      case "message":
        return Effect.gen(function* () {
          const target = yield* store.requireOrchestrator(
            (payload as { readonly orchestratorId: OrchestratorId }).orchestratorId,
          );
          if (target.id === caller.orchestratorId) {
            return yield* denied(caller, "An orchestrator cannot send a message to itself.");
          }
          yield* access.authorize(caller, "peer.message", {
            environmentId: target.hostEnvironmentId,
          });
          // The inbox records who sent an entry. Until it can name an
          // orchestrator as the sender, the message would arrive as the user's.
          return yield* automationError(
            "CAPABILITY_UNSUPPORTED",
            "Messages from one orchestrator's agent to another orchestrator are not available on this server yet.",
            { orchestratorId: caller.orchestratorId },
          );
        });
    }
  };
};

/**
 * The one place the WebSocket route asks whether an orchestrator's agent may
 * make a call. Every method is refused unless a rule here admits it, so an RPC
 * nobody thought about fails closed. Any other caller passes untouched.
 */
export const makeOrchestratorRpcGate = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const environmentId = yield* identity.getEnvironmentId;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const responsibility = yield* ResponsibilityService.ResponsibilityService;
  const store = makeStore(sql);
  const access = makeOrchestratorAccess(store, environmentId);

  const projectOf = (threadId: ThreadId) =>
    threads.getThreadShell(threadId).pipe(
      Effect.mapError(() => automationError("INTERNAL", "The thread could not be read.")),
      Effect.flatMap((shell) =>
        shell === null
          ? Effect.fail(automationError("NOT_FOUND", `Thread ${threadId} does not exist.`))
          : Effect.succeed(shell.projectId),
      ),
    );

  const checkThreadCommand = Effect.fn("OrchestratorRpcGate.threadCommand")(function* (
    caller: OrchestratorCaller,
    command: OrchestrationV2Command,
  ) {
    const orchestrator = yield* access.requireLive(caller);
    const action = THREAD_COMMAND_ACTIONS[command.type];
    if (action === undefined) {
      return yield* denied(
        caller,
        `An orchestrator's agent may not issue ${command.type}. That is the operator's decision.`,
      );
    }
    if (command.type === "thread.create") {
      yield* access.authorize(caller, "thread.create", { projectId: command.projectId });
      return;
    }
    const threadId =
      command.type === "thread.fork"
        ? command.sourceThreadId
        : "threadId" in command
          ? command.threadId
          : undefined;
    if (threadId === undefined) {
      return yield* denied(caller, `${command.type} names no thread an orchestrator may act on.`);
    }
    // Its own conversation is driven by the runtime, never by the agent inside it.
    if (threadId === orchestrator.threadId) {
      return yield* denied(
        caller,
        `Orchestrator ${orchestrator.id} cannot command its own main thread.`,
      );
    }
    if (action === "answer") {
      if (
        command.type !== "runtime-request.respond" &&
        command.type !== "thread.user-input.dismiss"
      ) {
        return yield* denied(caller, `${command.type} is not an answer to a request.`);
      }
      yield* responsibility.admitThreadResponse(caller, {
        threadId: command.threadId,
        requestId: command.requestId,
        ...(command.type === "runtime-request.respond" && command.decision !== undefined
          ? { decision: command.decision }
          : {}),
        ...(command.type === "thread.user-input.dismiss" ? { dismiss: true } : {}),
      });
      return;
    }
    yield* access.authorize(caller, action, { projectId: yield* projectOf(threadId) });
  });

  /** Checked where `dispatchCommand` holds the command. */
  const threadCommand = (caller: AutomationCaller, command: OrchestrationV2Command) =>
    caller.kind !== "orchestrator"
      ? Effect.void
      : checkThreadCommand(caller, command).pipe(Effect.mapError(refusal));

  /** Checked where `launchThread` holds its input. */
  const threadLaunch = (caller: AutomationCaller, input: { readonly projectId: ProjectId }) =>
    caller.kind !== "orchestrator"
      ? Effect.void
      : access
          .authorize(caller, "thread.create", { projectId: input.projectId })
          .pipe(Effect.asVoid, Effect.mapError(refusal));

  /**
   * Wraps a group's handlers so that, for an orchestrator's agent, a method
   * without a rule never runs and a `thread.read` method needs that action.
   * Handlers of any other caller are returned as they are.
   */
  const guardHandlers = <Handlers extends object>(
    caller: AutomationCaller,
    handlers: Handlers,
  ): Handlers => {
    if (caller.kind !== "orchestrator") return handlers;
    const guarded = Object.entries(handlers).map(([method, handler]) => {
      const run = handler as (...args: ReadonlyArray<unknown>) => unknown;
      const rule = isAutomationMethod(method) ? "payload" : CORE_RPC_ORCHESTRATOR_RULES.get(method);
      // Checked with the payload in hand: by the automation handlers, or by the
      // two thread handlers.
      if (rule === "payload") return [method, run] as const;
      const shape = rpcShape(method);
      const check =
        rule === undefined
          ? Effect.fail(denied(caller, `An orchestrator's agent may not call ${method}.`))
          : rule === "open"
            ? access.requireLive(caller)
            : access.authorize(caller, "thread.read");
      // An RPC whose contract has no authorization error still must not run:
      // the refusal then reaches the client as a defect instead.
      const refuse = (error: AutomationError) => {
        const typed = refusal(error);
        return shape.carries(typed) ? Effect.fail(typed) : Effect.die(typed);
      };
      const admitted = check.pipe(Effect.catch(refuse));
      return [
        method,
        (...args: ReadonlyArray<unknown>) =>
          shape.stream
            ? Stream.unwrap(Effect.map(admitted, () => run(...args) as Stream.Stream<unknown>))
            : Effect.flatMap(admitted, () => run(...args) as Effect.Effect<unknown>),
      ] as const;
    });
    return Object.fromEntries(guarded) as Handlers;
  };

  return { threadCommand, threadLaunch, guardHandlers } as const;
});
