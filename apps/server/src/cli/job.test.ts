import { assert, describe, it } from "@effect/vitest";
import {
  AUTOMATION_WS_METHODS,
  EnvironmentId,
  ExecutionNodeId,
  type Job,
  JobId,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import type { EnvironmentRpcClient } from "./environmentRpc.ts";
import { formatJob, formatJobLine, reportWaited, waitForJob } from "./job.ts";

const M = AUTOMATION_WS_METHODS;

const job: Job = {
  id: JobId.make("job_1"),
  environmentId: EnvironmentId.make("env-here"),
  nodeId: ExecutionNodeId.make("local"),
  requestedBy: { kind: "user" },
  requestedByEnvironmentId: EnvironmentId.make("env-here"),
  taskId: null,
  threadId: null,
  cwd: "/srv/app",
  action: { type: "command", executable: "npm", args: ["test"] },
  timeoutMs: 600_000,
  idempotent: false,
  status: "started",
  statusReason: null,
  exitCode: null,
  logBytes: 0,
  logTruncated: false,
  refs: [],
  acceptedAt: "2026-01-01T00:00:00.000Z",
  startedAt: "2026-01-01T00:00:01.000Z",
  finishedAt: null,
  updatedAt: "2026-01-01T00:00:01.000Z",
};

/** The server as `job wait` sees it: a watch stream, a read, and every cancel recorded. */
const clientFor = (watch: Stream.Stream<Job>, current: Job) => {
  const cancels: Array<string> = [];
  const client = {
    [M.jobsWatch]: () => watch,
    [M.jobsGet]: () => Effect.succeed(current),
    [M.jobsCancel]: ({ jobId }: { readonly jobId: string }) =>
      Effect.sync(() => {
        cancels.push(jobId);
        return current;
      }),
  } as unknown as EnvironmentRpcClient;
  return { client, cancels };
};

describe("job CLI", () => {
  it("does not present a quiet running job as finished", () => {
    const shown = formatJob(job);
    assert.include(shown, "job_1  started");
    assert.include(shown, "exit code: not reported");
    assert.include(shown, "never automatic; not declared idempotent");
    assert.include(formatJobLine(job), "started");
    assert.notInclude(formatJobLine(job), "exit");
    const failed: Job = { ...job, status: "failed", exitCode: 2, logTruncated: true };
    assert.include(formatJobLine(failed), "failed (exit 2)");
    assert.include(formatJob(failed), "truncated at the size cap");
  });

  it.effect("stops waiting at the timeout without cancelling the job", () =>
    Effect.gen(function* () {
      const { client, cancels } = clientFor(Stream.concat(Stream.make(job), Stream.never), job);
      const waiting = yield* Effect.forkChild(
        waitForJob(client, job.id, Option.some(Duration.seconds(30))),
      );
      yield* TestClock.adjust("30 seconds");
      const result = yield* Fiber.join(waiting);
      assert.isFalse(result.waited);
      assert.strictEqual(result.job.status, "started");
      assert.deepStrictEqual(cancels, []);
      const error = yield* reportWaited(result, true).pipe(Effect.flip);
      assert.include(error.message, "still started");
      assert.include(error.message, "not cancelled");
    }),
  );

  it.effect("exits cleanly only for a job that succeeded, and names an unknown outcome", () =>
    Effect.gen(function* () {
      const succeeded: Job = { ...job, status: "succeeded", exitCode: 0 };
      const done = yield* waitForJob(
        clientFor(Stream.make(job, succeeded), succeeded).client,
        job.id,
        Option.none(),
      );
      assert.isTrue(done.waited);
      yield* reportWaited(done, true);

      const failed: Job = { ...job, status: "failed", exitCode: 3 };
      const failure = yield* reportWaited(
        yield* waitForJob(clientFor(Stream.make(failed), failed).client, job.id, Option.none()),
        true,
      ).pipe(Effect.flip);
      assert.include(failure.message, "ended as failed with exit code 3");

      // `unknown` is not terminal, but there is nothing more to wait for.
      const unknown: Job = { ...job, status: "unknown" };
      const lost = yield* waitForJob(
        clientFor(Stream.concat(Stream.make(job, unknown), Stream.never), unknown).client,
        job.id,
        Option.none(),
      );
      assert.strictEqual(lost.job.status, "unknown");
      const lostError = yield* reportWaited(lost, true).pipe(Effect.flip);
      assert.include(lostError.message, "unknown outcome");
    }),
  );
});
