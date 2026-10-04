import type { ServerNetworkDiagnostics } from "@t3tools/contracts";
import { readTailscaleDiagnostics } from "@t3tools/tailscale";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ServerConfig from "../config.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";

/**
 * Reports how this host sees its own network, so a client that cannot reach
 * the environment over one route can ask over another what is wrong.
 */
export class NetworkDiagnostics extends Context.Service<
  NetworkDiagnostics,
  { readonly read: Effect.Effect<ServerNetworkDiagnostics> }
>()("t3/diagnostics/NetworkDiagnostics") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const read = Effect.gen(function* () {
    // The runtime state records the port actually bound, which differs from
    // the configured one when that was taken.
    const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath).pipe(
      Effect.orElseSucceed(() => Option.none()),
    );
    return {
      server: {
        port: Option.match(runtimeState, { onNone: () => null, onSome: (state) => state.port }),
        tailscaleServeEnabled: config.tailscaleServeEnabled,
        tailscaleServePort: config.tailscaleServePort,
      },
      tailscale: yield* readTailscaleDiagnostics,
    };
  }).pipe(
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.withSpan("NetworkDiagnostics.read"),
  );

  return NetworkDiagnostics.of({ read });
});

export const layer = Layer.effect(NetworkDiagnostics, make);
