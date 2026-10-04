import * as Console from "effect/Console";
import type * as Effect from "effect/Effect";
import { Flag } from "effect/unstable/cli";

import { DurationFromString } from "./config.ts";
import {
  type EnvironmentRpcClient,
  type EnvironmentTargetFlags,
  withEnvironmentRpc,
} from "./environmentRpc.ts";

export const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Print machine-readable JSON."),
  Flag.withDefault(false),
);

export const timeoutFlag = Flag.String("timeout").pipe(
  Flag.withSchema(DurationFromString),
  Flag.withDescription("Give up waiting after this long (e.g. 30s, 10m, 2h)."),
  Flag.optional,
);

export const printJson = (value: unknown) => Console.log(JSON.stringify(value, null, 2));

/** Prints one event of a stream as a single JSON line. */
export const printJsonLine = (value: unknown) => Console.log(JSON.stringify(value));

/** Runs a command handler against the target environment's RPC client. */
export const withClient =
  <Flags extends EnvironmentTargetFlags, A, E, R>(
    run: (client: EnvironmentRpcClient, flags: Flags) => Effect.Effect<A, E, R>,
  ) =>
  (flags: Flags) =>
    withEnvironmentRpc(flags, (client) => run(client, flags));
