import {
  AuthFederationPeerScope,
  type AutomationError,
  type EnvironmentId,
  FEDERATION_PROTOCOL_VERSION,
  type Peer,
  type PeerAddInput,
  type PeerDeliverInput,
  type PeerDeliverResult,
  type PeerHelloInput,
  type PeerHelloResult,
  PeerMessage,
  type PeerMessageBody,
  type PeerOutboxEntry,
  type PeerUpdateInput,
  type PeersOutboxInput,
} from "@t3tools/contracts";
import { resolveRemotePairingTarget } from "@t3tools/shared/remote";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { type AutomationCaller, automationError } from "./Caller.ts";
import {
  LOCAL_PEER_CAPABILITIES,
  negotiateProtocolVersion,
  peerMessageId,
  peerTokenSecretName,
  toPeer,
} from "./federation/PeerProtocol.ts";
import * as PeerStore from "./federation/PeerStore.ts";
import * as PeerTransport from "./federation/PeerTransport.ts";

export interface PeerEnqueueInput {
  readonly toEnvironmentId: EnvironmentId;
  readonly body: PeerMessageBody;
  readonly correlationId: string;
  /** Stable key: enqueueing the same thing twice returns the first message. */
  readonly dedupKey: string;
  readonly expiresAt?: string | undefined;
}

/** Paired peer environments and the store-and-forward link to each. */
export class PeerService extends Context.Service<
  PeerService,
  {
    readonly list: (
      caller: AutomationCaller,
    ) => Effect.Effect<ReadonlyArray<Peer>, AutomationError>;
    readonly add: (
      caller: AutomationCaller,
      input: PeerAddInput,
    ) => Effect.Effect<Peer, AutomationError>;
    readonly update: (
      caller: AutomationCaller,
      input: PeerUpdateInput,
    ) => Effect.Effect<Peer, AutomationError>;
    readonly remove: (
      caller: AutomationCaller,
      input: EnvironmentId,
    ) => Effect.Effect<boolean, AutomationError>;
    readonly outbox: (
      caller: AutomationCaller,
      input: PeersOutboxInput,
    ) => Effect.Effect<ReadonlyArray<PeerOutboxEntry>, AutomationError>;
    readonly enqueue: (input: PeerEnqueueInput) => Effect.Effect<PeerMessage, AutomationError>;
    readonly hello: (
      caller: AutomationCaller,
      input: PeerHelloInput,
    ) => Effect.Effect<PeerHelloResult, AutomationError>;
    readonly deliver: (
      caller: AutomationCaller,
      input: PeerDeliverInput,
    ) => Effect.Effect<PeerDeliverResult, AutomationError>;
  }
>()("t3/automation/PeerService") {}

const MAX_MESSAGES_PER_DELIVERY = 200;
const MAX_MESSAGE_BYTES = 512 * 1024;
const DEFAULT_OUTBOX_LIMIT = 200;

const decodeMessage = Schema.decodeUnknownEffect(PeerMessage);
const encodeMessageJson = Schema.encodeEffect(Schema.fromJsonString(PeerMessage));

const originOf = (value: string): string | null => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
};

const make = Effect.gen(function* () {
  const store = yield* PeerStore.PeerStore;
  const transport = yield* PeerTransport.PeerTransport;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  // Peers that called `deliver` since their last `hello`. A second delivery on
  // the same link proves the response to the first one arrived.
  const deliveredOnLink = yield* Ref.make<ReadonlySet<EnvironmentId>>(new Set());

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const requireOperator = (caller: AutomationCaller) =>
    caller.kind === "peer"
      ? Effect.fail(
          automationError("PERMISSION_DENIED", "A peer environment cannot manage peers here."),
        )
      : Effect.void;

  /**
   * Authorization at execution time: identity comes from the session, and the
   * peer row is read again on every call, so disabling or removing a peer
   * takes effect on its next request even over a socket that is still open.
   */
  const requirePeer = Effect.fn("PeerService.requirePeer")(function* (caller: AutomationCaller) {
    if (caller.kind !== "peer" || !caller.scopes.includes(AuthFederationPeerScope)) {
      return yield* automationError(
        "PERMISSION_DENIED",
        "Only a paired peer environment may call this.",
      );
    }
    const record = yield* store.get(caller.environmentId);
    if (record === null) {
      return yield* automationError(
        "PERMISSION_DENIED",
        "This environment is not registered as a peer here. Add it with `t3 peer add` on this side.",
        { environmentId: caller.environmentId },
      );
    }
    if (!record.enabled) {
      return yield* automationError("PERMISSION_DENIED", "This peer is disabled here.", {
        environmentId: caller.environmentId,
      });
    }
    return record;
  });

  const withPending = (record: PeerStore.PeerRecord) =>
    Effect.map(store.pendingCount(record.environmentId), (pending) => toPeer(record, pending));

  const readPeer = Effect.fn("PeerService.readPeer")(function* (environmentId: EnvironmentId) {
    const record = yield* store.get(environmentId);
    if (record === null) {
      return yield* automationError("NOT_FOUND", `No peer with environment id ${environmentId}.`, {
        environmentId,
      });
    }
    return record;
  });

  const describe = (httpBaseUrl: string) =>
    transport
      .describe(httpBaseUrl)
      .pipe(
        Effect.mapError((cause) =>
          automationError("ENVIRONMENT_UNAVAILABLE", cause.message, { httpBaseUrl }),
        ),
      );

  const list: PeerService["Service"]["list"] = Effect.fn("PeerService.list")(function* (caller) {
    yield* requireOperator(caller);
    return yield* Effect.forEach(yield* store.list, withPending);
  });

  const add: PeerService["Service"]["add"] = Effect.fn("PeerService.add")(
    function* (caller, input) {
      yield* requireOperator(caller);
      const credential = yield* Effect.gen(function* () {
        if (input.pairingUrl !== undefined) {
          if (input.token !== undefined || input.httpBaseUrl !== undefined) {
            return yield* automationError(
              "INVALID_INPUT",
              "Pass a pairing link, or a URL with a token, not both.",
            );
          }
          const pairing = yield* Effect.try({
            try: () => resolveRemotePairingTarget({ pairingUrl: input.pairingUrl! }),
            catch: () => automationError("INVALID_INPUT", "That is not a pairing link."),
          });
          const httpBaseUrl = pairing.httpBaseUrl.replace(/\/+$/, "");
          const token = yield* transport
            .exchangePairing(httpBaseUrl, pairing.credential)
            .pipe(
              Effect.mapError((cause) =>
                cause.reason === "unauthorized"
                  ? automationError(
                      "PERMISSION_DENIED",
                      "The peer refused the pairing link. It must be unused, unexpired, and created with `t3 peer credential create` so it grants the federation:peer scope.",
                    )
                  : automationError("ENVIRONMENT_UNAVAILABLE", cause.message),
              ),
            );
          return { httpBaseUrl, token };
        }
        const origin = input.httpBaseUrl === undefined ? null : originOf(input.httpBaseUrl);
        if (origin === null || input.token === undefined) {
          return yield* automationError(
            "INVALID_INPUT",
            "Pass a pairing link, or the peer's http(s) URL together with a token.",
          );
        }
        return { httpBaseUrl: origin, token: input.token };
      });

      const descriptor = yield* describe(credential.httpBaseUrl);
      const self = yield* environment.getEnvironmentId;
      if (descriptor.environmentId === self) {
        return yield* automationError("INVALID_INPUT", "An environment cannot be its own peer.");
      }
      // Compatibility is read from what the peer advertises. Anything short of an
      // explicit match is recorded as incompatible, with the reason, and nothing is sent.
      const version = negotiateProtocolVersion(
        LOCAL_PEER_CAPABILITIES.protocolVersions,
        descriptor.federationProtocolVersions,
      );
      const incompatibility = !descriptor.automation
        ? "The peer does not advertise automation support."
        : version === null
          ? `No shared federation protocol version (this environment speaks ${LOCAL_PEER_CAPABILITIES.protocolVersions.join(", ")}; the peer speaks ${descriptor.federationProtocolVersions.join(", ") || "none"}).`
          : null;
      const now = yield* nowIso;
      const existing = yield* store.get(descriptor.environmentId);
      const detail: PeerStore.PeerDetail = {
        httpBaseUrl: credential.httpBaseUrl,
        permissions: input.permissions,
        status: incompatibility === null ? "offline" : "incompatible",
        statusReason: incompatibility ?? "Not connected yet.",
        negotiatedProtocolVersion: incompatibility === null ? version : null,
        capabilities: null,
        lastConnectedAt: existing?.detail.lastConnectedAt ?? null,
        lastObservedAt: now,
      };
      // The credential goes to the secret store only: never into the row, an event, or a log.
      yield* secrets
        .set(
          peerTokenSecretName(descriptor.environmentId),
          new TextEncoder().encode(credential.token),
        )
        .pipe(
          Effect.mapError(() =>
            automationError("INTERNAL", "Could not store the peer credential."),
          ),
        );
      // The environment id is the identity. Adding it again replaces the name,
      // URL, credential and permissions and keeps the queues and cursors.
      if (existing === null) {
        yield* store.insert({
          environmentId: descriptor.environmentId,
          name: input.name,
          enabled: true,
          detail,
          createdAt: now,
        });
      } else {
        yield* store.update(descriptor.environmentId, {
          name: input.name,
          detail: () => detail,
          updatedAt: now,
        });
      }
      yield* store.signal({ type: "outbound", environmentId: descriptor.environmentId });
      return yield* Effect.flatMap(readPeer(descriptor.environmentId), withPending);
    },
  );

  const update: PeerService["Service"]["update"] = Effect.fn("PeerService.update")(
    function* (caller, input) {
      yield* requireOperator(caller);
      const record = yield* readPeer(input.environmentId);
      let httpBaseUrl = record.detail.httpBaseUrl;
      if (input.httpBaseUrl !== undefined) {
        const origin = originOf(input.httpBaseUrl);
        if (origin === null) {
          return yield* automationError("INVALID_INPUT", "The peer URL must be http(s).");
        }
        // The URL may move; the identity may not.
        const descriptor = yield* describe(origin);
        if (descriptor.environmentId !== record.environmentId) {
          return yield* automationError(
            "CONFLICT",
            "That URL belongs to a different environment. Add it as a new peer instead.",
            { expected: record.environmentId, found: descriptor.environmentId },
          );
        }
        httpBaseUrl = origin;
      }
      const enabled = input.enabled ?? record.enabled;
      yield* store.update(record.environmentId, {
        ...(input.name === undefined ? {} : { name: input.name }),
        enabled,
        detail: (current) => ({
          ...current,
          httpBaseUrl,
          permissions: input.permissions ?? current.permissions,
          ...(enabled
            ? {}
            : { status: "offline" as const, statusReason: "Disabled on this environment." }),
        }),
        updatedAt: yield* nowIso,
      });
      yield* store.signal({ type: "outbound", environmentId: record.environmentId });
      return yield* Effect.flatMap(readPeer(record.environmentId), withPending);
    },
  );

  const remove: PeerService["Service"]["remove"] = Effect.fn("PeerService.remove")(
    function* (caller, environmentId) {
      yield* requireOperator(caller);
      const removed = yield* store.remove(environmentId, yield* nowIso);
      yield* secrets.remove(peerTokenSecretName(environmentId)).pipe(Effect.ignore({ log: true }));
      yield* store.signal({ type: "outbound", environmentId });
      return removed;
    },
  );

  const outbox: PeerService["Service"]["outbox"] = Effect.fn("PeerService.outbox")(
    function* (caller, input) {
      yield* requireOperator(caller);
      return yield* store.outbox({
        environmentId: input.environmentId,
        statuses:
          input.includeDelivered === true
            ? undefined
            : ["pending_delivery", "rejected", "expired", "cancelled"],
        limit: input.limit ?? DEFAULT_OUTBOX_LIMIT,
      });
    },
  );

  const enqueue: PeerService["Service"]["enqueue"] = Effect.fn("PeerService.enqueue")(
    function* (input) {
      const self = yield* environment.getEnvironmentId;
      const now = yield* nowIso;
      const messageId = peerMessageId(self, input.toEnvironmentId, input.dedupKey);
      const candidate = {
        version: FEDERATION_PROTOCOL_VERSION,
        messageId,
        fromEnvironmentId: self,
        toEnvironmentId: input.toEnvironmentId,
        sequence: 1,
        correlationId: input.correlationId,
        sentAt: now,
        expiresAt: input.expiresAt ?? null,
        body: input.body,
      };
      const invalid = (message: string) => automationError("INVALID_INPUT", message, { messageId });
      const validated = yield* decodeMessage(candidate).pipe(
        Effect.mapError(() => invalid("The peer message is not valid.")),
      );
      const encoded = yield* encodeMessageJson(validated).pipe(
        Effect.mapError(() => invalid("The peer message cannot be encoded.")),
      );
      if (Buffer.byteLength(encoded) > MAX_MESSAGE_BYTES) {
        return yield* invalid(
          `A peer message may be at most ${MAX_MESSAGE_BYTES} bytes. Send references, not content.`,
        );
      }
      // Durable before anything is sent: the link worker only ever reads this table.
      const result = yield* store.enqueue({
        environmentId: input.toEnvironmentId,
        messageId,
        build: (sequence) => ({ ...validated, sequence }),
        now,
      });
      if (result.created) {
        yield* store.signal({ type: "outbound", environmentId: input.toEnvironmentId });
      }
      return result.message;
    },
  );

  const hello: PeerService["Service"]["hello"] = Effect.fn("PeerService.hello")(
    function* (caller, input) {
      const record = yield* requirePeer(caller);
      if (input.fromEnvironmentId !== record.environmentId) {
        return yield* automationError(
          "PERMISSION_DENIED",
          "The hello names a different environment than the credential it arrived with.",
          { session: record.environmentId, claimed: input.fromEnvironmentId },
        );
      }
      const self = yield* environment.getEnvironmentId;
      const descriptor = yield* environment.getDescriptor;
      const protocolVersion = negotiateProtocolVersion(
        LOCAL_PEER_CAPABILITIES.protocolVersions,
        input.capabilities.protocolVersions,
      );
      // A new link: the peer may have missed the last response it was sent.
      yield* store.resetUnconfirmedRejections(record.environmentId);
      yield* Ref.update(deliveredOnLink, (current) => {
        const next = new Set(current);
        next.delete(record.environmentId);
        return next;
      });
      const now = yield* nowIso;
      yield* store.update(record.environmentId, {
        detail: (current) => ({
          ...current,
          capabilities: input.capabilities,
          lastObservedAt: now,
        }),
        ackedThroughSequence: Math.min(
          input.receivedThroughSequence,
          record.nextOutboundSequence - 1,
        ),
        updatedAt: now,
      });
      return {
        environmentId: self,
        name: descriptor.label,
        capabilities: LOCAL_PEER_CAPABILITIES,
        protocolVersion,
        receivedThroughSequence: record.receivedThroughSequence,
        granted: record.detail.permissions.inbound,
      };
    },
  );

  const deliver: PeerService["Service"]["deliver"] = Effect.fn("PeerService.deliver")(
    function* (caller, input) {
      const record = yield* requirePeer(caller);
      if (input.messages.length > MAX_MESSAGES_PER_DELIVERY) {
        return yield* automationError(
          "BACKPRESSURE",
          `Send at most ${MAX_MESSAGES_PER_DELIVERY} messages per delivery.`,
        );
      }
      const self = yield* environment.getEnvironmentId;
      const rejected: Array<PeerDeliverResult["rejected"][number]> = [];
      const accepted: Array<PeerMessage> = [];
      for (const message of input.messages) {
        // Identity is the session's. What the body says about its sender is only checked against it.
        if (message.fromEnvironmentId !== record.environmentId) {
          rejected.push({
            messageId: message.messageId,
            code: "PERMISSION_DENIED",
            message: "The message names a different sender than the credential it arrived with.",
          });
        } else if (message.toEnvironmentId !== self) {
          rejected.push({
            messageId: message.messageId,
            code: "INVALID_INPUT",
            message: "The message is addressed to a different environment.",
          });
        } else {
          accepted.push(message);
        }
      }
      const now = yield* nowIso;
      // Stored before the acknowledgement below is returned.
      const stored = yield* store.storeInbound({
        environmentId: record.environmentId,
        messages: accepted,
        now,
      });
      for (const messageId of stored.conflicts) {
        rejected.push({
          messageId,
          code: "CONFLICT",
          message: "Another message already holds this sequence.",
        });
      }
      // A message seen before keeps the verdict it got the first time.
      const earlier = yield* store.inbound(
        record.environmentId,
        accepted.map((message) => message.messageId),
      );
      for (const row of earlier) {
        if (row.rejection !== null && row.status !== "rejected") rejected.push(row.rejection);
      }
      const confirmPrevious = (yield* Ref.get(deliveredOnLink)).has(record.environmentId);
      rejected.push(
        ...(yield* store.takeRejectionsToReport(record.environmentId, confirmPrevious)),
      );
      yield* Ref.update(deliveredOnLink, (current) => new Set(current).add(record.environmentId));
      yield* store.update(record.environmentId, {
        detail: (current) => ({ ...current, lastObservedAt: now }),
        updatedAt: now,
      });
      if (stored.stored > 0) yield* store.signal({ type: "inbound" });
      return {
        receivedThroughSequence: stored.receivedThroughSequence,
        rejected: rejected.filter(
          (entry, index) =>
            rejected.findIndex((other) => other.messageId === entry.messageId) === index,
        ),
      };
    },
  );

  return PeerService.of({ list, add, update, remove, outbox, enqueue, hello, deliver });
});

/**
 * For compositions that bring their own `PeerStore` and `PeerTransport`, such
 * as tests that connect two environments in memory.
 */
export const layerWithoutTransport = Layer.effect(PeerService, make);

/**
 * Needs `SqlClient`, `HttpClient`, `ServerEnvironment` and `ServerSecretStore`.
 * Also provides `PeerStore`, which `FederationReactor` shares to drive the links.
 */
export const layer = layerWithoutTransport.pipe(
  Layer.provideMerge(PeerStore.layer),
  Layer.provide(PeerTransport.layer),
);
