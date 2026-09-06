import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, type AiRuntime } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as Config from "../config.ts";
import { makeOllamaRuntime } from "./OllamaRuntime.ts";
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const runtime: AiRuntime = {
  id: "ollama-local",
  environmentId: EnvironmentId.make("node"),
  name: "Ollama",
  runtimeKind: "ollama",
  protocol: "ollama",
  baseUrl: "http://127.0.0.1:11434",
  authentication: "none",
  configuredModels: [],
  source: "discovered",
  installation: "managed",
  ownedProcess: false,
  status: "unavailable",
  version: null,
  models: [],
  checkedAt: null,
  hasApiKey: false,
  operation: null,
};
const dependencies = Config.layerTest(process.cwd(), { prefix: "t3-ollama-lifecycle-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);
const harness = Effect.fn("test.ollamaLifecycle")(function* (managed: boolean) {
  const config = yield* Config.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const directory = `${config.baseDir}/ai-runtimes/ollama`;
  if (managed) {
    yield* fs.makeDirectory(directory, { recursive: true });
    yield* fs.writeFileString(
      `${directory}/active.json`,
      encode({
        version: "v1",
        directory: `${directory}/v1`,
        executable: `${directory}/v1/bin/ollama`,
      }),
    );
  }
  let running = false;
  let stopped = 0;
  const hosts: string[] = [];
  const base = yield* ChildProcessSpawner.ChildProcessSpawner;
  const spawner = ChildProcessSpawner.ChildProcessSpawner.of({
    ...base,
    string: () => Effect.succeed(managed ? "" : "ollama version external"),
    spawn: Effect.fn("test.spawnOllama")(function* (command) {
      if (command._tag !== "StandardCommand") return yield* Effect.die("Unexpected pipeline");
      const status = command.args[0] === "status";
      if (!status) {
        hosts.push(command.options.env?.OLLAMA_HOST ?? "");
        running = true;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            running = false;
            stopped++;
          }),
        );
      }
      const output = status
        ? Stream.make(
            new TextEncoder().encode(
              encode({
                BackendState: "Running",
                Self: { DNSName: "node.test.ts.net", TailscaleIPs: ["100.64.0.9"] },
              }),
            ),
          )
        : Stream.empty;
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(123),
        exitCode: status ? Effect.succeed(ChildProcessSpawner.ExitCode(0)) : Effect.never,
        isRunning: Effect.sync(() => !status && running),
        kill: () =>
          Effect.sync(() => {
            running = false;
          }),
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: output,
        stderr: Stream.empty,
        all: output,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  });
  const lifecycle = yield* makeOllamaRuntime.pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.provideService(HostProcessPlatform, "linux"),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response('{"version":"1"}'))),
      ),
    ),
  );
  return { lifecycle, hosts, stopped: () => stopped, directory };
});
describe("Ollama process ownership and network binding", () => {
  it.effect(
    "starts on loopback by default, stops only its own process, then removes managed binaries",
    () =>
      Effect.gen(function* () {
        const h = yield* harness(true);
        yield* h.lifecycle.execute(
          runtime,
          { runtimeId: runtime.id, action: "start" },
          () => Effect.void,
        );
        expect(h.hosts).toEqual(["127.0.0.1:11434"]);
        expect((yield* h.lifecycle.inspect).ownedProcess).toBe(true);
        expect(
          (yield* h.lifecycle
            .execute(
              runtime,
              { runtimeId: runtime.id, action: "remove-installation" },
              () => Effect.void,
            )
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        yield* h.lifecycle.execute(
          runtime,
          { runtimeId: runtime.id, action: "stop" },
          () => Effect.void,
        );
        expect(h.stopped()).toBe(1);
        yield* h.lifecycle.execute(
          runtime,
          { runtimeId: runtime.id, action: "remove-installation" },
          () => Effect.void,
        );
        expect((yield* h.lifecycle.inspect).managed).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(dependencies)),
  );
  it.effect("never removes or replaces an external installation", () =>
    Effect.gen(function* () {
      const h = yield* harness(false);
      for (const action of ["install", "update", "remove-installation", "stop"] as const)
        expect(
          (yield* h.lifecycle
            .execute(
              { ...runtime, installation: "external" },
              { runtimeId: runtime.id, action },
              () => Effect.void,
            )
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
      expect(h.hosts).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(dependencies)),
  );
  it.effect("binds only an explicitly allowed local Tailnet address", () =>
    Effect.gen(function* () {
      const h = yield* harness(true);
      yield* h.lifecycle.execute(
        { ...runtime, listenOnTailnet: true, networkBaseUrl: "http://100.64.0.9:11434" },
        { runtimeId: runtime.id, action: "start" },
        () => Effect.void,
      );
      expect(h.hosts).toEqual(["100.64.0.9:11434"]);
    }).pipe(Effect.scoped, Effect.provide(dependencies)),
  );
  it.effect("rejects wildcard, LAN, and another node's Tailnet address", () =>
    Effect.gen(function* () {
      const h = yield* harness(true);
      for (const host of ["0.0.0.0", "192.168.1.5", "100.64.0.10"])
        expect(
          (yield* h.lifecycle
            .execute(
              { ...runtime, listenOnTailnet: true, networkBaseUrl: `http://${host}:11434` },
              { runtimeId: runtime.id, action: "start" },
              () => Effect.void,
            )
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
      expect(h.hosts).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(dependencies)),
  );
});
