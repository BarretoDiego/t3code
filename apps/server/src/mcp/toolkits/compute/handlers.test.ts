import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type GenerationJob,
  type ComputeError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { ComputeService } from "../../../compute/ComputeService.ts";
import { McpInvocationContext, type McpInvocationScope } from "../../McpInvocationContext.ts";
import { handlers } from "./handlers.ts";

const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("env"),
  threadId: ThreadId.make("own"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerSessionId: "session",
  issuedAt: 0,
  capabilities: new Set(["compute"]),
};
const request = { capability: "image.generate", operation: "generate", parameters: {} };
const job: GenerationJob = {
  id: "job",
  providerId: "provider",
  status: "running",
  createdAt: "2026-01-01T00:00:00.000Z",
  request: { ...request, context: { threadId: ThreadId.make("other") } },
};
const service = ComputeService.of({
  list: () => Effect.die("unauthorized catalog access"),
  saveProvider: () => Effect.die("unused"),
  removeProvider: () => Effect.die("unused"),
  submit: () => Effect.die("unauthorized submission"),
  getJob: () => Effect.succeed(job),
  listJobs: () => Effect.die("unused"),
  cancel: () => Effect.die("unauthorized cancellation"),
  changes: Stream.empty,
  events: Stream.empty,
});

it.effect("requires compute permission for every tool, including discovery", () =>
  Effect.gen(function* () {
    const calls: Array<
      Effect.Effect<unknown, ComputeError, ComputeService | McpInvocationContext>
    > = [
      handlers["compute.listProviders"](),
      handlers["compute.listCapabilities"](),
      handlers["compute.listModels"](),
      handlers["compute.submit"](request),
      handlers["compute.getJob"]({ jobId: "job" }),
      handlers["compute.cancelJob"]({ jobId: "job" }),
    ];
    for (const call of calls) {
      const denied = yield* call.pipe(
        Effect.asVoid,
        Effect.flip,
        Effect.provideService(ComputeService, service),
        Effect.provideService(McpInvocationContext, {
          ...scope,
          capabilities: new Set<"compute" | "preview">(),
        }),
      );
      expect(denied.code).toBe("compute-forbidden");
    }
  }),
);

it.effect("does not disclose or cancel jobs belonging to another thread", () =>
  Effect.gen(function* () {
    for (const call of [
      handlers["compute.getJob"]({ jobId: "job" }),
      handlers["compute.cancelJob"]({ jobId: "job" }),
    ]) {
      const denied = yield* call.pipe(
        Effect.flip,
        Effect.provideService(ComputeService, service),
        Effect.provideService(McpInvocationContext, scope),
      );
      expect(denied.code).toBe("job-not-found");
    }
  }),
);

it.effect("rejects a forged submission thread before executing compute", () =>
  Effect.gen(function* () {
    const denied = yield* handlers["compute.submit"]({
      ...request,
      context: { threadId: ThreadId.make("other") },
    }).pipe(
      Effect.asVoid,
      Effect.flip,
      Effect.provideService(ComputeService, service),
      Effect.provideService(McpInvocationContext, scope),
    );
    expect(denied.code).toBe("compute-forbidden");
  }),
);

it.effect("binds valid submissions to the authenticated thread", () =>
  Effect.gen(function* () {
    const accepted = yield* handlers["compute.submit"](request).pipe(
      Effect.provideService(ComputeService, {
        ...service,
        submit: (input) => Effect.succeed({ ...job, request: input.request }),
      }),
      Effect.provideService(McpInvocationContext, scope),
    );
    expect(accepted.request.context?.threadId).toBe(scope.threadId);
  }),
);
