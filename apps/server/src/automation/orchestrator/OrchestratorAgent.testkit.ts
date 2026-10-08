import {
  IdempotencyKey,
  type Orchestrator,
  type OrchestratorId,
  type OrchestratorUpsertInput,
  type ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import { internalCaller, type OrchestratorCaller } from "../Caller.ts";
import * as OrchestratorService from "../OrchestratorService.ts";
import { callerFromSession } from "../rpcHandlers.ts";
import { AGENT_CREDENTIAL_FILE_ENV, AgentCredentialDocument } from "./agentCredentialFile.ts";
import { awaitThreadEvent, orchestratorInput, type ProviderProbe } from "./Orchestrator.testkit.ts";
import * as OrchestratorRuntime from "./Runtime.ts";

export const operator = internalCaller("test-operator");
const decodeCredential = Schema.decodeUnknownEffect(AgentCredentialDocument);

/** A request as the HTTP layer sees one that carries only a bearer token. */
const bearerRequest = (token: string) =>
  ({ cookies: {}, headers: { authorization: `Bearer ${token}` } }) as unknown as Parameters<
    EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]
  >[0];

/** Who the server takes the bearer of `token` to be, as the WebSocket route decides it. */
export const callerOfToken = (token: string) =>
  EnvironmentAuth.EnvironmentAuth.use((auth) =>
    auth.authenticateHttpRequest(bearerRequest(token)),
  ).pipe(Effect.map(callerFromSession));

/** What the credential file an agent's environment points at holds right now. */
export const readCredentialFile = (file: string) =>
  FileSystem.FileSystem.use((fs) => fs.readFileString(file)).pipe(Effect.flatMap(decodeCredential));

const providerTurnRunning = (event: { readonly type: string; readonly payload: unknown }) =>
  event.type === "provider-turn.updated" &&
  (event.payload as { readonly status: string }).status === "running";

/**
 * A started runtime with an orchestrator whose first turn is running at the
 * provider and held there. `agent` is what that turn's agent holds: the
 * environment its shell got, the credential it reads, and the caller the server
 * takes it for. `release` lets the turn complete.
 */
export const orchestratorInTurn = Effect.fn("testkit.orchestratorInTurn")(function* (
  provider: ProviderProbe,
  overrides: Partial<OrchestratorUpsertInput> = {},
) {
  const service = yield* OrchestratorService.OrchestratorService;
  const runtime = yield* OrchestratorRuntime.OrchestratorRuntime;
  yield* runtime.start();
  yield* runtime.drain;
  const orchestrator = yield* service.upsert(operator, orchestratorInput(overrides));
  const hold = yield* Deferred.make<void>();
  yield* Ref.set(provider.holdNextTurn, hold);
  yield* service.send(operator, {
    idempotencyKey: IdempotencyKey.make(`send:${orchestrator.id}:first`),
    orchestratorId: orchestrator.id,
    text: "Start.",
  });
  const threadId = orchestrator.threadId as ThreadId;
  yield* awaitThreadEvent(threadId, providerTurnRunning);
  const turn = (yield* Ref.get(provider.turns)).findLast(
    (candidate) => candidate.threadId === threadId,
  )!;
  const file = turn.environment[AGENT_CREDENTIAL_FILE_ENV] as string;
  const token = (yield* readCredentialFile(file)).token as string;
  const caller = (yield* callerOfToken(token)) as OrchestratorCaller;
  return {
    service,
    runtime,
    orchestrator,
    threadId,
    agent: { environment: turn.environment, file, token, caller },
    release: Deferred.succeed(hold, undefined),
  };
});

export const describeOrchestrator = (orchestratorId: OrchestratorId) =>
  OrchestratorService.OrchestratorService.use((service) => service.list(operator)).pipe(
    Effect.map((all) => all.find((entry) => entry.id === orchestratorId) as Orchestrator),
  );

/** Every table that mentions `needle`, across the whole database. */
export const tablesMentioning = Effect.fn("testkit.tablesMentioning")(function* (needle: string) {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
  `;
  const found: Array<string> = [];
  for (const { name } of tables) {
    const rows = yield* sql.unsafe<Record<string, unknown>>(`SELECT * FROM "${name}"`);
    if (rows.some((row) => Object.values(row).some((value) => String(value).includes(needle)))) {
      found.push(name);
    }
  }
  return found;
});
