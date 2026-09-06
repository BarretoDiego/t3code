import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import {
  type AiRuntimeConfig,
  CodexSettings,
  ClaudeSettings,
  OpenCodeSettings,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import { makeEndpointDriver, normalizeRuntimeUrl, ollamaCapabilities } from "./AiRuntimeDriver.ts";
import { runtimeProviderConfig } from "./runtimeBinding.ts";

const decodeCodex = Schema.decodeUnknownSync(CodexSettings);
const decodeClaude = Schema.decodeUnknownSync(ClaudeSettings);
const decodeOpenCode = Schema.decodeUnknownSync(OpenCodeSettings);
const config: AiRuntimeConfig = {
  id: "test",
  name: "GPU's runtime",
  runtimeKind: "ollama",
  protocol: "ollama",
  baseUrl: "http://127.0.0.1:11434",
  authentication: "none",
  configuredModels: [],
};
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const withHttp = (respond: (url: string, headers: Readonly<Record<string, string>>) => Response) =>
  Effect.provideService(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => HttpClientResponse.fromWeb(request, respond(request.url, request.headers))),
    ),
  );

describe("runtime endpoint discovery", () => {
  it.effect("discovers live version and deduplicated models with verified capabilities", () =>
    Effect.gen(function* () {
      const driver = yield* makeEndpointDriver;
      const result = yield* driver.discover(config, "");
      expect(result.version).toBe("0.33.3");
      expect(result.models).toEqual([
        {
          id: "fixture-model",
          capabilities: ["text", "tools", "reasoning"],
          capabilitiesKnown: true,
        },
      ]);
    }).pipe(
      withHttp(
        (url) =>
          new Response(
            json(
              url.endsWith("/api/version")
                ? { version: "0.33.3" }
                : url.endsWith("/api/show")
                  ? { capabilities: ["completion", "tools", "thinking"] }
                  : { models: [{ name: "fixture-model" }, { name: "fixture-model" }] },
            ),
          ),
      ),
    ),
  );
  for (const status of [401, 403, 404, 503])
    it.effect(`reports HTTP ${status} without trusting cached models`, () =>
      Effect.gen(function* () {
        const driver = yield* makeEndpointDriver;
        const result = yield* driver.discover(config, "");
        expect(result.status).toBe(
          status === 401 || status === 403 ? "authentication-required" : "unavailable",
        );
        expect(result.models).toEqual([]);
      }).pipe(withHttp(() => new Response("", { status }))),
    );
  it.effect("parses OpenAI models and sends credentials only in headers", () =>
    Effect.gen(function* () {
      const driver = yield* makeEndpointDriver;
      const result = yield* driver.discover(
        {
          ...config,
          protocol: "openai",
          baseUrl: "https://runtime.test/v1",
          authentication: "bearer",
        },
        "private-key",
      );
      expect(result.models).toEqual([{ id: "custom", capabilities: [], capabilitiesKnown: false }]);
    }).pipe(
      withHttp((url, headers) => {
        expect(url).toBe("https://runtime.test/v1/models");
        expect(headers.authorization).toBe("Bearer private-key");
        return new Response(json({ data: [{ id: "custom" }] }));
      }),
    ),
  );
  it.effect("rejects malformed model responses", () =>
    Effect.gen(function* () {
      const driver = yield* makeEndpointDriver;
      expect((yield* driver.discover(config, "")).status).toBe("unavailable");
    }).pipe(withHttp(() => new Response("not json"))),
  );
  it.effect("refreshes an authoritative empty model list", () =>
    Effect.gen(function* () {
      const driver = yield* makeEndpointDriver;
      expect((yield* driver.discover(config, "")).models).toEqual([]);
    }).pipe(
      withHttp(
        (url) =>
          new Response(json(url.endsWith("/api/version") ? { version: "1" } : { models: [] })),
      ),
    ),
  );
  it.effect("requires terminal success from a streaming pull", () =>
    Effect.gen(function* () {
      const driver = yield* makeEndpointDriver;
      const progress: string[] = [];
      yield* driver.manageModel(config, "", "pull", "fixture-model", (value) =>
        Effect.sync(() => {
          progress.push(value.message);
        }),
      );
      expect(progress).toEqual(["downloading", "success"]);
    }).pipe(
      withHttp(
        () =>
          new Response('{"status":"downloading","completed":1,"total":2}\n{"status":"success"}\n'),
      ),
    ),
  );
  it.effect("rejects an interrupted pull response", () =>
    Effect.gen(function* () {
      const driver = yield* makeEndpointDriver;
      const outcome = yield* driver
        .manageModel(config, "", "pull", "fixture-model", () => Effect.void)
        .pipe(Effect.result);
      expect(outcome._tag).toBe("Failure");
    }).pipe(withHttp(() => new Response('{"status":"downloading"}\n'))),
  );
  it("keeps unknown capabilities unknown", () => {
    expect(ollamaCapabilities(undefined)).toEqual([]);
    expect(ollamaCapabilities(["future-feature"])).toEqual([]);
  });
  it("rejects credentials, fragments, and unsupported URL schemes", () => {
    for (const value of [
      "file:///tmp/runtime",
      "https://user:key@host",
      "https://host?api_key=secret",
      "https://host#secret",
      "invalid",
    ])
      expect(() => normalizeRuntimeUrl(value)).toThrow();
    expect(normalizeRuntimeUrl("http://host:11434/")).toBe("http://host:11434");
  });
});

describe("agent runtime binding", () => {
  const input = {
    runtimeId: "test",
    instanceId: ProviderInstanceId.make("bound"),
    model: 'model with "quotes"',
  };
  it("creates schema-valid OpenCode config with secret interpolation", () => {
    const result = runtimeProviderConfig(config, { ...input, driver: "opencode" }, "private-key");
    const decoded = decodeOpenCode(result.config);
    expect(decoded.customModels).toEqual([`t3runtime/${input.model}`]);
    const content = result.environment?.find((v) => v.name === "OPENCODE_CONFIG_CONTENT")?.value;
    expect(content).toContain("{env:T3_RUNTIME_API_KEY}");
    expect(content).not.toContain("private-key");
    expect(result.environment?.find((v) => v.name === "T3_RUNTIME_API_KEY")?.sensitive).toBe(true);
  });
  it("creates schema-valid Codex launch overrides that survive argument parsing", () => {
    const result = runtimeProviderConfig(config, { ...input, driver: "codex" }, "private-key");
    const decoded = decodeCodex(result.config);
    expect(tokenizeCliArgs(decoded.launchArgs)).toContain(`model=${JSON.stringify(input.model)}`);
    expect(tokenizeCliArgs(decoded.launchArgs)).toContain(
      'model_providers.t3runtime.wire_api="responses"',
    );
    expect(decoded.launchArgs).not.toContain("private-key");
  });
  it("creates schema-valid Claude configuration without inherited API authentication", () => {
    const result = runtimeProviderConfig(
      config,
      { ...input, driver: "claudeAgent" },
      "private-key",
    );
    expect(decodeClaude(result.config).customModels).toEqual([input.model]);
    expect(result.environment).toContainEqual({
      name: "ANTHROPIC_API_KEY",
      value: "",
      sensitive: false,
    });
    expect(result.environment).toContainEqual({
      name: "ANTHROPIC_AUTH_TOKEN",
      value: "private-key",
      sensitive: true,
    });
  });
  it("rejects unsupported protocol/harness combinations", () => {
    expect(() =>
      runtimeProviderConfig(
        { ...config, protocol: "transcription" },
        { ...input, driver: "opencode" },
        "",
      ),
    ).toThrow();
    expect(() =>
      runtimeProviderConfig(
        { ...config, protocol: "openai" },
        { ...input, driver: "claudeAgent" },
        "",
      ),
    ).toThrow();
  });
});
