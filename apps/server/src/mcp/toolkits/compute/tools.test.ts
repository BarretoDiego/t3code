import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { McpSchema, Tool } from "effect/unstable/ai";

import { ComputeToolkit } from "./tools.ts";

const isMcpToolJsonSchema = Schema.is(McpSchema.ToolJsonSchema);

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
    expect(
      isMcpToolJsonSchema(schema),
      `${tool.name} must expose an MCP-compatible object input schema`,
    ).toBe(true);
    expect(tool.description?.length ?? 0).toBeGreaterThan(40);
  }
});
