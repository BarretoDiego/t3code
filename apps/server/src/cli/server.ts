import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, GlobalFlag } from "effect/cli";
import * as CliError from "effect/cli/CliError";

import * as ServerConfig from "../config.ts";
import { awaitLauncherLoss } from "../launcherWatch.ts";
import { runServer } from "../server.ts";
import { type CliServerFlags, resolveServerConfig, sharedServerCommandFlags } from "./config.ts";

const encodeCommand = Schema.encodeEffect(Schema.fromJsonString(Schema.String));

// The desktop launcher reads this process's stdout and stderr. Once it is gone,
// every log write fails, and Node turns an unhandled stream error into a crash
// that skips shutdown and leaves the ownership lock and runtime record behind.
function ignoreClosedLauncherPipe(error: NodeJS.ErrnoException): void {
  if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") throw error;
}

export class UnknownCommandError extends Schema.TaggedError<UnknownCommandError>()(
  "UnknownCommandError",
  { word: Schema.String },
) {
  override get message(): string {
    return `Unknown command '${this.word}'. Run \`t3 --help\` to see the commands. To start the server in a new folder, pass a path such as ./${this.word}.`;
  }
}

/**
 * Server commands take an optional working directory, so a mistyped subcommand (`t3 threads`) would otherwise start the server in a new folder of that name.
 * A bare word that is not an existing directory is treated as an unknown command; explicit paths (`./name`, `~/name`, `/abs`) keep creating the folder.
 */
export const rejectUnknownCommand = Effect.fn("cli.rejectUnknownCommand")(function* (
  cwd: Option.Option<string>,
) {
  if (Option.isNone(cwd)) return;
  const word = cwd.value.trim();
  // A drive prefix (`C:name`) is a Windows path, relative to that drive's directory.
  if (word.length === 0 || /[\\/~]/.test(word) || word.startsWith(".") || /^[A-Za-z]:/.test(word))
    return;
  const fs = yield* FileSystem.FileSystem;
  const exists = yield* fs.exists(word).pipe(Effect.orElseSucceed(() => false));
  if (!exists) return yield* new UnknownCommandError({ word });
});

export const runServerCommand = Effect.fn("server.runServerCommand")(function* (
  flags: CliServerFlags,
  options?: {
    readonly startupPresentation?: ServerConfig.StartupPresentation;
    readonly forceAutoBootstrapProjectFromCwd?: boolean;
    readonly rejectRunningServer?: boolean;
  },
) {
  yield* rejectUnknownCommand(flags.cwd ?? Option.none());
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveServerConfig(flags, logLevel, options);
  const run = runServer.pipe(Effect.provideService(ServerConfig.ServerConfig, config));
  if (config.mode !== "desktop" || config.desktopBootstrapToken === undefined) return yield* run;
  yield* Effect.sync(() => {
    process.stdout.on("error", ignoreClosedLauncherPipe);
    process.stderr.on("error", ignoreClosedLauncherPipe);
  });
  return yield* Effect.raceFirst(
    run,
    awaitLauncherLoss().pipe(
      // End like SIGTERM does (interrupt-only exit, so the runtime forces process exit).
      Effect.andThen(Effect.interrupt),
    ),
  );
});

export const runDefaultServerCommand = Effect.fn("server.runDefaultServerCommand")(function* (
  flags: CliServerFlags,
) {
  if (Option.isSome(flags.cwd)) {
    const cwd = flags.cwd.value.trim();
    const fs = yield* FileSystem.FileSystem;
    const platform = yield* HostProcess.Platform;
    const explicitPath =
      cwd === "." ||
      cwd === ".." ||
      cwd === "~" ||
      /[/\\]/.test(cwd) ||
      (platform === "win32" && /^[a-z]:/i.test(cwd));
    if (!explicitPath && (!(yield* fs.exists(cwd)) || (yield* fs.stat(cwd)).type !== "Directory")) {
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
