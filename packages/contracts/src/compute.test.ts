import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  ComputeCapability,
  ComputeProviderConfig,
  ComputeResources,
  GenerationRequest,
  ParameterDefinition,
} from "./compute.ts";

const decodeParameter = Schema.decodeUnknownSync(ParameterDefinition);
const decodeProvider = Schema.decodeUnknownSync(ComputeProviderConfig);
const decodeCapability = Schema.decodeUnknownSync(ComputeCapability);
const decodeRequest = Schema.decodeUnknownSync(GenerationRequest);
const decodeResources = Schema.decodeUnknownSync(ComputeResources);

it("rejects non-finite and negative resource telemetry", () => {
  for (const available of [-1, Infinity, NaN])
    expect(() => decodeResources({ memory: { available } })).toThrow();
  expect(decodeResources({ memory: { available: 0 } })).toEqual({ memory: { available: 0 } });
});

it("accepts provider-defined dynamic parameter schemas without core-specific ids", () => {
  const parameter = decodeParameter({
    id: "worker-private-knob",
    label: "Worker private knob",
    type: "select",
    default: "balanced",
    options: [
      { label: "Balanced", value: "balanced" },
      { label: "Experimental", value: { profile: 7 } },
    ],
    visibleWhen: { mode: "advanced" },
  });
  expect(parameter.id).toBe("worker-private-knob");
  expect(parameter.options?.[1]?.value).toEqual({ profile: 7 });
});

it("accepts cloud execution without a node or static credentials", () => {
  const cloud = decodeProvider({
    id: "cloud",
    name: "Managed cloud",
    type: "future-cloud-driver",
    execution: {
      kind: "managed",
      service: "vendor-service",
      region: "region-a",
      project: "cloud-project",
    },
    authentication: { type: "workload-identity" },
    configuration: {},
  });
  expect(cloud.nodeId).toBeUndefined();
  expect(cloud.authentication).toEqual({ type: "workload-identity" });
  expect(cloud.execution?.project).toBe("cloud-project");
});

it("preserves extensible modality, operation, and artifact input identifiers", () => {
  const capability = decodeCapability({
    id: "volumetric.reconstruct",
    category: "volumetric",
    operations: ["reconstruct"],
  });
  const request = decodeRequest({
    capability: capability.id,
    operation: "reconstruct",
    parameters: { opaque: true },
    inputs: [{ id: "source", uri: "memory://source", mimeType: "application/octet-stream" }],
  });
  expect(request.capability).toBe("volumetric.reconstruct");
  expect(request.inputs?.[0]?.id).toBe("source");
});
