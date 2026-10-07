import { assert, describe, it } from "@effect/vitest";
import {
  type AgentProfile,
  AuthStandardClientScopes,
  IdempotencyKey,
  type OrchestratorId,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { FetchHttpClient } from "effect/unstable/http";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import { readAgentCredential, withLocalEnvironmentTarget } from "../../cli/environmentRpc.ts";
import * as ServerConfig from "../../config.ts";
import { persistServerRuntimeState } from "../../serverRuntimeState.ts";
import { type AutomationCaller, orchestratorSessionSubject } from "../Caller.ts";
import * as OrchestratorService from "../OrchestratorService.ts";
import { makeOrchestratorAccess } from "./Access.ts";
import { AGENT_CREDENTIAL_FILE_ENV } from "./agentCredentialFile.ts";
import {
  environmentId,
  makeAutomationLayer,
  modelSelection,
  orchestratorInput,
  otherInstanceId,
  projectId,
  PROVIDER_BASE_PATH,
  unsupportedInstanceId,
  withEngine,
} from "./Orchestrator.testkit.ts";
import {
  callerOfToken,
  describeOrchestrator,
  operator,
  orchestratorInTurn,
  readCredentialFile,
  tablesMentioning,
} from "./OrchestratorAgent.testkit.ts";
import * as OrchestratorRuntime from "./Runtime.ts";
import { makeStore } from "./Store.ts";

const TIMEOUT = 60_000;
const asText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const ORIGIN = "http://127.0.0.1:43117";

/** The decision every service asks: may this caller take this action now? */
const mayAct = (caller: AutomationCaller) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* makeOrchestratorAccess(makeStore(sql), environmentId).authorize(
      caller,
      "thread.send",
      { projectId },
    );
  });

/** The environment of a shell, as the CLI reads it. */
const inShell = (environment: Record<string, string>) =>
  Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: environment })));

const publishOrigin = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  yield* persistServerRuntimeState({
    path: config.serverRuntimeStatePath,
    state: {
      version: 1,
      pid: process.pid,
      port: 43_117,
      origin: ORIGIN,
      startedAt: "2026-06-20T00:00:00.000Z",
    },
  });
  return config;
});

const send = (orchestratorId: OrchestratorId, text: string) =>
  OrchestratorService.OrchestratorService.use((service) =>
    service.send(operator, {
      idempotencyKey: IdempotencyKey.make(`send:${orchestratorId}:${text}`),
      orchestratorId,
      text,
    }),
  );

const inboxStatuses = (orchestratorId: OrchestratorId) =>
  OrchestratorService.OrchestratorService.use((service) =>
    service.inbox(operator, { orchestratorId }),
  ).pipe(Effect.map((entries) => entries.map((entry) => entry.status)));

const profile = (overrides: Partial<AgentProfile>): AgentProfile => ({
  id: "profile-deep" as AgentProfile["id"],
  name: "Deep",
  slug: "deep" as AgentProfile["slug"],
  description: "",
  enabled: true,
  miniSkillIds: [],
  instructions: "Weigh every option before deciding.",
  routes: [],
  createdAt: "2026-06-20T00:00:00.000Z",
  updatedAt: "2026-06-20T00:00:00.000Z",
  ...overrides,
});

describe("orchestrator agent credential", () => {
  it.effect(
    "a turn's agent gets its own credential and this server's t3, and nothing stored repeats the token",
    () =>
      withEngine("agent-credential-delivery", ({ provider, journal }) =>
        Effect.gen(function* () {
          const config = yield* publishOrigin;
          const fs = yield* FileSystem.FileSystem;
          const { orchestrator, agent, release, service } = yield* orchestratorInTurn(provider);

          // The shell finds this server's CLI before anything installed globally.
          const [first, ...rest] = (agent.environment.PATH as string).split(":");
          assert.strictEqual(rest.join(":"), PROVIDER_BASE_PATH);
          assert.isTrue((first as string).startsWith(config.stateDir));
          const shim = yield* fs.readFileString(`${first}/t3`);
          assert.include(shim, process.execPath);
          assert.isTrue(((yield* fs.stat(`${first}/t3`)).mode & 0o111) !== 0);
          // The environment names a private file inside the state directory, not a secret.
          assert.isTrue(agent.file.startsWith(config.stateDir));
          assert.strictEqual((yield* fs.stat(agent.file)).mode & 0o077, 0);
          assert.notInclude(asText(agent.environment), agent.token);

          // The CLI in that shell targets this server as the orchestrator, without flags.
          const shell = { [AGENT_CREDENTIAL_FILE_ENV]: agent.file };
          const target = yield* withLocalEnvironmentTarget(config, Effect.succeed).pipe(
            inShell(shell),
            // Never used: the credential names the origin, so nothing is probed.
            Effect.provide(FetchHttpClient.layer),
          );
          assert.strictEqual(target.origin, ORIGIN);
          assert.deepStrictEqual(yield* callerOfToken(target.token), {
            kind: "orchestrator",
            orchestratorId: orchestrator.id,
            hostGeneration: orchestrator.hostGeneration,
            credentialId: agent.caller.credentialId,
            subject: orchestratorSessionSubject(orchestrator.id),
            scopes: ["orchestration:read", "orchestration:operate"],
          });
          assert.strictEqual((yield* mayAct(agent.caller))?.id, orchestrator.id);

          // Without the variable the CLI mints an ordinary session: a plain client.
          assert.isTrue(Option.isNone(yield* readAgentCredential.pipe(inShell({}))));
          const auth = yield* EnvironmentAuth.EnvironmentAuth;
          const ordinary = yield* auth.issueSession({
            scopes: AuthStandardClientScopes,
            label: "t3 cli",
          });
          assert.strictEqual((yield* callerOfToken(ordinary.token)).kind, "client");

          // A session that only carries the subject was not issued by the runtime:
          // it is neither the orchestrator nor a client with any scope.
          const forged = yield* auth.issueSession({
            subject: orchestratorSessionSubject(orchestrator.id),
            scopes: AuthStandardClientScopes,
          });
          assert.deepStrictEqual(yield* callerOfToken(forged.token), {
            kind: "client",
            subject: orchestratorSessionSubject(orchestrator.id),
            scopes: [],
          });

          yield* release;
          yield* journal.untilTurnsFinished(1);

          // Nothing the turn left behind carries the token.
          assert.deepStrictEqual(yield* tablesMentioning(agent.token), []);
          const stored = [
            yield* SubscriptionRef.get(journal.events),
            yield* service.inbox(operator, { orchestratorId: orchestrator.id }),
            yield* service.checkpoints(operator, { orchestratorId: orchestrator.id }),
            (yield* Ref.get(provider.turns)).map((turn) => turn.text),
          ];
          assert.notInclude(asText(stored), agent.token);

          // The turn is over: the file holds a tombstone, the session is gone,
          // and the CLI refuses instead of becoming the user.
          assert.isNull((yield* readCredentialFile(agent.file)).token);
          assert.strictEqual((yield* callerOfToken(agent.token).pipe(Effect.exit))._tag, "Failure");
          assert.strictEqual(
            (yield* mayAct(agent.caller).pipe(Effect.flip)).code,
            "PERMISSION_DENIED",
          );
          const ended = yield* readAgentCredential.pipe(inShell(shell), Effect.flip);
          assert.strictEqual(ended.reason, "ended");
          const missing = yield* readAgentCredential.pipe(
            inShell({ [AGENT_CREDENTIAL_FILE_ENV]: `${agent.file}.absent` }),
            Effect.flip,
          );
          assert.strictEqual(missing.reason, "unreadable");
        }).pipe(Effect.provide(makeAutomationLayer())),
      ),
    TIMEOUT,
  );

  it.effect(
    "the next turn gets a new credential and the previous one stays dead",
    () =>
      withEngine("agent-credential-rotation", ({ provider, journal }) =>
        Effect.gen(function* () {
          const { orchestrator, agent, release } = yield* orchestratorInTurn(provider);
          yield* release;
          yield* journal.untilTurnsFinished(1);
          yield* send(orchestrator.id, "Again.");
          yield* journal.untilTurnsFinished(2);
          // Same file for the same thread, so a provider process that outlives a
          // turn keeps reading the right place.
          const second = (yield* Ref.get(provider.turns))[1]!;
          assert.strictEqual(second.environment[AGENT_CREDENTIAL_FILE_ENV], agent.file);
          assert.strictEqual((yield* callerOfToken(agent.token).pipe(Effect.exit))._tag, "Failure");
          assert.isNull((yield* readCredentialFile(agent.file)).token);
        }).pipe(Effect.provide(makeAutomationLayer())),
      ),
    TIMEOUT,
  );

  it.effect.each(["paused", "disabled"] as const)(
    "a %s orchestrator's credential is refused and revoked while its turn still runs",
    (desiredState) =>
      withEngine(`agent-credential-${desiredState}`, ({ provider, journal }) =>
        Effect.gen(function* () {
          const { orchestrator, agent, release, service, runtime } =
            yield* orchestratorInTurn(provider);
          yield* service.setState(operator, { orchestratorId: orchestrator.id, desiredState });
          assert.strictEqual((yield* mayAct(agent.caller).pipe(Effect.flip)).code, "PAUSED");
          yield* runtime.wake(orchestrator.id);
          yield* runtime.drain;
          assert.strictEqual((yield* callerOfToken(agent.token).pipe(Effect.exit))._tag, "Failure");
          assert.isNull((yield* readCredentialFile(agent.file)).token);
          yield* release;
          yield* journal.untilTurnsFinished(1);
        }).pipe(Effect.provide(makeAutomationLayer())),
      ),
    TIMEOUT,
  );

  it.effect(
    "a deleted orchestrator's credential is refused",
    () =>
      withEngine("agent-credential-deleted", ({ provider }) =>
        Effect.gen(function* () {
          const { orchestrator, agent, service, runtime, release } =
            yield* orchestratorInTurn(provider);
          yield* service.delete(operator, orchestrator.id);
          const refused = yield* mayAct(agent.caller).pipe(Effect.flip);
          assert.strictEqual(refused.code, "PERMISSION_DENIED");
          assert.include(refused.message, "no longer exists");
          yield* runtime.wake(orchestrator.id);
          yield* runtime.drain;
          assert.strictEqual((yield* callerOfToken(agent.token).pipe(Effect.exit))._tag, "Failure");
          yield* release;
        }).pipe(Effect.provide(makeAutomationLayer())),
      ),
    TIMEOUT,
  );

  it.effect(
    "a credential issued under an earlier hosting generation is refused as NOT_OWNER",
    () =>
      withEngine("agent-credential-generation", ({ provider, journal }) =>
        Effect.gen(function* () {
          const { orchestrator, agent, release } = yield* orchestratorInTurn(provider);
          assert.strictEqual((yield* mayAct(agent.caller))?.id, orchestrator.id);
          // What a handoff does to the record: the hosting generation moves on.
          const sql = yield* SqlClient.SqlClient;
          yield* sql`
            UPDATE automation_orchestrators SET host_generation = host_generation + 1
            WHERE orchestrator_id = ${orchestrator.id}
          `;
          assert.strictEqual((yield* mayAct(agent.caller).pipe(Effect.flip)).code, "NOT_OWNER");
          yield* release;
          yield* journal.untilTurnsFinished(1);
        }).pipe(Effect.provide(makeAutomationLayer())),
      ),
    TIMEOUT,
  );

  it.effect(
    "a restarted runtime revokes the credentials the previous one left behind",
    () =>
      withEngine("agent-credential-restart", ({ provider }) =>
        Effect.gen(function* () {
          const { agent, release } = yield* orchestratorInTurn(provider).pipe(
            Effect.provide(makeAutomationLayer()),
          );
          // A new process: it never issued that session, so it must not honour it.
          yield* Effect.gen(function* () {
            const runtime = yield* OrchestratorRuntime.OrchestratorRuntime;
            yield* runtime.start();
            yield* runtime.drain;
            assert.strictEqual(
              (yield* callerOfToken(agent.token).pipe(Effect.exit))._tag,
              "Failure",
            );
            assert.strictEqual(
              (yield* mayAct(agent.caller).pipe(Effect.flip)).code,
              "PERMISSION_DENIED",
            );
          }).pipe(Effect.provide(makeAutomationLayer()));
          yield* release;
        }),
      ),
    TIMEOUT,
  );

  it.effect(
    "refuses to take a turn on a provider whose agent cannot be given the credential",
    () =>
      withEngine("agent-provider-unsupported", ({ provider }) =>
        Effect.gen(function* () {
          const service = yield* OrchestratorService.OrchestratorService;
          const runtime = yield* OrchestratorRuntime.OrchestratorRuntime;
          yield* runtime.start();
          const orchestrator = yield* service.upsert(
            operator,
            orchestratorInput({
              modelSelection: { instanceId: unsupportedInstanceId, model: "gpt-5.4" },
            }),
          );
          yield* send(orchestrator.id, "Do something.");
          yield* runtime.drain;
          assert.strictEqual((yield* Ref.get(provider.turns)).length, 0);
          assert.deepStrictEqual(yield* inboxStatuses(orchestrator.id), ["pending"]);
          const shown = yield* describeOrchestrator(orchestrator.id);
          assert.strictEqual(shown.effectiveState, "error");
          assert.include(shown.stateReason ?? "", "CAPABILITY_UNSUPPORTED");
          assert.include(shown.stateReason ?? "", "opencode");
          assert.include(shown.stateReason ?? "", unsupportedInstanceId);
          // Asking again changes nothing: still no turn, still pending.
          yield* runtime.wake(orchestrator.id);
          yield* runtime.drain;
          assert.strictEqual((yield* Ref.get(provider.turns)).length, 0);
          assert.deepStrictEqual(yield* inboxStatuses(orchestrator.id), ["pending"]);
        }).pipe(Effect.provide(makeAutomationLayer())),
      ),
    TIMEOUT,
  );
});

describe("orchestrator agent profile", () => {
  it.effect(
    "each turn runs with the configured profile: its routed model and its instructions",
    () =>
      withEngine(
        "agent-profile-applied",
        ({ provider, journal }) =>
          Effect.gen(function* () {
            const { release } = yield* orchestratorInTurn(provider, { profile: "deep" });
            const turn = (yield* Ref.get(provider.turns))[0]!;
            assert.strictEqual(turn.model, "gpt-5.5");
            assert.include(turn.text, "Weigh every option before deciding.");
            assert.include(turn.text, "Start.");
            yield* release;
            yield* journal.untilTurnsFinished(1);
          }).pipe(Effect.provide(makeAutomationLayer())),
        {
          settings: {
            agentProfiles: [
              profile({
                routes: [
                  {
                    id: "route-1",
                    instanceId: modelSelection.instanceId,
                    modelCandidates: ["gpt-5.5"],
                  },
                ],
              }),
            ],
          },
        },
      ),
    TIMEOUT,
  );

  it.effect(
    "without a profile the turn keeps the thread's own model",
    () =>
      withEngine("agent-profile-none", ({ provider, journal }) =>
        Effect.gen(function* () {
          const { release } = yield* orchestratorInTurn(provider);
          assert.strictEqual((yield* Ref.get(provider.turns))[0]!.model, "gpt-5.4");
          yield* release;
          yield* journal.untilTurnsFinished(1);
        }).pipe(Effect.provide(makeAutomationLayer())),
      ),
    TIMEOUT,
  );

  const refusedProfiles = [
    {
      name: "that no longer exists",
      settings: { agentProfiles: [] },
      expected: "no longer exists",
    },
    {
      name: "that is disabled",
      settings: { agentProfiles: [profile({ enabled: false })] },
      expected: "disabled",
    },
    {
      name: "with no model candidate on the thread's provider",
      settings: {
        agentProfiles: [
          profile({
            routes: [
              {
                id: "route-1",
                instanceId: modelSelection.instanceId,
                modelCandidates: ["not-installed"],
              },
            ],
          }),
        ],
      },
      expected: "not-installed",
    },
  ];
  it.effect.each(refusedProfiles)(
    "a profile $name starts no turn and leaves the inbox pending",
    (scenario) =>
      withEngine(
        `agent-profile-refused-${scenario.expected}`,
        ({ provider }) =>
          Effect.gen(function* () {
            const service = yield* OrchestratorService.OrchestratorService;
            const runtime = yield* OrchestratorRuntime.OrchestratorRuntime;
            yield* runtime.start();
            const orchestrator = yield* service.upsert(
              operator,
              orchestratorInput({ profile: "deep" }),
            );
            yield* send(orchestrator.id, "Decide.");
            yield* runtime.drain;
            assert.strictEqual((yield* Ref.get(provider.turns)).length, 0);
            assert.deepStrictEqual(yield* inboxStatuses(orchestrator.id), ["pending"]);
            const shown = yield* describeOrchestrator(orchestrator.id);
            assert.strictEqual(shown.effectiveState, "error");
            assert.include(shown.stateReason ?? "", "#deep");
            assert.include(shown.stateReason ?? "", scenario.expected);
          }).pipe(Effect.provide(makeAutomationLayer())),
        { settings: scenario.settings },
      ),
    TIMEOUT,
  );

  it.effect(
    "a profile that only routes another provider instance leaves this thread's model alone",
    () =>
      withEngine(
        "agent-profile-other-route",
        ({ provider, journal }) =>
          Effect.gen(function* () {
            const { release } = yield* orchestratorInTurn(provider, { profile: "deep" });
            const turn = (yield* Ref.get(provider.turns))[0]!;
            assert.strictEqual(turn.model, "gpt-5.4");
            assert.include(turn.text, "Weigh every option before deciding.");
            yield* release;
            yield* journal.untilTurnsFinished(1);
          }).pipe(Effect.provide(makeAutomationLayer())),
        {
          settings: {
            agentProfiles: [
              profile({
                routes: [
                  { id: "route-1", instanceId: otherInstanceId, modelCandidates: ["gpt-5.5"] },
                ],
              }),
            ],
          },
        },
      ),
    TIMEOUT,
  );
});
