import { AutomationErrorCode, CommandId } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import { Flag } from "effect/unstable/cli";

import { randomUuidV4 } from "../orchestration-v2/RandomUuid.ts";
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

export const idempotencyKeyFlag = Flag.String("idempotency-key").pipe(
  Flag.withDescription(
    "Caller-chosen key. Repeating the command with the same key returns the first result instead of acting twice.",
  ),
  Flag.optional,
);

export const printJson = (value: unknown) => Console.log(JSON.stringify(value, null, 2));

/** Prints one event of a stream as a single JSON line. */
export const printJsonLine = (value: unknown) => Console.log(JSON.stringify(value));

// ---------------------------------------------------------------------------
// Errors

/**
 * Codes a script branches on. They are the server's `AutomationErrorCode`s plus
 * `WAIT_TIMEOUT`, which only a waiting CLI command can produce.
 */
export type CliErrorCode = AutomationErrorCode | "WAIT_TIMEOUT";

/**
 * Process exit code for each error code. Documented in docs/user/cli.md and
 * `t3 guide`; scripts rely on them, so a code never changes its number.
 */
export const CLI_EXIT_CODES = {
  INTERNAL: 1,
  INVALID_INPUT: 2,
  NOT_FOUND: 3,
  CONFLICT: 4,
  REVISION_MISMATCH: 4,
  REQUEST_ALREADY_RESOLVED: 4,
  REQUEST_EXPIRED: 4,
  NOT_OWNER: 4,
  PERMISSION_DENIED: 5,
  ENVIRONMENT_UNAVAILABLE: 6,
  NODE_UNAVAILABLE: 6,
  CAPABILITY_UNSUPPORTED: 7,
  VERSION_INCOMPATIBLE: 7,
  WAIT_TIMEOUT: 8,
  RESULT_UNKNOWN: 9,
  CURSOR_EXPIRED: 10,
  BACKPRESSURE: 10,
  BUDGET_EXCEEDED: 10,
  PAUSED: 10,
} as const satisfies Record<CliErrorCode, number>;

const JsonDetail = Schema.Record(Schema.String, Schema.Json);

/** A command failure with a stable code. Thrown by handlers and produced from any other error by `toCliFailure`. */
export class CliFailure extends Schema.TaggedError<CliFailure>()("CliFailure", {
  code: Schema.Union([AutomationErrorCode, Schema.Literal("WAIT_TIMEOUT")]),
  message: Schema.String,
  detail: Schema.optional(JsonDetail),
  /** True once the failure was printed as JSON, so the runtime does not log it again. */
  printed: Schema.optional(Schema.Boolean),
}) {
  override get [Runtime.errorExitCode](): number {
    return CLI_EXIT_CODES[this.code];
  }
  override get [Runtime.errorReported](): boolean {
    return this.printed !== true;
  }
}

export const cliFailure = (code: CliErrorCode, message: string, detail?: CliFailure["detail"]) =>
  new CliFailure({ code, message, ...(detail === undefined ? {} : { detail }) });

export const failCli = (code: CliErrorCode, message: string, detail?: CliFailure["detail"]) =>
  Effect.fail(cliFailure(code, message, detail));

const isErrorCode = Schema.is(AutomationErrorCode);
const isCliFailure = Schema.is(CliFailure);

const stringField = (value: unknown, key: string): string | undefined =>
  Predicate.isObject(value) && typeof value[key] === "string" ? value[key] : undefined;

/**
 * The structured reason a server rejection carries, wherever it sits in the
 * cause chain. Orchestrator rejections put `{ code, detail, ...ids }` in
 * `cause`; over the wire that object survives inside the dispatch error.
 */
function structuredReason(
  error: unknown,
): { readonly code: AutomationErrorCode; readonly detail: Record<string, unknown> } | undefined {
  let current = error;
  for (let depth = 0; depth < 8 && Predicate.isObject(current); depth += 1) {
    if (isErrorCode(current.code) && !("_tag" in current)) {
      return { code: current.code, detail: current };
    }
    current = current.cause;
  }
  return undefined;
}

const jsonDetail = (value: Record<string, unknown>): CliFailure["detail"] => {
  const entries = Object.entries(value).filter(
    ([key, entry]) =>
      key !== "code" &&
      (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean"),
  );
  return entries.length === 0 ? undefined : (Object.fromEntries(entries) as CliFailure["detail"]);
};

const THREAD_CLI_REASON_CODES: Record<string, CliErrorCode> = {
  "project-not-found": "NOT_FOUND",
  "thread-not-found": "NOT_FOUND",
  "no-pending-request": "NOT_FOUND",
  ambiguous: "CONFLICT",
  "invalid-input": "INVALID_INPUT",
  "model-unresolved": "INVALID_INPUT",
  timeout: "WAIT_TIMEOUT",
  unavailable: "ENVIRONMENT_UNAVAILABLE",
};

const TAG_CODES: Record<string, CliErrorCode> = {
  AutomationCliError: "INVALID_INPUT",
  EnvironmentServerNotRunningError: "ENVIRONMENT_UNAVAILABLE",
  EnvironmentServerConnectError: "ENVIRONMENT_UNAVAILABLE",
  RpcClientError: "ENVIRONMENT_UNAVAILABLE",
  SocketError: "ENVIRONMENT_UNAVAILABLE",
  EnvironmentNotFoundError: "NOT_FOUND",
  EnvironmentAuthorizationError: "PERMISSION_DENIED",
  AgentCredentialUnavailableError: "PERMISSION_DENIED",
  OrchestratorSubagentThreadReadOnlyError: "CAPABILITY_UNSUPPORTED",
  OrchestratorCommandIdConflictError: "CONFLICT",
  OrchestratorCommandPreviouslyRejectedError: "CONFLICT",
  OrchestratorCommandRejectedError: "CONFLICT",
  LibraryCliError: "INVALID_INPUT",
};

/**
 * The one place a failure becomes a code. Server rejections keep the code the
 * server gave them; a domain rejection without one is a `CONFLICT` (the
 * command was understood and refused); anything unrecognized is `INTERNAL`.
 */
export function toCliFailure(error: unknown): CliFailure {
  if (isCliFailure(error)) return error;
  const tag = stringField(error, "_tag");
  const message =
    error instanceof Error ? error.message : (stringField(error, "message") ?? String(error));
  if (tag === "AutomationError" && Predicate.isObject(error) && isErrorCode(error.code)) {
    return cliFailure(
      error.code,
      message,
      Predicate.isObject(error.detail) ? jsonDetail(error.detail) : undefined,
    );
  }
  if (tag === "ThreadCliError") {
    return cliFailure(
      THREAD_CLI_REASON_CODES[stringField(error, "reason") ?? ""] ?? "INTERNAL",
      message,
    );
  }
  const reason = structuredReason(error);
  if (reason !== undefined) {
    return cliFailure(
      reason.code,
      stringField(reason.detail, "detail") ?? message,
      jsonDetail({ ...reason.detail, detail: undefined }),
    );
  }
  if (tag === "OrchestratorCommandPreviouslyRejectedError") {
    return cliFailure(
      "CONFLICT",
      `${message} The idempotency key belongs to a command the server refused; use a new key.`,
    );
  }
  if (tag !== undefined && TAG_CODES[tag] !== undefined) return cliFailure(TAG_CODES[tag], message);
  if (
    tag === "OrchestrationV2DispatchCommandError" ||
    tag === "OrchestrationDispatchCommandError" ||
    tag === "OrchestratorDispatchError"
  ) {
    // A dispatch error wraps the orchestrator's own rejection: classify that.
    const inner = Predicate.isObject(error) ? error.cause : undefined;
    const innerTag = stringField(inner, "_tag") ?? stringField(inner, "name");
    if (innerTag !== undefined && TAG_CODES[innerTag] !== undefined) {
      return cliFailure(TAG_CODES[innerTag], message);
    }
    return cliFailure("CONFLICT", stringField(error, "detail") ?? message);
  }
  return cliFailure("INTERNAL", message);
}

/**
 * Turns every failure of `effect` into a `CliFailure`, which sets the exit
 * code. With `json`, prints `{"error":{"code","message","detail"}}` on stderr
 * and marks the failure as printed.
 */
export const reportCliFailure =
  (json: boolean) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, CliFailure, R> =>
    effect.pipe(
      Effect.catch((error) => {
        const failure = toCliFailure(error);
        if (!json) return Effect.fail(failure);
        return Console.error(
          JSON.stringify({
            error: {
              code: failure.code,
              message: failure.message,
              detail: failure.detail ?? {},
            },
          }),
        ).pipe(
          Effect.andThen(
            Effect.fail(
              new CliFailure({
                code: failure.code,
                message: failure.message,
                ...(failure.detail === undefined ? {} : { detail: failure.detail }),
                printed: true,
              }),
            ),
          ),
        );
      }),
    );

// ---------------------------------------------------------------------------
// Idempotency

/**
 * The command id for a mutation. With `--idempotency-key` the id is derived
 * from the key (and `part`, when one CLI command dispatches several server
 * commands), so the server's command receipts make a repeat return the first
 * result. Without a key the id is random.
 */
export const commandIdFor = (
  key: Option.Option<string>,
  part?: string,
): Effect.Effect<CommandId, CliFailure> =>
  Option.match(key, {
    onSome: (value) => {
      const trimmed = value.trim();
      return trimmed.length === 0 || trimmed.length > 200
        ? failCli("INVALID_INPUT", "--idempotency-key must be 1 to 200 characters.")
        : Effect.succeed(CommandId.make(`cli:${trimmed}${part === undefined ? "" : `:${part}`}`));
    },
    onNone: () =>
      randomUuidV4.pipe(
        Effect.map((id) => CommandId.make(part === undefined ? id : `${id}:${part}`)),
      ),
  });

// ---------------------------------------------------------------------------
// Connection

/**
 * Replaces the socket a command would open. Tests set it to drive the real
 * command handlers against an in-process server; it is never set in production.
 */
export class CliRpcClientOverride extends Context.Reference<EnvironmentRpcClient | undefined>(
  "t3/cli/CliRpcClientOverride",
  { defaultValue: () => undefined },
) {}

/**
 * Runs a command handler against the target environment's RPC client and
 * reports its failure with a stable code (as JSON when the command has
 * `--json` set).
 */
export const withClient =
  <Flags extends EnvironmentTargetFlags, A, E, R>(
    run: (client: EnvironmentRpcClient, flags: Flags) => Effect.Effect<A, E, R>,
  ) =>
  (flags: Flags) =>
    Effect.gen(function* () {
      const override = yield* CliRpcClientOverride;
      return yield* override === undefined
        ? withEnvironmentRpc(flags, (client) => run(client, flags))
        : run(override, flags);
    }).pipe(reportCliFailure("json" in flags && flags.json === true));
