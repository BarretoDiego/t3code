import {
  AiRuntimeError,
  type AiRuntimeConfig,
  type AiRuntimeModel,
  type AiRuntimeOperation,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

export interface AiRuntimeDriver {
  readonly discover: (
    config: AiRuntimeConfig,
    apiKey: string,
  ) => Effect.Effect<
    {
      status: "available" | "unavailable" | "authentication-required";
      version: string | null;
      models: readonly AiRuntimeModel[];
    },
    AiRuntimeError
  >;
  readonly manageModel?: (
    config: AiRuntimeConfig,
    apiKey: string,
    action: "pull" | "remove-model",
    model: string,
    report: (
      progress: Pick<AiRuntimeOperation, "message" | "completed" | "total">,
    ) => Effect.Effect<void>,
  ) => Effect.Effect<void, AiRuntimeError>;
}

export function normalizeRuntimeUrl(value: string): string {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Use an HTTP(S) base URL without credentials, query, or fragment.");
  }
  return url.href.replace(/\/+$/, "");
}
export function isLoopbackRuntimeUrl(value: string): boolean {
  const hostname = new URL(value).hostname;
  return hostname === "localhost" || hostname === "[::1]" || hostname.startsWith("127.");
}
const Tags = Schema.Struct({ models: Schema.Array(Schema.Struct({ name: Schema.String })) });
const Version = Schema.Struct({ version: Schema.String });
const Show = Schema.Struct({ capabilities: Schema.optionalKey(Schema.Array(Schema.String)) });
const Models = Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) });
const Progress = Schema.Struct({
  status: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
  completed: Schema.optionalKey(Schema.Number),
  total: Schema.optionalKey(Schema.Number),
});

const decodeProgress = Schema.decodeUnknownEffect(Schema.fromJsonString(Progress));

export function ollamaCapabilities(
  capabilities: readonly string[] | undefined,
): AiRuntimeModel["capabilities"] {
  const mapping = {
    completion: "text",
    vision: "vision",
    tools: "tools",
    thinking: "reasoning",
    embedding: "embeddings",
  } as const;
  return Object.entries(mapping).flatMap(([key, value]) =>
    capabilities?.includes(key) ? [value] : [],
  );
}

export const makeEndpointDriver = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const request = Effect.fn("AiRuntimeDriver.request")(function* (
    config: AiRuntimeConfig,
    key: string,
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
  ) {
    let req = HttpClientRequest.make(method)(
      `${normalizeRuntimeUrl(config.listenOnTailnet && config.networkBaseUrl ? config.networkBaseUrl : config.baseUrl)}${path}`,
    );
    if (key && config.authentication !== "none")
      req = HttpClientRequest.setHeader(
        req,
        config.authentication === "api-key" ? "x-api-key" : "authorization",
        config.authentication === "api-key" ? key : `Bearer ${key}`,
      );
    if (config.protocol === "anthropic")
      req = HttpClientRequest.setHeader(req, "anthropic-version", "2023-06-01");
    if (body !== undefined) req = HttpClientRequest.bodyJsonUnsafe(req, body);
    return yield* client.execute(req);
  });
  const discover: AiRuntimeDriver["discover"] = Effect.fn("AiRuntimeDriver.discover")(
    function* (config, key) {
      // Custom and transcription endpoints have no universal model catalog API.
      if (config.protocol === "custom" || config.protocol === "transcription") {
        return {
          status: "unavailable" as const,
          version: null,
          models: config.configuredModels.map((id) => ({
            id,
            capabilities: [],
            capabilitiesKnown: false,
          })),
        };
      }
      const response = yield* request(
        config,
        key,
        "GET",
        config.protocol === "ollama"
          ? "/api/tags"
          : config.protocol === "anthropic" && !config.baseUrl.endsWith("/v1")
            ? "/v1/models"
            : "/models",
      );
      if (response.status === 401 || response.status === 403)
        return { status: "authentication-required" as const, version: null, models: [] };
      if (response.status < 200 || response.status >= 300)
        return { status: "unavailable" as const, version: null, models: [] };
      if (config.protocol !== "ollama") {
        const result = yield* HttpClientResponse.schemaBodyJson(Models)(response);
        return {
          status: "available" as const,
          version: null,
          models: [...new Set(result.data.map((m) => m.id))].map((id) => ({
            id,
            capabilities: [],
            capabilitiesKnown: false,
          })),
        };
      }
      const tags = yield* HttpClientResponse.schemaBodyJson(Tags)(response);
      const versionResponse = yield* request(config, key, "GET", "/api/version");
      const version = yield* HttpClientResponse.schemaBodyJson(Version)(versionResponse);
      const models = yield* Effect.forEach(
        [...new Set(tags.models.map((m) => m.name))],
        (id) =>
          request(config, key, "POST", "/api/show", { model: id }).pipe(
            Effect.flatMap(HttpClientResponse.schemaBodyJson(Show)),
            Effect.map((show) => ({
              id,
              capabilities: ollamaCapabilities(show.capabilities),
              capabilitiesKnown: show.capabilities !== undefined,
            })),
            Effect.catch(() => Effect.succeed({ id, capabilities: [], capabilitiesKnown: false })),
          ),
        { concurrency: 3 },
      );
      return { status: "available" as const, version: version.version, models };
    },
    Effect.timeout("15 seconds"),
    Effect.catch(() =>
      Effect.succeed({ status: "unavailable" as const, version: null, models: [] }),
    ),
  );

  const manageModel: NonNullable<AiRuntimeDriver["manageModel"]> = Effect.fn(
    "AiRuntimeDriver.manageModel",
  )(
    function* (config, key, action, model, report) {
      if (config.protocol !== "ollama")
        return yield* new AiRuntimeError({
          message: "Model management requires Ollama native compatibility.",
        });
      const response = yield* request(
        config,
        key,
        action === "pull" ? "POST" : "DELETE",
        action === "pull" ? "/api/pull" : "/api/delete",
        { model, stream: true },
      );
      if (response.status < 200 || response.status >= 300)
        return yield* new AiRuntimeError({
          message: `Runtime rejected model management (HTTP ${response.status}).`,
        });
      if (action === "remove-model") return;
      let succeeded = false;
      let lastReport = -Infinity;
      yield* response.stream.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.filter((line) => line.trim().length > 0),
        Stream.mapEffect((line) => decodeProgress(line)),
        Stream.runForEach((value) =>
          Effect.gen(function* () {
            if (value.error)
              return yield* new AiRuntimeError({
                message: "Ollama could not pull this model. Check its name and runtime storage.",
              });
            if (value.status === "success") succeeded = true;
            const now = yield* Clock.currentTimeMillis;
            if (!succeeded && now - lastReport < 250) return;
            lastReport = now;
            yield* report({
              message: value.status ?? "Pulling model",
              completed: value.completed ?? 0,
              total: value.total ?? null,
            });
          }),
        ),
      );
      if (!succeeded)
        return yield* new AiRuntimeError({
          message: "The model download ended before Ollama confirmed success.",
        });
    },
    Effect.timeout("2 hours"),
    Effect.mapError(
      () =>
        new AiRuntimeError({
          message:
            "Model operation failed. Check the runtime, model name, authentication, and storage.",
        }),
    ),
  );
  return { discover, manageModel } satisfies AiRuntimeDriver;
});
