import {
  ArtifactReference,
  ComputeJobGetInput,
  ComputeJobListInput,
  GenerationJob,
  GeneratedArtifactMetadata,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  ComputeJobRepository,
  type ComputeJobRepositoryShape,
  PersistedComputeArtifact,
} from "../Services/ComputeJobs.ts";

const encodeParents = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodeArtifact = Schema.decodeUnknownEffect(ArtifactReference);
const encodeArtifact = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({ artifact: ArtifactReference, metadata: GeneratedArtifactMetadata }),
  ),
);
const ComputeJobRow = Schema.Struct({
  job: Schema.fromJsonString(GenerationJob),
});

const failure = (sqlOperation: string, decodeOperation: string) => (cause: unknown) =>
  Schema.isSchemaError(cause)
    ? toPersistenceDecodeError(decodeOperation)(cause)
    : toPersistenceSqlError(sqlOperation)(cause);

const makeComputeJobRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const writeJob = SqlSchema.void({
    Request: GenerationJob,
    execute: (job) =>
      sql`
        INSERT INTO compute_jobs (
          job_id, provider_id, thread_id, project_id, status, created_at, updated_at, job_json
        ) VALUES (
          ${job.id}, ${job.providerId}, ${job.request.context?.threadId ?? null},
          ${job.request.context?.projectId ?? null}, ${job.status}, ${job.createdAt},
          ${job.completedAt ?? job.startedAt ?? job.createdAt}, ${JSON.stringify(job)}
        )
        ON CONFLICT(job_id) DO UPDATE SET
          provider_id = excluded.provider_id,
          thread_id = excluded.thread_id,
          project_id = excluded.project_id,
          status = excluded.status,
          updated_at = excluded.updated_at,
          job_json = excluded.job_json
      `,
  });
  const readJob = SqlSchema.findOneOption({
    Request: ComputeJobGetInput,
    Result: ComputeJobRow,
    execute: ({ jobId }) => sql`SELECT job_json AS "job" FROM compute_jobs WHERE job_id = ${jobId}`,
  });
  const readJobs = SqlSchema.findAll({
    Request: ComputeJobListInput,
    Result: ComputeJobRow,
    execute: ({ threadId, projectId, providerId, limit, before }) => sql`
      SELECT job_json AS "job" FROM compute_jobs
      WHERE 1 = 1
        ${threadId === undefined ? sql`` : sql`AND thread_id = ${threadId}`}
        ${projectId === undefined ? sql`` : sql`AND project_id = ${projectId}`}
        ${providerId === undefined ? sql`` : sql`AND provider_id = ${providerId}`}
        ${before === undefined ? sql`` : sql`AND (created_at < ${before.createdAt} OR (created_at = ${before.createdAt} AND job_id < ${before.id}))`}
      ORDER BY created_at DESC, job_id DESC
      LIMIT ${limit ?? 100}
    `,
  });
  const writeArtifact = SqlSchema.void({
    Request: PersistedComputeArtifact,
    execute: ({ artifact, metadata, createdAt }) =>
      Effect.gen(function* () {
        const existing = yield* sql<{
          readonly job_id: string;
        }>`SELECT job_id FROM compute_artifacts WHERE artifact_id = ${artifact.id}`;
        if (existing[0] && existing[0].job_id !== metadata.generationJobId)
          return yield* toPersistenceSqlError("ComputeJobRepository.artifactOwnership")(
            new Error("Artifact belongs to another job."),
          );
        const parents = yield* encodeParents(metadata.parentArtifacts ?? []);
        const decodedArtifact = yield* decodeArtifact(artifact);
        const encoded = yield* encodeArtifact({ artifact: decodedArtifact, metadata });
        yield* sql`
      INSERT INTO compute_artifacts (artifact_id, job_id, parent_artifact_ids_json, artifact_json, created_at)
      VALUES (
        ${artifact.id}, ${metadata.generationJobId},
        ${parents},
        ${encoded}, ${createdAt}
      )
      ON CONFLICT(artifact_id) DO UPDATE SET
        job_id = excluded.job_id,
        parent_artifact_ids_json = excluded.parent_artifact_ids_json,
        artifact_json = excluded.artifact_json
    `;
      }),
  });

  const upsertJob: ComputeJobRepositoryShape["upsertJob"] = (job) =>
    writeJob(job).pipe(
      Effect.mapError(
        failure("ComputeJobRepository.upsertJob:query", "ComputeJobRepository.upsertJob:encode"),
      ),
    );
  const getJob: ComputeJobRepositoryShape["getJob"] = (input) =>
    readJob(input).pipe(
      Effect.mapError(
        failure("ComputeJobRepository.getJob:query", "ComputeJobRepository.getJob:decode"),
      ),
      Effect.map(Option.map((row) => row.job)),
    );
  const listJobs: ComputeJobRepositoryShape["listJobs"] = (input) =>
    readJobs(input).pipe(
      Effect.mapError(
        failure("ComputeJobRepository.listJobs:query", "ComputeJobRepository.listJobs:decode"),
      ),
      Effect.map((rows) => rows.map((row) => row.job)),
    );
  const upsertArtifact: ComputeJobRepositoryShape["upsertArtifact"] = (artifact) =>
    writeArtifact(artifact).pipe(
      Effect.mapError(
        failure(
          "ComputeJobRepository.upsertArtifact:query",
          "ComputeJobRepository.upsertArtifact:encode",
        ),
      ),
    );
  const saveJob: ComputeJobRepositoryShape["saveJob"] = (job) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* upsertJob(job);
          for (const artifact of job.outputs ?? [])
            yield* upsertArtifact({
              artifact,
              metadata: {
                generationJobId: job.id,
                capability: job.request.capability,
                operation: job.request.operation,
                providerId: job.providerId,
                ...(job.request.model ? { model: job.request.model } : {}),
                parameters: job.request.parameters,
                parentArtifacts: job.request.inputs?.map((input) => input.id) ?? [],
              },
              createdAt: job.completedAt ?? job.createdAt,
            });
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("ComputeJobRepository.saveJob")));
  const listPendingJobs: ComputeJobRepositoryShape["listPendingJobs"] = () =>
    sql`
    SELECT job_json AS "job" FROM compute_jobs
    WHERE status NOT IN ('completed', 'failed', 'cancelled') ORDER BY created_at ASC, job_id ASC
  `.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ComputeJobRow))),
      Effect.map((rows) => rows.map((row) => row.job)),
      Effect.mapError(toPersistenceSqlError("ComputeJobRepository.listPendingJobs")),
    );
  return {
    saveJob,
    listPendingJobs,
    upsertJob,
    getJob,
    listJobs,
    upsertArtifact,
  } satisfies ComputeJobRepositoryShape;
});

export const ComputeJobRepositoryLive = Layer.effect(
  ComputeJobRepository,
  makeComputeJobRepository,
);
