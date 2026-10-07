import { assert, describe, it } from "@effect/vitest";
import {
  AUTOMATION_WS_METHODS,
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  WS_METHODS,
  type GenerationJob,
  type ResourceTelemetrySnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { readStatus } from "./status.ts";

const client = (
  overrides: Partial<Parameters<typeof readStatus>[0]> = {},
): Parameters<typeof readStatus>[0] => ({
  [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: () =>
    Stream.make({
      kind: "snapshot",
      snapshot: {
        schemaVersion: 1,
        snapshotSequence: 0,
        projects: [],
        threads: [],
        archivedThreads: [],
      },
    }),
  [ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot]: () =>
    Effect.succeed({ schemaVersion: 1, snapshotSequence: 0, projects: [], threads: [] }),
  [WS_METHODS.subscribeTerminalMetadata]: () => Stream.make({ type: "snapshot", terminals: [] }),
  [WS_METHODS.scheduledTasksList]: () => Effect.succeed({ tasks: [] }),
  [WS_METHODS.computeListJobs]: () => Effect.succeed([]),
  [WS_METHODS.serverGetPendingWork]: () => Effect.succeed({ effects: [] }),
  [AUTOMATION_WS_METHODS.diagnostics]: () =>
    Effect.succeed({
      environmentId: EnvironmentId.make("env-1"),
      journal: {
        environmentId: EnvironmentId.make("env-1"),
        headCursor: 0,
        oldestCursor: null,
        retainedEntries: 0,
        observedAt: "2026-01-01T00:00:00.000Z",
      },
      workers: [],
      pendingWork: {
        hookDeliveries: { pending: 0, retrying: 0, failed: 0 },
        orchestrators: [],
        activeTasks: 0,
        unknownTasks: 0,
        activeJobs: [],
        peerOutboxPending: 0,
      },
      peers: [],
      observedAt: "2026-01-01T00:00:00.000Z",
    }),
  [WS_METHODS.subscribeResourceTelemetry]: () => Stream.empty,
  ...overrides,
});
const job = (id: string, status: GenerationJob["status"]): GenerationJob => ({
  id,
  status,
  providerId: "provider-1",
  createdAt: "2026-10-03T22:00:00.000Z",
  request: { capability: "image", operation: "generate", parameters: {} },
});

describe("status collection", () => {
  it.effect(
    "keeps partial results and marks empty streams and unsupported reads as unconfirmed",
    () =>
      Effect.gen(function* () {
        const report = yield* readStatus(
          client({
            [WS_METHODS.serverGetPendingWork]: () =>
              Effect.die("server version lacks pending-work RPC"),
            [WS_METHODS.subscribeTerminalMetadata]: () => Stream.empty,
            [WS_METHODS.computeListJobs]: () => Effect.succeed([job("running-job", "running")]),
          }),
          "Remote",
          false,
        );
        assert.strictEqual(report.safeToClose, false);
        assert.strictEqual(report.readiness, "busy");
        assert.strictEqual(report.jobs[0]?.id, "running-job");
        assert.ok(report.unknowns.some((error) => error.includes("server work:")));
        assert.ok(report.unknowns.some((error) => error.includes("terminals:")));
        assert.ok(report.unknowns.some((error) => error.includes("processes:")));
      }),
  );
  it.effect("finds an older running job beyond a full page of completed jobs", () =>
    Effect.gen(function* () {
      const firstPage = Array.from({ length: 500 }, (_, index) =>
        job(`completed-${index}`, "completed"),
      );
      const report = yield* readStatus(
        client({
          [WS_METHODS.computeListJobs]: ({ before }) =>
            Effect.succeed(before ? [job("older-job", "running")] : firstPage),
        }),
        "Local",
        false,
      );
      assert.deepStrictEqual(
        report.jobs.map((entry) => entry.id),
        ["older-job"],
      );
      assert.strictEqual(report.readiness, "busy");
    }),
  );
  it.effect("rejects non-advancing pagination instead of hanging or claiming readiness", () =>
    Effect.gen(function* () {
      const page = Array.from({ length: 500 }, (_, index) =>
        job(`completed-${index}`, "completed"),
      );
      const report = yield* readStatus(
        client({ [WS_METHODS.computeListJobs]: () => Effect.succeed(page) }),
        "Local",
        false,
      );
      assert.ok(report.unknowns.some((error) => error.includes("pagination did not advance")));
      assert.strictEqual(report.safeToClose, false);
    }),
  );

  /** A process snapshot whose only meaningful part is when it was sampled. */
  const sampled = (lastSampleAt: Option.Option<DateTime.Utc>) =>
    ({
      processes: [],
      sampleIntervalMs: 1000,
      health: {
        native: { status: "healthy", lastSampleAt, lastError: Option.none() },
        inaccessibleProcessCount: 0,
      },
    }) as unknown as ResourceTelemetrySnapshot;

  it.effect("waits for a process sample taken after subscribing, not the cached one", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const report = yield* readStatus(
        client({
          // The sampler was idle, so the subscription opens with an hour-old snapshot.
          [WS_METHODS.subscribeResourceTelemetry]: () =>
            Stream.make(
              sampled(Option.some(DateTime.subtract(now, { hours: 1 }))),
              sampled(Option.some(now)),
            ),
        }),
        "Local",
        false,
      );
      assert.deepStrictEqual(report.unknowns, []);
      assert.strictEqual(report.readiness, "ready");
    }),
  );

  it.effect("reports a sampler that never produces a new sample as unconfirmed", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const report = yield* readStatus(
        client({
          [WS_METHODS.subscribeResourceTelemetry]: () =>
            Stream.make(sampled(Option.some(DateTime.subtract(now, { hours: 1 })))),
        }),
        "Local",
        false,
      );
      assert.deepStrictEqual(report.unknowns, ["Process inventory has no recent sample."]);
    }),
  );
});
