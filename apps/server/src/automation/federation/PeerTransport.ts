import {
  AUTOMATION_WS_METHODS,
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthFederationPeerScope,
  AuthTokenExchangeGrantType,
  AutomationError,
  EnvironmentHttpApi,
  type EnvironmentId,
  type PeerDeliverInput,
  type PeerDeliverResult,
  type PeerHelloInput,
  type PeerHelloResult,
} from "@t3tools/contracts";
import { encodeOAuthScope } from "@t3tools/shared/oauthScope";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { HttpClient } from "effect/unstable/http";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import { fetchEnvironmentDescriptor, openEnvironmentRpc } from "../../cli/environmentRpc.ts";

/**
 * `unauthorized` means the peer refused the credential itself; `unreachable`
 * covers everything from DNS to a dropped socket and is always worth retrying.
 */
export class PeerTransportError extends Schema.TaggedError<PeerTransportError>()(
  "PeerTransportError",
  {
    reason: Schema.Literals(["unreachable", "unauthorized"]),
    origin: Schema.String,
  },
) {
  override get message(): string {
    return this.reason === "unauthorized"
      ? `${this.origin} refused this environment's peer credential.`
      : `Could not reach the peer at ${this.origin}.`;
  }
}

export interface PeerDescriptor {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly automation: boolean;
  readonly federationProtocolVersions: ReadonlyArray<number>;
}

/** One open link to a peer. Any failed call means the link is gone: open a new one. */
export interface PeerLink {
  readonly hello: (
    input: PeerHelloInput,
  ) => Effect.Effect<PeerHelloResult, AutomationError | PeerTransportError>;
  readonly deliver: (
    input: PeerDeliverInput,
  ) => Effect.Effect<PeerDeliverResult, AutomationError | PeerTransportError>;
}

/**
 * The network boundary of federation. The first version dials the peer's own
 * HTTP origin, so the peer must be directly reachable (LAN, Tailscale) or
 * behind a tunnel the operator already runs; there is no relay.
 */
export class PeerTransport extends Context.Service<
  PeerTransport,
  {
    readonly describe: (httpBaseUrl: string) => Effect.Effect<PeerDescriptor, PeerTransportError>;
    /** Trades a one-time pairing credential for a session holding only the federation scope. */
    readonly exchangePairing: (
      httpBaseUrl: string,
      credential: string,
    ) => Effect.Effect<string, PeerTransportError>;
    readonly open: (
      httpBaseUrl: string,
      token: string,
    ) => Effect.Effect<PeerLink, PeerTransportError, Scope.Scope>;
  }
>()("t3/automation/federation/PeerTransport") {}

const isAutomationError = Schema.is(AutomationError);

/** A 401/403 from the peer, as opposed to a network failure. */
const refusedCredential = (cause: unknown): boolean => {
  const seen = new Set<unknown>();
  for (let current = cause; Predicate.isObject(current) && !seen.has(current);) {
    seen.add(current);
    const tag = "_tag" in current ? current._tag : undefined;
    // The peer's typed HTTP and RPC errors all carry an `Environment…` tag; an
    // internal error or a failed connection says nothing about the credential.
    if (
      typeof tag === "string" &&
      tag.startsWith("Environment") &&
      tag !== "EnvironmentInternalError" &&
      tag !== "EnvironmentServerConnectError"
    ) {
      return true;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
};

const transportError = (origin: string) => (cause: unknown) =>
  new PeerTransportError({
    reason: refusedCredential(cause) ? "unauthorized" : "unreachable",
    origin,
  });

const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const provideHttp = Effect.provideService(HttpClient.HttpClient, httpClient);

  const describe: PeerTransport["Service"]["describe"] = (httpBaseUrl) =>
    fetchEnvironmentDescriptor(httpBaseUrl).pipe(
      provideHttp,
      Effect.map((descriptor) => ({
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        automation: descriptor.capabilities.automation === true,
        federationProtocolVersions: descriptor.capabilities.federationProtocolVersions ?? [],
      })),
      Effect.mapError(transportError(httpBaseUrl)),
    );

  const exchangePairing: PeerTransport["Service"]["exchangePairing"] = (httpBaseUrl, credential) =>
    Effect.gen(function* () {
      const http = yield* HttpApiClient.make(EnvironmentHttpApi, { baseUrl: httpBaseUrl });
      const result = yield* http.auth.token({
        headers: {},
        payload: {
          grant_type: AuthTokenExchangeGrantType,
          subject_token: credential,
          subject_token_type: AuthEnvironmentBootstrapTokenType,
          requested_token_type: AuthAccessTokenType,
          scope: encodeOAuthScope([AuthFederationPeerScope]),
          client_label: "t3 peer",
          client_device_type: "bot",
        },
      });
      return result.access_token;
    }).pipe(
      provideHttp,
      // A pairing link that does not grant the federation scope is refused here.
      Effect.mapError(transportError(httpBaseUrl)),
    );

  const open: PeerTransport["Service"]["open"] = (httpBaseUrl, token) =>
    openEnvironmentRpc(httpBaseUrl, token).pipe(
      provideHttp,
      Effect.mapError(transportError(httpBaseUrl)),
      Effect.map((client): PeerLink => {
        const mapError = Effect.mapError((cause: unknown) =>
          isAutomationError(cause) ? cause : transportError(httpBaseUrl)(cause),
        );
        return {
          hello: (input) => client[AUTOMATION_WS_METHODS.peerHello](input).pipe(mapError),
          deliver: (input) => client[AUTOMATION_WS_METHODS.peerDeliver](input).pipe(mapError),
        };
      }),
    );

  return PeerTransport.of({ describe, exchangePairing, open });
});

/** Needs an `HttpClient`, which the server runtime already provides. */
export const layer = Layer.effect(PeerTransport, make);
