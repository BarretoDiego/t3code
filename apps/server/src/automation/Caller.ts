import {
  AutomationError,
  type AuthEnvironmentScope,
  type AutomationErrorCode,
  type EnvironmentId,
  type OrchestratorId,
} from "@t3tools/contracts";

/**
 * Who is asking. Transports build it from the authenticated session; services
 * decide from it, never from anything the request body claims about itself.
 */
export type AutomationCaller =
  | {
      readonly kind: "client";
      readonly subject: string;
      readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
    }
  /** A paired peer environment. `environmentId` comes from the session, not the message. */
  | {
      readonly kind: "peer";
      readonly environmentId: EnvironmentId;
      readonly subject: string;
      readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
    }
  /**
   * The agent inside one orchestrator turn, calling back through the `t3` CLI.
   * Built only from a credential the orchestrator runtime issued for that turn;
   * `hostGeneration` is the hosting generation it was issued under.
   */
  | {
      readonly kind: "orchestrator";
      readonly orchestratorId: OrchestratorId;
      readonly hostGeneration: number;
      /** The session the runtime issued. Services check it is still live before acting. */
      readonly credentialId: string;
      readonly subject: string;
      readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
    }
  /** The server acting on its own behalf: workers, reactors, timers. */
  | { readonly kind: "internal"; readonly subject: string };

export type OrchestratorCaller = Extract<AutomationCaller, { readonly kind: "orchestrator" }>;

export const internalCaller = (subject: string): AutomationCaller => ({
  kind: "internal",
  subject,
});

export const PEER_SESSION_SUBJECT_PREFIX = "peer:";

/** Session subject a peer environment's service credential carries. */
export const peerSessionSubject = (environmentId: EnvironmentId) =>
  `${PEER_SESSION_SUBJECT_PREFIX}${environmentId}`;

export const ORCHESTRATOR_SESSION_SUBJECT_PREFIX = "orchestrator:";

/**
 * Session subject of the credential an orchestrator's agent holds during a turn.
 * The subject alone proves nothing: the runtime also records each session it issued.
 */
export const orchestratorSessionSubject = (orchestratorId: OrchestratorId) =>
  `${ORCHESTRATOR_SESSION_SUBJECT_PREFIX}${orchestratorId}`;

export const automationError = (
  code: AutomationErrorCode,
  message: string,
  detail?: AutomationError["detail"],
) => new AutomationError({ code, message, ...(detail === undefined ? {} : { detail }) });

/** Placeholder for a capability this build has not wired yet. */
export const unsupported = (capability: string) =>
  automationError("CAPABILITY_UNSUPPORTED", `${capability} is not available on this server.`);
