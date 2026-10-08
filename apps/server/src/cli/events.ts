/**
 * `t3 events` - the environment's journal of automation events.
 *
 * The journal is addressed by cursor, so a command that starts after something
 * happened still sees it: read or watch from the cursor you last saw, or use a
 * named consumer and let the server remember the position.
 */
// @effect-diagnostics nodeBuiltinImport:off - Idempotency keys need a random UUID.
import * as NodeCrypto from "node:crypto";

import {
  AUTOMATION_WS_METHODS,
  AutomationEventEmitInput,
  DelegatedTaskId,
  EventConsumerId,
  OrchestratorId,
  ProjectId,
  ThreadId,
  type AutomationEventFilter,
  type AutomationJournalEntry,
  type AutomationJournalStatus,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { Argument, Command, Flag } from "effect/cli";

import { jsonFlag, printJson, printJsonLine, withClient } from "./common.ts";
import { environmentTargetFlags } from "./environmentRpc.ts";

const M = AUTOMATION_WS_METHODS;

export class AutomationCliError extends Schema.TaggedError<AutomationCliError>()(
  "AutomationCliError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

const fail = (detail: string) => Effect.fail(new AutomationCliError({ detail }));

// ---------------------------------------------------------------------------
// JSON bodies

export const bodyFileFlag = Flag.String("file").pipe(
  Flag.withDescription("Path of a JSON file, or - to read the JSON from stdin."),
);

/** Reads the text of `--file`: a path, or stdin when it is `-`. */
export const readBodyText = Effect.fn("cli.automation.readBodyText")(function* (file: string) {
  if (file !== "-") {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(file).pipe(Effect.catch(() => fail(`Could not read ${file}.`)));
  }
  const stdio = yield* Stdio.Stdio;
  if (yield* stdio.stdinIsTerminal) {
    return yield* fail("--file - reads JSON from stdin, but nothing is piped in.");
  }
  return yield* stdio.stdin.pipe(
    Stream.decodeText(),
    Stream.mkString,
    Effect.catch(() => fail("Could not read stdin.")),
  );
});

const decodeJsonObject = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

/**
 * Decodes a JSON object against a contract schema. `defaults` fill in fields
 * the body leaves out, which is how an edit keeps what it does not mention.
 */
export const decodeBody = <S extends Schema.Top>(
  schema: S,
  text: string,
  defaults: Readonly<Record<string, unknown>> = {},
) =>
  decodeJsonObject(text).pipe(
    Effect.mapError(() => new AutomationCliError({ detail: "The body is not a JSON object." })),
    Effect.flatMap((body) =>
      Schema.decodeUnknownEffect(schema)({ ...defaults, ...body }).pipe(
        Effect.mapError(
          (error) => new AutomationCliError({ detail: `The body is not valid: ${error.message}` }),
        ),
      ),
    ),
  );

// ---------------------------------------------------------------------------
// Filters and formatting

const repeated = (name: string, description: string) =>
  Flag.String(name).pipe(Flag.withDescription(description), Flag.atLeast(0));

const filterFlags = {
  type: repeated(
    "type",
    "Event type, or a prefix such as task.*; repeatable. Default: every type except administrative ones.",
  ),
  thread: repeated("thread", "Only events about this thread id; repeatable."),
  root: repeated("root", "Only events in the thread tree rooted at this thread id; repeatable."),
  project: repeated("project", "Only events about this project id; repeatable."),
  task: repeated("task", "Only events about this delegated task id; repeatable."),
  orchestrator: repeated("orchestrator", "Only events about this orchestrator id; repeatable."),
} as const;

interface FilterFlags {
  readonly type: ReadonlyArray<string>;
  readonly thread: ReadonlyArray<string>;
  readonly root: ReadonlyArray<string>;
  readonly project: ReadonlyArray<string>;
  readonly task: ReadonlyArray<string>;
  readonly orchestrator: ReadonlyArray<string>;
}

/** The filter the flags describe, or none when no filter flag was passed. */
export const filterFromFlags = (flags: FilterFlags): AutomationEventFilter | undefined => {
  const filter: AutomationEventFilter = {
    ...(flags.type.length === 0 ? {} : { types: flags.type }),
    ...(flags.thread.length === 0
      ? {}
      : { threadIds: flags.thread.map((id) => ThreadId.make(id)) }),
    ...(flags.root.length === 0
      ? {}
      : { rootThreadIds: flags.root.map((id) => ThreadId.make(id)) }),
    ...(flags.project.length === 0
      ? {}
      : { projectIds: flags.project.map((id) => ProjectId.make(id)) }),
    ...(flags.task.length === 0
      ? {}
      : { taskIds: flags.task.map((id) => DelegatedTaskId.make(id)) }),
    ...(flags.orchestrator.length === 0
      ? {}
      : { orchestratorIds: flags.orchestrator.map((id) => OrchestratorId.make(id)) }),
  };
  return Object.keys(filter).length === 0 ? undefined : filter;
};

const describeScope = (scope: AutomationJournalEntry["event"]["scope"]) =>
  [
    scope.threadId === undefined ? null : `thread=${scope.threadId}`,
    scope.parentThreadId === undefined ? null : `parent=${scope.parentThreadId}`,
    scope.taskId === undefined ? null : `task=${scope.taskId}`,
    scope.orchestratorId === undefined ? null : `orchestrator=${scope.orchestratorId}`,
    scope.requestId === undefined ? null : `request=${scope.requestId}`,
    scope.jobId === undefined ? null : `job=${scope.jobId}`,
  ]
    .filter((part) => part !== null)
    .join(" ");

/** One event as a line a person can scan: cursor, time, type, what it is about. */
export const formatEntryLine = (entry: AutomationJournalEntry) =>
  [String(entry.cursor), entry.event.recordedAt, entry.event.type, describeScope(entry.event.scope)]
    .filter((part) => part.length > 0)
    .join("  ");

const formatStatus = (status: AutomationJournalStatus) =>
  [
    `environment: ${status.environmentId}`,
    `head:        ${status.headCursor}`,
    `oldest:      ${status.oldestCursor ?? "-"}`,
    `retained:    ${status.retainedEntries}`,
  ].join("\n");

const cursorFlag = Flag.Int("cursor").pipe(
  Flag.withDescription("Start after this cursor (exclusive). 0 starts at the first event."),
  Flag.optional,
);

// ---------------------------------------------------------------------------
// Commands

const watchCommand = Command.make("watch", {
  ...environmentTargetFlags,
  cursor: cursorFlag,
  consumer: Flag.String("consumer").pipe(
    Flag.withDescription(
      "Named consumer. The server remembers its position, so the next watch resumes after the last event printed.",
    ),
    Flag.optional,
  ),
  ...filterFlags,
  format: Flag.Literals("format", ["text", "ndjson"]).pipe(
    Flag.withDescription("ndjson prints one JSON entry per line."),
    Flag.withDefault("text"),
  ),
  once: Flag.Boolean("once").pipe(
    Flag.withDescription("Stop once caught up instead of waiting for new events."),
    Flag.withDefault(false),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Print events from a cursor, then follow new ones. Without --cursor or --consumer, only new events.",
  ),
  Command.withHandler(
    withClient(
      Effect.fn("cli.events.watch")(function* (client, flags) {
        const ndjson = flags.json || flags.format === "ndjson";
        const consumerId = Option.getOrUndefined(Option.map(flags.consumer, EventConsumerId.make));
        const filter = filterFromFlags(flags);
        // Acknowledged only after the line is out, so a crash repeats an event rather than losing it.
        const acknowledge = (cursor: number) =>
          consumerId === undefined || cursor === 0
            ? Effect.void
            : Effect.asVoid(client[M.consumersAck]({ consumerId, cursor }));
        yield* client[M.eventsSubscribe]({
          ...(Option.isSome(flags.cursor) ? { afterCursor: flags.cursor.value } : {}),
          ...(filter === undefined ? {} : { filter }),
          ...(consumerId === undefined ? {} : { consumerId }),
        }).pipe(
          Stream.takeUntil((item) => flags.once && item.type === "live"),
          Stream.runForEach((item) =>
            item.type === "entry"
              ? (ndjson
                  ? printJsonLine(item.entry)
                  : Console.log(formatEntryLine(item.entry))
                ).pipe(Effect.andThen(acknowledge(item.entry.cursor)))
              : (ndjson || flags.once
                  ? Effect.void
                  : Console.error(`caught up at cursor ${item.cursor}; waiting for events`)
                ).pipe(Effect.andThen(acknowledge(item.cursor))),
          ),
        );
      }),
    ),
  ),
);

const readCommand = Command.make("read", {
  ...environmentTargetFlags,
  cursor: cursorFlag,
  limit: Flag.Int("limit").pipe(
    Flag.withDescription("Most events to return (up to 1000)."),
    Flag.withDefault(200),
  ),
  ...filterFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Print stored events after a cursor and the cursor to continue from."),
  Command.withHandler(
    withClient(
      Effect.fn("cli.events.read")(function* (client, flags) {
        const filter = filterFromFlags(flags);
        const result = yield* client[M.eventsRead]({
          ...(Option.isSome(flags.cursor) ? { afterCursor: flags.cursor.value } : {}),
          ...(filter === undefined ? {} : { filter }),
          limit: flags.limit,
        });
        if (flags.json) return yield* printJson(result);
        yield* Console.log(
          [
            ...result.entries.map(formatEntryLine),
            `next cursor: ${result.nextCursor}  (head ${result.status.headCursor})`,
          ].join("\n"),
        );
      }),
    ),
  ),
);

const statusCommand = Command.make("status", { ...environmentTargetFlags, json: jsonFlag }).pipe(
  Command.withDescription("Show the journal's head, oldest retained cursor, and size."),
  Command.withHandler(
    withClient(
      Effect.fn("cli.events.status")(function* (client, flags) {
        const status = yield* client[M.eventsStatus]({});
        yield* flags.json ? printJson(status) : Console.log(formatStatus(status));
      }),
    ),
  ),
);

const emitCommand = Command.make("emit", {
  ...environmentTargetFlags,
  file: bodyFileFlag,
  key: Flag.String("key").pipe(
    Flag.withDescription(
      "Idempotency key, when the body has none. Repeating a key returns the first event instead of adding another.",
    ),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Publish a custom event (type custom.<namespace>.<name>) from a JSON body.",
  ),
  Command.withHandler(
    withClient(
      Effect.fn("cli.events.emit")(function* (client, flags) {
        const input = yield* decodeBody(AutomationEventEmitInput, yield* readBodyText(flags.file), {
          idempotencyKey: Option.getOrElse(flags.key, () => NodeCrypto.randomUUID()),
        });
        const result = yield* client[M.eventsEmit](input);
        if (flags.json) return yield* printJson(result);
        yield* Console.log(
          `${result.created ? "Recorded" : "Already recorded as"} ${result.entry.event.type} at cursor ${result.entry.cursor} (${result.entry.event.eventId}).`,
        );
      }),
    ),
  ),
);

const consumersListCommand = Command.make("list", {
  ...environmentTargetFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("List named consumers and the cursor each has acknowledged."),
  Command.withHandler(
    withClient(
      Effect.fn("cli.events.consumers.list")(function* (client, flags) {
        const { consumers } = yield* client[M.consumersList]({});
        if (flags.json) return yield* printJson(consumers);
        yield* Console.log(
          consumers.length === 0
            ? "No consumers."
            : consumers
                .map((consumer) =>
                  [consumer.consumerId, `cursor ${consumer.cursor}`, consumer.updatedAt].join("  "),
                )
                .join("\n"),
        );
      }),
    ),
  ),
);

const consumersDeleteCommand = Command.make("delete", {
  ...environmentTargetFlags,
  consumer: Argument.String("consumer").pipe(Argument.withDescription("Consumer id.")),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Forget a named consumer. The journal no longer keeps events for it."),
  Command.withHandler(
    withClient(
      Effect.fn("cli.events.consumers.delete")(function* (client, flags) {
        const result = yield* client[M.consumersDelete]({
          consumerId: EventConsumerId.make(flags.consumer),
        });
        if (flags.json) return yield* printJson(result);
        yield* Console.log(
          result.removed
            ? `Deleted consumer ${flags.consumer}.`
            : `No consumer named ${flags.consumer}.`,
        );
      }),
    ),
  ),
);

export const eventsCommand = Command.make("events").pipe(
  Command.withDescription("Read, follow and publish the environment's automation events."),
  Command.withSubcommands([
    watchCommand,
    readCommand,
    statusCommand,
    emitCommand,
    Command.make("consumers").pipe(
      Command.withDescription("Manage named consumers of the event journal."),
      Command.withSubcommands([consumersListCommand, consumersDeleteCommand]),
    ),
  ]),
);
