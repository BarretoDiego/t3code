/**
 * `t3 orchestrator` - persistent orchestrators.
 *
 * An orchestrator is a coordinator with its own main thread, inbox, budget and
 * checkpoints. It is woken by what lands in its inbox, never by polling. These
 * commands create and edit one, talk to it, and inspect what it is doing.
 */
import * as NodeCrypto from "node:crypto";

import {
  AUTOMATION_WS_METHODS,
  DelegatedTaskId,
  IdempotencyKey,
  type InboxEntry,
  InboxEntryId,
  InboxEntryStatus,
  type Orchestrator,
  type OrchestratorCheckpoint,
  type OrchestratorDesiredState,
  OrchestratorId,
  OrchestratorUpsertInput,
  type PendingRequestSummary,
  type ResponsibilityClaim,
  type ResponsibilityOwner,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { Argument, Command, Flag } from "effect/unstable/cli";

import { jsonFlag, printJson, withClient } from "./common.ts";
import { type EnvironmentRpcClient, environmentTargetFlags } from "./environmentRpc.ts";
import { readMessage } from "./thread.ts";

const M = AUTOMATION_WS_METHODS;

export class OrchestratorCliError extends Schema.TaggedError<OrchestratorCliError>()(
  "OrchestratorCliError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

const fail = (detail: string) => Effect.fail(new OrchestratorCliError({ detail }));

/** The RPC methods these commands use: the same ones the app and agents call. */
export type OrchestratorCliClient = Pick<
  EnvironmentRpcClient,
  | typeof M.orchestratorsList
  | typeof M.orchestratorsUpsert
  | typeof M.orchestratorsSetState
  | typeof M.orchestratorsDelete
  | typeof M.orchestratorsSend
  | typeof M.orchestratorsInbox
  | typeof M.orchestratorsResolveInbox
  | typeof M.orchestratorsCheckpoints
  | typeof M.requestsList
  | typeof M.claimsTransfer
>;

// ---------------------------------------------------------------------------
// Definition files

const decodeJsonObject = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const decodeUpsertInput = Schema.decodeUnknownEffect(OrchestratorUpsertInput);

const CONFIG_KEYS = [
  "name",
  "scope",
  "projectId",
  "modelSelection",
  "profile",
  "runtimeMode",
  "instructions",
  "permissions",
  "budget",
  "responsibilityOrder",
  "batchWindowMs",
] as const;

/** Reads a definition file's JSON object, rejecting anything that is not one. */
export const parseDefinition = (text: string) =>
  decodeJsonObject(text).pipe(
    Effect.mapError(
      () => new OrchestratorCliError({ detail: "The definition must be a JSON object." }),
    ),
  );

/** A full definition, as `create` needs it. Reports the first field that is wrong. */
export const decodeDefinition = (definition: Readonly<Record<string, unknown>>) =>
  decodeUpsertInput(definition).pipe(
    Effect.mapError(
      (cause) =>
        new OrchestratorCliError({ detail: `The definition is not valid: ${cause.message}` }),
    ),
  );

/**
 * The definition an edit sends: the stored one with the file's fields over it.
 * An edit names the revision it read, so a concurrent edit is rejected rather
 * than overwritten; the file may pin `expectedRevision` itself.
 */
export const mergeDefinition = (
  existing: Orchestrator,
  patch: Readonly<Record<string, unknown>>,
) => {
  if (patch.id !== undefined && patch.id !== existing.id) {
    return fail(`The definition is for ${String(patch.id)}, not ${existing.id}.`);
  }
  const current = Object.fromEntries(
    CONFIG_KEYS.flatMap((key) => (existing[key] === undefined ? [] : [[key, existing[key]]])),
  );
  return decodeDefinition({
    ...current,
    ...patch,
    id: existing.id,
    expectedRevision: patch.expectedRevision ?? existing.revision,
  });
};

const readDefinitionText = Effect.fn("cli.orchestrator.readDefinitionText")(function* (
  file: string,
) {
  if (file === "-") {
    const stdio = yield* Stdio.Stdio;
    return yield* stdio.stdin.pipe(Stream.decodeText(), Stream.mkString);
  }
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem
    .readFileString(file)
    .pipe(Effect.mapError(() => new OrchestratorCliError({ detail: `Cannot read ${file}.` })));
});

// ---------------------------------------------------------------------------
// Lookup

/** Finds one orchestrator by id, unique id prefix, or exact name. */
export const resolveOrchestrator = (
  orchestrators: ReadonlyArray<Orchestrator>,
  identifier: string,
): Effect.Effect<Orchestrator, OrchestratorCliError> => {
  const wanted = identifier.trim();
  const exact = orchestrators.filter((orchestrator) => orchestrator.id === wanted);
  const byPrefix =
    wanted.length === 0
      ? []
      : orchestrators.filter(
          (orchestrator) =>
            orchestrator.id.startsWith(wanted) ||
            orchestrator.id.split(":").at(-1)?.startsWith(wanted),
        );
  const byName = orchestrators.filter(
    (orchestrator) => orchestrator.name.toLowerCase() === wanted.toLowerCase(),
  );
  const matches = exact.length > 0 ? exact : byPrefix.length > 0 ? byPrefix : byName;
  if (matches.length === 1) return Effect.succeed(matches[0]!);
  return fail(
    matches.length === 0
      ? `No orchestrator matches "${identifier}". Run \`t3 orchestrator list\`.`
      : `"${identifier}" matches ${matches.length} orchestrators: ${matches.map((match) => match.id).join(", ")}.`,
  );
};

/**
 * Reads `--to`: `user`, `thread:<id>`, or `orchestrator:<id>` (an id, prefix
 * or name, resolved against the orchestrators this environment knows).
 */
export const parseOwner = (
  orchestrators: ReadonlyArray<Orchestrator>,
  value: string,
): Effect.Effect<ResponsibilityOwner, OrchestratorCliError> => {
  const text = value.trim();
  if (text === "user") return Effect.succeed({ kind: "user" });
  if (text.startsWith("thread:") && text.length > "thread:".length) {
    return Effect.succeed({ kind: "thread", threadId: ThreadId.make(text) });
  }
  if (text.startsWith("orchestrator:")) {
    return resolveOrchestrator(orchestrators, text.slice("orchestrator:".length)).pipe(
      Effect.catch(() => resolveOrchestrator(orchestrators, text)),
      Effect.map((orchestrator) => ({
        kind: "orchestrator" as const,
        orchestratorId: orchestrator.id,
        environmentId: orchestrator.hostEnvironmentId,
      })),
    );
  }
  return fail("--to takes user, thread:<id>, or orchestrator:<id>.");
};

// ---------------------------------------------------------------------------
// Formatting

const describeOwner = (owner: ResponsibilityOwner) =>
  owner.kind === "user"
    ? "user"
    : owner.kind === "thread"
      ? owner.threadId
      : `${owner.orchestratorId} on ${owner.environmentId}`;

const describeTokens = (orchestrator: Orchestrator) =>
  orchestrator.usage.tokens === null
    ? "unknown"
    : `${orchestrator.usage.tokens}${orchestrator.usage.tokensComplete ? "" : "+ (incomplete)"}`;

export const formatOrchestratorLine = (orchestrator: Orchestrator) =>
  [
    orchestrator.id,
    orchestrator.effectiveState +
      (orchestrator.desiredState === "active" ? "" : ` (wanted ${orchestrator.desiredState})`),
    orchestrator.scope,
    `inbox ${orchestrator.inboxPending}`,
    orchestrator.name,
  ].join("  ");

export const formatOrchestratorDetail = (orchestrator: Orchestrator) => {
  const budget = Object.entries(orchestrator.budget)
    .filter(([, value]) => value !== null)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
  return [
    `${orchestrator.name}  (${orchestrator.id}, revision ${orchestrator.revision})`,
    `State:       ${orchestrator.effectiveState}; wanted ${orchestrator.desiredState}`,
    ...(orchestrator.stateReason === null ? [] : [`Reason:      ${orchestrator.stateReason}`]),
    `Scope:       ${orchestrator.scope}, project ${orchestrator.projectId}`,
    `Host:        ${orchestrator.hostEnvironmentId} (generation ${orchestrator.hostGeneration})`,
    `Main thread: ${orchestrator.threadId ?? "-"}`,
    `Model:       ${orchestrator.modelSelection.instanceId}/${orchestrator.modelSelection.model}, ${orchestrator.runtimeMode}`,
    `Inbox:       ${orchestrator.inboxPending} pending`,
    `Usage:       ${orchestrator.usage.turns} turns (${orchestrator.usage.turnsLastHour} in the last hour), tokens ${describeTokens(orchestrator)}, ${orchestrator.usage.activeChildren} active children`,
    `Budget:      ${budget.length === 0 ? "no limits" : budget}`,
    `Actions:     ${orchestrator.permissions.actions.join(", ") || "none"}`,
    `Last turn:   ${orchestrator.lastTurnAt ?? "never"}; last checkpoint ${orchestrator.lastCheckpointAt ?? "never"}`,
  ].join("\n");
};

const oneLine = (text: string, max: number) => {
  const compact = text.trim().replace(/\s+/gu, " ");
  return compact.length <= max ? compact : `${compact.slice(0, max - 1).trimEnd()}…`;
};

export const formatInboxEntry = (entry: InboxEntry) =>
  [
    entry.id,
    entry.status,
    entry.relevance,
    entry.kind,
    entry.receivedAt,
    oneLine(entry.text ?? entry.entries.map(({ event }) => event.type).join(", "), 80),
  ].join("  ");

const formatCheckpoint = (checkpoint: OrchestratorCheckpoint) =>
  [
    `#${checkpoint.sequence}  ${checkpoint.createdAt}  run ${checkpoint.runId ?? "-"}  inbox cursor ${checkpoint.inboxCursor}`,
    `  goals ${checkpoint.state.goals.length}, open tasks ${checkpoint.state.openTaskIds.length}, pending operations ${checkpoint.state.pendingOperations.length}, decisions ${checkpoint.state.decisions.length}`,
    `  ${oneLine(checkpoint.state.summary, 200)}`,
  ].join("\n");

const formatClaim = (claim: ResponsibilityClaim) =>
  `${describeOwner(claim.owner)} (${claim.rule}, generation ${claim.generation})`;

const formatRequest = (request: PendingRequestSummary) =>
  [
    request.requestId,
    request.kind + (request.reservedForUser ? " (reserved for the user)" : ""),
    `thread ${request.threadId}`,
    request.claim === null ? "unclaimed" : `owner ${formatClaim(request.claim)}`,
  ].join("  ");

// ---------------------------------------------------------------------------
// Operations

const newKey = () => IdempotencyKey.make(NodeCrypto.randomUUID());

/**
 * What each command does, against the RPC methods only. Commands print the
 * result; tests run these against the services directly.
 */
export const orchestratorOperations = (client: OrchestratorCliClient) => {
  const list = client[M.orchestratorsList]({}).pipe(Effect.map((result) => result.orchestrators));
  const find = (identifier: string) =>
    list.pipe(Effect.flatMap((orchestrators) => resolveOrchestrator(orchestrators, identifier)));

  const setState = Effect.fn("cli.orchestrator.setState")(function* (
    identifier: string,
    desiredState: OrchestratorDesiredState | "unchanged",
    interruptActiveTurn: boolean,
  ) {
    const orchestrator = yield* find(identifier);
    return yield* client[M.orchestratorsSetState]({
      orchestratorId: orchestrator.id,
      desiredState: desiredState === "unchanged" ? orchestrator.desiredState : desiredState,
      ...(interruptActiveTurn ? { interruptActiveTurn: true } : {}),
    });
  });

  return {
    list,
    find,
    create: Effect.fn("cli.orchestrator.create")(function* (definitionText: string) {
      const definition = yield* decodeDefinition(yield* parseDefinition(definitionText));
      return yield* client[M.orchestratorsUpsert]({
        ...definition,
        idempotencyKey: definition.idempotencyKey ?? newKey(),
      });
    }),
    edit: Effect.fn("cli.orchestrator.edit")(function* (
      identifier: string,
      definitionText: string,
    ) {
      const existing = yield* find(identifier);
      return yield* client[M.orchestratorsUpsert](
        yield* mergeDefinition(existing, yield* parseDefinition(definitionText)),
      );
    }),
    send: Effect.fn("cli.orchestrator.send")(function* (
      identifier: string,
      text: string,
      idempotencyKey: Option.Option<string>,
    ) {
      const orchestrator = yield* find(identifier);
      const trimmed = text.trim();
      if (trimmed.length === 0) return yield* fail("The message is empty.");
      return yield* client[M.orchestratorsSend]({
        idempotencyKey: Option.match(idempotencyKey, {
          onNone: newKey,
          onSome: (key) => IdempotencyKey.make(key),
        }),
        orchestratorId: orchestrator.id,
        text: trimmed,
      });
    }),
    setState,
    inbox: Effect.fn("cli.orchestrator.inbox")(function* (
      identifier: string,
      statuses: ReadonlyArray<InboxEntryStatus>,
      limit: number,
    ) {
      const orchestrator = yield* find(identifier);
      const { entries } = yield* client[M.orchestratorsInbox]({
        orchestratorId: orchestrator.id,
        ...(statuses.length === 0 ? {} : { statuses }),
        limit,
      });
      return entries;
    }),
    /** An entry id is unique, so the orchestrator is found from it. */
    resolveInbox: Effect.fn("cli.orchestrator.resolveInbox")(function* (
      entryId: string,
      resolution: "requeue" | "dismiss",
    ) {
      const wanted = entryId.trim();
      for (const orchestrator of yield* list) {
        const { entries } = yield* client[M.orchestratorsInbox]({
          orchestratorId: orchestrator.id,
          statuses: ["pending", "unknown"],
        });
        const entry = entries.find((candidate) => candidate.id === wanted);
        if (entry === undefined) continue;
        return yield* client[M.orchestratorsResolveInbox]({
          orchestratorId: orchestrator.id,
          entryId: InboxEntryId.make(entry.id),
          resolution,
        });
      }
      return yield* fail(
        `No pending or unknown inbox entry "${entryId}". Run \`t3 orchestrator inbox <orchestrator>\`.`,
      );
    }),
    checkpoints: Effect.fn("cli.orchestrator.checkpoints")(function* (
      identifier: string,
      limit: number,
    ) {
      const orchestrator = yield* find(identifier);
      const { checkpoints } = yield* client[M.orchestratorsCheckpoints]({
        orchestratorId: orchestrator.id,
        limit,
      });
      return checkpoints;
    }),
    claims: Effect.fn("cli.orchestrator.claims")(function* (identifier: string) {
      const orchestrator = yield* find(identifier);
      const { requests } = yield* client[M.requestsList]({ orchestratorId: orchestrator.id });
      return requests;
    }),
    transferClaim: Effect.fn("cli.orchestrator.transferClaim")(function* (input: {
      readonly thread: Option.Option<string>;
      readonly request: Option.Option<string>;
      readonly task: Option.Option<string>;
      readonly to: string;
      readonly expectedGeneration: Option.Option<number>;
      readonly reason: Option.Option<string>;
    }) {
      const forRequest = Option.isSome(input.thread) && Option.isSome(input.request);
      if (
        forRequest === Option.isSome(input.task) ||
        Option.isSome(input.thread) !== Option.isSome(input.request)
      ) {
        return yield* fail("Name what is claimed: --thread with --request, or --task.");
      }
      const to = yield* parseOwner(yield* list, input.to);
      return yield* client[M.claimsTransfer]({
        idempotencyKey: newKey(),
        subject:
          Option.isSome(input.thread) && Option.isSome(input.request)
            ? {
                kind: "request",
                threadId: ThreadId.make(input.thread.value),
                requestId: RuntimeRequestId.make(input.request.value),
              }
            : {
                kind: "task",
                taskId: DelegatedTaskId.make(Option.getOrThrow(input.task)),
              },
        to,
        ...(Option.isSome(input.expectedGeneration)
          ? { expectedGeneration: input.expectedGeneration.value }
          : {}),
        ...(Option.isSome(input.reason) ? { reason: input.reason.value } : {}),
      });
    }),
    remove: Effect.fn("cli.orchestrator.remove")(function* (identifier: string) {
      const orchestrator = yield* find(identifier);
      const { removed } = yield* client[M.orchestratorsDelete]({
        orchestratorId: OrchestratorId.make(orchestrator.id),
      });
      return { orchestrator, removed };
    }),
  };
};

// ---------------------------------------------------------------------------
// Commands

const orchestratorArgument = Argument.String("orchestrator").pipe(
  Argument.withDescription("Orchestrator id, unique id prefix, or exact name."),
);

const fileFlag = Flag.String("file").pipe(
  Flag.withDescription("Path to a JSON definition, or - to read it from stdin."),
);

const printOrchestrator = (orchestrator: Orchestrator, json: boolean, headline?: string) =>
  json
    ? printJson(orchestrator)
    : Console.log(
        [
          ...(headline === undefined ? [] : [headline, ""]),
          formatOrchestratorDetail(orchestrator),
        ].join("\n"),
      );

const createCommand = Command.make("create", {
  ...environmentTargetFlags,
  file: fileFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Create an orchestrator from a JSON definition. Its main thread is created with it.",
  ),
  Command.withHandler(
    withClient(
      Effect.fn("cli.orchestrator.create.command")(function* (client, flags) {
        const created = yield* orchestratorOperations(client).create(
          yield* readDefinitionText(flags.file),
        );
        yield* printOrchestrator(created, flags.json, `Created ${created.id}.`);
      }),
    ),
  ),
);

const editCommand = Command.make("edit", {
  ...environmentTargetFlags,
  orchestrator: orchestratorArgument,
  file: fileFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Change an orchestrator. The file may hold only the fields to change; the rest stay.",
  ),
  Command.withHandler(
    withClient(
      Effect.fn("cli.orchestrator.edit.command")(function* (client, flags) {
        const edited = yield* orchestratorOperations(client).edit(
          flags.orchestrator,
          yield* readDefinitionText(flags.file),
        );
        yield* printOrchestrator(edited, flags.json, `Updated ${edited.id}.`);
      }),
    ),
  ),
);

const listCommand = Command.make("list", { ...environmentTargetFlags, json: jsonFlag }).pipe(
  Command.withDescription("List orchestrators with what each is doing and its pending inbox."),
  Command.withHandler(
    withClient(
      Effect.fn("cli.orchestrator.list.command")(function* (client, flags) {
        const orchestrators = yield* orchestratorOperations(client).list;
        if (flags.json) return yield* printJson(orchestrators);
        yield* Console.log(
          orchestrators.length === 0
            ? "No orchestrators."
            : orchestrators.map(formatOrchestratorLine).join("\n"),
        );
      }),
    ),
  ),
);

const showCommand = Command.make("show", {
  ...environmentTargetFlags,
  orchestrator: orchestratorArgument,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Show one orchestrator: state and its reason, usage, budget, and host."),
  Command.withHandler(
    withClient(
      Effect.fn("cli.orchestrator.show.command")(function* (client, flags) {
        yield* printOrchestrator(
          yield* orchestratorOperations(client).find(flags.orchestrator),
          flags.json,
        );
      }),
    ),
  ),
);

const sendCommand = Command.make("send", {
  ...environmentTargetFlags,
  orchestrator: orchestratorArgument,
  message: Argument.String("message").pipe(
    Argument.withDescription("What to tell the orchestrator. Omit or pass - for stdin."),
    Argument.variadic(),
  ),
  idempotencyKey: Flag.String("idempotency-key").pipe(
    Flag.withDescription("Repeating a send with the same key stores the message once."),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Put a message in an orchestrator's inbox. It is stored even while the orchestrator is busy or paused.",
  ),
  Command.withHandler(
    withClient(
      Effect.fn("cli.orchestrator.send.command")(function* (client, flags) {
        const result = yield* orchestratorOperations(client).send(
          flags.orchestrator,
          yield* readMessage(flags.message),
          flags.idempotencyKey,
        );
        if (flags.json) return yield* printJson(result);
        yield* Console.log(
          `Stored ${result.entry.id} (${result.delivery}) on ${result.hostEnvironmentId}.`,
        );
      }),
    ),
  ),
);

const stateCommand = (
  name: "pause" | "resume" | "disable" | "interrupt",
  desiredState: OrchestratorDesiredState | "unchanged",
  description: string,
) =>
  Command.make(name, {
    ...environmentTargetFlags,
    orchestrator: orchestratorArgument,
    interrupt: Flag.Boolean("interrupt").pipe(
      Flag.withDescription(
        "Also interrupt the turn that is running. Delegated tasks keep running.",
      ),
      Flag.withDefault(false),
    ),
    json: jsonFlag,
  }).pipe(
    Command.withDescription(description),
    Command.withHandler(
      withClient(
        Effect.fn(`cli.orchestrator.${name}.command`)(function* (client, flags) {
          const updated = yield* orchestratorOperations(client).setState(
            flags.orchestrator,
            desiredState,
            name === "interrupt" || flags.interrupt,
          );
          if (flags.json) return yield* printJson(updated);
          yield* Console.log(
            `${updated.id} is ${updated.effectiveState}; wanted ${updated.desiredState}.${updated.stateReason === null ? "" : ` ${updated.stateReason}`}`,
          );
        }),
      ),
    ),
  );

const entryArgument = Argument.String("entry").pipe(Argument.withDescription("Inbox entry id."));

const resolveInboxCommand = (name: "requeue" | "dismiss", description: string) =>
  Command.make(name, {
    ...environmentTargetFlags,
    entry: entryArgument,
    json: jsonFlag,
  }).pipe(
    Command.withDescription(description),
    Command.withHandler(
      withClient(
        Effect.fn(`cli.orchestrator.inbox.${name}.command`)(function* (client, flags) {
          const entry = yield* orchestratorOperations(client).resolveInbox(flags.entry, name);
          if (flags.json) return yield* printJson(entry);
          yield* Console.log(`${entry.id} is now ${entry.status}.`);
        }),
      ),
    ),
  );

const inboxCommand = Command.make("inbox", {
  ...environmentTargetFlags,
  orchestrator: orchestratorArgument,
  status: Flag.Literals("status", InboxEntryStatus.literals).pipe(
    Flag.withDescription(
      "Only entries with this status: pending, reserved, processed, absorbed, unknown, dismissed. Repeat for several.",
    ),
    Flag.atLeast(0),
  ),
  limit: Flag.Int("limit").pipe(
    Flag.withDescription("Show at most this many of the newest entries."),
    Flag.withDefault(50),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "List an orchestrator's inbox entries, oldest first. `requeue` and `dismiss` settle one entry.",
  ),
  Command.withHandler(
    withClient(
      Effect.fn("cli.orchestrator.inbox.command")(function* (client, flags) {
        const entries = yield* orchestratorOperations(client).inbox(
          flags.orchestrator,
          flags.status,
          Math.max(1, flags.limit),
        );
        if (flags.json) return yield* printJson(entries);
        yield* Console.log(
          entries.length === 0 ? "No inbox entries." : entries.map(formatInboxEntry).join("\n"),
        );
      }),
    ),
  ),
  Command.withSubcommands([
    resolveInboxCommand(
      "requeue",
      "Show an entry with an unknown outcome to the orchestrator again. Use after checking that its turn did not act.",
    ),
    resolveInboxCommand("dismiss", "Drop a pending or unknown entry without showing it."),
  ]),
);

const checkpointsCommand = Command.make("checkpoints", {
  ...environmentTargetFlags,
  orchestrator: orchestratorArgument,
  limit: Flag.Int("limit").pipe(
    Flag.withDescription("Show at most this many, newest first."),
    Flag.withDefault(10),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Show an orchestrator's checkpoints: goals, open tasks, pending operations, decisions.",
  ),
  Command.withHandler(
    withClient(
      Effect.fn("cli.orchestrator.checkpoints.command")(function* (client, flags) {
        const checkpoints = yield* orchestratorOperations(client).checkpoints(
          flags.orchestrator,
          Math.max(1, flags.limit),
        );
        if (flags.json) return yield* printJson(checkpoints);
        yield* Console.log(
          checkpoints.length === 0
            ? "No checkpoints yet."
            : checkpoints.map(formatCheckpoint).join("\n"),
        );
      }),
    ),
  ),
);

const claimsCommand = Command.make("claims", {
  ...environmentTargetFlags,
  orchestrator: orchestratorArgument,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "List the pending requests an orchestrator owns, with each claim's generation.",
  ),
  Command.withHandler(
    withClient(
      Effect.fn("cli.orchestrator.claims.command")(function* (client, flags) {
        const requests = yield* orchestratorOperations(client).claims(flags.orchestrator);
        if (flags.json) return yield* printJson(requests);
        yield* Console.log(
          requests.length === 0
            ? "No pending requests claimed."
            : requests.map(formatRequest).join("\n"),
        );
      }),
    ),
  ),
);

const claimTransferCommand = Command.make("transfer", {
  ...environmentTargetFlags,
  thread: Flag.String("thread").pipe(
    Flag.withDescription("Thread of the request being handed over. Use with --request."),
    Flag.optional,
  ),
  request: Flag.String("request").pipe(Flag.withDescription("Runtime request id."), Flag.optional),
  task: Flag.String("task").pipe(
    Flag.withDescription("Delegated task id, instead of --thread and --request."),
    Flag.optional,
  ),
  to: Flag.String("to").pipe(
    Flag.withDescription("New owner: user, thread:<id>, or orchestrator:<id>."),
  ),
  expectedGeneration: Flag.Int("expected-generation").pipe(
    Flag.withDescription("Fail unless the claim is still at this generation."),
    Flag.optional,
  ),
  reason: Flag.String("reason").pipe(Flag.withDescription("Why, for the record."), Flag.optional),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Hand a request or task to another owner. The new owner answers with its own permissions.",
  ),
  Command.withHandler(
    withClient(
      Effect.fn("cli.orchestrator.claim.transfer.command")(function* (client, flags) {
        const claim = yield* orchestratorOperations(client).transferClaim(flags);
        if (flags.json) return yield* printJson(claim);
        yield* Console.log(`Now owned by ${formatClaim(claim)}.`);
      }),
    ),
  ),
);

const claimCommand = Command.make("claim").pipe(
  Command.withDescription("Move responsibility for a pending request or task."),
  Command.withSubcommands([claimTransferCommand]),
);

const removeCommand = Command.make("remove", {
  ...environmentTargetFlags,
  orchestrator: orchestratorArgument,
}).pipe(
  Command.withDescription(
    "Delete an orchestrator. Its main thread stays as an ordinary thread; use `disable` to keep it.",
  ),
  Command.withHandler(
    withClient(
      Effect.fn("cli.orchestrator.remove.command")(function* (client, flags) {
        const { orchestrator } = yield* orchestratorOperations(client).remove(flags.orchestrator);
        yield* Console.log(`Removed ${orchestrator.id} (${orchestrator.name}).`);
      }),
    ),
  ),
);

export const orchestratorCommand = Command.make("orchestrator").pipe(
  Command.withDescription(
    "Manage persistent orchestrators: coordinators with a main thread, inbox, budget and checkpoints.",
  ),
  Command.withSubcommands([
    createCommand,
    editCommand,
    listCommand,
    showCommand,
    sendCommand,
    stateCommand(
      "pause",
      "paused",
      "Stop new turns and keep the inbox. Delegated tasks keep running.",
    ),
    stateCommand("resume", "active", "Take turns again, starting with what is in the inbox."),
    stateCommand(
      "disable",
      "disabled",
      "Stop new turns and refuse hook deliveries. Messages you send are still kept.",
    ),
    stateCommand(
      "interrupt",
      "unchanged",
      "Interrupt the turn that is running without changing the wanted state.",
    ),
    inboxCommand,
    checkpointsCommand,
    claimsCommand,
    claimCommand,
    removeCommand,
  ]),
);
