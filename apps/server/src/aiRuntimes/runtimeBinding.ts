import {
  AiRuntimeError,
  ProviderDriverKind,
  type AiRuntimeConfig,
  type AiRuntimeBindInput,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import { normalizeRuntimeUrl } from "./AiRuntimeDriver.ts";

/** Produces ordinary provider settings; credentials continue through the existing secret pipeline. */
export function runtimeProviderConfig(
  runtime: AiRuntimeConfig,
  input: AiRuntimeBindInput,
  apiKey: string,
): ProviderInstanceConfig {
  const root = normalizeRuntimeUrl(
    runtime.listenOnTailnet && runtime.networkBaseUrl ? runtime.networkBaseUrl : runtime.baseUrl,
  );
  const openai = runtime.protocol === "ollama" ? `${root}/v1` : root;
  const key = apiKey || (runtime.authentication === "none" ? "ollama" : "");
  const variable = (name: string, value: string, sensitive = false) => ({ name, value, sensitive });
  const common = {
    driver: ProviderDriverKind.make(input.driver),
    displayName: `${input.driver === "claudeAgent" ? "Claude Code" : input.driver === "opencode" ? "OpenCode" : "Codex"} · ${runtime.name}`,
    enabled: true,
  };
  if (
    input.driver === "opencode" &&
    (runtime.protocol === "ollama" || runtime.protocol === "openai")
  ) {
    const model = `t3runtime/${input.model}`;
    return {
      ...common,
      config: { customModels: [model] },
      environment: [
        variable("T3_RUNTIME_API_KEY", key, true),
        variable(
          "OPENCODE_CONFIG_CONTENT",
          JSON.stringify({
            model,
            provider: {
              t3runtime: {
                npm: "@ai-sdk/openai-compatible",
                name: runtime.name,
                options: {
                  baseURL: openai,
                  apiKey: "{env:T3_RUNTIME_API_KEY}",
                  ...(runtime.authentication === "api-key"
                    ? { headers: { "x-api-key": "{env:T3_RUNTIME_API_KEY}" } }
                    : {}),
                },
                models: { [input.model]: { name: input.model } },
              },
            },
          }),
        ),
      ],
    };
  }
  if (
    input.driver === "codex" &&
    (runtime.protocol === "ollama" || runtime.protocol === "openai")
  ) {
    const options = {
      model_provider: "t3runtime",
      model: input.model,
      "model_providers.t3runtime.name": runtime.name,
      "model_providers.t3runtime.base_url": openai,
      "model_providers.t3runtime.env_key": "T3_RUNTIME_API_KEY",
      "model_providers.t3runtime.wire_api": "responses",
      ...(runtime.authentication === "api-key"
        ? { "model_providers.t3runtime.env_http_headers.x-api-key": "T3_RUNTIME_API_KEY" }
        : {}),
    };
    return {
      ...common,
      config: {
        customModels: [input.model],
        launchArgs: Object.entries(options)
          .flatMap(([name, value]) => ["-c", JSON.stringify(`${name}=${JSON.stringify(value)}`)])
          .join(" "),
      },
      environment: [variable("T3_RUNTIME_API_KEY", key, true)],
    };
  }
  if (
    input.driver === "claudeAgent" &&
    (runtime.protocol === "ollama" || runtime.protocol === "anthropic")
  ) {
    return {
      ...common,
      config: { customModels: [input.model] },
      environment: [
        variable("ANTHROPIC_BASE_URL", root),
        variable("ANTHROPIC_AUTH_TOKEN", runtime.authentication === "api-key" ? "" : key, true),
        variable(
          "ANTHROPIC_API_KEY",
          runtime.authentication === "api-key" ? key : "",
          runtime.authentication === "api-key",
        ),
        ...[
          "ANTHROPIC_MODEL",
          "ANTHROPIC_DEFAULT_OPUS_MODEL",
          "ANTHROPIC_DEFAULT_SONNET_MODEL",
          "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        ].map((name) => variable(name, input.model)),
        variable("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1"),
      ],
    };
  }
  throw new AiRuntimeError({
    message:
      "This harness does not support the selected runtime compatibility. Codex requires the Responses API; Claude Code requires Anthropic Messages.",
  });
}
