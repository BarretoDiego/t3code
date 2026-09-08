import { ComputeError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { ComputeService } from "../../../compute/ComputeService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ComputeToolkit } from "./tools.ts";

export const handlers = {
  "compute.listProviders": () =>
    Effect.gen(function* () {
      yield* McpInvocationContext.requireComputeCapability();
      const compute = yield* ComputeService;
      return (yield* compute.list()).providers;
    }),
  "compute.listCapabilities": () =>
    Effect.gen(function* () {
      yield* McpInvocationContext.requireComputeCapability();
      const compute = yield* ComputeService;
      return (yield* compute.list()).providers.flatMap((provider) => provider.capabilities);
    }),
  "compute.listModels": () =>
    Effect.gen(function* () {
      yield* McpInvocationContext.requireComputeCapability();
      const compute = yield* ComputeService;
      return (yield* compute.list()).providers.flatMap((provider) => provider.models);
    }),
  "compute.submit": (request) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireComputeCapability();
      if (request.context?.threadId && request.context.threadId !== scope.threadId)
        return yield* new ComputeError({
          code: "compute-forbidden",
          message: "Compute tools are scoped to the current thread.",
        });
      const compute = yield* ComputeService;
      return yield* compute.submit({
        request: {
          ...request,
          context: { ...request.context, threadId: scope.threadId },
        },
      });
    }),
  "compute.getJob": (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireComputeCapability();
      const compute = yield* ComputeService;
      const job = yield* compute.getJob(input);
      if (job.request.context?.threadId !== scope.threadId)
        return yield* new ComputeError({
          code: "job-not-found",
          message: "Job not found in this thread.",
        });
      return job;
    }),
  "compute.cancelJob": (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireComputeCapability();
      const compute = yield* ComputeService;
      const job = yield* compute.getJob(input);
      if (job.request.context?.threadId !== scope.threadId)
        return yield* new ComputeError({
          code: "job-not-found",
          message: "Job not found in this thread.",
        });
      return yield* compute.cancel(input);
    }),
} satisfies Parameters<typeof ComputeToolkit.toLayer>[0];

export const ComputeToolkitHandlersLive = ComputeToolkit.toLayer(handlers);
