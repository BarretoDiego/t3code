/**
 * `t3 hooks` - subscriptions that deliver matching events to a target.
 *
 * A hook is declared as JSON: which events it matches, where they go, and how
 * delivery retries. The server matches and delivers; these commands only
 * manage the declarations and inspect what was delivered.
 */
import {
  AUTOMATION_WS_METHODS,
  type Hook,
  type HookDelivery,
  HookDeliveryId,
  HookDeliveryStatus,
  type HookTarget,
  HookUpsertInput,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Argument, Command, Flag } from "effect/cli";

import { jsonFlag, printJson, withClient } from "./common.ts";
import { type EnvironmentRpcClient, environmentTargetFlags } from "./environmentRpc.ts";
import {
  AutomationCliError,
  bodyFileFlag,
  decodeBody,
  formatEntryLine,
  readBodyText,
} from "./events.ts";

const M = AUTOMATION_WS_METHODS;

const fail = (detail: string) => Effect.fail(new AutomationCliError({ detail }));

/** Decodes a hook definition; `existing` supplies the fields an edit leaves out. */
export const decodeHookBody = (text: string, existing?: Hook) =>
  decodeBody(
    HookUpsertInput,
    text,
    existing === undefined
      ? {}
      : {
          name: existing.name,
          enabled: existing.enabled,
          filter: existing.filter,
          target: existing.target,
          deliveryMode: existing.deliveryMode,
          retry: existing.retry,
          timeoutMs: existing.timeoutMs,
          priority: existing.priority,
          ...(existing.batchWindowMs === undefined
            ? {}
            : { batchWindowMs: existing.batchWindowMs }),
          ...(existing.cooldownMs === undefined ? {} : { cooldownMs: existing.cooldownMs }),
          ...(existing.maxDeliveriesPerTask === undefined
            ? {}
            : { maxDeliveriesPerTask: existing.maxDeliveriesPerTask }),
          id: existing.id,
          expectedRevision: existing.revision,
        },
  );

const describeTarget = (target: HookTarget) => {
  switch (target.type) {
    case "orchestrator_inbox":
      return `inbox of ${target.orchestratorId}`;
    case "cli_consumer":
      return `consumer ${target.consumerId}`;
    case "webhook":
      return `webhook ${target.url}`;
    case "command":
      return `command ${target.executable}`;
  }
};

const describeTypes = (hook: Hook) =>
  hook.filter.types === undefined || hook.filter.types.length === 0
    ? "all event types"
    : hook.filter.types.join(", ");

export const formatHookLine = (hook: Hook) =>
  [
    hook.id,
    hook.enabled ? "enabled" : "disabled",
    `priority ${hook.priority}`,
    describeTypes(hook),
    `-> ${describeTarget(hook.target)}`,
    hook.name,
  ].join("  ");

const formatHookDetail = (hook: Hook) =>
  [
    `${hook.name}  (${hook.id})`,
    `  state:    ${hook.enabled ? "enabled" : "disabled"}  (revision ${hook.revision})`,
    `  matches:  ${describeTypes(hook)}`,
    `  target:   ${describeTarget(hook.target)}`,
    `  delivery: ${hook.deliveryMode}${hook.batchWindowMs === undefined ? "" : ` within ${hook.batchWindowMs} ms`}, priority ${hook.priority}`,
    `  retry:    up to ${hook.retry.maxAttempts} attempts, ${hook.retry.initialDelayMs}-${hook.retry.maxDelayMs} ms apart, ${hook.timeoutMs} ms timeout`,
    `  cursor:   ${hook.cursor}`,
  ].join("\n");

export const formatDeliveryLine = (delivery: HookDelivery) =>
  [
    delivery.id,
    delivery.status,
    delivery.firstCursor === delivery.lastCursor
      ? `cursor ${delivery.firstCursor}`
      : `cursors ${delivery.firstCursor}-${delivery.lastCursor}`,
    `attempts ${delivery.attemptCount}`,
    ...(delivery.suppressedReason === null ? [] : [`suppressed: ${delivery.suppressedReason}`]),
    ...(delivery.nextAttemptAt === null ? [] : [`next ${delivery.nextAttemptAt}`]),
    ...(delivery.lastError === null ? [] : [delivery.lastError]),
  ].join("  ");

const loadHooks = (client: EnvironmentRpcClient) =>
  Effect.map(client[M.hooksList]({}), (result) => result.hooks);

/** Resolves a hook by id, unique id prefix, or exact name. */
const resolveHook = Effect.fn("cli.hooks.resolveHook")(function* (
  client: EnvironmentRpcClient,
  identifier: string,
) {
  const wanted = identifier.trim();
  const hooks = yield* loadHooks(client);
  const exact = hooks.filter((hook) => hook.id === wanted);
  const byPrefix =
    wanted.length === 0
      ? []
      : hooks.filter(
          (hook) => hook.id.startsWith(wanted) || hook.id.replace(/^hook-/, "").startsWith(wanted),
        );
  const byName = hooks.filter((hook) => hook.name.toLowerCase() === wanted.toLowerCase());
  const matches = [exact, byPrefix, byName].find((candidates) => candidates.length > 0) ?? [];
  if (matches.length === 1) return matches[0]!;
  return yield* fail(
    matches.length === 0
      ? `No hook matches '${wanted}'. Run \`t3 hooks list\` to see them.`
      : `'${wanted}' matches ${matches.length} hooks: ${matches.map((hook) => hook.id).join(", ")}. Use its id.`,
  );
});

const hookArgument = Argument.String("hook").pipe(
  Argument.withDescription("Hook id, unique id prefix, or exact name."),
);

const deliveryArgument = Argument.String("delivery").pipe(
  Argument.withDescription("Delivery id, as printed by `t3 hooks deliveries`."),
);

const printHook = (hook: Hook, json: boolean, headline?: string) =>
  json
    ? printJson(hook)
    : Console.log(
        [...(headline === undefined ? [] : [headline, ""]), formatHookDetail(hook)].join("\n"),
      );

// ---------------------------------------------------------------------------
// Commands

const addCommand = Command.make("add", {
  ...environmentTargetFlags,
  file: bodyFileFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Create a hook from a JSON definition. It starts at the newest event unless the definition sets startAt.",
  ),
  Command.withHandler(
    withClient(
      Effect.fn("cli.hooks.add")(function* (client, flags) {
        const input = yield* decodeHookBody(yield* readBodyText(flags.file));
        const hook = yield* client[M.hooksUpsert](input);
        yield* printHook(hook, flags.json, `Created ${hook.id}.`);
      }),
    ),
  ),
);

const editCommand = Command.make("edit", {
  ...environmentTargetFlags,
  hook: hookArgument,
  file: bodyFileFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Change a hook. The JSON names only the fields to change; the edit is refused if the hook changed meanwhile.",
  ),
  Command.withHandler(
    withClient(
      Effect.fn("cli.hooks.edit")(function* (client, flags) {
        const existing = yield* resolveHook(client, flags.hook);
        const input = yield* decodeHookBody(yield* readBodyText(flags.file), existing);
        if (input.id !== existing.id) {
          return yield* fail(`The body names hook ${input.id}, not ${existing.id}.`);
        }
        const hook = yield* client[M.hooksUpsert](input);
        yield* printHook(hook, flags.json, `Updated ${hook.id}.`);
      }),
    ),
  ),
);

const listCommand = Command.make("list", { ...environmentTargetFlags, json: jsonFlag }).pipe(
  Command.withDescription("List hooks with what they match and where they deliver."),
  Command.withHandler(
    withClient(
      Effect.fn("cli.hooks.list")(function* (client, flags) {
        const hooks = yield* loadHooks(client);
        if (flags.json) return yield* printJson(hooks);
        yield* Console.log(hooks.length === 0 ? "No hooks." : hooks.map(formatHookLine).join("\n"));
      }),
    ),
  ),
);

const showCommand = Command.make("show", {
  ...environmentTargetFlags,
  hook: hookArgument,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Show one hook in full. With --json, the definition `edit` accepts."),
  Command.withHandler(
    withClient(
      Effect.fn("cli.hooks.show")(function* (client, flags) {
        yield* printHook(yield* resolveHook(client, flags.hook), flags.json);
      }),
    ),
  ),
);

const setEnabledCommand = (name: "enable" | "disable", description: string) =>
  Command.make(name, { ...environmentTargetFlags, hook: hookArgument, json: jsonFlag }).pipe(
    Command.withDescription(description),
    Command.withHandler(
      withClient(
        Effect.fn(`cli.hooks.${name}`)(function* (client, flags) {
          const existing = yield* resolveHook(client, flags.hook);
          const hook = yield* client[M.hooksSetEnabled]({
            hookId: existing.id,
            enabled: name === "enable",
          });
          if (flags.json) return yield* printJson(hook);
          yield* Console.log(`${hook.enabled ? "Enabled" : "Disabled"} ${hook.id}.`);
        }),
      ),
    ),
  );

const removeCommand = Command.make("remove", {
  ...environmentTargetFlags,
  hook: hookArgument,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Delete a hook and its delivery records. Use `disable` to keep it."),
  Command.withHandler(
    withClient(
      Effect.fn("cli.hooks.remove")(function* (client, flags) {
        const existing = yield* resolveHook(client, flags.hook);
        const result = yield* client[M.hooksDelete]({ hookId: existing.id }).pipe();
        if (flags.json) return yield* printJson(result);
        yield* Console.log(`Removed ${existing.id} (${existing.name}).`);
      }),
    ),
  ),
);

const testCommand = Command.make("test", {
  ...environmentTargetFlags,
  hook: hookArgument,
  cursor: Flag.Int("cursor").pipe(
    Flag.withDescription("Match events after this cursor. Default: the most recent events."),
    Flag.optional,
  ),
  limit: Flag.Int("limit").pipe(Flag.withDescription("Most events to examine."), Flag.optional),
  deliver: Flag.Boolean("deliver").pipe(
    Flag.withDescription("Send the matched events to the target for real. Default: a dry run."),
    Flag.withDefault(false),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Show which recent events a hook matches and what it would send, without sending.",
  ),
  Command.withHandler(
    withClient(
      Effect.fn("cli.hooks.test")(function* (client, flags) {
        const existing = yield* resolveHook(client, flags.hook);
        const result = yield* client[M.hooksTest]({
          hookId: existing.id,
          ...(Option.isSome(flags.cursor) ? { afterCursor: flags.cursor.value } : {}),
          ...(Option.isSome(flags.limit) ? { limit: flags.limit.value } : {}),
          ...(flags.deliver ? { deliver: true } : {}),
        });
        if (flags.json) return yield* printJson(result);
        yield* Console.log(
          [
            result.matched.length === 0
              ? "No recent event matches this hook."
              : `Matched ${result.matched.length} event${result.matched.length === 1 ? "" : "s"}:`,
            ...result.matched.map((entry) => `  ${formatEntryLine(entry)}`),
            ...(result.delivery === null
              ? []
              : ["", `Sent: ${formatDeliveryLine(result.delivery)}`]),
            ...(result.dryRun && result.matched.length > 0
              ? [
                  "",
                  "Dry run: nothing was sent. Add --deliver to send, or --json to see the payload.",
                ]
              : []),
          ].join("\n"),
        );
      }),
    ),
  ),
);

const deliveriesCommand = Command.make("deliveries", {
  ...environmentTargetFlags,
  hook: Argument.String("hook").pipe(
    Argument.withDescription("Only this hook's deliveries (id, id prefix, or name)."),
    Argument.optional,
  ),
  status: Flag.Literals("status", HookDeliveryStatus.literals).pipe(
    Flag.withDescription("Only deliveries in this status; repeatable."),
    Flag.atLeast(0),
  ),
  limit: Flag.Int("limit").pipe(
    Flag.withDescription("Most deliveries to list, newest first."),
    Flag.withDefault(100),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "List deliveries: pending, retrying, delivered, failed, and suppressed ones with the reason.",
  ),
  Command.withHandler(
    withClient(
      Effect.fn("cli.hooks.deliveries")(function* (client, flags) {
        const hook = Option.isSome(flags.hook)
          ? yield* resolveHook(client, flags.hook.value)
          : undefined;
        const { deliveries } = yield* client[M.hooksDeliveries]({
          ...(hook === undefined ? {} : { hookId: hook.id }),
          ...(flags.status.length === 0 ? {} : { statuses: flags.status }),
          limit: flags.limit,
        });
        if (flags.json) return yield* printJson(deliveries);
        yield* Console.log(
          deliveries.length === 0
            ? "No deliveries."
            : deliveries.map(formatDeliveryLine).join("\n"),
        );
      }),
    ),
  ),
);

const deliveryActionCommand = (
  name: "redeliver" | "dismiss",
  description: string,
  method: typeof M.hooksRedeliver | typeof M.hooksDismissDelivery,
) =>
  Command.make(name, {
    ...environmentTargetFlags,
    delivery: deliveryArgument,
    json: jsonFlag,
  }).pipe(
    Command.withDescription(description),
    Command.withHandler(
      withClient(
        Effect.fn(`cli.hooks.${name}`)(function* (client, flags) {
          const delivery = yield* client[method]({
            deliveryId: HookDeliveryId.make(flags.delivery),
          });
          if (flags.json) return yield* printJson(delivery);
          yield* Console.log(
            name === "redeliver"
              ? `Queued again: ${formatDeliveryLine(delivery)}`
              : `Dismissed ${delivery.id}.`,
          );
        }),
      ),
    ),
  );

export const hooksCommand = Command.make("hooks").pipe(
  Command.withDescription("Manage hooks that deliver matching events to a target."),
  Command.withSubcommands([
    addCommand,
    editCommand,
    listCommand,
    showCommand,
    setEnabledCommand("enable", "Resume a disabled hook. It catches up from where it stopped."),
    setEnabledCommand(
      "disable",
      "Stop a hook without deleting it. It keeps its position in the journal.",
    ),
    removeCommand,
    testCommand,
    deliveriesCommand,
    deliveryActionCommand(
      "redeliver",
      "Send a failed, suppressed or delivered delivery again, under the same dedup key.",
      M.hooksRedeliver,
    ),
    deliveryActionCommand(
      "dismiss",
      "Close a failed or suppressed delivery so it no longer shows as needing attention.",
      M.hooksDismissDelivery,
    ),
  ]),
);
