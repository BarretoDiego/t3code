import type {
  AutomationError,
  EnvironmentId,
  ExecutionNodeId,
  OrchestratorAction,
  OrchestratorId,
  ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { type AutomationCaller, automationError, type OrchestratorCaller } from "../Caller.ts";
import { isLiveAgentCredential } from "./CredentialRegistry.ts";
import type { OrchestratorStore, StoredOrchestrator } from "./Store.ts";

/** What an action is aimed at. Only the dimensions given are checked. */
interface OrchestratorActionTarget {
  readonly projectId?: ProjectId | string | undefined;
  /** A peer environment being addressed. The host's own environment is always in scope. */
  readonly environmentId?: EnvironmentId | undefined;
  readonly nodeId?: ExecutionNodeId | undefined;
}

/**
 * Decides, at the moment an action runs, whether the orchestrator behind a
 * caller may take it. Built from the orchestrator store so every service asks
 * the same stored facts; a caller that is not an orchestrator is not its
 * business and passes untouched.
 */
export const makeOrchestratorAccess = (
  store: Pick<OrchestratorStore, "getOrchestrator">,
  environmentId: EnvironmentId,
) => {
  /**
   * The orchestrator a caller's credential stands for, provided the credential
   * is still honoured: issued by the runtime and not ended, for an orchestrator
   * that exists, is hosted here under the same generation, and is active.
   */
  const requireLive = Effect.fn("OrchestratorAccess.requireLive")(function* (
    caller: OrchestratorCaller,
  ) {
    if (!isLiveAgentCredential(caller.credentialId)) {
      return yield* automationError(
        "PERMISSION_DENIED",
        "This orchestrator credential has ended. It is valid only while its turn runs.",
        { orchestratorId: caller.orchestratorId },
      );
    }
    const orchestrator = yield* store.getOrchestrator(caller.orchestratorId);
    if (orchestrator === null) {
      return yield* automationError(
        "PERMISSION_DENIED",
        `Orchestrator ${caller.orchestratorId} no longer exists.`,
        { orchestratorId: caller.orchestratorId },
      );
    }
    if (
      orchestrator.hostEnvironmentId !== environmentId ||
      orchestrator.hostGeneration !== caller.hostGeneration
    ) {
      return yield* automationError(
        "NOT_OWNER",
        `Orchestrator ${orchestrator.id} is no longer hosted under the generation this credential was issued for.`,
        {
          orchestratorId: orchestrator.id,
          hostEnvironmentId: orchestrator.hostEnvironmentId,
          hostGeneration: orchestrator.hostGeneration,
        },
      );
    }
    if (orchestrator.desiredState !== "active") {
      return yield* automationError(
        "PAUSED",
        `Orchestrator ${orchestrator.id} is ${orchestrator.desiredState}; its agent may not act.`,
        { orchestratorId: orchestrator.id, desiredState: orchestrator.desiredState },
      );
    }
    return orchestrator;
  });

  /**
   * Fails unless the caller may take `action` on `target`. Resolves to the
   * orchestrator for an orchestrator caller and to null for anyone else.
   */
  const authorize = (
    caller: AutomationCaller,
    action: OrchestratorAction,
    target: OrchestratorActionTarget = {},
  ): Effect.Effect<StoredOrchestrator | null, AutomationError> =>
    caller.kind !== "orchestrator"
      ? Effect.succeed(null)
      : Effect.gen(function* () {
          const orchestrator = yield* requireLive(caller);
          const { permissions } = orchestrator.config;
          const denied = (message: string) =>
            automationError("PERMISSION_DENIED", message, {
              orchestratorId: orchestrator.id,
              action,
            });
          if (!permissions.actions.includes(action)) {
            return yield* denied(`Orchestrator ${orchestrator.id} does not hold ${action}.`);
          }
          if (
            target.projectId !== undefined &&
            permissions.projectIds !== undefined &&
            !permissions.projectIds.some((projectId) => projectId === target.projectId)
          ) {
            return yield* denied(
              `Project ${target.projectId} is outside orchestrator ${orchestrator.id}'s scope.`,
            );
          }
          if (
            target.environmentId !== undefined &&
            target.environmentId !== environmentId &&
            permissions.environmentIds !== undefined &&
            !permissions.environmentIds.includes(target.environmentId)
          ) {
            return yield* denied(
              `Orchestrator ${orchestrator.id} may not address environment ${target.environmentId}.`,
            );
          }
          if (
            target.nodeId !== undefined &&
            permissions.nodeIds !== undefined &&
            !permissions.nodeIds.includes(target.nodeId)
          ) {
            return yield* denied(
              `Orchestrator ${orchestrator.id} may not use node ${target.nodeId}.`,
            );
          }
          return orchestrator;
        });

  /** Refuses an orchestrator caller outright, for operations only an operator performs. */
  const operatorOnly = (caller: AutomationCaller, operation: string) =>
    caller.kind === "orchestrator"
      ? Effect.fail(
          automationError(
            "PERMISSION_DENIED",
            `An orchestrator's agent may not ${operation}. That is the operator's decision.`,
            { orchestratorId: caller.orchestratorId },
          ),
        )
      : Effect.void;

  /**
   * The orchestrator id an operation runs under. An orchestrator caller always
   * acts as itself: naming another orchestrator is refused, naming none is filled in.
   */
  const actingOrchestratorId = (
    caller: AutomationCaller,
    named: OrchestratorId | undefined,
  ): Effect.Effect<OrchestratorId | undefined, AutomationError> =>
    caller.kind !== "orchestrator"
      ? Effect.succeed(named)
      : named !== undefined && named !== caller.orchestratorId
        ? Effect.fail(
            automationError(
              "PERMISSION_DENIED",
              `Orchestrator ${caller.orchestratorId} cannot act as orchestrator ${named}.`,
              { orchestratorId: caller.orchestratorId },
            ),
          )
        : Effect.succeed(caller.orchestratorId);

  return { requireLive, authorize, operatorOnly, actingOrchestratorId } as const;
};
