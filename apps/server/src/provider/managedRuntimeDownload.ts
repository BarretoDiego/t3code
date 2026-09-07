// @effect-diagnostics nodeBuiltinImport:off - Effect has no incremental digest.
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

export class ManagedRuntimeDownloadError extends Schema.TaggedErrorClass<ManagedRuntimeDownloadError>()(
  "ManagedRuntimeDownloadError",
  { message: Schema.String },
) {}

/** Streams a release to disk with a strict byte budget and SHA-256 verification.
 * The caller owns staging cleanup, activation, and executable leases. */
export const downloadVerifiedRuntime = Effect.fn("downloadVerifiedRuntime")(function* (input: {
  url: string;
  destination: string;
  bytes: number;
  sha256: string;
  progress: (completed: number) => Effect.Effect<void>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const http = yield* HttpClient.HttpClient;
  const response = yield* http
    .execute(HttpClientRequest.get(input.url))
    .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
  const encoding = response.headers["content-encoding"]?.trim().toLowerCase();
  const length = response.headers["content-length"];
  if (
    (!encoding || encoding === "identity") &&
    length !== undefined &&
    Number(length) !== input.bytes
  )
    return yield* new ManagedRuntimeDownloadError({
      message: "Runtime archive size differs from its release metadata.",
    });
  const hash = NodeCrypto.createHash("sha256");
  let completed = 0;
  let lastProgress = yield* Clock.currentTimeMillis;
  yield* response.stream.pipe(
    Stream.tap((chunk) =>
      Effect.gen(function* () {
        completed += chunk.byteLength;
        if (completed > input.bytes)
          return yield* new ManagedRuntimeDownloadError({
            message: "Runtime archive exceeds its byte budget.",
          });
        hash.update(chunk);
        const now = yield* Clock.currentTimeMillis;
        if (now - lastProgress >= 250 || completed === input.bytes) {
          lastProgress = now;
          yield* input.progress(completed);
        }
      }),
    ),
    Stream.run(fs.sink(input.destination, { flag: "wx", mode: 0o600 })),
  );
  if (completed !== input.bytes || hash.digest("hex") !== input.sha256)
    return yield* new ManagedRuntimeDownloadError({
      message: "Runtime archive failed its size or SHA-256 verification.",
    });
}, Effect.timeout("45 minutes"));
