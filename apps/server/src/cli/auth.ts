import {
  AuthAdministrativeScopes,
  AuthSessionId,
  AuthStandardClientScopes,
  EnvironmentHttpApi,
  EnvironmentScopeRequiredError,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";

import {
  formatIssuedPairingCredential,
  formatIssuedSession,
  formatPairingCredentialList,
  formatSessionList,
} from "../cliAuthFormat.ts";
import * as ServerConfig from "../config.ts";
import { authScopesFlag } from "./authScopes.ts";
import {
  authLocationFlags,
  type CliAuthLocationFlags,
  DurationFromString,
  resolveCliAuthConfig,
} from "./config.ts";
import { environmentFlag, withEnvironmentTarget } from "./environmentRpc.ts";

export class RemoteAuthError extends Schema.TaggedError<RemoteAuthError>()("RemoteAuthError", {
  environment: Schema.String,
  missingScope: Schema.optional(Schema.String),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return this.missingScope === undefined
      ? `Environment '${this.environment}' rejected the request.`
      : `The credential saved for '${this.environment}' lacks the ${this.missingScope} scope. Managing access needs an administrative token: run \`t3 auth session issue\` on that machine, then \`t3 env add ${this.environment} <url> --token <token>\` here.`;
  }
}

const isScopeRequiredError = Schema.is(EnvironmentScopeRequiredError);
const makeEnvironmentApi = (origin: string) =>
  HttpApiClient.make(EnvironmentHttpApi, { baseUrl: origin });
type EnvironmentAuthApi = Effect.Success<ReturnType<typeof makeEnvironmentApi>>["auth"];

/**
 * Runs an access-management request on the saved environment `environment`
 * through its HTTP API, the same one the Connections settings use.
 */
const runWithRemoteAuth = <A, E, R>(
  flags: { readonly baseDir: Option.Option<string> },
  environment: string,
  run: (input: {
    readonly auth: EnvironmentAuthApi;
    readonly headers: { readonly authorization: string };
    readonly origin: string;
  }) => Effect.Effect<A, E, R>,
) =>
  withEnvironmentTarget({ baseDir: flags.baseDir, env: Option.some(environment) }, (target) =>
    Effect.gen(function* () {
      const api = yield* makeEnvironmentApi(target.origin);
      return yield* run({
        auth: api.auth,
        headers: { authorization: `Bearer ${target.token}` },
        origin: target.origin,
      });
    }).pipe(
      Effect.mapError(
        (cause) =>
          new RemoteAuthError({
            environment,
            ...(isScopeRequiredError(cause) ? { missingScope: cause.requiredScope } : {}),
            cause,
          }),
      ),
    ),
  );

const authEnvironmentFlag = environmentFlag.pipe(
  Flag.withDescription(
    "Manage access on this saved environment instead of this machine (see `t3 env list`).",
  ),
);

const runWithEnvironmentAuth = <A, E>(
  flags: CliAuthLocationFlags,
  run: (environmentAuth: EnvironmentAuth.EnvironmentAuth["Service"]) => Effect.Effect<A, E>,
  options?: {
    readonly quietLogs?: boolean;
  },
) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveCliAuthConfig(flags, logLevel);
    const minimumLogLevel = options?.quietLogs ? "Error" : config.logLevel;
    return yield* Effect.gen(function* () {
      const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
      return yield* run(environmentAuth);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(EnvironmentAuth.layerRuntime).pipe(
          Layer.provide(ServerConfig.layer(config)),
          Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
        ),
      ),
    );
  });

const ttlFlag = Flag.String("ttl").pipe(
  Flag.withSchema(DurationFromString),
  Flag.withDescription("TTL, for example `5m`, `1h`, `30d`, or `15 minutes`."),
  Flag.optional,
);

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

const labelFlag = Flag.String("label").pipe(
  Flag.withDescription("Optional human-readable label."),
  Flag.optional,
);

const subjectFlag = Flag.String("subject").pipe(
  Flag.withDescription("Optional session subject."),
  Flag.optional,
);

const baseUrlFlag = Flag.String("base-url").pipe(
  Flag.withDescription("Optional public base URL used to print a ready `/pair#token=...` link."),
  Flag.optional,
);

const tokenOnlyFlag = Flag.Boolean("token-only").pipe(
  Flag.withDescription("Print only the issued bearer token."),
  Flag.withDefault(false),
);

const pairingCreateCommand = Command.make("create", {
  ...authLocationFlags,
  env: authEnvironmentFlag,
  scopes: authScopesFlag(AuthStandardClientScopes),
  ttl: ttlFlag,
  label: labelFlag,
  baseUrl: baseUrlFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Issue a new client pairing token."),
  Command.withHandler((flags) =>
    Option.isSome(flags.env)
      ? runWithRemoteAuth(flags, flags.env.value, ({ auth, headers, origin }) =>
          Effect.gen(function* () {
            if (Option.isSome(flags.ttl)) {
              yield* Console.error(
                "--ttl is ignored with --env: the environment sets the lifetime of links created remotely.",
              );
            }
            const issued = yield* auth.pairingCredential({
              headers,
              payload: {
                scopes: flags.scopes,
                ...(Option.isSome(flags.label) ? { label: flags.label.value } : {}),
              },
            });
            yield* Console.log(
              formatIssuedPairingCredential(
                {
                  ...issued,
                  scopes: flags.scopes,
                  subject: "one-time-token",
                  createdAt: yield* DateTime.now,
                },
                { json: flags.json, baseUrl: Option.getOrElse(flags.baseUrl, () => origin) },
              ),
            );
          }),
        )
      : runWithEnvironmentAuth(
          flags,
          (environmentAuth) =>
            Effect.gen(function* () {
              const issued = yield* environmentAuth.createPairingLink({
                scopes: flags.scopes,
                subject: "one-time-token",
                ...(Option.isSome(flags.ttl) ? { ttl: flags.ttl.value } : {}),
                ...(Option.isSome(flags.label) ? { label: flags.label.value } : {}),
              });
              const output = formatIssuedPairingCredential(issued, {
                json: flags.json,
                ...(Option.isSome(flags.baseUrl) ? { baseUrl: flags.baseUrl.value } : {}),
              });
              yield* Console.log(output);
            }),
          {
            quietLogs: flags.json,
          },
        ),
  ),
);

const pairingListCommand = Command.make("list", {
  ...authLocationFlags,
  env: authEnvironmentFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("List active client pairing tokens without revealing their secrets."),
  Command.withHandler((flags) =>
    Option.isSome(flags.env)
      ? runWithRemoteAuth(flags, flags.env.value, ({ auth, headers }) =>
          Effect.flatMap(auth.pairingLinks({ headers }), (pairingLinks) =>
            Console.log(formatPairingCredentialList(pairingLinks, { json: flags.json })),
          ),
        )
      : runWithEnvironmentAuth(
          flags,
          (environmentAuth) =>
            Effect.gen(function* () {
              const pairingLinks = yield* environmentAuth.listPairingLinks({
                excludeSubjects: [EnvironmentAuth.INTERNAL_ADMINISTRATIVE_BOOTSTRAP_SUBJECT],
              });
              yield* Console.log(formatPairingCredentialList(pairingLinks, { json: flags.json }));
            }),
          {
            quietLogs: flags.json,
          },
        ),
  ),
);

const pairingRevokeCommand = Command.make("revoke", {
  ...authLocationFlags,
  env: authEnvironmentFlag,
  id: Argument.String("id").pipe(Argument.withDescription("Pairing credential id to revoke.")),
}).pipe(
  Command.withDescription("Revoke an active client pairing token."),
  Command.withHandler((flags) => {
    const report = (revoked: boolean) =>
      Console.log(
        revoked
          ? `Revoked pairing credential ${flags.id}.\n`
          : `No active pairing credential found for ${flags.id}.\n`,
      );
    return Option.isSome(flags.env)
      ? runWithRemoteAuth(flags, flags.env.value, ({ auth, headers }) =>
          Effect.flatMap(auth.revokePairingLink({ headers, payload: { id: flags.id } }), (result) =>
            report(result.revoked),
          ),
        )
      : runWithEnvironmentAuth(flags, (environmentAuth) =>
          Effect.flatMap(environmentAuth.revokePairingLink(flags.id), report),
        );
  }),
);

const pairingCommand = Command.make("pairing").pipe(
  Command.withDescription("Manage one-time client pairing tokens."),
  Command.withSubcommands([pairingCreateCommand, pairingListCommand, pairingRevokeCommand]),
);

const sessionIssueCommand = Command.make("issue", {
  ...authLocationFlags,
  scopes: authScopesFlag(AuthAdministrativeScopes),
  ttl: ttlFlag,
  label: labelFlag,
  subject: subjectFlag,
  tokenOnly: tokenOnlyFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Issue a scoped bearer access token for headless or remote clients."),
  Command.withHandler((flags) =>
    runWithEnvironmentAuth(
      flags,
      (environmentAuth) =>
        Effect.gen(function* () {
          const issued = yield* environmentAuth.issueSession({
            scopes: flags.scopes,
            ...(Option.isSome(flags.ttl) ? { ttl: flags.ttl.value } : {}),
            ...(Option.isSome(flags.label) ? { label: flags.label.value } : {}),
            ...(Option.isSome(flags.subject) ? { subject: flags.subject.value } : {}),
          });
          yield* Console.log(
            formatIssuedSession(issued, {
              json: flags.json,
              tokenOnly: flags.tokenOnly,
            }),
          );
        }),
      {
        quietLogs: flags.json || flags.tokenOnly,
      },
    ),
  ),
);

const sessionListCommand = Command.make("list", {
  ...authLocationFlags,
  env: authEnvironmentFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("List active sessions without revealing bearer tokens."),
  Command.withHandler((flags) =>
    Option.isSome(flags.env)
      ? runWithRemoteAuth(flags, flags.env.value, ({ auth, headers }) =>
          Effect.flatMap(auth.clients({ headers }), (sessions) =>
            Console.log(formatSessionList(sessions, { json: flags.json })),
          ),
        )
      : runWithEnvironmentAuth(
          flags,
          (environmentAuth) =>
            Effect.gen(function* () {
              const sessions = yield* environmentAuth.listSessions();
              yield* Console.log(formatSessionList(sessions, { json: flags.json }));
            }),
          {
            quietLogs: flags.json,
          },
        ),
  ),
);

const sessionRevokeCommand = Command.make("revoke", {
  ...authLocationFlags,
  env: authEnvironmentFlag,
  sessionId: Argument.String("session-id").pipe(
    Argument.withDescription("Session id to revoke."),
    Argument.withSchema(AuthSessionId),
  ),
}).pipe(
  Command.withDescription("Revoke an active session."),
  Command.withHandler((flags) => {
    const report = (revoked: boolean) =>
      Console.log(
        revoked
          ? `Revoked session ${flags.sessionId}.\n`
          : `No active session found for ${flags.sessionId}.\n`,
      );
    return Option.isSome(flags.env)
      ? runWithRemoteAuth(flags, flags.env.value, ({ auth, headers }) =>
          Effect.flatMap(
            auth.revokeClient({ headers, payload: { sessionId: flags.sessionId } }),
            (result) => report(result.revoked),
          ),
        )
      : runWithEnvironmentAuth(flags, (environmentAuth) =>
          Effect.flatMap(environmentAuth.revokeSession(flags.sessionId), report),
        );
  }),
);

const sessionCommand = Command.make("session").pipe(
  Command.withDescription("Manage bearer sessions."),
  Command.withSubcommands([sessionIssueCommand, sessionListCommand, sessionRevokeCommand]),
);

export const authCommand = Command.make("auth").pipe(
  Command.withDescription(
    "Manage pairing links and sessions for this machine's server, or a saved environment with --env.",
  ),
  Command.withSubcommands([pairingCommand, sessionCommand]),
);
