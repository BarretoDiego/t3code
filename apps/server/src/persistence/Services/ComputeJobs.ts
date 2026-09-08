import {
  ArtifactReference,
  ComputeJobGetInput,
  ComputeJobListInput,
  GenerationJob,
  GeneratedArtifactMetadata,
  IsoDateTime,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ComputeRepositoryError } from "../Errors.ts";

export const PersistedComputeArtifact = Schema.Struct({
  artifact: ArtifactReference,
  metadata: GeneratedArtifactMetadata,
  createdAt: IsoDateTime,
});
export type PersistedComputeArtifact = typeof PersistedComputeArtifact.Type;

export interface ComputeJobRepositoryShape {
  /** Atomically persists the job and all output lineage. */
  readonly saveJob: (job: GenerationJob) => Effect.Effect<void, ComputeRepositoryError>;
  readonly listPendingJobs: () => Effect.Effect<
    ReadonlyArray<GenerationJob>,
    ComputeRepositoryError
  >;
  readonly upsertJob: (job: GenerationJob) => Effect.Effect<void, ComputeRepositoryError>;
  readonly getJob: (
    input: ComputeJobGetInput,
  ) => Effect.Effect<Option.Option<GenerationJob>, ComputeRepositoryError>;
  readonly listJobs: (
    input: ComputeJobListInput,
  ) => Effect.Effect<ReadonlyArray<GenerationJob>, ComputeRepositoryError>;
  readonly upsertArtifact: (
    artifact: PersistedComputeArtifact,
  ) => Effect.Effect<void, ComputeRepositoryError>;
}

export class ComputeJobRepository extends Context.Service<
  ComputeJobRepository,
  ComputeJobRepositoryShape
>()("t3/persistence/Services/ComputeJobs/ComputeJobRepository") {}
