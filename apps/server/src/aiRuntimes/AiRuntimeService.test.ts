import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AiRuntimeError,
  EnvironmentId,
  ProviderInstanceId,
  type AiRuntimeConfig,
  type AiRuntimeOperation,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import * as Config from "../config.ts";
import * as Secrets from "../auth/ServerSecretStore.ts";
import * as Settings from "../serverSettings.ts";
import { makeAiRuntimeService } from "./AiRuntimeService.ts";
import { OllamaRuntime } from "./OllamaRuntime.ts";

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const manual: AiRuntimeConfig = {
  id: "gpu",
  name: "GPU",
  runtimeKind: "openai-compatible",
  protocol: "openai",
  baseUrl: "https://gpu.test/v1",
  authentication: "bearer",
  configuredModels: [],
};
const dependencies = Layer.mergeAll(Secrets.layer, Settings.layerTest()).pipe(
  Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "t3-ai-runtimes-test-" })),
  Layer.provideMerge(NodeServices.layer),
);
const harness = Effect.gen(function* () {
  let online = true;
  let names = ["fixture-model"];
  let probes = 0;
  let installed = false;
  let running = false;
  let paused = false;
  const started = yield* Deferred.make<void>();
  const proceed = yield* Deferred.make<void>();
  const authorization: Array<string | undefined> = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      probes++;
      authorization.push(request.headers.authorization);
      return HttpClientResponse.fromWeb(
        request,
        new Response(
          json(
            request.url.endsWith("/api/version")
              ? { version: "fixture" }
              : request.url.endsWith("/api/show")
                ? { capabilities: ["completion", "tools"] }
                : request.url.endsWith("/api/tags")
                  ? { models: names.map((name) => ({ name })) }
                  : { data: names.map((id) => ({ id })) },
          ),
          { status: online ? 200 : 503 },
        ),
      );
    }),
  );
  const lifecycle = OllamaRuntime.of({
    inspect: Effect.sync(() => ({
      managed: installed,
      external: false,
      version: installed ? "fixture" : null,
      ownedProcess: running,
    })),
    execute: Effect.fn("test.lifecycle.execute")(function* (_runtime, input) {
      if (input.action === "remove-installation" && !installed)
        return yield* new AiRuntimeError({ message: "External installation" });
      if (input.action === "install" || input.action === "update") {
        yield* Deferred.succeed(started, undefined);
        if (paused) yield* Deferred.await(proceed);
        installed = true;
      }
      if (input.action === "start") {
        running = true;
        online = true;
      }
      if (input.action === "stop") {
        running = false;
        online = false;
      }
      if (input.action === "remove-installation") installed = false;
    }),
  });
  const create = makeAiRuntimeService.pipe(
    Effect.provideService(HttpClient.HttpClient, client),
    Effect.provideService(OllamaRuntime, lifecycle),
    Effect.provideService(
      ServerEnvironment,
      ServerEnvironment.of({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("node-test")),
        getDescriptor: Effect.die("unused"),
      }),
    ),
  );
  const service = yield* create;
  const terminal = (id: string) =>
    service.changes.pipe(
      Stream.map((snapshot) => snapshot.runtimes.find((item) => item.id === id)?.operation),
      Stream.filter(
        (operation): operation is AiRuntimeOperation =>
          operation !== undefined && operation !== null && operation.phase !== "running",
      ),
      Stream.take(1),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    );
  return {
    service,
    create,
    terminal,
    started,
    proceed,
    authorization,
    setOnline: (value: boolean) => {
      online = value;
    },
    setNames: (value: string[]) => {
      names = value;
    },
    pause: () => {
      paused = true;
    },
    probes: () => probes,
  };
});

describe("environment runtime registry", () => {
  it.effect("deduplicates discovery and shares the cached probe across clients", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const first = yield* h.service.list();
      const probes = h.probes();
      const second = yield* h.service.list();
      expect(second).toEqual(first);
      expect(h.probes()).toBe(probes);
      expect(first.runtimes.map((r) => r.id)).toEqual(["ollama-local"]);
      yield* h.service.save({ runtime: { ...first.runtimes[0]!, name: "Local custom name" } });
      expect((yield* h.service.list()).runtimes).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(dependencies)),
  );
  it.effect(
    "retains offline runtime identity and refreshes online models, including empty catalogs",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        const first = yield* h.service.list();
        h.setOnline(false);
        const offline = yield* h.service.list(true);
        expect(offline.runtimes[0]?.id).toBe(first.runtimes[0]?.id);
        expect(offline.runtimes[0]?.status).toBe("unavailable");
        expect(offline.runtimes[0]?.models).toEqual(first.runtimes[0]?.models);
        h.setOnline(true);
        h.setNames(["new-model"]);
        expect((yield* h.service.list(true)).runtimes[0]?.models[0]?.id).toBe("new-model");
        h.setNames([]);
        expect((yield* h.service.list(true)).runtimes[0]?.models).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(dependencies)),
  );
  it.effect(
    "persists manual runtimes while keeping credentials out of metadata and responses",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        const snapshot = yield* h.service.save({ runtime: manual, apiKey: "super-private" });
        expect(json(snapshot)).not.toContain("super-private");
        const fs = yield* FileSystem.FileSystem;
        const config = yield* Config.ServerConfig;
        expect(
          yield* fs.readFileString(`${config.baseDir}/ai-runtimes/endpoints.json`),
        ).not.toContain("super-private");
        const rebuilt = yield* h.create;
        expect((yield* rebuilt.list()).runtimes.find((r) => r.id === "gpu")?.hasApiKey).toBe(true);
        expect(h.authorization).toContain("Bearer super-private");
        yield* rebuilt.save({ runtime: { ...manual, name: "Renamed" } });
        expect((yield* rebuilt.list()).runtimes.find((r) => r.id === "gpu")?.hasApiKey).toBe(true);
        yield* rebuilt.save({ runtime: manual, apiKey: "" });
        expect((yield* rebuilt.list()).runtimes.find((r) => r.id === "gpu")?.hasApiKey).toBe(false);
        yield* rebuilt.remove("gpu");
        expect((yield* rebuilt.list()).runtimes).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(dependencies)),
  );
  it.effect("rejects duplicate manual endpoints and invalid or credential-bearing URLs", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.service.save({ runtime: manual });
      expect(
        (yield* h.service.save({ runtime: { ...manual, id: "duplicate" } }).pipe(Effect.result))
          ._tag,
      ).toBe("Failure");
      expect(
        (yield* h.service
          .save({ runtime: { ...manual, baseUrl: "http://user:secret@host" } })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(
        (yield* h.service
          .save({ runtime: { ...manual, networkBaseUrl: "http://localhost:11434" } })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
    }).pipe(Effect.scoped, Effect.provide(dependencies)),
  );
  it.effect("leaves upstream provider behavior intact until a binding is explicitly created", () =>
    Effect.gen(function* () {
      const settings = yield* Settings.ServerSettingsService;
      const before = yield* settings.getSettings;
      const h = yield* harness;
      yield* h.service.list();
      expect(yield* settings.getSettings).toEqual(before);
      yield* h.service.bind({
        runtimeId: "ollama-local",
        instanceId: ProviderInstanceId.make("local_agent"),
        driver: "opencode",
        model: "fixture-model",
      });
      const after = yield* settings.getSettings;
      expect(
        after.providerInstances[ProviderInstanceId.make("local_agent")]?.runtimeBinding,
      ).toEqual({ environmentId: "node-test", runtimeId: "ollama-local", model: "fixture-model" });
      for (const [id, value] of Object.entries(before.providerInstances))
        expect(after.providerInstances[ProviderInstanceId.make(id)]).toEqual(value);
      expect(
        (yield* h.service
          .bind({
            runtimeId: "ollama-local",
            instanceId: ProviderInstanceId.make("local_agent"),
            driver: "opencode",
            model: "fixture-model",
          })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      h.setOnline(false);
      expect(
        (yield* h.service
          .bind({
            runtimeId: "ollama-local",
            instanceId: ProviderInstanceId.make("offline_agent"),
            driver: "opencode",
            model: "fixture-model",
          })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
    }).pipe(Effect.scoped, Effect.provide(dependencies)),
  );
  it.effect("updates bound agent endpoints and secrets, rejecting incompatible edits", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const settings = yield* Settings.ServerSettingsService;
      yield* h.service.save({ runtime: manual, apiKey: "old-private" });
      const instanceId = ProviderInstanceId.make("gpu_agent");
      yield* h.service.bind({
        runtimeId: manual.id,
        instanceId,
        driver: "opencode",
        model: "fixture-model",
      });
      const updated = { ...manual, baseUrl: "https://replacement.test/v1" };
      const snapshot = yield* h.service.save({ runtime: updated, apiKey: "new-private" });
      expect(json(snapshot)).not.toContain("new-private");
      const instance = (yield* settings.getSettings).providerInstances[instanceId]!;
      expect(
        instance.environment?.find((item) => item.name === "OPENCODE_CONFIG_CONTENT")?.value,
      ).toContain(updated.baseUrl);
      expect(
        instance.environment?.find((item) => item.name === "T3_RUNTIME_API_KEY"),
      ).toMatchObject({ value: "new-private", sensitive: true });
      expect(
        (yield* h.service
          .save({ runtime: { ...updated, protocol: "anthropic" }, apiKey: "rejected-private" })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect((yield* settings.getSettings).providerInstances[instanceId]).toEqual(instance);
      expect(
        (yield* h.service.list(true)).runtimes.find((item) => item.id === manual.id)?.protocol,
      ).toBe("openai");
      expect(h.authorization).not.toContain("Bearer rejected-private");
      expect((yield* h.service.remove(manual.id).pipe(Effect.result))._tag).toBe("Failure");
    }).pipe(Effect.scoped, Effect.provide(dependencies)),
  );
  it.effect("emits install, start, stop, update and removal receipts", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      h.setOnline(false);
      for (const action of ["install", "start", "stop", "update", "remove-installation"] as const) {
        yield* h.service.action({ runtimeId: "ollama-local", action });
        expect((yield* h.terminal("ollama-local")).phase).toBe("succeeded");
        const runtime = (yield* h.service.list(true)).runtimes[0]!;
        if (action === "install" || action === "update")
          expect(runtime.installation).toBe("managed");
        if (action === "start") expect(runtime.ownedProcess).toBe(true);
        if (action === "remove-installation") expect(runtime.installation).toBe("absent");
      }
    }).pipe(Effect.scoped, Effect.provide(dependencies)),
  );
  it.effect("cancels only the current operation and preserves the previous installation", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      h.pause();
      h.setOnline(false);
      const snapshot = yield* h.service.action({ runtimeId: "ollama-local", action: "install" });
      yield* Deferred.await(h.started);
      expect(
        (yield* h.service
          .action({ runtimeId: "ollama-local", action: "cancel", operationId: "wrong" })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(
        (yield* h.service
          .action({ runtimeId: "ollama-local", action: "install" })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      yield* h.service.action({
        runtimeId: "ollama-local",
        action: "cancel",
        operationId: snapshot.runtimes[0]!.operation!.id,
      });
      expect((yield* h.terminal("ollama-local")).phase).toBe("cancelled");
      expect((yield* h.service.list()).runtimes[0]?.installation).toBe("absent");
    }).pipe(Effect.scoped, Effect.provide(dependencies)),
  );
});
