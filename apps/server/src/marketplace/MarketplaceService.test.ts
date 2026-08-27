import { describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  MarketplaceId,
  MarketplaceInputId,
  MarketplaceManifest,
  MarketplacePackageId,
  MarketplacePackageManifest,
  ProviderInstanceId,
  ProviderTemplatePayload,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import {
  MarketplaceService,
  layer as marketplaceLayer,
  marketplacePackageAvailability,
  MARKETPLACE_PACKAGE_HANDLER_TYPES,
  normalizeMarketplaceSourceUrl,
  validateProviderTemplatePermissions,
  validateProviderTemplateInputs,
} from "./MarketplaceService.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";

const decodeTemplate = Schema.decodeUnknownSync(ProviderTemplatePayload);
const decodeMarketplaceJson = Schema.decodeUnknownSync(Schema.fromJsonString(MarketplaceManifest));
const decodePackageManifestJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(MarketplacePackageManifest),
);

describe("official marketplace repository", () => {
  it.effect("publishes valid manifests with matching integrity digests", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const catalogPath = path.resolve(process.cwd(), "t3-marketplace.json");
      const catalog = decodeMarketplaceJson(yield* fileSystem.readFileString(catalogPath));

      expect(catalog.id).toBe("t3-official");
      expect(catalog.packages.length).toBeGreaterThan(0);
      for (const entry of catalog.packages) {
        const manifestPath = path.resolve(process.cwd(), entry.manifest);
        const bytes = yield* fileSystem.readFile(manifestPath);
        const manifest = decodePackageManifestJson(new TextDecoder().decode(bytes));
        expect({ id: manifest.id, type: manifest.type, version: manifest.version }).toEqual({
          id: entry.id,
          type: entry.type,
          version: entry.version,
        });
        expect(entry.integrity).toBe(
          `sha256-${NodeCrypto.createHash("sha256").update(bytes).digest("hex")}`,
        );
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("normalizeMarketplaceSourceUrl", () => {
  it("accepts direct manifests and appends the conventional filename to directories", () => {
    expect(normalizeMarketplaceSourceUrl("https://example.com/catalog.json")).toBe(
      "https://example.com/catalog.json",
    );
    expect(normalizeMarketplaceSourceUrl("https://example.com/community/")).toBe(
      "https://example.com/community/t3-marketplace.json",
    );
  });

  it("normalizes GitHub repository and tree URLs without an API dependency", () => {
    expect(normalizeMarketplaceSourceUrl("https://github.com/acme/t3-packages")).toBe(
      "https://raw.githubusercontent.com/acme/t3-packages/HEAD/t3-marketplace.json",
    );
    expect(
      normalizeMarketplaceSourceUrl(
        "https://github.com/acme/mono/tree/release/catalogs/t3#packages",
      ),
    ).toBe("https://raw.githubusercontent.com/acme/mono/release/catalogs/t3/t3-marketplace.json");
  });

  it("rejects non-HTTP sources", () => {
    expect(normalizeMarketplaceSourceUrl("file:///tmp/catalog.json")).toBeNull();
    expect(normalizeMarketplaceSourceUrl("not a URL")).toBeNull();
  });
});

describe("marketplace package handlers", () => {
  it("marks registered package types available and preserves unknown types", () => {
    expect(MARKETPLACE_PACKAGE_HANDLER_TYPES.has("provider-template")).toBe(true);
    expect(marketplacePackageAvailability("provider-template", undefined, "linux")).toBe(
      "available",
    );
    expect(marketplacePackageAvailability("skill", undefined, "linux")).toBe("unsupported-type");
  });
});

describe("provider template input safety", () => {
  it.effect("requires packages to disclose the effects used by their payload", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        validateProviderTemplatePermissions({
          schemaVersion: 1,
          id: MarketplacePackageId.make("undisclosed-template"),
          type: "provider-template",
          name: "Undisclosed template",
          version: "1.0.0",
          description: "Attempts to configure an environment without disclosure.",
          permissions: ["provider.configure"],
          payload: {
            driver: "codex",
            suggestedInstanceId: "undisclosed_template",
            displayName: "Undisclosed template",
            inputs: [],
            environment: [
              { name: "EXAMPLE_TOKEN", value: "value", sensitive: true, required: true },
            ],
          },
        }),
      );
      expect(failure).toMatchObject({
        reason: "invalid-manifest",
        detail: expect.stringContaining("provider.environment"),
      });
    }),
  );

  it.effect("never persists password values", () =>
    Effect.gen(function* () {
      const payload = decodeTemplate({
        driver: "codex",
        suggestedInstanceId: "codex_openrouter",
        displayName: "Codex · OpenRouter",
        inputs: [
          { id: "api-key", label: "API key", control: "password", required: true },
          { id: "model", label: "Model", control: "text", required: true },
        ],
        environment: [
          { name: "OPENROUTER_API_KEY", input: "api-key", sensitive: true, required: true },
        ],
      });

      const resolved = yield* validateProviderTemplateInputs({
        payload,
        supplied: { "api-key": "sk-secret", model: "openai/gpt-5.4" },
      });

      expect(resolved.values["api-key"]).toBe("sk-secret");
      expect(resolved.persistedValues).toEqual({ model: "openai/gpt-5.4" });
    }),
  );

  it.effect("reuses an existing sensitive environment value during update", () =>
    Effect.gen(function* () {
      const payload = decodeTemplate({
        driver: "claudeAgent",
        suggestedInstanceId: "claude_api",
        displayName: "Claude API",
        inputs: [{ id: "api-key", label: "API key", control: "password", required: true }],
        environment: [
          { name: "ANTHROPIC_API_KEY", input: "api-key", sensitive: true, required: true },
        ],
      });

      const resolved = yield* validateProviderTemplateInputs({
        payload,
        supplied: {},
        existingEnvironment: [
          { name: "ANTHROPIC_API_KEY", value: "existing-secret", sensitive: true },
        ],
      });

      expect(resolved.values["api-key"]).toBe("existing-secret");
      expect(resolved.persistedValues).toEqual({});
    }),
  );

  it.effect("rejects a sensitive input interpolated into generated files", () =>
    Effect.gen(function* () {
      const payload = decodeTemplate({
        driver: "codex",
        suggestedInstanceId: "unsafe_codex",
        displayName: "Unsafe Codex",
        inputs: [{ id: "api-key", label: "API key", control: "password", required: true }],
        environment: [
          { name: "OPENROUTER_API_KEY", input: "api-key", sensitive: true, required: true },
        ],
        providerHome: {
          configField: "homePath",
          files: [{ path: "config.toml", content: 'api_key = "{{input.api-key}}"' }],
        },
      });

      const failure = yield* Effect.flip(
        validateProviderTemplateInputs({ payload, supplied: { "api-key": "sk-secret" } }),
      );
      expect(failure).toMatchObject({ reason: "invalid-manifest" });
    }),
  );

  it.effect("rejects undeclared answers", () =>
    Effect.gen(function* () {
      const payload = decodeTemplate({
        driver: "codex",
        suggestedInstanceId: "codex_clean",
        displayName: "Codex Clean",
        inputs: [],
        environment: [],
      });

      const failure = yield* Effect.flip(
        validateProviderTemplateInputs({ payload, supplied: { surprise: "x" } }),
      );
      expect(failure).toMatchObject({ reason: "invalid-input" });
    }),
  );
});

describe("marketplace provider-template lifecycle", () => {
  it.effect("installs, persists safe state, and uninstalls an isolated provider", () => {
    const catalog = JSON.stringify({
      schemaVersion: 1,
      id: "t3-official",
      name: "T3 Code Official",
      packages: [
        {
          id: "test-codex",
          type: "provider-template",
          name: "Test Codex",
          version: "1.0.0",
          description: "A lifecycle fixture.",
          manifest: "./test-codex.json",
          permissions: ["provider.configure", "provider.environment", "provider.files"],
        },
      ],
    });
    const packageManifest = JSON.stringify({
      schemaVersion: 1,
      id: "test-codex",
      type: "provider-template",
      name: "Test Codex",
      version: "1.0.0",
      description: "A lifecycle fixture.",
      permissions: ["provider.configure", "provider.environment", "provider.files"],
      payload: {
        driver: "codex",
        suggestedInstanceId: "codex_marketplace_test",
        displayName: "Codex Marketplace Test",
        inputs: [
          { id: "api-key", label: "API key", control: "password", required: true },
          {
            id: "model",
            label: "Model",
            control: "text",
            required: true,
            default: "openai/gpt-5.4",
          },
        ],
        config: { customModels: ["{{input.model}}"] },
        environment: [
          { name: "OPENROUTER_API_KEY", input: "api-key", sensitive: true, required: true },
        ],
        providerHome: {
          configField: "homePath",
          files: [{ path: "config.toml", content: 'model = "{{input.model}}"\n' }],
        },
      },
    });
    const httpLayer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(request.url.endsWith("test-codex.json") ? packageManifest : catalog, {
              headers: { "content-type": "application/json" },
            }),
          ),
        ),
      ),
    );
    const dependencies = Layer.mergeAll(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-marketplace-lifecycle-test-" }),
      ServerSettings.layerTest(),
      httpLayer,
    );
    const testLayer = marketplaceLayer.pipe(
      Layer.provideMerge(dependencies),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const marketplace = yield* MarketplaceService;
      const settings = yield* ServerSettings.ServerSettingsService;
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;

      const initial = yield* marketplace.list();
      expect(initial.packages.map(({ package: entry }) => entry.id)).toEqual(["test-codex"]);

      const installed = yield* marketplace.install({
        sourceId: MarketplaceId.make("t3-official"),
        packageId: MarketplacePackageId.make("test-codex"),
        inputs: {
          [MarketplaceInputId.make("api-key")]: "sk-do-not-persist",
          [MarketplaceInputId.make("model")]: "openai/gpt-5.4",
        },
      });
      expect(installed.installations).toHaveLength(1);
      const installation = installed.installations[0]!;
      expect(installation.target).toEqual({
        type: "provider-instance",
        instanceId: "codex_marketplace_test",
      });

      const afterInstall = yield* settings.getSettings;
      const provider =
        afterInstall.providerInstances[ProviderInstanceId.make("codex_marketplace_test")];
      expect(provider).toBeDefined();
      if (!provider) return;
      expect(provider.driver).toBe("codex");
      expect(provider.environment).toEqual([
        { name: "OPENROUTER_API_KEY", value: "sk-do-not-persist", sensitive: true },
      ]);
      const homePath = (provider.config as { readonly homePath?: string }).homePath;
      expect(homePath).toBeTruthy();
      expect(yield* fileSystem.readFileString(`${homePath}/config.toml`)).toBe(
        'model = "openai/gpt-5.4"\n',
      );

      const persistedState = yield* fileSystem.readFileString(config.marketplaceStatePath);
      expect(persistedState).not.toContain("sk-do-not-persist");
      expect(persistedState).toContain("openai/gpt-5.4");

      const removed = yield* marketplace.uninstall(installation.id);
      expect(removed.installations).toEqual([]);
      expect(
        (yield* settings.getSettings).providerInstances[
          ProviderInstanceId.make("codex_marketplace_test")
        ],
      ).toBeUndefined();
      expect(yield* fileSystem.exists(`${config.marketplacePackagesDir}/${installation.id}`)).toBe(
        false,
      );
    }).pipe(Effect.provide(testLayer), Effect.scoped);
  });
});
