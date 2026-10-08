import { WsRpcGroup } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { Argument, Command, Flag } from "effect/cli";
import { RpcSchema } from "effect/rpc";

import { RPC_REQUIRED_SCOPES } from "../auth/RpcAuthorization.ts";
import { environmentTargetFlags, withFlatEnvironmentRpc } from "./environmentRpc.ts";
import { jsonFlag, printJson, printJsonLine, timeoutFlag } from "./common.ts";

export class RpcCliError extends Schema.TaggedError<RpcCliError>()("RpcCliError", {
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}

type AnyRpc = (typeof WsRpcGroup.requests extends ReadonlyMap<string, infer R> ? R : never) & {
  readonly payloadSchema: Schema.Top;
  readonly successSchema: Schema.Top;
};

/** Contract schemas need no services; the cast keeps `unknown` out of the CLI's requirements. */
type JsonCodec = (input: unknown) => Effect.Effect<unknown, Schema.SchemaError>;

function describeRpc(rpc: AnyRpc) {
  const stream = RpcSchema.isStreamSchema(rpc.successSchema);
  return {
    method: rpc._tag,
    stream,
    scope: (RPC_REQUIRED_SCOPES as Record<string, string>)[rpc._tag] ?? null,
    payload: rpc.payloadSchema,
    success: stream
      ? (rpc.successSchema as RpcSchema.Stream<Schema.Top, Schema.Top>).success
      : rpc.successSchema,
  };
}

/** Server failures arrive as tagged errors; keep their message and the original cause. */
const rpcFailure = (cause: unknown) =>
  new RpcCliError({
    detail:
      typeof cause === "object" && cause !== null && "message" in cause
        ? String(cause.message)
        : "The server rejected the call.",
    cause,
  });

const findRpc = (method: string) => {
  const rpc = WsRpcGroup.requests.get(method) as AnyRpc | undefined;
  return rpc === undefined
    ? Effect.fail(
        new RpcCliError({
          detail: `Unknown method '${method}'. Run \`t3 rpc list\` to see methods.`,
        }),
      )
    : Effect.succeed(describeRpc(rpc));
};

const decodeJsonText = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const readPayload = Effect.fn("cli.rpc.readPayload")(function* (raw: Option.Option<string>) {
  if (Option.isNone(raw)) return {};
  let text = raw.value;
  if (text === "-") {
    const stdio = yield* Stdio.Stdio;
    text = yield* stdio.stdin.pipe(Stream.decodeText(), Stream.mkString);
  }
  return yield* decodeJsonText(text).pipe(
    Effect.mapError(
      (cause) => new RpcCliError({ detail: "The payload is not valid JSON.", cause }),
    ),
  );
});

const listCommand = Command.make("list", {
  filter: Argument.String("filter").pipe(
    Argument.withDescription("Only methods containing this text, e.g. `git` or `terminal`."),
    Argument.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("List every server method the CLI can call."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const methods = [...WsRpcGroup.requests.values()]
        .map((rpc) => describeRpc(rpc as AnyRpc))
        .filter((rpc) => Option.isNone(flags.filter) || rpc.method.includes(flags.filter.value))
        .toSorted((left, right) => left.method.localeCompare(right.method));
      if (flags.json) {
        return yield* printJson(
          methods.map(({ method, stream, scope }) => ({ method, stream, scope })),
        );
      }
      yield* Console.log(
        methods
          .map((rpc) => `${rpc.method}${rpc.stream ? "  (stream)" : ""}  [${rpc.scope}]`)
          .join("\n"),
      );
    }),
  ),
);

const describeCommand = Command.make("describe", {
  method: Argument.String("method"),
}).pipe(
  Command.withDescription("Print a method's payload and result as JSON Schema."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const rpc = yield* findRpc(flags.method);
      yield* printJson({
        method: rpc.method,
        stream: rpc.stream,
        scope: rpc.scope,
        payload: Schema.toJsonSchemaDocument(rpc.payload),
        result: Schema.toJsonSchemaDocument(rpc.success),
      });
    }),
  ),
);

const callCommand = Command.make("call", {
  ...environmentTargetFlags,
  method: Argument.String("method").pipe(
    Argument.withDescription("Method name from `t3 rpc list`, e.g. git.status."),
  ),
  payload: Argument.String("payload").pipe(
    Argument.withDescription("JSON payload, or - to read it from stdin. Default: {}."),
    Argument.optional,
  ),
  limit: Flag.Int("limit").pipe(
    Flag.withDescription("For streams: stop after this many events."),
    Flag.optional,
  ),
  timeout: timeoutFlag,
}).pipe(
  Command.withDescription(
    "Call any server method with a JSON payload. Streams print one JSON event per line.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const rpc = yield* findRpc(flags.method);
      const input = yield* readPayload(flags.payload);
      const decode = Schema.decodeUnknownEffect(rpc.payload) as JsonCodec;
      const payload = yield* decode(input).pipe(
        Effect.mapError(
          (cause) =>
            new RpcCliError({
              detail: `Invalid payload for ${rpc.method}: ${cause.message}\nSee \`t3 rpc describe ${rpc.method}\`.`,
              cause,
            }),
        ),
      );
      const encode = Schema.encodeUnknownEffect(rpc.success) as JsonCodec;
      const call = withFlatEnvironmentRpc(flags, (client) => {
        const invoke = client as unknown as (tag: string, payload: unknown) => unknown;
        if (!rpc.stream) {
          return (invoke(rpc.method, payload) as Effect.Effect<unknown, object>).pipe(
            Effect.mapError(rpcFailure),
            Effect.flatMap(encode),
            Effect.flatMap((value) => printJson(value ?? null)),
          );
        }
        const events = invoke(rpc.method, payload) as Stream.Stream<unknown, object>;
        return events.pipe(
          Stream.mapError(rpcFailure),
          Option.isSome(flags.limit) ? Stream.take(flags.limit.value) : (stream) => stream,
          Stream.mapEffect(encode),
          Stream.runForEach(printJsonLine),
        );
      });
      if (Option.isNone(flags.timeout)) return yield* call;
      yield* call.pipe(Effect.timeoutOption(flags.timeout.value));
    }),
  ),
);

export const rpcCommand = Command.make("rpc").pipe(
  Command.withDescription(
    "Call any server method directly (git, settings, providers, files, …), locally or with --env.",
  ),
  Command.withSubcommands([listCommand, describeCommand, callCommand]),
);
