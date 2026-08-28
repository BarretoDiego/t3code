import { describe, expect, it } from "vite-plus/test";
import type { MarketplaceCatalogEntry } from "@t3tools/contracts";

import {
  groupMarketplacePackagesByType,
  packageTypePluralLabel,
} from "./MarketplaceSettings.logic";

function entry(type: string, id: string): MarketplaceCatalogEntry {
  return {
    sourceId: "t3-official" as MarketplaceCatalogEntry["sourceId"],
    sourceName: "T3 Code Official",
    package: {
      id: id as MarketplaceCatalogEntry["package"]["id"],
      type: type as MarketplaceCatalogEntry["package"]["type"],
      name: id,
      version: "1.0.0" as MarketplaceCatalogEntry["package"]["version"],
      description: "fixture",
      manifest: `./${id}.json`,
      tags: [],
      permissions: [],
    },
    availability: "available",
    installedVersions: [],
    updateAvailable: false,
  };
}

describe("packageTypePluralLabel", () => {
  it("humanizes and pluralizes package types", () => {
    expect(packageTypePluralLabel("provider-template")).toBe("Provider Templates");
    expect(packageTypePluralLabel("skill")).toBe("Skills");
    expect(packageTypePluralLabel("specialist")).toBe("Specialists");
  });
});

describe("groupMarketplacePackagesByType", () => {
  it("orders known categories first and keeps catalog order inside each group", () => {
    const groups = groupMarketplacePackagesByType([
      entry("specialist", "specialist-performance-tuner"),
      entry("skill", "skill-release-notes"),
      entry("provider-template", "claude-kimi"),
      entry("skill", "skill-pr-review"),
      entry("provider-template", "claude-api-key"),
      entry("agent", "agent-security-reviewer"),
    ]);

    expect(groups.map((group) => group.type)).toEqual([
      "provider-template",
      "skill",
      "agent",
      "specialist",
    ]);
    expect(groups[0]?.entries.map(({ package: pkg }) => pkg.id)).toEqual([
      "claude-kimi",
      "claude-api-key",
    ]);
    expect(groups[1]?.entries.map(({ package: pkg }) => pkg.id)).toEqual([
      "skill-release-notes",
      "skill-pr-review",
    ]);
  });

  it("sorts unknown types alphabetically after the known categories", () => {
    const groups = groupMarketplacePackagesByType([
      entry("mcp", "future-mcp"),
      entry("provider-template", "claude-api-key"),
      entry("tool", "future-tool"),
    ]);

    expect(groups.map((group) => group.type)).toEqual(["provider-template", "mcp", "tool"]);
  });

  it("returns no groups for an empty catalog", () => {
    expect(groupMarketplacePackagesByType([])).toEqual([]);
  });
});
