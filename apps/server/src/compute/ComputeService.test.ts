import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as Config from "../config.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import {
  SqlitePersistenceMemory,
  layerConfig as SqliteLive,
} from "../persistence/Layers/Sqlite.ts";
import { ComputeService } from "./ComputeService.ts";

const environment = ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(EnvironmentId.make("compute-test-environment")),
  getDescriptor: Effect.die("unused"),
});
const layer = ComputeService.layer.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "t3-compute-service-test-" })),
  Layer.provideMerge(NodeServices.layer),
  Layer.provide(Layer.succeed(ServerEnvironment, environment)),
);

it.effect(
  "recovers configuration and unfinished jobs after closing and recreating the service",
  () =>
    Effect.gen(function* () {
      const restartedLayer = ComputeService.layer.pipe(Layer.provide(SqliteLive));
      const submitted = yield* Effect.gen(function* () {
        const compute = yield* ComputeService;
        yield* compute.saveProvider({
          id: "restart",
          name: "Restart",
          type: "mock",
          configuration: {},
        });
        return yield* compute.submit({
          request: {
            capability: "image.generate",
            operation: "generate",
            parameters: { prompt: "restart" },
            inputs: [{ id: "source", uri: "memory://source", mimeType: "image/png" }],
          },
        });
      }).pipe(Effect.provide(restartedLayer), Effect.scoped);
      yield* TestClock.adjust("3 seconds");
      yield* Effect.gen(function* () {
        const compute = yield* ComputeService;
        expect((yield* compute.list(true)).providers[0]?.provider.id).toBe("restart");
        const recovered = yield* compute.getJob({ jobId: submitted.id });
        expect(recovered.status).toBe("completed");
        expect(recovered.outputs?.[0]?.resource?._tag).toBe("attachment");
        expect(recovered.outputs?.[0]?.metadata?.parentArtifacts).toEqual(["source"]);
        expect(yield* compute.listJobs({})).toHaveLength(1);
      }).pipe(Effect.provide(restartedLayer), Effect.scoped);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Config.layerTest(process.cwd(), { prefix: "t3-compute-restart-test-" }),
          Layer.succeed(ServerEnvironment, environment),
          TestClock.layer(),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    ),
);

it.effect("discovers the mock provider, persists submission, and cancels the durable job", () =>
  Effect.gen(function* () {
    const compute = yield* ComputeService;
    expect((yield* compute.list()).providers).toEqual([]);
    yield* compute.saveProvider({
      id: "mock-multimodal",
      name: "Mock",
      type: "mock",
      configuration: {},
    });
    const providers = yield* compute.list();
    expect(providers.providers[0]?.provider.id).toBe("mock-multimodal");
    expect(providers.providers[0]?.capabilities.map((capability) => capability.id)).toContain(
      "image.generate",
    );
    const job = yield* compute.submit({
      request: {
        capability: "image.generate",
        operation: "generate",
        parameters: { prompt: "cat" },
      },
    });
    expect(job.status).toBe("queued");
    const cancelled = yield* compute.cancel({ jobId: job.id });
    expect(cancelled.status).toBe("cancelled");
    expect((yield* compute.listJobs({})).map((entry) => entry.id)).toContain(job.id);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "reports a configured but unimplemented adapter as offline without breaking discovery",
  () =>
    Effect.gen(function* () {
      const compute = yield* ComputeService;
      const snapshot = yield* compute.saveProvider({
        id: "future-worker",
        name: "Future worker",
        type: "future-protocol",
        configuration: { transport: "later" },
      });
      expect(
        snapshot.providers.find((entry) => entry.provider.id === "future-worker")?.provider.status,
      ).toBe("offline");
    }).pipe(Effect.provide(layer)),
);

it.effect("reconciles mock progress into persisted output and lineage", () =>
  Effect.gen(function* () {
    const compute = yield* ComputeService;
    yield* compute.saveProvider({
      id: "mock-multimodal",
      name: "Mock",
      type: "mock",
      configuration: {},
    });
    const job = yield* compute.submit({
      request: {
        capability: "image.generate",
        operation: "generate",
        parameters: { prompt: "test" },
        inputs: [{ id: "parent", uri: "memory://parent", mimeType: "image/png" }],
      },
    });
    yield* Effect.yieldNow;
    yield* TestClock.adjust("3 seconds");
    yield* Effect.yieldNow;
    yield* compute.list(true);
    const completed = yield* compute.getJob({ jobId: job.id });
    expect(completed.status).toBe("completed");
    expect(completed.outputs?.[0]?.mimeType).toBe("image/png");
  }).pipe(Effect.provide(Layer.mergeAll(layer, TestClock.layer()))),
);

it.effect("polls managed jobs server-side and protects their destination until completion", () =>
  Effect.gen(function* () {
    const compute = yield* ComputeService;
    const provider = {
      id: "cloud",
      name: "Managed simulation",
      type: "mock-managed",
      execution: { kind: "managed" as const, service: "simulation", region: "region-a" },
      authentication: { type: "workload-identity" as const },
      configuration: {},
    };
    const catalog = yield* compute.saveProvider(provider);
    expect(
      catalog.providers.find((entry) => entry.provider.id === "cloud")?.executionSupport,
    ).toEqual({ cancellation: "supported", recovery: "request-id" });
    const completedEvent = yield* compute.events.pipe(
      Stream.filter((event) => event._tag === "job.completed"),
      Stream.take(1),
      Stream.runHead,
      Effect.forkScoped({ startImmediately: true }),
    );
    const submitted = yield* compute.submit({
      request: {
        capability: "document.generate",
        operation: "generate",
        providerId: "cloud",
        parameters: {},
      },
    });
    expect(submitted.remoteOperation?.adapterType).toBe("mock-managed");
    expect(submitted.nodeId).toBeUndefined();
    expect((yield* Effect.flip(compute.removeProvider("cloud"))).code).toBe("provider-in-use");
    expect(
      (yield* Effect.flip(
        compute.saveProvider({ ...provider, execution: { kind: "managed", region: "region-b" } }),
      )).code,
    ).toBe("provider-in-use");
    yield* TestClock.adjust("5 seconds");
    yield* Fiber.join(completedEvent);
    const completed = yield* compute.getJob({ jobId: submitted.id });
    expect(completed.status).toBe("completed");
    expect(completed.outputs?.[0]?.uri.startsWith("attachment:")).toBe(true);
    expect(completed.outputs?.[0]?.resource?._tag).toBe("attachment");
    yield* compute.removeProvider("cloud");
    expect((yield* compute.getJob({ jobId: submitted.id })).remoteOperation).toEqual(
      submitted.remoteOperation,
    );
  }).pipe(Effect.scoped, Effect.provide(layer.pipe(Layer.provideMerge(TestClock.layer())))),
);
