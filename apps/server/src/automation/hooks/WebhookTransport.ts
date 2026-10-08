// @effect-diagnostics nodeBuiltinImport:off - Name resolution has no Effect platform service.
import * as NodeDnsPromises from "node:dns/promises";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

class WebhookTransportError extends Schema.TaggedError<WebhookTransportError>()(
  "WebhookTransportError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

/** The network boundary of webhook delivery: name resolution and one POST. */
export class WebhookTransport extends Context.Service<
  WebhookTransport,
  {
    /** Every address the host name resolves to. */
    readonly resolve: (
      hostname: string,
    ) => Effect.Effect<ReadonlyArray<string>, WebhookTransportError>;
    /** Sends the request once. A redirect is returned as its status, never followed. */
    readonly post: (request: {
      readonly url: string;
      readonly headers: Readonly<Record<string, string>>;
      readonly body: string;
    }) => Effect.Effect<
      { readonly status: number; readonly location: string | null },
      WebhookTransportError
    >;
  }
>()("t3/automation/hooks/WebhookTransport") {}

const make = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  return WebhookTransport.of({
    resolve: (hostname) =>
      Effect.tryPromise({
        try: () => NodeDnsPromises.lookup(hostname, { all: true }),
        catch: () => new WebhookTransportError({ reason: `Could not resolve ${hostname}.` }),
      }).pipe(Effect.map((addresses) => addresses.map((entry) => entry.address))),
    post: (request) =>
      client
        .execute(
          HttpClientRequest.post(request.url).pipe(
            HttpClientRequest.setHeaders(request.headers),
            HttpClientRequest.bodyText(request.body, "application/json"),
          ),
        )
        .pipe(
          Effect.map((response) => ({
            status: response.status,
            location: response.headers.location ?? null,
          })),
          Effect.scoped,
          Effect.mapError(
            () => new WebhookTransportError({ reason: "The webhook request did not complete." }),
          ),
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        ),
  });
});

export const layer = Layer.effect(WebhookTransport, make).pipe(
  Layer.provide(FetchHttpClient.layer),
);
