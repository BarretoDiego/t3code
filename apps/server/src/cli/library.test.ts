import { describe, expect, it } from "vite-plus/test";

import { parseRoute } from "./library.ts";

describe("parseRoute", () => {
  it("reads the instance, ordered fallbacks, and effort", () => {
    expect(parseRoute("codex=gpt-5, gpt-5-mini@high", "r1")).toEqual({
      id: "r1",
      instanceId: "codex",
      modelCandidates: ["gpt-5", "gpt-5-mini"],
      reasoningEffort: "high",
    });
  });

  it("allows a route that only overrides the effort", () => {
    expect(parseRoute("claudeAgent=@low", "r2")).toEqual({
      id: "r2",
      instanceId: "claudeAgent",
      modelCandidates: [],
      reasoningEffort: "low",
    });
  });

  it("rejects input without an instance", () => {
    expect(parseRoute("gpt-5", "r3")).toBeNull();
  });
});
