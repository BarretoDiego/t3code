import {
  AUTOMATION_WS_METHODS,
  DELEGATED_TASK_TERMINAL_STATUSES,
  type DelegatedTask,
  DelegatedTaskStatus,
  IdempotencyKey,
  TaskDelegateInput,
  TaskUpdateInput,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { Argument, Command, Flag } from "effect/cli";

import { randomUuidV4 } from "../orchestration-v2/RandomUuid.ts";
import {
  cliFailure,
  failCli,
  idempotencyKeyFlag,
  jsonFlag,
  printJson,
  timeoutFlag,
  withClient,
} from "./common.ts";
import { type EnvironmentRpcClient, environmentTargetFlags } from "./environmentRpc.ts";
import { formatThreadTree, readMessage, resolveThread } from "./thread.ts";

const M = AUTOMATION_WS_METHODS;

/**
 * Statuses at which a waiter has something to act on: the task reported, ended,
 * or cannot go on without someone (blocked, or its outcome is unknown).
 */
export const TASK_WAIT_STATUSES: ReadonlyArray<DelegatedTask["status"]> = [
  "reported",
  "blocked",
  "unknown",
  ...DELEGATED_TASK_TERMINAL_STATUSES,
];

const taskArgument = Argument.String("task").pipe(
  Argument.withDescription("Task id or unique id prefix."),
);

const taskFlags = {
  ...environmentTargetFlags,
  task: taskArgument,
  json: jsonFlag,
} as const;

const mutationFlags = { ...taskFlags, idempotencyKey: idempotencyKeyFlag } as const;

/** Reads a JSON document from a file, or from stdin when the path is `-`. */
const readJsonFile = Effect.fn("cli.task.readJsonFile")(function* (path: string) {
  const text =
    path === "-"
      ? yield* (yield* Stdio.Stdio).stdin.pipe(Stream.decodeText(), Stream.mkString)
      : yield* (yield* FileSystem.FileSystem)
          .readFileString(path)
          .pipe(
            Effect.mapError((cause) =>
              cliFailure("INVALID_INPUT", `Cannot read ${path}: ${cause.message}`),
            ),
          );
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
    Effect.mapError(() => cliFailure("INVALID_INPUT", `${path} is not valid JSON.`)),
  );
});

/** Decodes a document against the server's own contract, so a bad file fails before any call. */
const decodeInput = <S extends Schema.Top>(schema: S, value: unknown, what: string) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError((cause) => cliFailure("INVALID_INPUT", `Invalid ${what}: ${cause.message}`)),
  );

/** The key a mutation runs under: the caller's, or a fresh one for a single attempt. */
const idempotencyKey = (flag: Option.Option<string>) =>
  Option.match(flag, {
    onSome: (value) =>
      Schema.decodeUnknownEffect(IdempotencyKey)(value).pipe(
        Effect.mapError(() =>
          cliFailure("INVALID_INPUT", "--idempotency-key must be 1 to 200 characters."),
        ),
      ),
    onNone: () => randomUuidV4.pipe(Effect.map((id) => IdempotencyKey.make(`cli:${id}`))),
  });

/** Resolves a task by full id or unique id prefix. An ambiguous prefix is refused. */
const resolveTask = Effect.fn("cli.task.resolve")(function* (
  client: EnvironmentRpcClient,
  identifier: string,
) {
  const trimmed = identifier.trim();
  if (trimmed.length === 0) return yield* failCli("INVALID_INPUT", "Task id cannot be empty.");
  const { tasks } = yield* client[M.tasksList]({ includeTerminal: true });
  const exact = tasks.find((task) => task.id === trimmed);
  const matches = exact ? [exact] : tasks.filter((task) => task.id.startsWith(trimmed));
  if (matches.length === 0) {
    return yield* failCli("NOT_FOUND", `No task matches '${trimmed}'.`);
  }
  if (matches.length > 1) {
    return yield* failCli(
      "CONFLICT",
      `'${trimmed}' matches ${matches.length} tasks: ${matches
        .slice(0, 5)
        .map((task) => task.id)
        .join(", ")}. Use a longer prefix.`,
    );
  }
  return matches[0]!;
});

function formatTaskLine(task: DelegatedTask): string {
  return [
    task.id,
    task.status.padEnd(16),
    task.contract.title,
    task.threadId === null ? "" : `thread ${task.threadId}`,
    task.statusReason === null ? "" : `(${task.statusReason})`,
  ]
    .join("  ")
    .trimEnd();
}

function formatTask(task: DelegatedTask): string {
  const lines = [
    formatTaskLine(task),
    `Objective: ${task.contract.objective}`,
    `Runs on ${task.executionEnvironmentId}${task.originEnvironmentId === task.executionEnvironmentId ? "" : `, delegated from ${task.originEnvironmentId}`} · revision ${task.revision} · attempts ${task.attemptCount}`,
    `Can: ${
      Object.entries(task.capabilities)
        .filter(([, allowed]) => allowed)
        .map(([name]) => name)
        .join(", ") || "nothing"
    }`,
  ];
  if (task.result !== null) {
    lines.push("", "Report:", task.result.summary || "(empty)");
    for (const criterion of task.result.criteria) {
      const mark = criterion.met === null ? "?" : criterion.met ? "x" : " ";
      lines.push(
        `  [${mark}] ${criterion.text}${criterion.evidence ? ` — ${criterion.evidence}` : ""}`,
      );
    }
  } else if (task.contract.acceptanceCriteria.length > 0) {
    lines.push("", "Acceptance criteria:");
    for (const criterion of task.contract.acceptanceCriteria) lines.push(`  [?] ${criterion}`);
  }
  return lines.join("\n");
}

const printTask = (task: DelegatedTask, json: boolean, extra: Record<string, unknown> = {}) =>
  json ? printJson({ task, ...extra }) : Console.log(formatTask(task));

/** Sends one `tasks.update` action and prints the task it returns. */
const updateCommand = <const Name extends string>(
  name: Name,
  description: string,
  action: TaskUpdateInput["action"],
) =>
  Command.make(name, mutationFlags).pipe(
    Command.withDescription(description),
    Command.withHandler(
      withClient(
        Effect.fn(`cli.task.${name}`)(function* (client, input) {
          const task = yield* resolveTask(client, input.task);
          const updated = yield* client[M.tasksUpdate]({
            idempotencyKey: yield* idempotencyKey(input.idempotencyKey),
            taskId: task.id,
            action,
          });
          yield* printTask(updated, input.json);
        }),
      ),
    ),
  );

const delegateCommand = Command.make("delegate", {
  ...environmentTargetFlags,
  file: Flag.String("file").pipe(
    Flag.withDescription(
      "JSON file with the task: {idempotencyKey, target, contract, parentThreadId?, ...}. Pass - to read it from stdin.",
    ),
  ),
  parent: Flag.String("parent").pipe(
    Flag.withDescription("Parent thread (id or unique prefix). Overrides the file."),
    Flag.optional,
  ),
  json: jsonFlag,
  idempotencyKey: idempotencyKeyFlag,
}).pipe(
  Command.withDescription(
    "Delegate a task: store its contract and start a managed thread for it. The same idempotency key always returns the same task and thread.",
  ),
  Command.withHandler(
    withClient(
      Effect.fn("cli.task.delegate")(function* (client, flags) {
        const document = yield* readJsonFile(flags.file);
        if (typeof document !== "object" || document === null || Array.isArray(document)) {
          return yield* failCli("INVALID_INPUT", "The task file must contain a JSON object.");
        }
        const parentThreadId = Option.isSome(flags.parent)
          ? (yield* resolveThread(client, flags.parent.value)).thread.id
          : undefined;
        const input = yield* decodeInput(
          TaskDelegateInput,
          {
            ...document,
            ...(Option.isSome(flags.idempotencyKey)
              ? { idempotencyKey: flags.idempotencyKey.value }
              : {}),
            ...(parentThreadId === undefined ? {} : { parentThreadId }),
          },
          "task",
        );
        const { task, created } = yield* client[M.tasksDelegate](input);
        if (flags.json) return yield* printJson({ task, created });
        yield* Console.log(
          `${created ? "Delegated" : "Already delegated"} ${task.id}: ${task.status}${task.threadId === null ? "" : `, thread ${task.threadId}`}.`,
        );
      }),
    ),
  ),
);

const showCommand = Command.make("show", taskFlags).pipe(
  Command.withDescription("Show a task: its contract, status, thread, and report."),
  Command.withHandler(
    withClient(
      Effect.fn("cli.task.show")(function* (client, flags) {
        yield* printTask(yield* resolveTask(client, flags.task), flags.json);
      }),
    ),
  ),
);

const listCommand = Command.make("list", {
  ...environmentTargetFlags,
  parent: Flag.String("parent").pipe(
    Flag.withDescription("Only tasks delegated from this thread (id or unique prefix)."),
    Flag.optional,
  ),
  status: Flag.Literals("status", DelegatedTaskStatus.literals).pipe(
    Flag.withDescription("Only tasks with this status; repeatable."),
    Flag.atLeast(0),
  ),
  all: Flag.Boolean("all").pipe(
    Flag.withDescription("Include finished tasks (validated, failed, cancelled, expired)."),
    Flag.withDefault(false),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("List delegated tasks. Finished ones are hidden unless --all."),
  Command.withHandler(
    withClient(
      Effect.fn("cli.task.list")(function* (client, flags) {
        const parentThreadId = Option.isSome(flags.parent)
          ? (yield* resolveThread(client, flags.parent.value)).thread.id
          : undefined;
        const { tasks } = yield* client[M.tasksList]({
          ...(parentThreadId === undefined ? {} : { parentThreadId }),
          ...(flags.status.length === 0 ? {} : { statuses: flags.status }),
          includeTerminal: flags.all,
        });
        if (flags.json) return yield* printJson({ tasks });
        if (tasks.length === 0) return yield* Console.log("No tasks.");
        yield* Console.log(tasks.map(formatTaskLine).join("\n"));
      }),
    ),
  ),
);

const treeCommand = Command.make("tree", taskFlags).pipe(
  Command.withDescription(
    "Show everything running under a task's thread: sub-tasks and provider subagents.",
  ),
  Command.withHandler(
    withClient(
      Effect.fn("cli.task.tree")(function* (client, flags) {
        const task = yield* resolveTask(client, flags.task);
        if (task.threadId === null) {
          return yield* failCli(
            "CONFLICT",
            `Task ${task.id} is ${task.status} and has no thread yet, so there is no tree under it.`,
            { taskId: task.id, status: task.status },
          );
        }
        const { nodes } = yield* client[M.threadTree]({ threadId: task.threadId });
        if (flags.json) return yield* printJson({ taskId: task.id, nodes });
        yield* Console.log(formatThreadTree(nodes));
      }),
    ),
  ),
);

const sendCommand = Command.make("send", {
  ...mutationFlags,
  message: Argument.String("message").pipe(
    Argument.withDescription("Message text. Omit or pass - to read it from stdin."),
    Argument.variadic(),
  ),
}).pipe(
  Command.withDescription("Send a message to the thread carrying out a task."),
  Command.withHandler(
    withClient(
      Effect.fn("cli.task.send")(function* (client, flags) {
        const text = (yield* readMessage(flags.message)).trim();
        const task = yield* resolveTask(client, flags.task);
        const updated = yield* client[M.tasksUpdate](
          yield* decodeInput(
            TaskUpdateInput,
            {
              idempotencyKey: yield* idempotencyKey(flags.idempotencyKey),
              taskId: task.id,
              action: { type: "send", text },
            },
            "message",
          ),
        );
        yield* printTask(updated, flags.json);
      }),
    ),
  ),
);

const cancelCommand = Command.make("cancel", {
  ...mutationFlags,
  reason: Flag.String("reason").pipe(
    Flag.withDescription("Why. Recorded on the task."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription(
    "Ask a task to stop. It is cancel_requested until its thread shows nothing running, then cancelled.",
  ),
  Command.withHandler(
    withClient(
      Effect.fn("cli.task.cancel")(function* (client, flags) {
        const task = yield* resolveTask(client, flags.task);
        const updated = yield* client[M.tasksUpdate]({
          idempotencyKey: yield* idempotencyKey(flags.idempotencyKey),
          taskId: task.id,
          action: {
            type: "cancel",
            ...(Option.isSome(flags.reason) ? { reason: flags.reason.value } : {}),
          },
        });
        yield* printTask(updated, flags.json);
      }),
    ),
  ),
);

const ValidationFile = Schema.Struct({
  criteria: Schema.Array(
    Schema.Struct({ met: Schema.Boolean, evidence: Schema.optional(Schema.String) }),
  ),
  summary: Schema.optional(Schema.String),
});

const validateCommand = Command.make("validate", {
  ...mutationFlags,
  file: Flag.String("file").pipe(
    Flag.withDescription(
      'JSON file {"criteria":[{"met":true,"evidence":"..."}],"summary":"..."} with one entry per acceptance criterion, in order. Pass - to read it from stdin.',
    ),
  ),
}).pipe(
  Command.withDescription(
    "Record that a reported task meets every acceptance criterion. A report is not accepted until this runs.",
  ),
  Command.withHandler(
    withClient(
      Effect.fn("cli.task.validate")(function* (client, flags) {
        const validation = yield* decodeInput(
          ValidationFile,
          yield* readJsonFile(flags.file),
          "validation",
        );
        const task = yield* resolveTask(client, flags.task);
        const updated = yield* client[M.tasksUpdate]({
          idempotencyKey: yield* idempotencyKey(flags.idempotencyKey),
          taskId: task.id,
          action: { type: "validate", ...validation },
        });
        yield* printTask(updated, flags.json);
      }),
    ),
  ),
);

const rejectCommand = Command.make("reject", {
  ...mutationFlags,
  reason: Argument.String("reason").pipe(
    Argument.withDescription("What is missing. Sent to the task's thread as its next message."),
    Argument.variadic(),
  ),
}).pipe(
  Command.withDescription(
    "Send a reported task back with the reason. Its thread gets the reason and the task runs again.",
  ),
  Command.withHandler(
    withClient(
      Effect.fn("cli.task.reject")(function* (client, flags) {
        const reason = (yield* readMessage(flags.reason)).trim();
        const task = yield* resolveTask(client, flags.task);
        const updated = yield* client[M.tasksUpdate](
          yield* decodeInput(
            TaskUpdateInput,
            {
              idempotencyKey: yield* idempotencyKey(flags.idempotencyKey),
              taskId: task.id,
              action: { type: "reject", reason },
            },
            "reason",
          ),
        );
        yield* printTask(updated, flags.json);
      }),
    ),
  ),
);

const reconcileCommand = updateCommand(
  "reconcile",
  "Re-read a task's thread and settle its status. For a task that is unknown after a restart; nothing is re-run.",
  { type: "reconcile" },
);

const waitCommand = Command.make("wait", {
  ...taskFlags,
  timeout: timeoutFlag,
}).pipe(
  Command.withDescription(
    "Block until a task reports, ends, or needs someone (blocked, unknown). Event-driven. A timeout exits 8 and cancels nothing.",
  ),
  Command.withHandler(
    withClient(
      Effect.fn("cli.task.wait")(function* (client, flags) {
        const task = yield* resolveTask(client, flags.task);
        const settled = (candidate: DelegatedTask) => TASK_WAIT_STATUSES.includes(candidate.status);
        // The journal position is read before the task, and events are replayed
        // from it, so a change between the two reads still arrives. Each event
        // is only a signal to read the task again.
        const { headCursor } = yield* client[M.eventsStatus]({});
        const waited = Stream.concat(
          Stream.make(null),
          client[M.eventsSubscribe]({
            afterCursor: headCursor,
            filter: { taskIds: [task.id] },
          }).pipe(Stream.filter((item) => item.type === "entry")),
        ).pipe(
          Stream.mapEffect(() => client[M.tasksGet]({ taskId: task.id })),
          Stream.filterMap((current) =>
            settled(current) ? Result.succeed(current) : Result.fail(current),
          ),
          Stream.runHead,
          Effect.flatMap(
            Option.match({
              onNone: () =>
                failCli("ENVIRONMENT_UNAVAILABLE", "The server closed the event stream."),
              onSome: Effect.succeed,
            }),
          ),
        );
        const result = yield* Option.match(flags.timeout, {
          onNone: () => waited,
          onSome: (duration) =>
            waited.pipe(
              Effect.timeoutOrElse({
                duration,
                orElse: () =>
                  Effect.fail(
                    cliFailure(
                      "WAIT_TIMEOUT",
                      `Timed out waiting for task ${task.id}. Nothing was cancelled: the task keeps running.`,
                      { taskId: task.id, cancelled: false },
                    ),
                  ),
              }),
            ),
        });
        yield* printTask(result, flags.json);
      }),
    ),
  ),
);

export const taskCommand = Command.make("task").pipe(
  Command.withDescription(
    "Delegate work to managed threads and follow it: delegate, show, list, tree, send, cancel, validate, reject, reconcile, wait.",
  ),
  Command.withSubcommands([
    delegateCommand,
    showCommand,
    listCommand,
    treeCommand,
    sendCommand,
    cancelCommand,
    validateCommand,
    rejectCommand,
    reconcileCommand,
    waitCommand,
  ]),
);
