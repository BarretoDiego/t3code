import { expect, it } from "@effect/vitest";
import { ProjectId, ThreadId, type GenerationJob } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ComputeJobRepositoryLive } from "./ComputeJobs.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ComputeJobRepository } from "../Services/ComputeJobs.ts";

const job: GenerationJob = {
  id: "persisted-job",
  providerId: "mock-provider",
  status: "completed",
  remoteOperation: { id: "operations/remote-123", adapterType: "managed-fixture" },
  execution: { kind: "managed", service: "cloud", region: "region-a" },
  createdAt: "2026-01-01T00:00:00.000Z",
  completedAt: "2026-01-01T00:00:01.000Z",
  request: {
    capability: "image.edit",
    operation: "edit",
    parameters: { opaque: "value" },
    context: { projectId: ProjectId.make("project"), threadId: ThreadId.make("thread") },
    inputs: [{ id: "parent", uri: "memory://parent", mimeType: "image/png" }],
  },
  outputs: [{ id: "child", uri: "memory://child", mimeType: "image/png" }],
};
const layer = ComputeJobRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory));

it.effect("rolls back the whole job when an output collides with another job's lineage", () =>
  Effect.gen(function* () {
    const repository = yield* ComputeJobRepository;
    yield* repository.saveJob(job);
    const collision = yield* Effect.flip(repository.saveJob({ ...job, id: "other-job" }));
    expect(collision._tag).toBe("PersistenceSqlError");
    expect(Option.isNone(yield* repository.getJob({ jobId: "other-job" }))).toBe(true);
    expect(Option.getOrThrow(yield* repository.getJob({ jobId: job.id }))).toEqual(job);
  }).pipe(Effect.provide(layer)),
);

it.effect("paginates history deterministically while retaining every active job", () =>
  Effect.gen(function* () {
    const repository = yield* ComputeJobRepository;
    for (let index = 0; index < 105; index++)
      yield* repository.saveJob({
        ...job,
        outputs: [],
        id: `job-${String(index).padStart(3, "0")}`,
        status: index === 0 ? "running" : "completed",
      });
    const first = yield* repository.listJobs({});
    expect(first).toHaveLength(100);
    const last = first.at(-1)!;
    const second = yield* repository.listJobs({
      before: { id: last.id, createdAt: last.createdAt },
    });
    expect(second).toHaveLength(5);
    expect(new Set([...first, ...second].map((entry) => entry.id)).size).toBe(105);
    expect((yield* repository.listPendingJobs()).map((entry) => entry.id)).toEqual(["job-000"]);
  }).pipe(Effect.provide(layer)),
);

it.effect("persists filtered job history and artifact lineage", () =>
  Effect.gen(function* () {
    const repository = yield* ComputeJobRepository;
    const sql = yield* SqlClient.SqlClient;
    yield* repository.upsertJob(job);
    yield* repository.upsertArtifact({
      artifact: job.outputs![0]!,
      metadata: {
        generationJobId: job.id,
        capability: job.request.capability,
        operation: job.request.operation,
        providerId: job.providerId,
        parentArtifacts: ["parent"],
      },
      createdAt: job.completedAt!,
    });
    expect(Option.getOrThrow(yield* repository.getJob({ jobId: job.id }))).toEqual(job);
    expect(yield* repository.listJobs({ threadId: ThreadId.make("thread") })).toEqual([job]);
    const artifacts = yield* sql<{ readonly jobId: string; readonly parents: string }>`
      SELECT job_id AS "jobId", parent_artifact_ids_json AS "parents"
      FROM compute_artifacts
    `;
    expect(artifacts).toEqual([{ jobId: job.id, parents: '["parent"]' }]);
  }).pipe(Effect.provide(layer)),
);
