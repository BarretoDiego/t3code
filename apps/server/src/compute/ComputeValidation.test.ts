import { expect, it } from "@effect/vitest";
import {
  type ComputeProviderSnapshot,
  type GenerationRequest,
  type ParameterDefinition,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import {
  normalizeGenerationRequest,
  validCapabilityCatalog,
  validateProviderConfiguration,
} from "./ComputeValidation.ts";

const provider = { id: "p", name: "Provider", type: "fixture", configuration: {} };
const request: GenerationRequest = {
  capability: "custom.execute",
  operation: "execute",
  parameters: {},
};
const destination = (parameters: readonly ParameterDefinition[]): ComputeProviderSnapshot => ({
  provider: { ...provider, status: "online" },
  models: [],
  capabilities: [
    {
      id: "custom.execute",
      category: "custom",
      operations: ["execute"],
      models: [
        {
          id: "m",
          name: "Model",
          status: "available",
          operations: ["execute"],
          parameters,
          presets: [{ id: "preset", label: "Preset", parameters: { count: 4 } }],
        },
      ],
    },
  ],
});

it.effect("validates parameters and merges defaults, preset and explicit overrides in order", () =>
  Effect.gen(function* () {
    const normalized = yield* normalizeGenerationRequest(
      { ...request, preset: "preset", parameters: { count: 6 } },
      destination([
        {
          id: "count",
          label: "Count",
          type: "integer",
          required: true,
          default: 2,
          min: 0,
          max: 10,
          step: 2,
        },
        { id: "enabled", label: "Enabled", type: "boolean", default: false },
      ]),
    );
    expect(normalized.parameters).toEqual({ count: 6, enabled: false });
    expect(normalized.model).toBe("m");
  }),
);

it.effect("rejects invalid types, range, increments, missing and unknown parameters", () =>
  Effect.gen(function* () {
    const target = destination([
      { id: "count", label: "Count", type: "integer", required: true, min: 0, max: 10, step: 2 },
    ]);
    for (const parameters of [
      {},
      { count: "2" },
      { count: 1.5 },
      { count: -2 },
      { count: 12 },
      { count: 3 },
      { count: 2, undeclared: true },
    ]) {
      const result = yield* Effect.flip(
        normalizeGenerationRequest({ ...request, parameters }, target),
      );
      expect(result.code).toBe("parameter-invalid");
    }
    expect(
      (yield* Effect.flip(normalizeGenerationRequest({ ...request, preset: "unknown" }, target)))
        .code,
    ).toBe("preset-invalid");
  }),
);

it.effect(
  "supports structured selections and input artifact references without runtime-specific knobs",
  () =>
    Effect.gen(function* () {
      const target = destination([
        {
          id: "choice",
          label: "Choice",
          type: "select",
          options: [{ label: "Structured", value: { mode: 2 } }],
        },
        {
          id: "choices",
          label: "Choices",
          type: "multiselect",
          options: [{ label: "A", value: "a" }],
        },
        { id: "source", label: "Source", type: "image" },
        { id: "payload", label: "Payload", type: "json" },
      ]);
      const input = {
        ...request,
        inputs: [{ id: "image", uri: "attachment:fixture", mimeType: "image/png" }],
        parameters: {
          choice: { mode: 2 },
          choices: ["a"],
          source: "image",
          payload: { nested: true },
        },
      };
      expect((yield* normalizeGenerationRequest(input, target)).parameters).toEqual(
        input.parameters,
      );
      expect(
        (yield* Effect.flip(
          normalizeGenerationRequest(
            { ...input, parameters: { ...input.parameters, source: "missing" } },
            target,
          ),
        )).code,
      ).toBe("parameter-invalid");
    }),
);

it.effect("rejects inline secrets, unsafe endpoints and secret paths", () =>
  Effect.gen(function* () {
    for (const invalid of [
      { ...provider, configuration: { nested: { api_key: "do-not-store" } } },
      { ...provider, endpoint: "https://user:password@service.example" },
      { ...provider, endpoint: "https://service.example?token=secret" },
      { ...provider, authentication: { type: "token", secretRef: "../session" } },
      { ...provider, nodeId: "node", execution: { kind: "managed" as const } },
    ])
      expect((yield* Effect.flip(validateProviderConfiguration(invalid))).code).toBeDefined();
    expect(
      (yield* validateProviderConfiguration({
        ...provider,
        authentication: { type: "workload-identity" },
      })).authentication,
    ).toEqual({ type: "workload-identity" });
  }),
);

it("rejects duplicate capability and parameter ids and malformed declarations", () => {
  const capabilities = destination([
    { id: "count", label: "Count", type: "number", min: 10, max: 1 },
  ]).capabilities;
  expect(validCapabilityCatalog(capabilities)).toBe(false);
  const valid = destination([]).capabilities;
  expect(validCapabilityCatalog(valid)).toBe(true);
  expect(validCapabilityCatalog([...valid, ...valid])).toBe(false);
});
