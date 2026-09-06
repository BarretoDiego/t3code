import {
  AiRuntimeError,
  ProviderInstanceId,
  AiRuntimeConfig,
  AiRuntimeSnapshot,
  type AiRuntime,
  type AiRuntimeBindInput,
  type AiRuntimeActionInput,
  type AiRuntimeOperation,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { ServerConfig } from "../config.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  makeEndpointDriver,
  normalizeRuntimeUrl,
  isLoopbackRuntimeUrl,
} from "./AiRuntimeDriver.ts";
import type { RuntimeProgress } from "./ManagedRuntime.ts";
import { OllamaRuntime } from "./OllamaRuntime.ts";
import { runtimeProviderConfig } from "./runtimeBinding.ts";

const ConfigFile = Schema.Array(AiRuntimeConfig);
const encodeConfigs = Schema.encodeEffect(Schema.fromJsonString(ConfigFile));
const isRuntimeError = Schema.is(AiRuntimeError);
const localOllama: AiRuntimeConfig = {
  id: "ollama-local",
  name: "Ollama",
  runtimeKind: "ollama",
  protocol: "ollama",
  baseUrl: "http://127.0.0.1:11434",
  authentication: "none",
  configuredModels: [],
};
const failure = () =>
  new AiRuntimeError({
    message:
      "Runtime operation failed. Check the environment connection, runtime configuration, and storage.",
  });

export const makeAiRuntimeService = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const secrets = yield* ServerSecretStore;
  const environment = yield* ServerEnvironment;
  const settings = yield* ServerSettingsService;
  const crypto = yield* Crypto.Crypto;
  const scope = yield* Effect.scope;
  const driver = yield* makeEndpointDriver;
  const ollama = yield* OllamaRuntime;
  const environmentId = yield* environment.getEnvironmentId;
  const directory = path.join(config.baseDir, "ai-runtimes");
  const configPath = path.join(directory, "endpoints.json");
  const gate = yield* Semaphore.make(1);
  const state = yield* SubscriptionRef.make<AiRuntimeSnapshot>({ runtimes: [] });
  let configs: readonly AiRuntimeConfig[] | undefined;
  let lastRefresh = -Infinity;
  const operations = new Map<string, { id: string; fiber: Fiber.Fiber<void> }>();
  const secretName = (id: string) => `ai-runtime-${id}`;
  const keyFor = (id: string) =>
    secrets
      .get(secretName(id))
      .pipe(Effect.map((key) => (Option.isSome(key) ? new TextDecoder().decode(key.value) : "")));
  const load = Effect.gen(function* () {
    if (configs) return configs;
    configs = (yield* fs.exists(configPath))
      ? yield* fs
          .readFileString(configPath)
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ConfigFile))))
      : [];
    return configs;
  });
  const persist = Effect.fn("AiRuntimeService.persist")(function* (
    next: readonly AiRuntimeConfig[],
  ) {
    yield* fs.makeDirectory(directory, { recursive: true });
    const temporary = path.join(directory, `${yield* crypto.randomUUIDv4}.tmp`);
    yield* fs.writeFileString(temporary, yield* encodeConfigs(next), { mode: 0o600 });
    yield* fs.rename(temporary, configPath);
    configs = next;
    lastRefresh = -Infinity;
  });
  const refreshUnlocked = Effect.fn("AiRuntimeService.refresh")(function* (force: boolean) {
    const now = yield* Clock.currentTimeMillis;
    if (!force && now - lastRefresh < 30_000) return yield* SubscriptionRef.get(state);
    const configured = yield* load;
    const all = configured.some(
      (item) =>
        item.id === localOllama.id ||
        (item.protocol === "ollama" && normalizeRuntimeUrl(item.baseUrl) === localOllama.baseUrl),
    )
      ? configured
      : [localOllama, ...configured];
    const previous = yield* SubscriptionRef.get(state);
    const lifecycle = yield* ollama.inspect;
    const installation = lifecycle.managed;
    const onPath = lifecycle.external;
    const ownedProcess = lifecycle.ownedProcess;
    const runtimes = yield* Effect.forEach(
      all,
      (item) =>
        Effect.gen(function* () {
          const key = yield* keyFor(item.id);
          const result = yield* driver.discover(item, key);
          const old = previous.runtimes.find((runtime) => runtime.id === item.id);
          const local = item.id === localOllama.id;
          return {
            ...item,
            ...result,
            environmentId,
            source: configured.some((runtime) => runtime.id === item.id)
              ? ("configured" as const)
              : ("discovered" as const),
            installation:
              local && installation
                ? ("managed" as const)
                : result.status === "available" || (local && onPath)
                  ? ("external" as const)
                  : ("absent" as const),
            ownedProcess: local && ownedProcess,
            checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
            hasApiKey: key.length > 0,
            version: result.version ?? (local ? lifecycle.version : null),
            models: result.status === "available" ? result.models : (old?.models ?? result.models),
            operation: old?.operation ?? null,
          } satisfies AiRuntime;
        }),
      { concurrency: 3 },
    );
    lastRefresh = yield* Clock.currentTimeMillis;
    const snapshot = { runtimes };
    yield* SubscriptionRef.set(state, snapshot);
    return snapshot;
  });
  const list = (force = false) =>
    gate.withPermit(refreshUnlocked(force)).pipe(Effect.mapError(failure));
  const save = Effect.fn("AiRuntimeService.save")(
    function* (input: { runtime: AiRuntimeConfig; apiKey?: string }) {
      yield* gate.withPermit(
        Effect.gen(function* () {
          const current = yield* load;
          if (operations.has(input.runtime.id))
            return yield* new AiRuntimeError({
              message: "Wait for the current runtime operation before editing.",
            });
          const baseUrl = yield* Effect.try({
            try: () => normalizeRuntimeUrl(input.runtime.baseUrl),
            catch: () => new AiRuntimeError({ message: "Invalid runtime base URL." }),
          });
          const networkBaseUrl = input.runtime.networkBaseUrl
            ? yield* Effect.try({
                try: () => normalizeRuntimeUrl(input.runtime.networkBaseUrl!),
                catch: () => new AiRuntimeError({ message: "Invalid network base URL." }),
              })
            : undefined;
          if (networkBaseUrl && isLoopbackRuntimeUrl(networkBaseUrl))
            return yield* new AiRuntimeError({ message: "A network address cannot be localhost." });
          if (
            input.runtime.id === localOllama.id &&
            (baseUrl !== localOllama.baseUrl || input.runtime.protocol !== "ollama")
          )
            return yield* new AiRuntimeError({
              message:
                "The local Ollama identity must keep its local endpoint. Add another runtime for other addresses.",
            });
          if (
            current.some(
              (item) =>
                item.id !== input.runtime.id &&
                item.protocol === input.runtime.protocol &&
                normalizeRuntimeUrl(item.baseUrl) === baseUrl,
            )
          )
            return yield* new AiRuntimeError({
              message: "This endpoint is already configured. Edit its existing runtime.",
            });
          if (
            input.runtime.id !== localOllama.id &&
            input.runtime.protocol === "ollama" &&
            isLoopbackRuntimeUrl(baseUrl) &&
            new URL(baseUrl).port === "11434"
          )
            return yield* new AiRuntimeError({
              message: "Configure the detected local Ollama entry instead of adding a duplicate.",
            });
          if (
            input.runtime.listenOnTailnet &&
            (input.runtime.id !== localOllama.id ||
              !networkBaseUrl ||
              input.runtime.authentication !== "none")
          )
            return yield* new AiRuntimeError({
              message:
                "Tailnet listening requires the local managed Ollama entry, a network address, and authentication set to None. Tailnet ACLs provide access control.",
            });
          const runtime = {
            ...input.runtime,
            baseUrl,
            ...(networkBaseUrl ? { networkBaseUrl } : {}),
          };
          const previousKey = yield* keyFor(runtime.id);
          const nextKey = input.apiKey ?? previousKey;
          const providerSettings = yield* settings.getSettings;
          const providerInstances = { ...providerSettings.providerInstances };
          let changedBindings = false;
          for (const [id, instance] of Object.entries(providerInstances)) {
            if (
              instance.runtimeBinding?.environmentId !== environmentId ||
              instance.runtimeBinding.runtimeId !== runtime.id
            )
              continue;
            if (
              instance.driver !== "opencode" &&
              instance.driver !== "codex" &&
              instance.driver !== "claudeAgent"
            )
              continue;
            const instanceId = ProviderInstanceId.make(id);
            const generated = yield* Effect.try({
              try: () =>
                runtimeProviderConfig(
                  runtime,
                  {
                    runtimeId: runtime.id,
                    instanceId,
                    driver: instance.driver as AiRuntimeBindInput["driver"],
                    model: instance.runtimeBinding!.model,
                  },
                  nextKey,
                ),
              catch: () =>
                new AiRuntimeError({
                  message:
                    "A bound agent does not support this compatibility. Remove its binding in Providers before changing protocols.",
                }),
            });
            const names = new Set(generated.environment?.map((variable) => variable.name));
            providerInstances[instanceId] = {
              ...instance,
              config: {
                ...(Predicate.isObject(instance.config) ? instance.config : {}),
                ...(Predicate.isObject(generated.config) ? generated.config : {}),
              },
              environment: [
                ...(instance.environment ?? []).filter((variable) => !names.has(variable.name)),
                ...(generated.environment ?? []),
              ],
            };
            changedBindings = true;
          }
          if (input.apiKey !== undefined) {
            if (input.apiKey)
              yield* secrets.set(secretName(runtime.id), new TextEncoder().encode(input.apiKey));
            else yield* secrets.remove(secretName(runtime.id));
          }
          yield* persist([...current.filter((item) => item.id !== runtime.id), runtime]);
          if (changedBindings) yield* settings.updateSettings({ providerInstances });
        }),
      );
      return yield* list(true);
    },
    Effect.mapError((error) => (isRuntimeError(error) ? error : failure())),
  );
  const remove = Effect.fn("AiRuntimeService.remove")(
    function* (runtimeId: string) {
      yield* gate.withPermit(
        Effect.gen(function* () {
          if (operations.has(runtimeId))
            return yield* new AiRuntimeError({ message: "Cancel the runtime operation first." });
          const providerSettings = yield* settings.getSettings;
          if (
            Object.values(providerSettings.providerInstances).some(
              (instance) =>
                instance.runtimeBinding?.environmentId === environmentId &&
                instance.runtimeBinding.runtimeId === runtimeId,
            )
          )
            return yield* new AiRuntimeError({
              message:
                "Remove the associated provider instances in Settings → Providers before forgetting this endpoint.",
            });
          yield* persist((yield* load).filter((item) => item.id !== runtimeId));
          yield* secrets.remove(secretName(runtimeId));
        }),
      );
      return yield* list(true);
    },
    Effect.mapError((error) => (isRuntimeError(error) ? error : failure())),
  );
  const updateOperation = (id: string, operation: AiRuntimeOperation) =>
    SubscriptionRef.update(state, (current) => ({
      runtimes: current.runtimes.map((runtime) =>
        runtime.id === id ? { ...runtime, operation } : runtime,
      ),
    }));
  const runAction = Effect.fn("AiRuntimeService.runAction")(
    function* (runtime: AiRuntime, input: AiRuntimeActionInput, report: RuntimeProgress) {
      if (input.action === "pull" || input.action === "remove-model") {
        if (!input.model) return yield* new AiRuntimeError({ message: "Enter a model name." });
        return yield* driver.manageModel(
          runtime,
          yield* keyFor(runtime.id),
          input.action,
          input.model,
          report,
        );
      }
      return yield* ollama.execute(runtime, input, report);
    },
    Effect.mapError((error) => (isRuntimeError(error) ? error : failure())),
  );
  const action = Effect.fn("AiRuntimeService.action")(
    function* (input: AiRuntimeActionInput) {
      if (input.action === "cancel") {
        const running = operations.get(input.runtimeId);
        if (running && running.id !== input.operationId)
          return yield* new AiRuntimeError({
            message: "The operation changed. Refresh before cancelling.",
          });
        if (running) yield* Fiber.interrupt(running.fiber);
        return yield* SubscriptionRef.get(state);
      }
      yield* list();
      return yield* gate.withPermit(
        Effect.gen(function* () {
          if (operations.has(input.runtimeId))
            return yield* new AiRuntimeError({
              message: "A runtime operation is already running.",
            });
          const runtime = (yield* SubscriptionRef.get(state)).runtimes.find(
            (item) => item.id === input.runtimeId,
          );
          if (!runtime) return yield* new AiRuntimeError({ message: "Runtime not found." });
          const id = yield* crypto.randomUUIDv4;
          let operation: AiRuntimeOperation = {
            id,
            action: input.action,
            phase: "running",
            message: input.action,
            completed: 0,
            total: null,
          };
          yield* updateOperation(runtime.id, operation);
          const report: RuntimeProgress = (progress) => {
            operation = { ...operation, ...progress };
            return updateOperation(runtime.id, operation);
          };
          const work = runAction(runtime, input, report).pipe(
            Effect.onExit((exit) =>
              Effect.gen(function* () {
                const failed = Exit.isFailure(exit);
                operation = {
                  ...operation,
                  phase: failed
                    ? Cause.hasInterruptsOnly(exit.cause)
                      ? "cancelled"
                      : "failed"
                    : "succeeded",
                  message: failed
                    ? Cause.hasInterruptsOnly(exit.cause)
                      ? "Cancelled"
                      : Option.getOrElse(Cause.findErrorOption(exit.cause), failure).message
                    : "Completed",
                };
                yield* updateOperation(runtime.id, operation);
                operations.delete(runtime.id);
                lastRefresh = -Infinity;
                yield* list(true).pipe(Effect.ignore);
              }),
            ),
            Effect.ignoreCause,
          );
          const fiber = yield* Effect.forkIn(Effect.interruptible(work), scope);
          operations.set(runtime.id, { id, fiber });
          return yield* SubscriptionRef.get(state);
        }).pipe(Effect.uninterruptible),
      );
    },
    Effect.mapError((error) => (isRuntimeError(error) ? error : failure())),
  );
  const bind = Effect.fn("AiRuntimeService.bind")(
    function* (input: AiRuntimeBindInput) {
      const snapshot = yield* refreshUnlocked(true);
      const runtime = snapshot.runtimes.find((item) => item.id === input.runtimeId);
      if (!runtime || runtime.status !== "available")
        return yield* new AiRuntimeError({
          message: "The runtime must be reachable from this environment before binding an agent.",
        });
      if (!runtime.models.some((model) => model.id === input.model))
        return yield* new AiRuntimeError({
          message: "This model is no longer available. Refresh the model list.",
        });
      const current = yield* settings.getSettings;
      if (current.providerInstances[input.instanceId])
        return yield* new AiRuntimeError({
          message: "Choose a new provider instance ID to preserve existing provider settings.",
        });
      const key = yield* keyFor(runtime.id);
      const instance = yield* Effect.try({
        try: () => runtimeProviderConfig(runtime, input, key),
        catch: (error) => (isRuntimeError(error) ? error : failure()),
      });
      yield* settings.updateSettings({
        providerInstances: {
          ...current.providerInstances,
          [input.instanceId]: {
            ...instance,
            runtimeBinding: { environmentId, runtimeId: runtime.id, model: input.model },
          },
        },
      });
      return snapshot;
    },
    (effect) => gate.withPermit(effect),
    Effect.mapError((error) => (isRuntimeError(error) ? error : failure())),
  );
  return {
    list,
    save,
    remove,
    action,
    bind,
    changes: Stream.unwrap(list().pipe(Effect.as(SubscriptionRef.changes(state)))),
  };
});
export class AiRuntimeService extends Context.Service<
  AiRuntimeService,
  Effect.Success<typeof makeAiRuntimeService>
>()("t3/aiRuntimes/AiRuntimeService") {
  static readonly layer = Layer.effect(AiRuntimeService, makeAiRuntimeService).pipe(
    Layer.provide(OllamaRuntime.layer),
  );
}
