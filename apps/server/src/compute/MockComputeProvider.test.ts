import { expect, it } from "@effect/vitest";
import type { GenerationJob } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { makeMockComputeProvider } from "./MockComputeProvider.ts";

const job: GenerationJob = {
  id: "mock-job",
  providerId: "mock-multimodal",
  status: "queued",
  createdAt: "1970-01-01T00:00:00.000Z",
  request: { capability: "image.generate", operation: "generate", parameters: { prompt: "test" } },
};

it.effect("publishes durable progress and a valid output without hardware", () =>
  Effect.gen(function* () {
    const provider = makeMockComputeProvider(1);
    yield* provider.submit(job);
    yield* TestClock.adjust("2 millis");
    expect((yield* provider.getJob(job))?.status).toBe("running");
    yield* TestClock.adjust("2 millis");
    // A fresh adapter reconstructs the mock job from durable timestamps.
    const completed = yield* makeMockComputeProvider(1).getJob(job);
    expect(completed?.status).toBe("completed");
    expect(completed?.outputs?.[0]?.mimeType).toBe("image/png");
    expect(completed?.outputs?.[0]?.uri.startsWith("data:image/png;base64,")).toBe(true);
    const bytes = Buffer.from(completed!.outputs![0]!.uri.split(",")[1]!, "base64");
    for (let offset = 8; offset < bytes.length;) {
      const length = bytes.readUInt32BE(offset);
      expect(NodeZlib.crc32(bytes.subarray(offset + 4, offset + 8 + length))).toBe(
        bytes.readUInt32BE(offset + 8 + length),
      );
      if (bytes.toString("ascii", offset + 4, offset + 8) === "IDAT")
        expect(NodeZlib.inflateSync(bytes.subarray(offset + 8, offset + 8 + length)).length).toBe(
          5,
        );
      offset += length + 12;
    }
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("cancels a queued mock job and keeps it terminal", () =>
  Effect.gen(function* () {
    const provider = makeMockComputeProvider(100);
    yield* provider.submit(job);
    yield* provider.cancel(job);
    expect((yield* provider.getJob(job))?.status).toBe("cancelled");
  }),
);
import * as NodeZlib from "node:zlib";
