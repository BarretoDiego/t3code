import { expect, it } from "@effect/vitest";
import { Tool } from "effect/unstable/ai";

import { ComputeToolkit } from "./tools.ts";

it("exports the generic compute tool surface with object input schemas", () => {
  expect(Object.keys(ComputeToolkit.tools)).toEqual([
    "compute.listProviders",
    "compute.listCapabilities",
    "compute.listModels",
    "compute.submit",
    "compute.getJob",
    "compute.cancelJob",
  ]);
  for (const tool of Object.values(ComputeToolkit.tools)) {
    const schema = Tool.getJsonSchema(tool);
    expect(schema, `${tool.name} must expose an input schema`).toBeTypeOf("object");
    expect(tool.description?.length ?? 0).toBeGreaterThan(40);
  }
});
