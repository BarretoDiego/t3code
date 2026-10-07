import type { AuthEnvironmentScope, OrchestratorId } from "@t3tools/contracts";

import {
  type AutomationCaller,
  ORCHESTRATOR_SESSION_SUBJECT_PREFIX,
  orchestratorSessionSubject,
} from "../Caller.ts";

interface IssuedCredential {
  readonly orchestratorId: OrchestratorId;
  readonly hostGeneration: number;
}

// Process-wide on purpose: the session a caller presents is checked by services
// built in other layer compositions than the runtime that issued it, and a
// second copy of this state would make every credential look forged. It is
// never persisted, so a restart forgets every credential it issued.
const issuedBySession = new Map<string, IssuedCredential>();

/** Called by the runtime, and only by it, when it issues a turn's session. */
export const recordIssuedCredential = (sessionId: string, credential: IssuedCredential) => {
  issuedBySession.set(sessionId, credential);
};

export const forgetIssuedCredential = (sessionId: string) => {
  issuedBySession.delete(sessionId);
};

/** True while the runtime that issued this session still stands behind it. */
export const isLiveAgentCredential = (credentialId: string) => issuedBySession.has(credentialId);

/**
 * The caller an orchestrator-subject session proves, or undefined for any other
 * session. It is the orchestrator's agent only when the runtime issued that
 * very session; one that merely carries the subject holds nothing at all,
 * rather than passing as an ordinary client.
 */
export const orchestratorCallerFromSession = (session: {
  readonly sessionId: string;
  readonly subject: string;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
}): AutomationCaller | undefined => {
  if (!session.subject.startsWith(ORCHESTRATOR_SESSION_SUBJECT_PREFIX)) return undefined;
  const issued = issuedBySession.get(session.sessionId);
  if (
    issued === undefined ||
    orchestratorSessionSubject(issued.orchestratorId) !== session.subject
  ) {
    return { kind: "client", subject: session.subject, scopes: [] };
  }
  return {
    kind: "orchestrator",
    orchestratorId: issued.orchestratorId,
    hostGeneration: issued.hostGeneration,
    credentialId: session.sessionId,
    subject: session.subject,
    scopes: session.scopes,
  };
};
