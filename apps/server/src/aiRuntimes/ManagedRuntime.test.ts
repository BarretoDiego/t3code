import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { installManagedRelease, ManagedReleaseRecord } from "./ManagedRuntime.ts";

const archive = Uint8Array.from(
  Buffer.from(
    "H4sIABOInWoC/+3SsQrCMBDG8cx9ihORbDYKIfguLikoBmoqSe3ze9Sh4F4R/P9u+I5bbvm6lNuh7+M9mtU4FbyfU32mcz4s+3wP4XA04swXPOsYi740/2m7aTutQL01j5LyeBW7q+dsxb5LIdOl1DRkOe11bGMAAAAAAAAAAAAAAAAAAL/hBbcHQ1wAKAAA",
    "base64",
  ),
);
const digest = NodeCrypto.createHash("sha256").update(archive).digest("hex");
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const http = (options: { badDigest?: boolean; body?: Stream.Stream<Uint8Array> } = {}) =>
  HttpClient.make((request) =>
    Effect.sync(() => {
      const metadata = request.url.includes("api.github.com");
      const response = HttpClientResponse.fromWeb(
        request,
        new Response(
          metadata
            ? encode({
                tag_name: "v9.9.9",
                assets: [
                  {
                    name: "fixture.tgz",
                    size: archive.length,
                    digest: `sha256:${options.badDigest ? "0".repeat(64) : digest}`,
                    browser_download_url:
                      "https://github.com/ollama/ollama/releases/download/v9.9.9/fixture.tgz",
                  },
                ],
              })
            : archive,
        ),
      );
      return !metadata && options.body
        ? Object.defineProperty(response, "stream", { value: options.body })
        : response;
    }),
  );
const install = (directory: string) =>
  installManagedRelease({
    directory,
    repository: "ollama/ollama",
    assetName: "fixture.tgz",
    executable: "bin/ollama",
    report: () => Effect.void,
  });

describe("managed runtime installation", () => {
  it.effect(
    "downloads, verifies, extracts and atomically activates a tiny official-release fixture",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-runtime-install-" });
        const release = yield* install(directory).pipe(
          Effect.provideService(HttpClient.HttpClient, http()),
        );
        const pointer = yield* fs
          .readFileString(`${directory}/active.json`)
          .pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ManagedReleaseRecord))),
          );
        expect(pointer).toEqual(release);
        expect(release.version).toBe("v9.9.9");
        expect(yield* fs.exists(release.executable)).toBe(true);
        expect(
          (yield* fs.readDirectory(directory)).some((name) => name.startsWith(".install-")),
        ).toBe(false);
        // Reinstall/update of an identical release keeps its immutable directory.
        expect(
          yield* install(directory).pipe(Effect.provideService(HttpClient.HttpClient, http())),
        ).toEqual(release);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.effect("keeps the previous active release on failed integrity checks", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-runtime-integrity-" });
      yield* fs.writeFileString(`${directory}/active.json`, "previous-pointer");
      const outcome = yield* install(directory).pipe(
        Effect.provideService(HttpClient.HttpClient, http({ badDigest: true })),
        Effect.result,
      );
      expect(outcome._tag).toBe("Failure");
      expect(yield* fs.readFileString(`${directory}/active.json`)).toBe("previous-pointer");
      expect(yield* fs.readDirectory(directory)).toEqual(["active.json"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.effect("cleans staging after cancellation without replacing an installed release", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-runtime-cancel-" });
      yield* fs.writeFileString(`${directory}/active.json`, "previous-pointer");
      const requested = yield* Deferred.make<void>();
      const body = Stream.fromEffect(
        Deferred.succeed(requested, undefined).pipe(Effect.andThen(Effect.never)),
      );
      const fiber = yield* install(directory).pipe(
        Effect.provideService(HttpClient.HttpClient, http({ body })),
        Effect.forkChild,
      );
      yield* Deferred.await(requested);
      yield* Fiber.interrupt(fiber);
      expect(yield* fs.readDirectory(directory)).toEqual(["active.json"]);
      expect(yield* fs.readFileString(`${directory}/active.json`)).toBe("previous-pointer");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
