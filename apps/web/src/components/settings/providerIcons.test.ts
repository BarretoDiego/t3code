import { describe, expect, it } from "vite-plus/test";

import { PROVIDER_ICON_CHOICES, resolveProviderIconChoice } from "../providerIcons";

describe("providerIcons registry", () => {
  it("exposes unique keyed icon choices", () => {
    expect(PROVIDER_ICON_CHOICES.length).toBeGreaterThan(10);
    expect(new Set(PROVIDER_ICON_CHOICES.map((choice) => choice.key)).size).toBe(
      PROVIDER_ICON_CHOICES.length,
    );
    expect(resolveProviderIconChoice("kimi")?.label).toBe("Kimi");
    expect(resolveProviderIconChoice("nope")).toBeNull();
    expect(resolveProviderIconChoice(undefined)).toBeNull();
  });
});
