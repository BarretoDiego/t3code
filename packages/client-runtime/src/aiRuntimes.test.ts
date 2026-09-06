import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, type AiRuntime } from "@t3tools/contracts";
import { runtimeAvailability, runtimeForConsumer, runtimeIdentity } from "./aiRuntimes.ts";
const runtime: AiRuntime = {
  id: "ollama-local",
  environmentId: EnvironmentId.make("gpu"),
  name: "GPU",
  runtimeKind: "ollama",
  protocol: "ollama",
  baseUrl: "http://127.0.0.1:11434",
  networkBaseUrl: "http://100.100.1.1:11434",
  authentication: "bearer",
  configuredModels: [],
  source: "discovered",
  installation: "external",
  ownedProcess: false,
  status: "available",
  version: "1",
  models: [],
  checkedAt: null,
  hasApiKey: true,
  operation: null,
};
describe("network runtime projection", () => {
  it("makes cached runtimes unavailable when their node disconnects and available on reconnect", () => {
    expect(runtimeAvailability(runtime, true)).toEqual({ available: true, label: "Local only" });
    expect(runtimeAvailability(runtime, false).available).toBe(false);
    expect(runtimeAvailability(runtime, true).available).toBe(true);
    expect(runtimeAvailability({ ...runtime, status: "authentication-required" }, true).label).toBe(
      "Authentication required",
    );
  });
  it("does not claim that an advertised network address was verified by another node", () => {
    expect(runtimeAvailability(runtime, true).label).toBe("Local only");
    expect(runtimeAvailability({ ...runtime, listenOnTailnet: true }, true).label).toContain(
      "Available from this node",
    );
    expect(
      runtimeAvailability({ ...runtime, baseUrl: runtime.networkBaseUrl! }, true).label,
    ).toContain("Available from this node");
  });
  it("imports an explicit address and origin identity without credentials or cached status", () => {
    const imported = runtimeForConsumer(runtime, "remote-gpu");
    expect(imported.baseUrl).toBe(runtime.networkBaseUrl);
    expect(imported.origin).toEqual({ environmentId: "gpu", runtimeId: "ollama-local" });
    expect(imported).not.toHaveProperty("hasApiKey");
    expect(imported).not.toHaveProperty("status");
    expect(runtimeIdentity(imported, EnvironmentId.make("consumer"))).toBe("consumer/remote-gpu");
    const { networkBaseUrl: _networkBaseUrl, ...localRuntime } = runtime;
    expect(() => runtimeForConsumer(localRuntime, "remote")).toThrow();
  });
});
