/**
 * `t3 peer` - other T3 environments this one talks to directly.
 *
 * A peer link is one-directional: this environment holds a credential minted
 * by the peer and pushes addressed messages to it. For work that reports back
 * (a delegated task and its status) each side adds the other. Nothing is
 * relayed: the peer's URL must be reachable from here, on the LAN, over
 * Tailscale, or through a tunnel that is already running.
 */
import {
  AUTOMATION_WS_METHODS,
  AuthFederationPeerScope,
  EnvironmentId,
  type Peer,
  type PeerOutboxEntry,
  PeerPermissions,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { peerSessionSubject } from "../automation/Caller.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { buildPairingUrl } from "../startupAccess.ts";
import { jsonFlag, printJson, withClient } from "./common.ts";
import { authLocationFlags, DurationFromString, resolveCliAuthConfig } from "./config.ts";
import { type EnvironmentRpcClient, environmentTargetFlags } from "./environmentRpc.ts";

const M = AUTOMATION_WS_METHODS;

export class PeerCliError extends Schema.TaggedError<PeerCliError>()("PeerCliError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

const fail = (detail: string) => Effect.fail(new PeerCliError({ detail }));

/** What a peer may ask of this environment when no file says otherwise: nothing. */
const NO_PEER_PERMISSIONS: PeerPermissions = { inbound: [], forwardEventTypes: [] };

const decodePermissions = Schema.decodeUnknownEffect(Schema.fromJsonString(PeerPermissions));

/** Reads a permissions document: `{ "inbound": [...], "forwardEventTypes": [...] }`. */
export const parsePeerPermissions = (text: string) =>
  decodePermissions(text).pipe(
    Effect.mapError(
      () =>
        new PeerCliError({
          detail:
            'The permissions file must be JSON like {"inbound": ["task.delegate"], "forwardEventTypes": ["task.*"]}. Inbound actions: message.send, event.forward, task.delegate, task.read, orchestrator.read, orchestrator.send, orchestrator.host.',
        }),
    ),
  );

const permissionsFileFlag = Flag.String("permissions-file").pipe(
  Flag.withDescription(
    "JSON file with what the peer may ask of this environment and which event types are forwarded to it. Pass - for stdin. Default: nothing.",
  ),
  Flag.optional,
);

const readPermissions = Effect.fn("cli.peer.readPermissions")(function* (
  file: Option.Option<string>,
) {
  if (Option.isNone(file)) return Option.none<PeerPermissions>();
  const text =
    file.value === "-"
      ? yield* (yield* Stdio.Stdio).stdin.pipe(Stream.decodeText(), Stream.mkString)
      : yield* (yield* FileSystem.FileSystem)
          .readFileString(file.value)
          .pipe(Effect.mapError(() => new PeerCliError({ detail: `Cannot read ${file.value}.` })));
  return Option.some(yield* parsePeerPermissions(text));
});

const loadPeers = (client: EnvironmentRpcClient) =>
  Effect.map(client[M.peersList]({}), (result) => result.peers);

/** Resolves a peer by environment id, unique id prefix, or exact name. */
const resolvePeer = Effect.fn("cli.peer.resolvePeer")(function* (
  client: EnvironmentRpcClient,
  identifier: string,
) {
  const wanted = identifier.trim();
  const peers = yield* loadPeers(client);
  const matches = [
    peers.filter((peer) => peer.environmentId === wanted),
    peers.filter((peer) => wanted.length > 0 && peer.environmentId.startsWith(wanted)),
    peers.filter((peer) => peer.name.toLowerCase() === wanted.toLowerCase()),
  ].find((candidates) => candidates.length > 0);
  if (matches?.length === 1) return matches[0]!;
  return yield* fail(
    matches === undefined
      ? `No peer matches '${wanted}'. Run \`t3 peer list\` to see them.`
      : `'${wanted}' matches ${matches.length} peers: ${matches.map((peer) => peer.environmentId).join(", ")}. Use its environment id.`,
  );
});

/** One line per peer: the link's real state, never a guess at it. */
export function formatPeerLine(peer: Peer): string {
  return [
    peer.environmentId,
    peer.name,
    peer.enabled ? peer.status : "disabled",
    `outbox ${peer.outboxPending}`,
    peer.lastConnectedAt === null ? "never connected" : `connected ${peer.lastConnectedAt}`,
    ...(peer.statusReason === null ? [] : [peer.statusReason]),
  ].join("  ");
}

export function formatPeer(peer: Peer): string {
  return [
    `${peer.name} (${peer.environmentId})`,
    `  url:         ${peer.httpBaseUrl}`,
    `  link:        ${peer.enabled ? peer.status : "disabled"}${peer.statusReason === null ? "" : ` - ${peer.statusReason}`}`,
    `  protocol:    ${peer.negotiatedProtocolVersion ?? "not negotiated"}`,
    `  connected:   ${peer.lastConnectedAt ?? "never"}`,
    `  observed:    ${peer.lastObservedAt ?? "never"}`,
    `  outbox:      ${peer.outboxPending} waiting`,
    `  events in:   through its cursor ${peer.inboundCursor}`,
    `  may ask:     ${peer.permissions.inbound.join(", ") || "nothing"}`,
    ...(peer.permissions.projectIds === undefined
      ? []
      : [`  projects:    ${peer.permissions.projectIds.join(", ") || "none"}`]),
    ...(peer.permissions.nodeIds === undefined
      ? []
      : [`  nodes:       ${peer.permissions.nodeIds.join(", ") || "none"}`]),
    `  forwarded:   ${peer.permissions.forwardEventTypes.join(", ") || "no events"}`,
  ].join("\n");
}

/** `delivered` is "the peer stored it"; what happened to the work arrives separately. */
export function formatOutboxLine(entry: PeerOutboxEntry): string {
  const { message } = entry;
  return [
    `#${message.sequence}`,
    message.toEnvironmentId,
    message.body.type,
    entry.status === "delivered" ? "delivered (stored by the peer)" : entry.status,
    ...(entry.rejection === null ? [] : [entry.rejection]),
    ...(entry.attemptCount === 0 ? [] : [`${entry.attemptCount} failed attempts`]),
    ...(entry.lastError === null ? [] : [entry.lastError]),
    message.messageId,
  ].join("  ");
}

const peerArgument = Argument.String("peer").pipe(
  Argument.withDescription("Peer environment id, unique id prefix, or name."),
);

const printPeer = (peer: Peer, json: boolean) =>
  json ? printJson(peer) : Console.log(formatPeer(peer));

const addCommand = Command.make("add", {
  ...environmentTargetFlags,
  name: Argument.String("name").pipe(Argument.withDescription("What to call the peer here.")),
  target: Argument.String("pairing-link-or-url").pipe(
    Argument.withDescription(
      "A peer pairing link from `t3 peer credential create` on the other environment, or its URL with --token.",
    ),
  ),
  token: Flag.String("token").pipe(
    Flag.withDescription("Peer token from `t3 peer credential create --session` on the peer."),
    Flag.optional,
  ),
  permissionsFile: permissionsFileFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Add a peer environment. Its environment id is pinned; nothing is allowed until permissions say so.",
  ),
  Command.withHandler(
    withClient(
      Effect.fn("cli.peer.add")(function* (client, flags) {
        const permissions = Option.getOrElse(
          yield* readPermissions(flags.permissionsFile),
          () => NO_PEER_PERMISSIONS,
        );
        const peer = yield* client[M.peersAdd]({
          name: flags.name,
          permissions,
          ...(Option.isSome(flags.token)
            ? { httpBaseUrl: flags.target, token: flags.token.value }
            : { pairingUrl: flags.target }),
        });
        if (flags.json) return yield* printJson(peer);
        yield* Console.log(formatPeer(peer));
        if (peer.status === "incompatible") {
          yield* Console.error("Stored as incompatible: nothing will be sent to it.");
        }
      }),
    ),
  ),
);

const listCommand = Command.make("list", { ...environmentTargetFlags, json: jsonFlag }).pipe(
  Command.withDescription("List peers with the state of each link and what is waiting to be sent."),
  Command.withHandler(
    withClient(
      Effect.fn("cli.peer.list")(function* (client, flags) {
        const peers = yield* loadPeers(client);
        if (flags.json) return yield* printJson(peers);
        yield* Console.log(peers.length === 0 ? "No peers." : peers.map(formatPeerLine).join("\n"));
      }),
    ),
  ),
);

const showCommand = Command.make("show", {
  ...environmentTargetFlags,
  peer: peerArgument,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Show one peer: link state, cursors, and permissions."),
  Command.withHandler(
    withClient(
      Effect.fn("cli.peer.show")(function* (client, flags) {
        yield* printPeer(yield* resolvePeer(client, flags.peer), flags.json);
      }),
    ),
  ),
);

const updateCommand = Command.make("update", {
  ...environmentTargetFlags,
  peer: peerArgument,
  name: Flag.String("name").pipe(Flag.withDescription("New name."), Flag.optional),
  url: Flag.String("url").pipe(
    Flag.withDescription("New URL. It must still answer as the same environment id."),
    Flag.optional,
  ),
  permissionsFile: permissionsFileFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Change a peer's name, URL, or permissions. A permission change applies to messages already queued.",
  ),
  Command.withHandler(
    withClient(
      Effect.fn("cli.peer.update")(function* (client, flags) {
        const permissions = yield* readPermissions(flags.permissionsFile);
        if (Option.isNone(flags.name) && Option.isNone(flags.url) && Option.isNone(permissions)) {
          return yield* fail("Nothing to change: pass --name, --url, or --permissions-file.");
        }
        const peer = yield* resolvePeer(client, flags.peer);
        const updated = yield* client[M.peersUpdate]({
          environmentId: peer.environmentId,
          ...(Option.isSome(flags.name) ? { name: flags.name.value } : {}),
          ...(Option.isSome(flags.url) ? { httpBaseUrl: flags.url.value } : {}),
          ...(Option.isSome(permissions) ? { permissions: permissions.value } : {}),
        });
        yield* printPeer(updated, flags.json);
      }),
    ),
  ),
);

const setEnabledCommand = (name: "enable" | "disable", description: string) =>
  Command.make(name, { ...environmentTargetFlags, peer: peerArgument, json: jsonFlag }).pipe(
    Command.withDescription(description),
    Command.withHandler(
      withClient(
        Effect.fn(`cli.peer.${name}`)(function* (client, flags) {
          const peer = yield* resolvePeer(client, flags.peer);
          const updated = yield* client[M.peersUpdate]({
            environmentId: peer.environmentId,
            enabled: name === "enable",
          });
          yield* printPeer(updated, flags.json);
        }),
      ),
    ),
  );

const removeCommand = Command.make("remove", {
  ...environmentTargetFlags,
  peer: peerArgument,
}).pipe(
  Command.withDescription(
    "Remove a peer and its credential. Messages still waiting for it are cancelled, and its next call here is refused.",
  ),
  Command.withHandler(
    withClient(
      Effect.fn("cli.peer.remove")(function* (client, flags) {
        const peer = yield* resolvePeer(client, flags.peer);
        yield* client[M.peersRemove]({ environmentId: peer.environmentId });
        yield* Console.log(`Removed ${peer.name} (${peer.environmentId}).`);
      }),
    ),
  ),
);

const outboxCommand = Command.make("outbox", {
  ...environmentTargetFlags,
  peer: Argument.String("peer").pipe(
    Argument.withDescription("Only messages for this peer."),
    Argument.optional,
  ),
  all: Flag.Boolean("all").pipe(
    Flag.withDescription("Include messages the peer already stored."),
    Flag.withDefault(false),
  ),
  limit: Flag.Int("limit").pipe(Flag.withDescription("Most entries to print."), Flag.optional),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Show messages waiting for peers, and those rejected, expired, or cancelled.",
  ),
  Command.withHandler(
    withClient(
      Effect.fn("cli.peer.outbox")(function* (client, flags) {
        const peer = Option.isSome(flags.peer)
          ? Option.some(yield* resolvePeer(client, flags.peer.value))
          : Option.none<Peer>();
        const { entries } = yield* client[M.peersOutbox]({
          ...(Option.isSome(peer) ? { environmentId: peer.value.environmentId } : {}),
          ...(flags.all ? { includeDelivered: true } : {}),
          ...(Option.isSome(flags.limit) ? { limit: flags.limit.value } : {}),
        });
        if (flags.json) return yield* printJson(entries);
        yield* Console.log(
          entries.length === 0 ? "Nothing waiting." : entries.map(formatOutboxLine).join("\n"),
        );
      }),
    ),
  ),
);

// ---------------------------------------------------------------------------
// Credentials: run on the environment that will be called

/**
 * Mints what lets `callerEnvironmentId` call this environment as a peer: a
 * session whose subject names that environment and whose only scope is
 * `federation:peer`. It cannot read or operate anything a client can, and what
 * it may ask is still decided by the permissions stored for that peer here.
 */
export const issuePeerCredential = Effect.fn("cli.peer.issuePeerCredential")(function* (input: {
  readonly callerEnvironmentId: EnvironmentId;
  readonly session: boolean;
  readonly ttl: Option.Option<Duration.Duration>;
}) {
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const common = {
    subject: peerSessionSubject(input.callerEnvironmentId),
    scopes: [AuthFederationPeerScope],
    label: `peer ${input.callerEnvironmentId}`,
    ...(Option.isSome(input.ttl) ? { ttl: input.ttl.value } : {}),
  };
  if (input.session) {
    const issued = yield* auth.issueSession(common);
    return { kind: "session" as const, secret: issued.token, expiresAt: issued.expiresAt };
  }
  const issued = yield* auth.createPairingLink(common);
  return { kind: "pairing" as const, secret: issued.credential, expiresAt: issued.expiresAt };
});

const withLocalAuth = <A, E>(
  flags: { readonly baseDir: Option.Option<string>; readonly devUrl?: Option.Option<URL> },
  run: Effect.Effect<
    A,
    E,
    EnvironmentAuth.EnvironmentAuth | ServerEnvironment.ServerEnvironmentIdentity
  >,
) =>
  Effect.gen(function* () {
    const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel);
    return yield* run.pipe(
      Effect.provide(
        EnvironmentAuth.layerRuntime.pipe(
          Layer.provide(ServerConfig.layer(config)),
          Layer.provide(Layer.succeed(References.MinimumLogLevel, "Error")),
        ),
      ),
    );
  });

const credentialCreateCommand = Command.make("create", {
  ...authLocationFlags,
  environment: Argument.String("caller-environment-id").pipe(
    Argument.withDescription(
      "Environment id of the environment that will call this one. It prints it with `t3 peer identity`.",
    ),
  ),
  session: Flag.Boolean("session").pipe(
    Flag.withDescription(
      "Issue a bearer token for `t3 peer add <name> <url> --token` instead of a one-time pairing link.",
    ),
    Flag.withDefault(false),
  ),
  baseUrl: Flag.String("base-url").pipe(
    Flag.withDescription(
      "This server's URL as the caller reaches it, to print a ready pairing link.",
    ),
    Flag.optional,
  ),
  ttl: Flag.String("ttl").pipe(
    Flag.withSchema(DurationFromString),
    Flag.withDescription("Lifetime, for example 10m or 30d."),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "On the environment being called: mint a credential that lets one named environment call it as a peer, and nothing else.",
  ),
  Command.withHandler((flags) =>
    withLocalAuth(
      flags,
      Effect.gen(function* () {
        const callerEnvironmentId = EnvironmentId.make(flags.environment.trim());
        const self = yield* (yield* ServerEnvironment.ServerEnvironmentIdentity).getEnvironmentId;
        if (callerEnvironmentId === self) {
          return yield* fail(
            "That is this environment's own id. Pass the id of the environment that will call this one.",
          );
        }
        const issued = yield* issuePeerCredential({
          callerEnvironmentId,
          session: flags.session,
          ttl: flags.ttl,
        });
        const pairingUrl =
          issued.kind === "pairing" && Option.isSome(flags.baseUrl)
            ? buildPairingUrl(flags.baseUrl.value, issued.secret)
            : undefined;
        const expiresAt = DateTime.formatIso(issued.expiresAt);
        if (flags.json) {
          return yield* printJson({
            kind: issued.kind,
            environmentId: self,
            callerEnvironmentId,
            scopes: [AuthFederationPeerScope],
            ...(issued.kind === "session"
              ? { token: issued.secret }
              : { credential: issued.secret }),
            ...(pairingUrl === undefined ? {} : { pairingUrl }),
            expiresAt,
          });
        }
        yield* Console.log(
          [
            `Peer credential for ${callerEnvironmentId} to call ${self}. Scope: ${AuthFederationPeerScope} only. Expires ${expiresAt}.`,
            issued.kind === "session"
              ? `On ${callerEnvironmentId}: t3 peer add <name> <this server's URL> --token ${issued.secret}`
              : `On ${callerEnvironmentId}: t3 peer add <name> "${pairingUrl ?? `<this server's URL>/pair#token=${issued.secret}`}"`,
            `Then here, so it may ask for anything: t3 peer add <name> <its link> --permissions-file <file>`,
          ].join("\n"),
        );
      }),
    ),
  ),
);

const identityCommand = Command.make("identity", { ...authLocationFlags, json: jsonFlag }).pipe(
  Command.withDescription(
    "Print this environment's id, which a peer needs to mint a credential for it.",
  ),
  Command.withHandler((flags) =>
    withLocalAuth(
      flags,
      Effect.gen(function* () {
        const environmentId = yield* (yield* ServerEnvironment.ServerEnvironmentIdentity)
          .getEnvironmentId;
        yield* flags.json ? printJson({ environmentId }) : Console.log(environmentId);
      }),
    ),
  ),
);

export const peerCommand = Command.make("peer").pipe(
  Command.withDescription(
    "Connect this environment to other T3 environments: peers, their permissions, and queued messages.",
  ),
  Command.withSubcommands([
    addCommand,
    listCommand,
    showCommand,
    updateCommand,
    setEnabledCommand("enable", "Resume a disabled peer link."),
    setEnabledCommand(
      "disable",
      "Stop sending to a peer and refuse its calls. Queued messages stay queued.",
    ),
    removeCommand,
    outboxCommand,
    Command.make("credential").pipe(
      Command.withDescription("Credentials that let another environment call this one as a peer."),
      Command.withSubcommands([credentialCreateCommand]),
    ),
    identityCommand,
  ]),
);
