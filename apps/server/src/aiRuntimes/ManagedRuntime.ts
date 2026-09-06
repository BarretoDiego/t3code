import { downloadVerifiedRuntime } from "../provider/managedRuntimeDownload.ts";
import { AiRuntimeError, type AiRuntimeOperation } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const Release = Schema.Struct({
  tag_name: Schema.String,
  assets: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      size: Schema.Number,
      digest: Schema.NullOr(Schema.String),
      browser_download_url: Schema.String,
    }),
  ),
});
export const ManagedReleaseRecord = Schema.Struct({
  version: Schema.String,
  directory: Schema.String,
  executable: Schema.String,
});
export type ManagedReleaseRecord = typeof ManagedReleaseRecord.Type;
const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(ManagedReleaseRecord));
export type RuntimeProgress = (
  value: Pick<AiRuntimeOperation, "message" | "completed" | "total">,
) => Effect.Effect<void>;

/** Download an official release into an immutable directory, validate it, then atomically activate it.
 * Callers own process leases and must keep them alive across updates. No system installer is run. */
export const installManagedRelease = Effect.fn("ManagedRuntime.installRelease")(
  function* (input: {
    directory: string;
    repository: string;
    assetName: string;
    executable: string;
    report: RuntimeProgress;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const http = yield* HttpClient.HttpClient;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const response = yield* http
      .get(`https://api.github.com/repos/${input.repository}/releases/latest`, {
        headers: { "User-Agent": "T3-Code", Accept: "application/vnd.github+json" },
      })
      .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
    const release = yield* HttpClientResponse.schemaBodyJson(Release)(response);
    const asset = release.assets.find((item) => item.name === input.assetName);
    if (
      !asset?.digest?.match(/^sha256:[a-f0-9]{64}$/) ||
      !asset.browser_download_url.startsWith(
        `https://github.com/${input.repository}/releases/download/`,
      )
    )
      return yield* new AiRuntimeError({
        message: "An official release with a SHA-256 digest is not available for this platform.",
      });
    yield* fs.makeDirectory(input.directory, { recursive: true });
    const staging = yield* fs.makeTempDirectoryScoped({
      directory: input.directory,
      prefix: ".install-",
    });
    const archive = path.join(staging, input.assetName);
    const extracted = path.join(staging, "runtime");
    yield* fs.makeDirectory(extracted);
    yield* downloadVerifiedRuntime({
      url: asset.browser_download_url,
      destination: archive,
      bytes: asset.size,
      sha256: asset.digest.slice(7),
      progress: (completed) =>
        input.report({ message: "Downloading official runtime", completed, total: asset.size }),
    });
    const completed = asset.size;
    yield* input.report({
      message: "Extracting and verifying runtime",
      completed,
      total: asset.size,
    });
    const exit = yield* spawner.exitCode(
      ChildProcess.make("tar", ["-xf", archive, "-C", extracted]),
    );
    if (exit !== 0)
      return yield* new AiRuntimeError({
        message: "Archive extraction failed. Linux .zst releases require tar with zstd support.",
      });
    const binary = path.join(extracted, input.executable);
    const version = yield* spawner
      .string(ChildProcess.make(binary, ["--version"]))
      .pipe(Effect.timeout("30 seconds"));
    if (!version.includes(release.tag_name.replace(/^v/, "")))
      return yield* new AiRuntimeError({
        message: "Downloaded executable did not report the expected version.",
      });
    const directory = path.join(input.directory, asset.digest.slice(7));
    const record = {
      version: release.tag_name,
      directory,
      executable: path.join(directory, input.executable),
    };
    if (yield* fs.exists(directory)) {
      const existingVersion = yield* spawner
        .string(ChildProcess.make(record.executable, ["--version"]))
        .pipe(Effect.timeout("30 seconds"));
      if (!existingVersion.includes(release.tag_name.replace(/^v/, "")))
        return yield* new AiRuntimeError({ message: "The existing release is damaged." });
    }
    yield* Effect.gen(function* () {
      if (!(yield* fs.exists(directory))) yield* fs.rename(extracted, directory);
      const pointer = path.join(staging, "active.json");
      yield* fs.writeFileString(pointer, yield* encodeRecord(record), { mode: 0o600 });
      yield* fs.rename(pointer, path.join(input.directory, "active.json"));
    }).pipe(Effect.uninterruptible);
    return record;
  },
  Effect.scoped,
  Effect.timeout("45 minutes"),
  Effect.mapError(
    () =>
      new AiRuntimeError({
        message:
          "Managed installation failed. Check disk space, archive tools, and network access. The previous release is preserved.",
      }),
  ),
);
