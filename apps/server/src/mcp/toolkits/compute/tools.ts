import {
  ComputeCapability,
  ComputeError,
  ComputeJobCancelInput,
  ComputeJobGetInput,
  ComputeProviderSnapshot,
  GenerationJob,
  GenerationRequest,
  ModelCapability,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import { ComputeService } from "../../../compute/ComputeService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, ComputeService];

const readonlyTool = <T extends Tool.Any>(tool: T): T =>
  tool
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true) as T;

export const ComputeListProvidersTool = readonlyTool(
  Tool.make("compute.listProviders", {
    description:
      "List configured compute providers, connection status, environment/node or managed execution target, cancellation/recovery support, queue depth, and declared resources. Query this before submitting work when the destination matters.",
    parameters: Tool.EmptyParams,
    success: Schema.Array(ComputeProviderSnapshot),
    failure: ComputeError,
    dependencies,
  }).annotate(Tool.Title, "List compute providers"),
);

export const ComputeListCapabilitiesTool = readonlyTool(
  Tool.make("compute.listCapabilities", {
    description:
      "List capabilities currently announced by online or configured compute providers. Capability and operation strings are provider-defined, so inspect this before constructing a request.",
    parameters: Tool.EmptyParams,
    success: Schema.Array(ComputeCapability),
    failure: ComputeError,
    dependencies,
  }).annotate(Tool.Title, "List compute capabilities"),
);

export const ComputeListModelsTool = readonlyTool(
  Tool.make("compute.listModels", {
    description:
      "List provider-announced model capabilities and their declarative parameter schemas, presets, operations, and availability states.",
    parameters: Tool.EmptyParams,
    success: Schema.Array(ModelCapability),
    failure: ComputeError,
    dependencies,
  }).annotate(Tool.Title, "List compute models"),
);

export const ComputeSubmitTool = Tool.make("compute.submit", {
  description:
    "Submit one generic compute generation job. Supply capability, operation, declared parameters, and optional model/preset/provider/node/environment constraints. Managed providers may incur charges; select the intended provider and do not blindly retry an uncertain submission. The job is attached to this thread automatically.",
  parameters: GenerationRequest,
  success: GenerationJob,
  failure: ComputeError,
  dependencies,
})
  .annotate(Tool.Title, "Submit compute job")
  .annotate(Tool.Destructive, false);

export const ComputeGetJobTool = readonlyTool(
  Tool.make("compute.getJob", {
    description:
      "Read a durable compute job by id, including progress, outputs, error, and metrics.",
    parameters: ComputeJobGetInput,
    success: GenerationJob,
    failure: ComputeError,
    dependencies,
  }).annotate(Tool.Title, "Get compute job"),
);

export const ComputeCancelJobTool = Tool.make("compute.cancelJob", {
  description:
    "Request cancellation of a non-terminal compute job. Some managed providers do not support cancellation. An acknowledgement does not mean execution stopped: inspect the returned status and subsequent job updates. Charges may continue until the provider confirms termination.",
  parameters: ComputeJobCancelInput,
  success: GenerationJob,
  failure: ComputeError,
  dependencies,
})
  .annotate(Tool.Title, "Cancel compute job")
  .annotate(Tool.Destructive, true);

export const ComputeToolkit = Toolkit.make(
  ComputeListProvidersTool,
  ComputeListCapabilitiesTool,
  ComputeListModelsTool,
  ComputeSubmitTool,
  ComputeGetJobTool,
  ComputeCancelJobTool,
);
