import { expect, it } from "@effect/vitest";
import type { ComputeProviderConfig } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { resolveComputeCredential } from "./ComputeCredentials.ts";

const provider: ComputeProviderConfig = {
  id: "cloud",
  name: "Cloud",
  type: "cloud",
  configuration: {},
};

it.effect("delegates workload identity without requesting a stored secret", () =>
  Effect.gen(function* () {
    expect(
      yield* resolveComputeCredential({
        ...provider,
        authentication: { type: "workload-identity" },
      }),
    ).toBeUndefined();
  }).pipe(
    Effect.provideService(
      ServerSecretStore,
      ServerSecretStore.of({
        get: () => Effect.die("must not read a secret"),
        set: () => Effect.void,
        create: () => Effect.void,
        remove: () => Effect.void,
        getOrCreateRandom: () => Effect.die("unused"),
      }),
    ),
  ),
);

it.effect("resolves fresh redacted credentials only from the compute namespace", () =>
  Effect.gen(function* () {
    const names: string[] = [];
    let value = "first-credential";
    const resolve = resolveComputeCredential({
      ...provider,
      authentication: { type: "token", secretRef: "cloud-token" },
    }).pipe(
      Effect.provideService(
        ServerSecretStore,
        ServerSecretStore.of({
          get: (name) =>
            Effect.sync(() => {
              names.push(name);
              return Option.some(new TextEncoder().encode(value));
            }),
          set: () => Effect.void,
          create: () => Effect.void,
          remove: () => Effect.void,
          getOrCreateRandom: () => Effect.die("unused"),
        }),
      ),
    );
    const first = yield* resolve;
    expect(String(first)).not.toContain(value);
    expect(new TextDecoder().decode(Redacted.value(first!))).toBe(value);
    value = "rotated-credential";
    expect(new TextDecoder().decode(Redacted.value((yield* resolve)!))).toBe(value);
    expect(names).toEqual(["compute-cloud-token", "compute-cloud-token"]);
  }),
);

it.effect("rejects traversal and reports missing credentials without secret content", () =>
  Effect.gen(function* () {
    const store = ServerSecretStore.of({
      get: () => Effect.succeed(Option.none()),
      set: () => Effect.void,
      create: () => Effect.void,
      remove: () => Effect.void,
      getOrCreateRandom: () => Effect.die("unused"),
    });
    const bad = yield* resolveComputeCredential({
      ...provider,
      authentication: { type: "token", secretRef: "../session-key" },
    }).pipe(Effect.flip, Effect.provideService(ServerSecretStore, store));
    expect(bad.code).toBe("invalid-secret-ref");
    const missing = yield* resolveComputeCredential({
      ...provider,
      authentication: { type: "token", secretRef: "missing" },
    }).pipe(Effect.flip, Effect.provideService(ServerSecretStore, store));
    expect(missing.code).toBe("credential-unavailable");
  }),
);
