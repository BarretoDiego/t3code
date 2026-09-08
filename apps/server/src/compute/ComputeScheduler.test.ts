import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type ComputeProviderSnapshot,
  type GenerationRequest,
} from "@t3tools/contracts";

import { selectComputeProvider } from "./ComputeScheduler.ts";

const request: GenerationRequest = {
  capability: "image.generate",
  operation: "generate",
  model: "image-v1",
  parameters: {},
};
const provider = (
  id: string,
  overrides: Partial<ComputeProviderSnapshot> = {},
): ComputeProviderSnapshot => ({
  provider: {
    id,
    name: id,
    type: "fixture",
    status: "online",
    nodeId: `${id}-node`,
    environmentId: EnvironmentId.make("fixture-environment"),
    configuration: {},
  },
  capabilities: [
    {
      id: "image.generate",
      category: "image",
      operations: ["generate"],
      models: [{ id: "image-v1", name: "Image v1", operations: ["generate"], status: "ready" }],
    },
  ],
  models: [],
  queueDepth: 0,
  ...overrides,
});

it("excludes offline and incompatible nodes, then chooses the shortest compatible queue", () => {
  const offline = provider("offline", {
    provider: { ...provider("offline").provider, status: "offline" },
  });
  const incompatible = provider("audio", {
    capabilities: [{ id: "audio.tts.generate", category: "speech", operations: ["generate"] }],
  });
  const busy = provider("busy", { queueDepth: 4 });
  const available = provider("available", { queueDepth: 1 });
  expect(
    selectComputeProvider([offline, incompatible, busy, available], request)?.provider.id,
  ).toBe("available");
});

it("honors an explicit node and prefers a model already loaded", () => {
  const ready = provider("ready");
  const loaded = provider("loaded", {
    capabilities: [
      {
        ...provider("loaded").capabilities[0]!,
        models: [{ id: "image-v1", name: "Image v1", operations: ["generate"], status: "loaded" }],
      },
    ],
  });
  expect(selectComputeProvider([ready, loaded], request)?.provider.id).toBe("loaded");
  expect(
    selectComputeProvider([ready, loaded], { ...request, nodeId: ready.provider.nodeId! })?.provider
      .id,
  ).toBe("ready");
});

it("schedules managed services with no hardware and respects explicit node affinity", () => {
  const managed = provider("cloud", {
    provider: {
      id: "cloud",
      name: "Cloud",
      type: "managed",
      status: "online",
      configuration: {},
      execution: { kind: "managed" },
    },
  });
  expect(selectComputeProvider([managed], request)?.provider.id).toBe("cloud");
  expect(selectComputeProvider([managed], { ...request, nodeId: "node-a" })).toBeUndefined();
  expect(
    selectComputeProvider([managed], { ...request, providerId: "different-account" }),
  ).toBeUndefined();
});

it("does not borrow a model advertised under a different capability", () => {
  const cloud = provider("cloud", {
    capabilities: [
      { id: "image.generate", category: "image", operations: ["generate"] },
      {
        id: "video.generate",
        category: "video",
        operations: ["generate"],
        models: [
          {
            id: "image-v1",
            name: "Different capability model",
            operations: ["generate"],
            status: "available",
          },
        ],
      },
    ],
  });
  expect(selectComputeProvider([cloud], request)).toBeUndefined();
});
