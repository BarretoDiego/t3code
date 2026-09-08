import { type ComputeCapability, type GenerationJob } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { ComputeProviderAdapter } from "./ComputeProviderAdapter.ts";

const now = Effect.gen(function* () {
  return DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
});

const capabilities: ReadonlyArray<ComputeCapability> = [
  {
    id: "image.generate",
    category: "image",
    operations: ["generate"],
    models: [
      {
        id: "mock-image-v1",
        name: "Mock image model",
        operations: ["generate"],
        status: "ready",
        parameters: [
          { id: "prompt", label: "Prompt", type: "text", required: true },
          {
            id: "quality",
            label: "Quality",
            type: "select",
            options: [
              { label: "Fast", value: "fast" },
              { label: "Quality", value: "quality" },
            ],
          },
        ],
        presets: [{ id: "fast", label: "Fast", parameters: { quality: "fast" } }],
      },
    ],
  },
  { id: "video.generate", category: "video", operations: ["generate"] },
  { id: "audio.music.generate", category: "music", operations: ["generate"] },
  { id: "audio.tts.generate", category: "speech", operations: ["generate"] },
  { id: "3d.image-to-3d", category: "3d", operations: ["image-to-3d"] },
];

const onePixelPng =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=";

/** Deterministic, no-hardware provider used for contract and lifecycle verification. */
export function makeMockComputeProvider(delayMs = 750): ComputeProviderAdapter {
  const cancelled = new Set<string>();
  const terminal = (job: GenerationJob) =>
    ["completed", "failed", "cancelled"].includes(job.status);
  const read = Effect.fn("MockComputeProvider.read")(function* (job: GenerationJob) {
    if (terminal(job)) return job;
    const time = yield* Clock.currentTimeMillis;
    const elapsed = Math.max(0, time - DateTime.toEpochMillis(DateTime.makeUnsafe(job.createdAt)));
    if (cancelled.has(job.id))
      return { ...job, status: "cancelled" as const, completedAt: yield* now };
    if (elapsed < delayMs) return job;
    const stage = Math.min(4, Math.floor(elapsed / delayMs));
    if (stage < 4)
      return {
        ...job,
        status:
          stage === 1
            ? ("starting" as const)
            : stage === 2
              ? ("running" as const)
              : ("postprocessing" as const),
        startedAt: DateTime.formatIso(
          DateTime.makeUnsafe(DateTime.toEpochMillis(DateTime.makeUnsafe(job.createdAt)) + delayMs),
        ),
        progress: stage === 1 ? 0 : stage === 2 ? 35 : 80,
      };
    return {
      ...job,
      status: "completed" as const,
      progress: 100,
      completedAt: DateTime.formatIso(
        DateTime.makeUnsafe(
          DateTime.toEpochMillis(DateTime.makeUnsafe(job.createdAt)) + delayMs * 4,
        ),
      ),
      outputs: [
        {
          id: `${job.id}-output`,
          uri: job.request.capability.startsWith("image.")
            ? onePixelPng
            : "data:application/json;base64,eyJzaW11bGF0ZWQiOnRydWV9",
          mimeType: job.request.capability.startsWith("image.") ? "image/png" : "application/json",
          name: job.request.capability.startsWith("image.")
            ? "mock-output.png"
            : "mock-output.json",
        },
      ],
    };
  });
  return {
    type: "mock",
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    health: () => Effect.succeed({ status: "online" as const }),
    discover: () =>
      Effect.succeed({
        capabilities,
        resources: { cpu: { usage: 0 }, memory: { total: 1, available: 1 } },
      }),
    submit: (job) => Effect.succeed(job),
    cancel: (job) =>
      Effect.sync(() => {
        if (!terminal(job)) cancelled.add(job.id);
      }),
    getJob: read,
    reconcile: (jobs) => Effect.forEach(jobs, read),
  };
}
