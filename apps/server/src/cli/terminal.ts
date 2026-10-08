import * as NodeUtil from "node:util";

import {
  DEFAULT_TERMINAL_ID,
  type TerminalAttachStreamEvent,
  type TerminalSummary,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { Argument, Command, Flag } from "effect/cli";

import { DurationFromString } from "./config.ts";
import { type EnvironmentRpcClient, environmentTargetFlags } from "./environmentRpc.ts";
import { jsonFlag, printJson, timeoutFlag, withClient } from "./common.ts";
import { resolveThread } from "./thread.ts";

export class TerminalCliError extends Schema.TaggedError<TerminalCliError>()("TerminalCliError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

/** Ctrl-] detaches an interactive session, as in telnet. */
const DETACH_BYTE = 0x1d;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;

const threadArgument = Argument.String("thread").pipe(
  Argument.withDescription("Thread id or unique id prefix that owns the terminal."),
);
const terminalFlag = Flag.String("terminal").pipe(
  Flag.withDescription(`Terminal id within the thread. Default: ${DEFAULT_TERMINAL_ID}.`),
  Flag.withDefault(DEFAULT_TERMINAL_ID),
);
const rawFlag = Flag.Boolean("raw").pipe(
  Flag.withDescription("Keep ANSI escape sequences in the output."),
  Flag.withDefault(false),
);

function plainText(data: string, raw: boolean): string {
  return raw ? data : NodeUtil.stripVTControlCharacters(data).replace(/\r\n?/g, "\n");
}

/**
 * The thread's terminal location: where the web opens it (the thread's
 * worktree, else the project root).
 */
const resolveTerminalTarget = Effect.fn("cli.terminal.target")(function* (
  client: EnvironmentRpcClient,
  identifier: string,
) {
  const { thread, project } = yield* resolveThread(client, identifier);
  const cwd = thread.worktreePath ?? project?.workspaceRoot;
  if (cwd === undefined) {
    return yield* new TerminalCliError({
      detail: `Thread ${thread.id} has no project directory to open a terminal in.`,
    });
  }
  return { threadId: thread.id, cwd, worktreePath: thread.worktreePath } as const;
});

type TerminalTarget = Effect.Success<ReturnType<typeof resolveTerminalTarget>>;

/** Attach stream for a terminal; opens it first when `open` is set. */
const attachStream = (
  client: EnvironmentRpcClient,
  target: TerminalTarget,
  terminalId: string,
  options: { readonly open: boolean; readonly cols?: number; readonly rows?: number },
) =>
  client[WS_METHODS.terminalAttach]({
    threadId: target.threadId,
    terminalId,
    ...(options.open
      ? {
          cwd: target.cwd,
          worktreePath: target.worktreePath,
          restartIfNotRunning: true,
          cols: options.cols ?? DEFAULT_COLS,
          rows: options.rows ?? DEFAULT_ROWS,
        }
      : {}),
  });

const firstSnapshot = (stream: ReturnType<typeof attachStream>) =>
  stream.pipe(
    Stream.filterMap((event) =>
      event.type === "snapshot" ? Result.succeed(event.snapshot) : Result.fail(event),
    ),
    Stream.runHead,
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(new TerminalCliError({ detail: "The terminal closed before attaching." })),
        onSome: Effect.succeed,
      }),
    ),
  );

const loadTerminals = (client: EnvironmentRpcClient) =>
  client[WS_METHODS.subscribeTerminalMetadata]({}).pipe(
    Stream.filterMap((event) =>
      event.type === "snapshot" ? Result.succeed(event.terminals) : Result.fail(event),
    ),
    Stream.runHead,
    Effect.map(Option.getOrElse((): ReadonlyArray<TerminalSummary> => [])),
  );

/**
 * Opens the terminal if needed. A shell that just started is still printing
 * its prompt; input sent before it settles gets echoed twice, so wait for the
 * startup output to go quiet first.
 */
const ensureTerminal = Effect.fn("cli.terminal.ensure")(function* (
  client: EnvironmentRpcClient,
  target: TerminalTarget,
  terminalId: string,
) {
  const snapshot = yield* firstSnapshot(attachStream(client, target, terminalId, { open: true }));
  if (snapshot.history.trim().length > 0) return snapshot;
  yield* attachStream(client, target, terminalId, { open: false }).pipe(
    Stream.filter((event) => event.type === "output"),
    Stream.timeout(Duration.seconds(1)),
    Stream.runDrain,
    Effect.timeoutOption(Duration.seconds(8)),
  );
  return snapshot;
});

/** Fails clearly instead of attaching to a terminal that does not exist. */
const requireExistingTerminal = Effect.fn("cli.terminal.requireExisting")(function* (
  client: EnvironmentRpcClient,
  threadId: string,
  terminalId: string,
) {
  const terminals = yield* loadTerminals(client);
  if (!terminals.some((entry) => entry.threadId === threadId && entry.terminalId === terminalId)) {
    return yield* new TerminalCliError({
      detail: `No terminal ${terminalId} on thread ${threadId}. Open one with \`t3 terminal open\`.`,
    });
  }
});

const writeOut = (text: string) =>
  Effect.flatMap(Stdio.Stdio, (stdio) =>
    Stream.make(text).pipe(Stream.run(stdio.stdout({ endOnDone: false }))),
  );

// ---------------------------------------------------------------------------
// Commands

const listCommand = Command.make("list", {
  ...environmentTargetFlags,
  thread: Flag.String("thread").pipe(
    Flag.withDescription("Only this thread's terminals."),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("List terminals and what they are running."),
  Command.withHandler(
    withClient(
      Effect.fn("cli.terminal.list")(function* (client, flags) {
        const threadId = Option.isSome(flags.thread)
          ? (yield* resolveThread(client, flags.thread.value)).thread.id
          : undefined;
        const terminals = (yield* loadTerminals(client)).filter(
          (terminal) => threadId === undefined || terminal.threadId === threadId,
        );
        if (flags.json) return yield* printJson(terminals);
        if (terminals.length === 0) return yield* Console.log("No terminals.");
        yield* Console.log(
          terminals
            .map(
              (terminal) =>
                `${terminal.threadId}  ${terminal.terminalId}  ${terminal.status.padEnd(8)}  ${terminal.label}  ${terminal.cwd}`,
            )
            .join("\n"),
        );
      }),
    ),
  ),
);

const openCommand = Command.make("open", {
  ...environmentTargetFlags,
  thread: threadArgument,
  terminal: terminalFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Open (or restart) a thread's terminal in its workspace."),
  Command.withHandler(
    withClient(
      Effect.fn("cli.terminal.open")(function* (client, flags) {
        const target = yield* resolveTerminalTarget(client, flags.thread);
        const snapshot = yield* firstSnapshot(
          attachStream(client, target, flags.terminal, { open: true }),
        );
        const { history: _history, ...summary } = snapshot;
        if (flags.json) return yield* printJson(summary);
        yield* Console.log(
          `Terminal ${snapshot.terminalId} on ${snapshot.threadId} is ${snapshot.status} in ${snapshot.cwd}.`,
        );
      }),
    ),
  ),
);

const readCommand = Command.make("read", {
  ...environmentTargetFlags,
  thread: threadArgument,
  terminal: terminalFlag,
  lines: Flag.Int("lines").pipe(
    Flag.withDescription("How many trailing lines of scrollback to print."),
    Flag.withDefault(200),
  ),
  raw: rawFlag,
}).pipe(
  Command.withDescription("Print a terminal's recent scrollback."),
  Command.withHandler(
    withClient(
      Effect.fn("cli.terminal.read")(function* (client, flags) {
        const target = yield* resolveTerminalTarget(client, flags.thread);
        yield* requireExistingTerminal(client, target.threadId, flags.terminal);
        const snapshot = yield* firstSnapshot(
          attachStream(client, target, flags.terminal, { open: false }),
        );
        const lines = plainText(snapshot.history, flags.raw).split("\n");
        yield* Console.log(lines.slice(-Math.max(1, flags.lines)).join("\n"));
      }),
    ),
  ),
);

const writeCommand = Command.make("write", {
  ...environmentTargetFlags,
  thread: threadArgument,
  text: Argument.String("text").pipe(
    Argument.withDescription("Text to type into the terminal."),
    Argument.variadic(),
  ),
  terminal: terminalFlag,
  noEnter: Flag.Boolean("no-enter").pipe(
    Flag.withDescription("Do not press Enter after the text."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("Type text into a terminal (opening it if needed), then press Enter."),
  Command.withHandler(
    withClient(
      Effect.fn("cli.terminal.write")(function* (client, flags) {
        const target = yield* resolveTerminalTarget(client, flags.thread);
        yield* ensureTerminal(client, target, flags.terminal);
        const data = `${flags.text.join(" ")}${flags.noEnter ? "" : "\r"}`;
        if (data.length === 0) {
          return yield* new TerminalCliError({ detail: "Nothing to write." });
        }
        yield* client[WS_METHODS.terminalWrite]({
          threadId: target.threadId,
          terminalId: flags.terminal,
          data,
        });
      }),
    ),
  ),
);

const runCommand = Command.make("run", {
  ...environmentTargetFlags,
  thread: threadArgument,
  command: Argument.String("command").pipe(
    Argument.withDescription("Shell command line to run."),
    Argument.variadic(),
  ),
  terminal: terminalFlag,
  idle: Flag.String("idle").pipe(
    Flag.withSchema(DurationFromString),
    Flag.withDescription("Stop collecting once the terminal is quiet this long. Default: 2s."),
    Flag.optional,
  ),
  timeout: timeoutFlag,
  raw: rawFlag,
}).pipe(
  Command.withDescription(
    "Run a command in a thread's terminal and print the output it produces until it goes quiet.",
  ),
  Command.withHandler(
    withClient(
      Effect.fn("cli.terminal.run")(function* (client, flags) {
        const commandLine = flags.command.join(" ").trim();
        if (commandLine.length === 0) {
          return yield* new TerminalCliError({ detail: "Pass a command to run." });
        }
        const target = yield* resolveTerminalTarget(client, flags.thread);
        yield* ensureTerminal(client, target, flags.terminal);
        const idle = Option.getOrElse(flags.idle, () => Duration.seconds(2));
        const chunks: string[] = [];
        let exited = false;
        const collect = attachStream(client, target, flags.terminal, { open: false }).pipe(
          // Send the command only once attached, so no output is missed.
          Stream.tap((event) =>
            event.type === "snapshot"
              ? client[WS_METHODS.terminalWrite]({
                  threadId: target.threadId,
                  terminalId: flags.terminal,
                  data: `${commandLine}\r`,
                })
              : Effect.void,
          ),
          Stream.filter(
            (event): event is Extract<TerminalAttachStreamEvent, { type: "output" | "exited" }> =>
              event.type === "output" || event.type === "exited",
          ),
          Stream.takeUntil((event) => event.type === "exited"),
          Stream.timeout(idle),
          Stream.runForEach((event) =>
            Effect.sync(() => {
              if (event.type === "output") chunks.push(event.data);
              else exited = true;
            }),
          ),
        );
        if (Option.isSome(flags.timeout)) {
          yield* collect.pipe(Effect.timeoutOption(flags.timeout.value));
        } else {
          yield* collect;
        }
        yield* writeOut(plainText(chunks.join(""), flags.raw));
        if (exited) yield* Console.log("\n[terminal exited]");
      }),
    ),
  ),
);

const attachCommand = Command.make("attach", {
  ...environmentTargetFlags,
  thread: threadArgument,
  terminal: terminalFlag,
}).pipe(
  Command.withDescription(
    "Attach this terminal to a thread's terminal. Ctrl-] detaches; without a TTY it only follows output.",
  ),
  Command.withHandler(
    withClient(
      Effect.fn("cli.terminal.attach")(function* (client, flags) {
        const stdio = yield* Stdio.Stdio;
        const target = yield* resolveTerminalTarget(client, flags.thread);
        const interactive = (yield* stdio.stdinIsTerminal) && (yield* stdio.stdoutIsTerminal);
        const size = () => ({
          cols: process.stdout.columns || DEFAULT_COLS,
          rows: process.stdout.rows || DEFAULT_ROWS,
        });
        const session = { threadId: target.threadId, terminalId: flags.terminal };

        const output = attachStream(client, target, flags.terminal, {
          open: true,
          ...(interactive ? size() : {}),
        }).pipe(
          Stream.takeUntil((event) => event.type === "exited" || event.type === "closed"),
          Stream.runForEach((event) => {
            switch (event.type) {
              case "snapshot":
                return writeOut(event.snapshot.history);
              case "output":
                return writeOut(event.data);
              case "exited":
                return writeOut("\r\n[terminal exited]\r\n");
              case "closed":
                return writeOut("\r\n[terminal closed]\r\n");
              default:
                return Effect.void;
            }
          }),
        );
        if (!interactive) return yield* output;

        const input = stdio.stdin.pipe(
          Stream.takeUntil((chunk) => chunk.includes(DETACH_BYTE)),
          Stream.runForEach((chunk) => {
            const detachAt = chunk.indexOf(DETACH_BYTE);
            const data = new TextDecoder().decode(
              detachAt === -1 ? chunk : chunk.subarray(0, detachAt),
            );
            return data.length === 0
              ? Effect.void
              : client[WS_METHODS.terminalWrite]({ ...session, data });
          }),
        );
        const resizes = Stream.callback<void>((queue) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              const onResize = () => Queue.offerUnsafe(queue, undefined);
              process.stdout.on("resize", onResize);
              return onResize;
            }),
            (onResize) => Effect.sync(() => process.stdout.off("resize", onResize)),
          ),
        ).pipe(
          Stream.runForEach(() =>
            client[WS_METHODS.terminalResize]({ ...session, ...size() }).pipe(Effect.ignore),
          ),
        );

        yield* Effect.acquireUseRelease(
          Effect.sync(() => process.stdin.setRawMode(true)),
          () =>
            Effect.raceFirst(output, Effect.raceFirst(input, resizes)).pipe(
              Effect.andThen(writeOut("\r\n[detached]\r\n")),
            ),
          () => Effect.sync(() => process.stdin.setRawMode(false)),
        );
      }),
    ),
  ),
);

/** A terminal command that sends one request and reports it. */
const terminalAction = <E>(
  name: string,
  description: string,
  run: (
    client: EnvironmentRpcClient,
    target: TerminalTarget,
    terminalId: string,
  ) => Effect.Effect<unknown, E>,
  done: string,
) =>
  Command.make(name, {
    ...environmentTargetFlags,
    thread: threadArgument,
    terminal: terminalFlag,
  }).pipe(
    Command.withDescription(description),
    Command.withHandler(
      withClient(
        Effect.fn(`cli.terminal.${name}`)(function* (client, flags) {
          const target = yield* resolveTerminalTarget(client, flags.thread);
          yield* run(client, target, flags.terminal);
          yield* Console.log(`${done} ${flags.terminal} on ${target.threadId}.`);
        }),
      ),
    ),
  );

const clearCommand = terminalAction(
  "clear",
  "Clear a terminal's screen and scrollback.",
  (client, target, terminalId) =>
    client[WS_METHODS.terminalClear]({ threadId: target.threadId, terminalId }),
  "Cleared",
);

const restartCommand = terminalAction(
  "restart",
  "Restart a terminal's shell.",
  (client, target, terminalId) =>
    client[WS_METHODS.terminalRestart]({
      threadId: target.threadId,
      terminalId,
      cwd: target.cwd,
      worktreePath: target.worktreePath,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
    }),
  "Restarted",
);

const closeCommand = Command.make("close", {
  ...environmentTargetFlags,
  thread: threadArgument,
  terminal: terminalFlag,
  deleteHistory: Flag.Boolean("delete-history").pipe(
    Flag.withDescription("Also delete the saved scrollback."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("Close a terminal."),
  Command.withHandler(
    withClient(
      Effect.fn("cli.terminal.close")(function* (client, flags) {
        const target = yield* resolveTerminalTarget(client, flags.thread);
        yield* client[WS_METHODS.terminalClose]({
          threadId: target.threadId,
          terminalId: flags.terminal,
          deleteHistory: flags.deleteHistory,
        });
        yield* Console.log(`Closed ${flags.terminal} on ${target.threadId}.`);
      }),
    ),
  ),
);

export const terminalCommand = Command.make("terminal").pipe(
  Command.withDescription("Use the terminals of a thread's workspace, locally or with --env."),
  Command.withSubcommands([
    listCommand,
    openCommand,
    runCommand,
    readCommand,
    writeCommand,
    attachCommand,
    clearCommand,
    restartCommand,
    closeCommand,
  ]),
);
