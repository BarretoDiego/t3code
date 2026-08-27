import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  MarketplaceManifest,
  MarketplacePackageManifest,
  MarketplaceSnapshot,
  ProviderTemplatePayload,
} from "./marketplace.ts";

const decodeCatalog = Schema.decodeUnknownSync(MarketplaceManifest);
const decodePackage = Schema.decodeUnknownSync(MarketplacePackageManifest);
const decodeProviderTemplate = Schema.decodeUnknownSync(ProviderTemplatePayload);
const decodeSnapshot = Schema.decodeUnknownSync(MarketplaceSnapshot);

describe("marketplace contracts", () => {
  it("keeps unknown package types discoverable", () => {
    const catalog = decodeCatalog({
      schemaVersion: 1,
      id: "community",
      name: "Community",
      packages: [
        {
          id: "example-skill",
          type: "skill",
          name: "Example skill",
          version: "1.2.3",
          description: "A package type introduced by a future handler.",
          manifest: "./packages/example-skill.json",
        },
      ],
    });

    expect(catalog.packages[0]?.type).toBe("skill");
    expect(catalog.packages[0]?.tags).toEqual([]);
    expect(catalog.packages[0]?.permissions).toEqual([]);
  });

  it("decodes generic package payloads without interpreting them", () => {
    const manifest = decodePackage({
      schemaVersion: 1,
      id: "future-mcp",
      type: "mcp",
      name: "Future MCP",
      version: "2.0.0-beta.1",
      description: "Opaque until an MCP handler is registered.",
      payload: { transport: "stdio", command: ["example", "serve"] },
    });

    expect(manifest.type).toBe("mcp");
    expect(manifest.payload).toEqual({ transport: "stdio", command: ["example", "serve"] });
  });

  it("rejects non-exact package versions and malformed integrity values", () => {
    expect(() =>
      decodeCatalog({
        schemaVersion: 1,
        id: "community",
        name: "Community",
        packages: [
          {
            id: "bad-version",
            type: "skill",
            name: "Bad version",
            version: "^1.0.0",
            description: "Ranges are not package versions.",
            manifest: "./package.json",
            integrity: "sha256-not-a-digest",
          },
        ],
      }),
    ).toThrow();
  });

  it("decodes a declarative provider template with secret input defaults", () => {
    const payload = decodeProviderTemplate({
      driver: "codex",
      suggestedInstanceId: "codex_openrouter",
      displayName: "Codex · OpenRouter",
      inputs: [
        {
          id: "api-key",
          label: "API key",
          control: "password",
          required: true,
        },
        {
          id: "model",
          label: "Model",
          control: "text",
          default: "openai/gpt-5.4",
        },
      ],
      environment: [
        { name: "OPENROUTER_API_KEY", input: "api-key", sensitive: true, required: true },
      ],
      providerHome: {
        configField: "homePath",
        files: [{ path: "config.toml", content: 'model = "{{input.model}}"' }],
      },
    });

    expect(payload.inputs[0]?.required).toBe(true);
    expect(payload.inputs[1]?.required).toBe(false);
    expect(payload.environment[0]?.sensitive).toBe(true);
  });

  it("represents unsupported packages in a snapshot instead of dropping them", () => {
    const snapshot = decodeSnapshot({
      sources: [
        {
          id: "community",
          name: "Community",
          url: "https://example.com/t3-marketplace.json",
          official: false,
          removable: true,
        },
      ],
      packages: [
        {
          sourceId: "community",
          sourceName: "Community",
          package: {
            id: "future-tool",
            type: "tool",
            name: "Future tool",
            version: "1.0.0",
            description: "Not supported by this environment yet.",
            manifest: "./tool.json",
          },
          availability: "unsupported-type",
          installedVersions: [],
          updateAvailable: false,
        },
      ],
      installations: [],
      sourceErrors: [],
    });

    expect(snapshot.packages).toHaveLength(1);
    expect(snapshot.packages[0]?.availability).toBe("unsupported-type");
  });
});
