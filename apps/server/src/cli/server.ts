import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, GlobalFlag } from "effect/cli";
import * as CliError from "effect/cli/CliError";

import * as ServerConfig from "../config.ts";
import { runServer } from "../server.ts";
import { type CliServerFlags, resolveServerConfig, sharedServerCommandFlags } from "./config.ts";

const encodeCommand = Schema.encodeEffect(Schema.fromJsonString(Schema.String));

export class UnknownCommandError extends Schema.TaggedError<UnknownCommandError>()(
  "UnknownCommandError",
  { word: Schema.String },
) {
  override get message(): string {
    return `Unknown command '${this.word}'. Run \`t3 --help\` to see the commands. To start the server in a new folder, pass a path such as ./${this.word}.`;
  }
}

/**
 * The server commands take an optional working directory, so a mistyped or
 * unsupported subcommand (`t3 threads`) would otherwise start the server in a
 * freshly created folder of that name. A bare word that is not an existing
 * directory is treated as an unknown command instead; explicit paths
 * (`./name`, `~/name`, `/abs`) keep creating the folder.
 */
export const rejectUnknownCommand = Effect.fn("cli.rejectUnknownCommand")(function* (
  cwd: Option.Option<string>,
) {
  if (Option.isNone(cwd)) return;
  const word = cwd.value.trim();
  if (word.length === 0 || /[\\/~]/.test(word) || word.startsWith(".")) return;
  const fs = yield* FileSystem.FileSystem;
  const exists = yield* fs.exists(word).pipe(Effect.orElseSucceed(() => false));
  if (!exists) return yield* new UnknownCommandError({ word });
});

export const runServerCommand = (
  flags: CliServerFlags,
  options?: {
    readonly startupPresentation?: ServerConfig.StartupPresentation;
    readonly forceAutoBootstrapProjectFromCwd?: boolean;
    readonly rejectRunningServer?: boolean;
  },
) =>
  Effect.gen(function* () {
    yield* rejectUnknownCommand(flags.cwd ?? Option.none());
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveServerConfig(flags, logLevel, options);
    return yield* runServer.pipe(Effect.provideService(ServerConfig.ServerConfig, config));
  });

/** Bare words can name existing directories, but must not create typo projects. */
export const runDefaultServerCommand = (flags: CliServerFlags) =>
  Effect.gen(function* () {
    if (Option.isSome(flags.cwd)) {
      const cwd = flags.cwd.value.trim();
      const fs = yield* FileSystem.FileSystem;
      const platform = yield* HostProcessPlatform;
      const explicitPath =
        cwd === "." ||
        cwd === ".." ||
        cwd === "~" ||
        /[/\\]/.test(cwd) ||
        (platform === "win32" && /^[a-z]:/i.test(cwd));
      if (
        !explicitPath &&
        (!(yield* fs.exists(cwd)) || (yield* fs.stat(cwd)).type !== "Directory")
      ) {
        return yield* new CliError.UserError({
          cause: cwd,
          userMessage: `Unknown command ${yield* encodeCommand(cwd)}. Use "t3 --help" for commands or an explicit path such as "t3 ./my-project" for a new directory.`,
        });
      }
    }
    return yield* runServerCommand(flags, { rejectRunningServer: true });
  });

export const startCommand = Command.make("start", { ...sharedServerCommandFlags }).pipe(
  Command.withDescription("Run the T3 Code server."),
  Command.withHandler((flags) => runServerCommand(flags, { rejectRunningServer: true })),
);

export const serveCommand = Command.make("serve", { ...sharedServerCommandFlags }).pipe(
  Command.withDescription(
    "Run the T3 Code server without opening a browser and print headless pairing details.",
  ),
  Command.withHandler((flags) =>
    runServerCommand(flags, {
      startupPresentation: "headless",
      forceAutoBootstrapProjectFromCwd: false,
    }),
  ),
);
