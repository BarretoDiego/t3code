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
import * as Duration from "effect/Duration";
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
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
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

/**
 * The origin of the server that owns this base dir. The persisted runtime
 * state is the primary record, but it can be missing (an older server that
 * shared the base dir cleared it on exit) or stale, so the desktop app's
 * default port is tried as well. A candidate only counts when its descriptor
 * reports this base dir's environment id: the session minted locally is only
 * valid there.
 */
const findLocalServer = Effect.fn("cli.findLocalServer")(function* (
  config: ServerConfig.ServerConfig["Service"],
) {
  const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const environmentId = yield* identity.getEnvironmentId;
  const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath).pipe(
    Effect.orElseSucceed(() => Option.none()),
  );
  const candidates = [
    ...Option.toArray(Option.map(runtimeState, (state) => state.origin)),
    `http://127.0.0.1:${ServerConfig.DEFAULT_PORT}`,
  ].filter((origin, index, all) => all.indexOf(origin) === index);
  for (const origin of candidates) {
    const descriptor = yield* fetchEnvironmentDescriptor(origin).pipe(
      Effect.timeout(Duration.seconds(2)),
      Effect.option,
    );
    if (Option.isSome(descriptor) && descriptor.value.environmentId === environmentId) {
      return origin;
    }
  }
  return yield* new EnvironmentServerNotRunningError({ statePath: config.serverRuntimeStatePath });
});

/** Where a command's target lives and a bearer token that is valid there. */
interface EnvironmentTarget {
  readonly origin: string;
  readonly token: string;
  readonly saved: Option.Option<SavedEnvironment>;
}

/** Runs `use` with the services that reach environments: local auth, saved environments, HTTP. */
export const withEnvironmentRuntime = <A, E, R>(
  flags: { readonly baseDir: Option.Option<string> },
  use: (config: ServerConfig.ServerConfig["Service"]) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveCliAuthConfig({ baseDir: flags.baseDir }, logLevel);
    return yield* use(config).pipe(
      Effect.provide(
        Layer.mergeAll(EnvironmentAuth.runtimeLayer, ServerSecretStore.layer).pipe(
          Layer.provideMerge(FetchHttpClient.layer),
          Layer.provide(ServerConfig.layer(config)),
          Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
        ),
      ),
    );
  });

export const findSavedEnvironment = Effect.fn("cli.findSavedEnvironment")(function* (name: string) {
  const saved = yield* readSavedEnvironments;
  const environment = saved.find((entry) => entry.name === name);
  if (environment === undefined) {
    return yield* new EnvironmentNotFoundError({
      environment: name,
      known: saved.map((entry) => entry.name),
    });
  }
  return environment;
});

/**
 * Runs `use` against the server on this machine. The session is minted from
 * the local auth store and revoked on exit, so no credential outlives the
 * command.
 */
export const withLocalEnvironmentTarget = <A, E, R>(
  config: ServerConfig.ServerConfig["Service"],
  use: (target: EnvironmentTarget) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const origin = yield* findLocalServer(config);
    const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
    return yield* Effect.acquireUseRelease(
      environmentAuth.issueSession({ scopes: AuthStandardClientScopes, label: "t3 cli" }),
      (issued) => use({ origin, token: issued.token, saved: Option.none() }),
      (issued) =>
        environmentAuth.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
    );
  });

/** Runs `use` with the origin and credential of the environment the flags select. */
export const withEnvironmentTarget = <A, E, R>(
  flags: EnvironmentTargetFlags,
  use: (target: EnvironmentTarget) => Effect.Effect<A, E, R>,
) =>
  withEnvironmentRuntime(flags, (config) =>
    Effect.gen(function* () {
      if (Option.isNone(flags.env)) return yield* withLocalEnvironmentTarget(config, use);
      const environment = yield* findSavedEnvironment(flags.env.value);
      return yield* use({
        origin: environment.httpBaseUrl,
        token: environment.token,
        saved: Option.some(environment),
      });
    }),
  );

/** Opens the typed RPC socket of the server at `origin`; it closes with the scope. */
export const openEnvironmentRpc = (origin: string, token: string) =>
  openSocket(origin, token, makeWsRpcClient);

const connectEnvironment = <Client, A, E, R>(
  flags: EnvironmentTargetFlags,
  makeClient: Effect.Effect<Client, never, RpcClient.Protocol | Scope.Scope>,
  use: (client: Client) => Effect.Effect<A, E, R>,
) =>
  withEnvironmentTarget(flags, (target) =>
    Effect.scoped(Effect.flatMap(openSocket(target.origin, target.token, makeClient), use)),
  );

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
