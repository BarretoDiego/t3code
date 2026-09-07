import { expect, it } from "@effect/vitest";
import {
  type ComputeProviderConfig,
  type GenerationJob,
  GenerationJob as JobSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { makeManagedComputeProvider, type ManagedComputeDriver } from "./ManagedComputeProvider.ts";
import { makeMockManagedComputeDriver } from "./MockManagedComputeDriver.ts";

const encodeJob = Schema.encodeEffect(Schema.fromJsonString(JobSchema));
const decodeJob = Schema.decodeUnknownEffect(Schema.fromJsonString(JobSchema));
const provider: ComputeProviderConfig = {
  id: "cloud",
  name: "Cloud",
  type: "mock-managed",
  execution: { kind: "managed", service: "custom-cloud", region: "region-a" },
  authentication: { type: "workload-identity" },
  configuration: {},
};
const job: GenerationJob = {
  id: "local-job",
  providerId: provider.id,
  status: "queued",
  createdAt: "2026-01-01T00:00:00.000Z",
  execution: provider.execution!,
  request: { capability: "document.generate", operation: "generate", parameters: {} },
};

it.effect("recovers a remote operation after adapter recreation from a persisted job", () =>
  Effect.gen(function* () {
    const driver = makeMockManagedComputeDriver();
    const first = makeManagedComputeProvider(driver);
    yield* first.connect(provider);
    const accepted = yield* first.submit(job);
    expect(accepted.nodeId).toBeUndefined();
    expect(accepted.remoteOperation?.id).toBe("operations/local-job");
    yield* first.disconnect(provider.id);
    const serialized = yield* encodeJob(accepted);
    const restored = yield* decodeJob(serialized);
    const restarted = makeManagedComputeProvider(driver);
    yield* restarted.connect(provider);
    yield* TestClock.adjust("1 second");
    expect((yield* restarted.getJob(restored))?.progress).toBe(50);
    yield* TestClock.adjust("1 second");
    const [completed] = yield* restarted.reconcile([restored]);
    expect(completed?.status).toBe("completed");
    expect(completed?.outputs?.[0]?.mimeType).toBe("application/json");
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("recovers a lost submission acknowledgement without resubmitting", () =>
  Effect.gen(function* () {
    const driver = makeMockManagedComputeDriver();
    let submissions = 0;
    const counted: ManagedComputeDriver = {
      ...driver,
      connect: (config) =>
        driver.connect(config).pipe(
          Effect.map((connection) => ({
            ...connection,
            submit: (request) =>
              Effect.sync(() => {
                submissions++;
              }).pipe(Effect.andThen(connection.submit(request))),
          })),
        ),
    };
    const first = makeManagedComputeProvider(counted);
    yield* first.connect(provider);
    yield* first.submit(job);
    const restarted = makeManagedComputeProvider(counted);
    yield* restarted.connect(provider);
    const [recovered] = yield* restarted.reconcile([job]);
    expect(recovered?.remoteOperation?.id).toBe("operations/local-job");
    expect(submissions).toBe(1);
  }),
);

it.effect("keeps provider accounts isolated even when operation ids collide", () =>
  Effect.gen(function* () {
    const adapter = makeManagedComputeProvider(makeMockManagedComputeDriver());
    yield* adapter.connect(provider);
    yield* adapter.connect({ ...provider, id: "another-account" });
    const first = yield* adapter.submit(job);
    const second = yield* adapter.submit({ ...job, providerId: "another-account" });
    yield* adapter.cancel(first);
    expect((yield* adapter.getJob(first))?.status).toBe("cancelled");
    expect((yield* adapter.getJob(second))?.status).toBe("running");
  }),
);

it.effect("preserves jobs while offline and rejects cancellation unsupported by the API", () =>
  Effect.gen(function* () {
    const driver = makeMockManagedComputeDriver();
    const adapter = makeManagedComputeProvider({
      ...driver,
      connect: (config) =>
        driver.connect(config).pipe(
          Effect.map(({ cancel, ...client }) => {
            expect(cancel).toBeDefined();
            return client;
          }),
        ),
    });
    yield* adapter.connect(provider);
    const accepted = yield* adapter.submit(job);
    expect((yield* Effect.flip(adapter.cancel(accepted))).code).toBe("cancel-unsupported");
    expect((yield* adapter.getJob(accepted))?.status).toBe("running");
    yield* adapter.disconnect(provider.id);
    expect(yield* adapter.reconcile([accepted])).toEqual([accepted]);
    yield* adapter.connect(provider);
    expect((yield* adapter.getJob(accepted))?.remoteOperation).toEqual(accepted.remoteOperation);
  }),
);

it.effect("does not mark a cancel acknowledgement as a completed cancellation", () =>
  Effect.gen(function* () {
    const driver = makeMockManagedComputeDriver();
    const adapter = makeManagedComputeProvider({
      ...driver,
      connect: (config) =>
        driver
          .connect(config)
          .pipe(Effect.map((client) => ({ ...client, cancel: () => Effect.void }))),
    });
    yield* adapter.connect(provider);
    const accepted = yield* adapter.submit(job);
    yield* adapter.cancel(accepted);
    expect((yield* adapter.getJob(accepted))?.status).toBe("running");
  }),
);

it.effect("does not poll terminal jobs and rejects remote locators for a different adapter", () =>
  Effect.gen(function* () {
    const adapter = makeManagedComputeProvider(makeMockManagedComputeDriver());
    expect(yield* adapter.getJob({ ...job, status: "completed" })).toEqual({
      ...job,
      status: "completed",
    });
    const result = yield* Effect.flip(
      adapter.getJob({ ...job, remoteOperation: { id: "remote", adapterType: "other" } }),
    );
    expect(result.code).toBe("operation-mismatch");
  }),
);

it.effect("preserves a synchronous remote failure without retrying it", () =>
  Effect.gen(function* () {
    const driver = makeMockManagedComputeDriver();
    const adapter = makeManagedComputeProvider({
      ...driver,
      connect: (config) =>
        driver.connect(config).pipe(
          Effect.map((client) => ({
            ...client,
            submit: (request) =>
              Effect.succeed({
                id: `remote/${request.id}`,
                status: "failed" as const,
                error: {
                  code: "quota-exceeded",
                  message: "Remote quota exhausted.",
                  retryable: true,
                },
              }),
          })),
        ),
    });
    yield* adapter.connect(provider);
    const failed = yield* adapter.submit(job);
    expect(failed.status).toBe("failed");
    expect(failed.error?.code).toBe("quota-exceeded");
    expect(yield* adapter.reconcile([failed])).toEqual([failed]);
  }),
);

it.effect("leaves an unknown submission unresolved when request-id recovery is unavailable", () =>
  Effect.gen(function* () {
    const driver = makeMockManagedComputeDriver();
    const adapter = makeManagedComputeProvider({
      ...driver,
      connect: (config) =>
        driver.connect(config).pipe(
          Effect.map(({ findByRequestId, ...client }) => {
            expect(findByRequestId).toBeDefined();
            return client;
          }),
        ),
    });
    yield* adapter.connect(provider);
    expect((yield* adapter.discover(provider)).executionSupport?.recovery).toBe("operation-id");
    expect(yield* adapter.getJob(job)).toEqual(job);
    expect((yield* Effect.flip(adapter.cancel(job))).code).toBe("operation-unresolved");
  }),
);
