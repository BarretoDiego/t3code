import { readTailscaleStatus } from "@t3tools/tailscale";
import { AiRuntimeError, type AiRuntime, type AiRuntimeActionInput } from "@t3tools/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { ServerConfig } from "../config.ts";
import {
  installManagedRelease,
  ManagedReleaseRecord,
  type RuntimeProgress,
} from "./ManagedRuntime.ts";
const isRuntimeError = Schema.is(AiRuntimeError);
const failure = () =>
  new AiRuntimeError({
    message: "Ollama lifecycle failed. Check installation, storage, and runtime ownership.",
  });
export const makeOllamaRuntime = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcessPlatform;
  const architecture = yield* HostProcessArchitecture;
  const scope = yield* Effect.scope;
  const http = yield* HttpClient.HttpClient;
  const directory = path.join(config.baseDir, "ai-runtimes");
  const managedDirectory = path.join(directory, "ollama");
  let processScope: Scope.Closeable | undefined;
  let processHandle: ChildProcessSpawner.ChildProcessHandle | undefined;
  const managed = Effect.gen(function* () {
    const pointer = path.join(managedDirectory, "active.json");
    if (!(yield* fs.exists(pointer))) return null;
    return yield* fs
      .readFileString(pointer)
      .pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ManagedReleaseRecord))),
      );
  });
  const external = spawner.string(ChildProcess.make("ollama", ["--version"])).pipe(
    Effect.timeout("3 seconds"),
    Effect.map((output) => output.trim().length > 0),
    Effect.catch(() => Effect.succeed(false)),
  );
  const stop = Effect.gen(function* () {
    if (!processScope)
      return yield* new AiRuntimeError({
        message: "Only a process started by this T3 server can be stopped here.",
      });
    yield* Scope.close(processScope, Exit.void);
    processScope = undefined;
    processHandle = undefined;
  });
  const execute = Effect.fn("OllamaRuntime.execute")(
    function* (runtime: AiRuntime, input: AiRuntimeActionInput, report: RuntimeProgress) {
      if (runtime.id !== "ollama-local")
        return yield* new AiRuntimeError({
          message: "Manage this installation on its owning environment.",
        });
      if (input.action === "stop") return yield* stop;
      if (input.action === "remove-installation") {
        if (!(yield* managed))
          return yield* new AiRuntimeError({
            message: "External installations cannot be removed by T3.",
          });
        if (runtime.status === "available" || (processHandle && (yield* processHandle.isRunning)))
          return yield* new AiRuntimeError({
            message: "Stop the managed runtime before removing it.",
          });
        yield* fs.remove(managedDirectory, { recursive: true, force: true });
        return;
      }
      if (input.action === "install" || input.action === "update") {
        if (!(yield* managed) && (runtime.status === "available" || (yield* external)))
          return yield* new AiRuntimeError({
            message: "An external Ollama installation is available. Use the existing installation.",
          });
        const arch = architecture === "arm64" ? "arm64" : architecture === "x64" ? "amd64" : null;
        const assetName =
          platform === "darwin"
            ? "ollama-darwin.tgz"
            : platform === "linux" && arch
              ? `ollama-linux-${arch}.tar.zst`
              : platform === "win32" && arch
                ? `ollama-windows-${arch}.zip`
                : null;
        if (!assetName)
          return yield* new AiRuntimeError({
            message: "Managed Ollama is not supported on this platform.",
          });
        yield* installManagedRelease({
          directory: managedDirectory,
          repository: "ollama/ollama",
          assetName,
          executable: platform === "win32" ? "ollama.exe" : "bin/ollama",
          report,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.provideService(HttpClient.HttpClient, http),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        return;
      }
      if (input.action === "start") {
        if (runtime.status === "available") return;
        if (processScope) yield* stop;
        const release = yield* managed;
        let listenHost = "127.0.0.1:11434";
        if (runtime.listenOnTailnet) {
          if (!release || !runtime.networkBaseUrl)
            return yield* new AiRuntimeError({
              message:
                "Tailnet listening requires a managed installation and an explicit network address.",
            });
          const address = new URL(runtime.networkBaseUrl);
          const tailnet = yield* readTailscaleStatus.pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provideService(HostProcessPlatform, platform),
          );
          if (
            address.protocol !== "http:" ||
            address.pathname !== "/" ||
            address.port !== "11434" ||
            !tailnet.tailnetIpv4Addresses.includes(address.hostname)
          )
            return yield* new AiRuntimeError({
              message:
                "Use this node's Tailscale IPv4 address with http:// and port 11434. Other interfaces are not allowed.",
            });
          listenHost = address.host;
        }
        const childScope = yield* Scope.make();
        yield* Scope.addFinalizer(scope, Scope.close(childScope, Exit.void));
        const modelDirectory = path.join(directory, "ollama-models");
        if (release) yield* fs.makeDirectory(modelDirectory, { recursive: true });
        const child = yield* spawner
          .spawn(
            ChildProcess.make(release?.executable ?? "ollama", ["serve"], {
              env: {
                OLLAMA_HOST: listenHost,
                ...(release ? { OLLAMA_MODELS: modelDirectory } : {}),
              },
              extendEnv: true,
              stdout: "ignore",
              stderr: "ignore",
            }),
          )
          .pipe(
            Effect.provideService(Scope.Scope, childScope),
            Effect.onError(() => Scope.close(childScope, Exit.void)),
          );
        processScope = childScope;
        processHandle = child;
        yield* http.get(`http://${listenHost}/api/version`).pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.retry(Schedule.spaced("250 millis")),
          Effect.timeout("10 seconds"),
          Effect.onError(() => stop.pipe(Effect.ignore)),
        );
      }
    },
    Effect.mapError((error) => (isRuntimeError(error) ? error : failure())),
  );
  const inspect = Effect.gen(function* () {
    const release = yield* managed;
    return {
      managed: release !== null,
      version: release?.version ?? null,
      external: yield* external,
      ownedProcess: processHandle ? yield* processHandle.isRunning : false,
    };
  }).pipe(Effect.mapError(failure));
  return { inspect, execute };
});
export class OllamaRuntime extends Context.Service<
  OllamaRuntime,
  Effect.Success<typeof makeOllamaRuntime>
>()("t3/aiRuntimes/OllamaRuntime") {
  static readonly layer = Layer.effect(OllamaRuntime, makeOllamaRuntime);
}
