import { assert, describe, it } from "@effect/vitest";
import { ORCHESTRATION_V2_WS_METHODS, WS_METHODS, type GenerationJob } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
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
});
