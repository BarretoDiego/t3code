import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type AuthEnvironmentScope,
  type AuthSessionId,
  type OrchestratorId,
  type ThreadId,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../../config.ts";
import { setAgentShellEnvironment } from "../../orchestration-v2/AgentShellEnvironment.ts";
import { readPersistedServerRuntimeState } from "../../serverRuntimeState.ts";
import {
  automationError,
  ORCHESTRATOR_SESSION_SUBJECT_PREFIX,
  orchestratorSessionSubject,
} from "../Caller.ts";
import { AGENT_CREDENTIAL_FILE_ENV, AgentCredentialDocument } from "./agentCredentialFile.ts";
import { forgetIssuedCredential, recordIssuedCredential } from "./CredentialRegistry.ts";

const encodeDocument = Schema.encodeEffect(AgentCredentialDocument);

/** What the agent's session may reach before the orchestrator's own permissions narrow it. */
const AGENT_SESSION_SCOPES: ReadonlyArray<AuthEnvironmentScope> = [
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
];

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * Issues, delivers and revokes the credential an orchestrator's agent uses
 * during a turn, and puts this server's own `t3` on the agent's PATH. Everything
 * it writes stays in the server's state directory.
 */
export const makeAgentCredentials = Effect.gen(function* () {
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const platform = yield* HostProcessPlatform;
  const self = yield* resolveSelfInvocation();
  const root = path.join(config.stateDir, "orchestrator-agents");
  const binDirectory = path.join(root, "bin");
  const sessionsByOrchestrator = new Map<OrchestratorId, AuthSessionId>();

  const internal = (operation: string) => () =>
    automationError("INTERNAL", `The orchestrator agent credential could not be ${operation}.`);

  const credentialFile = (orchestratorId: OrchestratorId) =>
    path.join(root, "credentials", `${orchestratorId.replaceAll(/[^A-Za-z0-9_-]/gu, "_")}.json`);

  const writeDocument = (orchestratorId: OrchestratorId, token: string | null) =>
    Effect.gen(function* () {
      const state = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.orElseSucceed(() => Option.none()),
      );
      const origin = Option.getOrNull(Option.map(state, (value) => value.origin));
      const file = credentialFile(orchestratorId);
      yield* fs.makeDirectory(path.dirname(file), { recursive: true, mode: 0o700 });
      // Written beside the target and renamed, so a reader never sees half a
      // credential. One orchestrator has one writer: its turn loop.
      const temporary = `${file}.tmp`;
      yield* fs.writeFileString(temporary, yield* encodeDocument({ version: 1, origin, token }), {
        mode: 0o600,
      });
      yield* fs.chmod(temporary, 0o600);
      yield* fs.rename(temporary, file);
    });

  /** The `t3` the agent runs: this server's own entrypoint, whatever is installed globally. */
  const writeShim = Effect.gen(function* () {
    yield* fs.makeDirectory(binDirectory, { recursive: true, mode: 0o700 });
    const argv = self.entrypoint === undefined ? [self.command] : [self.command, self.entrypoint];
    if (platform === "win32") {
      yield* fs.writeFileString(
        path.join(binDirectory, "t3.cmd"),
        `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n${argv.map((part) => `"${part}"`).join(" ")} %*\r\n`,
      );
      return;
    }
    const shim = path.join(binDirectory, "t3");
    yield* fs.writeFileString(
      shim,
      `#!/bin/sh\n# The T3 Code CLI of the server that owns this state directory. Rewritten on every turn.\nELECTRON_RUN_AS_NODE=1 exec ${argv.map(shellQuote).join(" ")} "$@"\n`,
      { mode: 0o755 },
    );
    yield* fs.chmod(shim, 0o755);
  });

  const revokeSession = (orchestratorId: OrchestratorId) =>
    Effect.gen(function* () {
      const sessionId = sessionsByOrchestrator.get(orchestratorId);
      if (sessionId === undefined) return false;
      sessionsByOrchestrator.delete(orchestratorId);
      forgetIssuedCredential(sessionId);
      yield* auth.revokeSession(sessionId).pipe(Effect.ignore({ log: true }));
      return true;
    });

  /**
   * Ends the credential: the session is revoked and the file keeps only a
   * tombstone. A no-op for an orchestrator that holds none.
   */
  const revoke = (orchestratorId: OrchestratorId) =>
    Effect.gen(function* () {
      if (!(yield* revokeSession(orchestratorId))) return;
      yield* writeDocument(orchestratorId, null).pipe(Effect.ignore({ log: true }));
    });

  /**
   * Starts a turn's credential. The provider process of `threadId` learns where
   * to read it and finds this server's `t3` first on PATH; the token itself goes
   * only into the private file.
   */
  const issue = Effect.fn("OrchestratorAgentCredentials.issue")(function* (input: {
    readonly orchestratorId: OrchestratorId;
    readonly hostGeneration: number;
    readonly threadId: ThreadId;
    readonly ttl: Duration.Duration;
  }) {
    yield* revokeSession(input.orchestratorId);
    yield* writeShim.pipe(Effect.mapError(internal("prepared")));
    const session = yield* auth
      .issueSession({
        subject: orchestratorSessionSubject(input.orchestratorId),
        scopes: AGENT_SESSION_SCOPES,
        label: "orchestrator agent",
        ttl: input.ttl,
      })
      .pipe(Effect.mapError(internal("issued")));
    sessionsByOrchestrator.set(input.orchestratorId, session.sessionId);
    recordIssuedCredential(session.sessionId, {
      orchestratorId: input.orchestratorId,
      hostGeneration: input.hostGeneration,
    });
    yield* writeDocument(input.orchestratorId, session.token).pipe(
      Effect.mapError(internal("stored")),
      Effect.tapError(() => revokeSession(input.orchestratorId)),
    );
    setAgentShellEnvironment(input.threadId, {
      variables: { [AGENT_CREDENTIAL_FILE_ENV]: credentialFile(input.orchestratorId) },
      pathEntry: binDirectory,
      pathSeparator: platform === "win32" ? ";" : ":",
    });
  });

  /**
   * Revokes every agent session a previous process left behind. The record of
   * who issued them died with that process, so none of them may be honoured.
   */
  const revokeLeftovers = Effect.gen(function* () {
    const sessions = yield* auth.listSessions().pipe(Effect.orElseSucceed(() => []));
    for (const session of sessions) {
      if (!session.subject.startsWith(ORCHESTRATOR_SESSION_SUBJECT_PREFIX)) continue;
      forgetIssuedCredential(session.sessionId);
      yield* auth.revokeSession(session.sessionId).pipe(Effect.ignore({ log: true }));
    }
  });

  return { issue, revoke, revokeLeftovers } as const;
});
