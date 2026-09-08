import * as NodeCrypto from "node:crypto";

import { ComputeError, type GenerationJob } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { storeAttachmentUpload } from "../assets/AttachmentUpload.ts";
import { toSafeThreadAttachmentSegment } from "../attachmentStore.ts";

/** Small inline results use the existing attachment store and signed asset route, never WS blobs. */
export const materializeComputeArtifacts = Effect.fn("compute.materializeArtifacts")(function* (
  job: GenerationJob,
) {
  const outputs = yield* Effect.forEach(job.outputs ?? [], (artifact) =>
    Effect.gen(function* () {
      const metadata = {
        ...artifact.metadata,
        generationJobId: job.id,
        providerId: job.providerId,
        capability: job.request.capability,
        operation: job.request.operation,
        ...(job.request.model ? { model: job.request.model } : {}),
        parameters: job.request.parameters,
        parentArtifacts: job.request.inputs?.map((input) => input.id) ?? [],
      };
      if (!artifact.uri.startsWith("data:")) return { ...artifact, metadata };
      const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(artifact.uri);
      if (!match || match[1] !== artifact.mimeType || artifact.uri.length > 1_400_000)
        return yield* new ComputeError({
          code: "artifact-invalid",
          message: "Inline compute output must be a base64 artifact smaller than 1 MiB.",
        });
      const bytes = Buffer.from(match[2]!, "base64");
      if (bytes.toString("base64") !== match[2] || bytes.length === 0 || bytes.length > 1_048_576)
        return yield* new ComputeError({
          code: "artifact-invalid",
          message: "Invalid inline artifact encoding or size.",
        });
      const hash = NodeCrypto.createHash("sha256")
        .update(job.id)
        .update("\0")
        .update(artifact.id)
        .digest("hex")
        .slice(0, 32);
      const uuid = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}`;
      const extension =
        (
          {
            "image/png": "png",
            "application/json": "json",
            "audio/wav": "wav",
            "model/gltf+json": "gltf",
          } as Record<string, string>
        )[artifact.mimeType] ?? "bin";
      const threadSegment =
        toSafeThreadAttachmentSegment(job.request.context?.threadId ?? "compute") ?? "compute";
      const attachmentId = `${threadSegment}-${uuid}-${extension}`;
      const stored = yield* storeAttachmentUpload(
        {
          version: 1,
          kind: "attachment-upload",
          type: "file",
          attachmentId,
          name: `compute-output.${extension}`,
          mimeType: artifact.mimeType,
          sizeBytes: bytes.length,
          expiresAt: 0,
        },
        bytes,
      ).pipe(
        Effect.mapError(
          () =>
            new ComputeError({
              code: "artifact-store-failed",
              message: "Could not store compute output.",
            }),
        ),
      );
      if (!stored.ok)
        return yield* new ComputeError({
          code: "artifact-store-failed",
          message: "Could not store compute output.",
        });
      return {
        ...artifact,
        uri: `attachment:${attachmentId}`,
        sizeBytes: bytes.length,
        metadata,
        resource: {
          _tag: "attachment" as const,
          attachmentId,
          fileName: artifact.name ?? `compute-output.${extension}`,
          mimeType: artifact.mimeType,
        },
      };
    }),
  );
  return { ...job, ...(job.outputs ? { outputs } : {}) } satisfies GenerationJob;
});
