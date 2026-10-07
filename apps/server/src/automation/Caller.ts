import {
  AutomationError,
  type AuthEnvironmentScope,
  type AutomationErrorCode,
  type EnvironmentId,
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
  /** The server acting on its own behalf: workers, reactors, timers. */
  | { readonly kind: "internal"; readonly subject: string };

export const internalCaller = (subject: string): AutomationCaller => ({
  kind: "internal",
  subject,
});

export const PEER_SESSION_SUBJECT_PREFIX = "peer:";

/** Session subject a peer environment's service credential carries. */
export const peerSessionSubject = (environmentId: EnvironmentId) =>
  `${PEER_SESSION_SUBJECT_PREFIX}${environmentId}`;

export const automationError = (
  code: AutomationErrorCode,
  message: string,
  detail?: AutomationError["detail"],
) => new AutomationError({ code, message, ...(detail === undefined ? {} : { detail }) });

/** Placeholder for a capability this build has not wired yet. */
export const unsupported = (capability: string) =>
  automationError("CAPABILITY_UNSUPPORTED", `${capability} is not available on this server.`);
