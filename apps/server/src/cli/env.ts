import { EnvironmentHttpApi } from "@t3tools/contracts";
import { resolveRemotePairingTarget } from "@t3tools/shared/remote";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/unstable/cli";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import { baseDirFlag } from "./config.ts";
import { printJson } from "./thread.ts";
import {
  EnvironmentServerConnectError,
  exchangePairingCredential,
  fetchEnvironmentDescriptor,
  readSavedEnvironments,
  type SavedEnvironment,
  withSavedEnvironmentStore,
  writeSavedEnvironments,
} from "./environmentRpc.ts";

export class EnvironmentCommandError extends Schema.TaggedError<EnvironmentCommandError>()(
  "EnvironmentCommandError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return this.detail;
  }
}

const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The server origin a URL points at, with a trailing slash. */
function originOf(value: string): string | null {
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return `${url.origin}/`;
  } catch {
    return null;
  }
}

/** Resolves `t3 env add` input to a server origin and a bearer token. */
const resolveCredential = Effect.fn("cli.env.resolveCredential")(function* (
  target: string,
  token: Option.Option<string>,
) {
  if (Option.isSome(token)) {
    const origin = originOf(target);
    if (origin === null) {
      return yield* new EnvironmentCommandError({ detail: `'${target}' is not a server URL.` });
    }
    return { httpBaseUrl: origin, token: token.value.trim() };
  }
  const pairing = yield* Effect.try({
    try: () => resolveRemotePairingTarget({ pairingUrl: target }),
    catch: (cause) =>
      new EnvironmentCommandError({
        detail:
          "Pass a pairing link (Settings → Connections → pair a device), or a server URL with --token.",
        cause,
      }),
  });
  return {
    httpBaseUrl: pairing.httpBaseUrl,
    token: yield* exchangePairingCredential(pairing.httpBaseUrl, pairing.credential).pipe(
      Effect.mapError(
        (cause) =>
          new EnvironmentCommandError({
            detail: `${pairing.httpBaseUrl} rejected the pairing link. Links work once and expire; create a new one and try again.`,
            cause,
          }),
      ),
    ),
  };
});

const addCommand = Command.make("add", {
  baseDir: baseDirFlag,
  name: Argument.String("name").pipe(
    Argument.withDescription("Short name to target it with, e.g. `--env laptop`."),
  ),
  target: Argument.String("pairing-link-or-url").pipe(
    Argument.withDescription(
      "A pairing link from the target environment, or its URL when passing --token.",
    ),
  ),
  token: Flag.String("token").pipe(
    Flag.withDescription("Bearer token from `t3 auth session issue` on the target machine."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription(
    "Save a remote environment (direct URL, Tailscale, or T3 Connect tunnel) for --env.",
  ),
  Command.withHandler((flags) =>
    withSavedEnvironmentStore(
      flags,
      Effect.gen(function* () {
        if (!ENVIRONMENT_NAME_PATTERN.test(flags.name)) {
          return yield* new EnvironmentCommandError({
            detail: "Use letters, digits, '.', '_' or '-' for the environment name.",
          });
        }
        const credential = yield* resolveCredential(flags.target, flags.token);
        const descriptor = yield* fetchEnvironmentDescriptor(credential.httpBaseUrl);
        const http = yield* HttpApiClient.make(EnvironmentHttpApi, {
          baseUrl: credential.httpBaseUrl,
        });
        const session = yield* http.auth
          .session({ headers: { authorization: `Bearer ${credential.token}` } })
          .pipe(
            Effect.mapError(
              (cause) =>
                new EnvironmentServerConnectError({ origin: credential.httpBaseUrl, cause }),
            ),
          );
        if (!session.authenticated) {
          return yield* new EnvironmentCommandError({
            detail: `${descriptor.label} did not accept the credential.`,
          });
        }
        const saved = yield* readSavedEnvironments;
        const entry: SavedEnvironment = {
          name: flags.name,
          label: descriptor.label,
          environmentId: descriptor.environmentId,
          httpBaseUrl: credential.httpBaseUrl,
          token: credential.token,
          addedAt: DateTime.formatIso(yield* DateTime.now),
        };
        yield* writeSavedEnvironments([
          ...saved.filter((environment) => environment.name !== flags.name),
          entry,
        ]);
        yield* Console.log(
          `Saved ${flags.name}: ${descriptor.label} (${credential.httpBaseUrl}). Use --env ${flags.name}.`,
        );
      }),
    ),
  ),
);

const listCommand = Command.make("list", {
  baseDir: baseDirFlag,
  json: Flag.Boolean("json").pipe(Flag.withDefault(false)),
}).pipe(
  Command.withDescription("List saved environments."),
  Command.withHandler((flags) =>
    withSavedEnvironmentStore(
      flags,
      Effect.gen(function* () {
        const saved = yield* readSavedEnvironments;
        const rows = saved.map(({ token: _token, ...entry }) => entry);
        if (flags.json) return yield* printJson(rows);
        if (rows.length === 0) {
          return yield* Console.log("No saved environments. Add one with `t3 env add`.");
        }
        yield* Console.log(
          rows.map((row) => `${row.name}  ${row.label}  ${row.httpBaseUrl}`).join("\n"),
        );
      }),
    ),
  ),
);

const removeCommand = Command.make("remove", {
  baseDir: baseDirFlag,
  name: Argument.String("name"),
}).pipe(
  Command.withDescription(
    "Forget a saved environment. Revoke its access in that environment's Connections settings.",
  ),
  Command.withHandler((flags) =>
    withSavedEnvironmentStore(
      flags,
      Effect.gen(function* () {
        const saved = yield* readSavedEnvironments;
        if (!saved.some((environment) => environment.name === flags.name)) {
          return yield* new EnvironmentCommandError({
            detail: `No environment named '${flags.name}'.`,
          });
        }
        yield* writeSavedEnvironments(
          saved.filter((environment) => environment.name !== flags.name),
        );
        yield* Console.log(`Removed ${flags.name}.`);
      }),
    ),
  ),
);

export const envCommand = Command.make("env").pipe(
  Command.withDescription("Manage remote environments that CLI commands can target with --env."),
  Command.withSubcommands([addCommand, listCommand, removeCommand]),
);
