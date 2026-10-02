import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthStandardClientScopes,
  AuthTokenExchangeGrantType,
  EnvironmentHttpApi,
  WsRpcGroup,
} from "@t3tools/contracts";
import { encodeOAuthScope } from "@t3tools/shared/oauthScope";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { Flag, GlobalFlag } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

import packageJson from "../../package.json" with { type: "json" };
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { baseDirFlag, resolveCliAuthConfig } from "./config.ts";

const makeWsRpcClient = RpcClient.make(WsRpcGroup);
export type EnvironmentRpcClient =
  typeof makeWsRpcClient extends Effect.Effect<infer Client, any, any> ? Client : never;

const makeFlatWsRpcClient = RpcClient.make(WsRpcGroup, { flatten: true });
export type FlatEnvironmentRpcClient =
  typeof makeFlatWsRpcClient extends Effect.Effect<infer Client, any, any> ? Client : never;

export class EnvironmentServerNotRunningError extends Schema.TaggedError<EnvironmentServerNotRunningError>()(
  "EnvironmentServerNotRunningError",
  { statePath: Schema.String },
) {
  override get message(): string {
    return "No running T3 Code server found. Start the desktop app or run `t3`, or pass --env <name> to use a saved environment.";
  }
}

export class EnvironmentServerConnectError extends Schema.TaggedError<EnvironmentServerConnectError>()(
  "EnvironmentServerConnectError",
  { origin: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not connect to the T3 Code server at ${this.origin}. If its access was revoked, add the environment again with \`t3 env add\`.`;
  }
}

export class EnvironmentNotFoundError extends Schema.TaggedError<EnvironmentNotFoundError>()(
  "EnvironmentNotFoundError",
  { environment: Schema.String, known: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return this.known.length === 0
      ? `No environment named '${this.environment}'. Add one with \`t3 env add\`.`
      : `No environment named '${this.environment}'. Saved environments: ${this.known.join(", ")}.`;
  }
}

// ---------------------------------------------------------------------------
// Saved environments

/**
 * A remote server the CLI can drive. The token is a bearer session on that
 * server (from pairing or `t3 auth session issue`), so the record lives in the
 * secret store rather than in plain config.
 */
export const SavedEnvironment = Schema.Struct({
  name: Schema.String,
  label: Schema.String,
  environmentId: Schema.String,
  httpBaseUrl: Schema.String,
  token: Schema.String,
  addedAt: Schema.String,
});
export type SavedEnvironment = typeof SavedEnvironment.Type;

const SavedEnvironmentsDocument = Schema.fromJsonString(
  Schema.Struct({ version: Schema.Literal(1), environments: Schema.Array(SavedEnvironment) }),
);
const decodeSavedEnvironments = Schema.decodeUnknownEffect(SavedEnvironmentsDocument);
const encodeSavedEnvironments = Schema.encodeEffect(SavedEnvironmentsDocument);

const SAVED_ENVIRONMENTS_SECRET = "cli-environments";

export const readSavedEnvironments = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const raw = yield* secrets.get(SAVED_ENVIRONMENTS_SECRET);
  if (Option.isNone(raw)) return [] as ReadonlyArray<SavedEnvironment>;
  const document = yield* decodeSavedEnvironments(new TextDecoder().decode(raw.value));
  return document.environments;
});

export const writeSavedEnvironments = (environments: ReadonlyArray<SavedEnvironment>) =>
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const encoded = yield* encodeSavedEnvironments({ version: 1, environments });
    yield* secrets.set(SAVED_ENVIRONMENTS_SECRET, new TextEncoder().encode(encoded));
  });

/** Exchanges a one-time pairing credential for a long-lived bearer session. */
export const exchangePairingCredential = (httpBaseUrl: string, credential: string) =>
  Effect.gen(function* () {
    const http = yield* HttpApiClient.make(EnvironmentHttpApi, { baseUrl: httpBaseUrl });
    const result = yield* http.auth.token({
      headers: {},
      payload: {
        grant_type: AuthTokenExchangeGrantType,
        subject_token: credential,
        subject_token_type: AuthEnvironmentBootstrapTokenType,
        requested_token_type: AuthAccessTokenType,
        scope: encodeOAuthScope(AuthStandardClientScopes),
        client_label: "t3 cli",
        client_device_type: "bot",
      },
    });
    return result.access_token;
  }).pipe(
    Effect.mapError((cause) => new EnvironmentServerConnectError({ origin: httpBaseUrl, cause })),
  );

/** Reads the environment's public descriptor (id and label). */
export const fetchEnvironmentDescriptor = (httpBaseUrl: string) =>
  Effect.gen(function* () {
    const http = yield* HttpApiClient.make(EnvironmentHttpApi, { baseUrl: httpBaseUrl });
    return yield* http.metadata.descriptor();
  }).pipe(
    Effect.mapError((cause) => new EnvironmentServerConnectError({ origin: httpBaseUrl, cause })),
  );

// ---------------------------------------------------------------------------
// Connection

/**
 * `--env <name>` picks a saved remote environment; without it commands target
 * the server on this machine. `T3CODE_ENV` sets the default for a shell or an
 * agent session.
 */
export const environmentFlag = Flag.String("env").pipe(
  Flag.withDescription(
    "Saved environment to target (see `t3 env list`). Default: the server on this machine.",
  ),
  Flag.withFallbackConfig(Config.String("T3CODE_ENV")),
  Flag.optional,
);

export const environmentTargetFlags = { baseDir: baseDirFlag, env: environmentFlag } as const;

export interface EnvironmentTargetFlags {
  readonly baseDir: Option.Option<string>;
  readonly env: Option.Option<string>;
}

function webSocketUrl(origin: string, ticket: string): string {
  const url = new URL("/ws", origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("wsTicket", ticket);
  url.searchParams.set("clientSurface", "cli");
  url.searchParams.set("clientAppVersion", packageJson.version);
  return url.toString();
}

/** Opens the RPC socket using `token` and builds a client over it. */
const openSocket = <Client>(
  origin: string,
  token: string,
  makeClient: Effect.Effect<Client, never, RpcClient.Protocol | Scope.Scope>,
) =>
  Effect.gen(function* () {
    const http = yield* HttpApiClient.make(EnvironmentHttpApi, { baseUrl: origin });
    const { ticket } = yield* http.auth
      .webSocketTicket({ headers: { authorization: `Bearer ${token}` } })
      .pipe(Effect.mapError((cause) => new EnvironmentServerConnectError({ origin, cause })));
    // Build the protocol into the caller's scope: providing the layer directly
    // would close the socket as soon as the client is constructed.
    const protocol = yield* Layer.build(
      RpcClient.layerProtocolSocket({ retryTransientErrors: false }).pipe(
        Layer.provide(
          Socket.layerWebSocket(webSocketUrl(origin, ticket)).pipe(
            Layer.provide(NodeSocket.layerWebSocketConstructorWS),
          ),
        ),
        Layer.provide(RpcSerialization.layerJson),
      ),
    );
    return yield* makeClient.pipe(Effect.provide(protocol));
  });

const connectEnvironment = <Client, A, E, R>(
  flags: EnvironmentTargetFlags,
  makeClient: Effect.Effect<Client, never, RpcClient.Protocol | Scope.Scope>,
  use: (client: Client) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveCliAuthConfig({ baseDir: flags.baseDir }, logLevel);
    const runtime = Layer.mergeAll(EnvironmentAuth.runtimeLayer, ServerSecretStore.layer).pipe(
      Layer.provideMerge(FetchHttpClient.layer),
      Layer.provide(ServerConfig.layer(config)),
      Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
    );

    if (Option.isSome(flags.env)) {
      const name = flags.env.value;
      return yield* Effect.gen(function* () {
        const saved = yield* readSavedEnvironments;
        const environment = saved.find((entry) => entry.name === name);
        if (environment === undefined) {
          return yield* new EnvironmentNotFoundError({
            environment: name,
            known: saved.map((entry) => entry.name),
          });
        }
        return yield* Effect.scoped(
          Effect.flatMap(openSocket(environment.httpBaseUrl, environment.token, makeClient), use),
        );
      }).pipe(Effect.provide(runtime));
    }

    // The local server: mint a short-lived session from the local auth store
    // and revoke it on exit, so no credential outlives the command.
    const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
    if (Option.isNone(runtimeState)) {
      return yield* new EnvironmentServerNotRunningError({
        statePath: config.serverRuntimeStatePath,
      });
    }
    const origin = runtimeState.value.origin;
    return yield* Effect.gen(function* () {
      const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
      return yield* Effect.acquireUseRelease(
        environmentAuth.issueSession({ scopes: AuthStandardClientScopes, label: "t3 cli" }),
        (issued) =>
          Effect.scoped(Effect.flatMap(openSocket(origin, issued.token, makeClient), use)),
        (issued) =>
          environmentAuth.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
      );
    }).pipe(Effect.provide(runtime));
  });

/**
 * Runs `use` with a WebSocket RPC client for the target environment — the
 * same RPC surface the web and mobile clients use, so commands get identical
 * server behavior (turn bootstrap, worktrees, setup scripts, terminals).
 */
export const withEnvironmentRpc = <A, E, R>(
  flags: EnvironmentTargetFlags,
  use: (client: EnvironmentRpcClient) => Effect.Effect<A, E, R>,
) => connectEnvironment(flags, makeWsRpcClient, use);

/** Like `withEnvironmentRpc`, but with a client that takes the method tag at runtime. */
export const withFlatEnvironmentRpc = <A, E, R>(
  flags: EnvironmentTargetFlags,
  use: (client: FlatEnvironmentRpcClient) => Effect.Effect<A, E, R>,
) => connectEnvironment(flags, makeFlatWsRpcClient, use);

/** Runs `use` with the CLI's secret store, for managing saved environments. */
export const withSavedEnvironmentStore = <A, E, R>(
  flags: { readonly baseDir: Option.Option<string> },
  use: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveCliAuthConfig({ baseDir: flags.baseDir }, logLevel);
    return yield* use.pipe(
      Effect.provide(
        ServerSecretStore.layer.pipe(
          Layer.provideMerge(FetchHttpClient.layer),
          Layer.provide(ServerConfig.layer(config)),
          Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
        ),
      ),
    );
  });
