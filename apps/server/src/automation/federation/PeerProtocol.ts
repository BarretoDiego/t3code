// @effect-diagnostics-next-line nodeBuiltinImport:off -- Synchronous SHA-256 preserves persisted identifiers and byte digests.
import * as NodeCrypto from "node:crypto";

import {
  AUTOMATION_EVENT_TYPES,
  type AggregationCoverage,
  type EnvironmentId,
  FEDERATION_PROTOCOL_VERSION,
  type Peer,
  type PeerAction,
  type PeerCapabilities,
  type PeerMessageBody,
  PeerMessageId,
} from "@t3tools/contracts";

import type { PeerRecord } from "./PeerStore.ts";

/** What this build can do for a peer. `orchestratorHost` stays false until the handler seam is wired. */
export const LOCAL_PEER_CAPABILITIES: PeerCapabilities = {
  protocolVersions: [FEDERATION_PROTOCOL_VERSION],
  eventTypes: [...AUTOMATION_EVENT_TYPES],
  hookTargets: ["orchestrator_inbox", "cli_consumer", "webhook", "command"],
  orchestratorHost: false,
  jobs: true,
};

/** The highest version both sides speak, or null. Never assume one. */
export const negotiateProtocolVersion = (
  ours: ReadonlyArray<number>,
  theirs: ReadonlyArray<number>,
): number | null => {
  const shared = ours.filter((version) => theirs.includes(version));
  return shared.length === 0 ? null : Math.max(...shared);
};

/** Stable across retries: the same sender, receiver and dedup key always name the same message. */
export const peerMessageId = (from: EnvironmentId, to: EnvironmentId, dedupKey: string) =>
  PeerMessageId.make(
    `pm_${NodeCrypto.createHash("sha256").update(`${from}\u0000${to}\u0000${dedupKey}`).digest("hex").slice(0, 40)}`,
  );

export const peerTokenSecretName = (environmentId: EnvironmentId) =>
  `automation-peer-${NodeCrypto.createHash("sha256").update(environmentId).digest("hex").slice(0, 32)}`;

/**
 * The inbound permission a message needs, or null when the message reports on
 * work this environment itself asked the peer to do.
 */
export const requiredPeerAction = (body: PeerMessageBody): PeerAction | null => {
  switch (body.type) {
    case "text":
      return "message.send";
    case "events":
      return "event.forward";
    case "task.delegate":
    case "task.cancel":
      return "task.delegate";
    case "orchestrator.send":
      return "orchestrator.send";
    case "orchestrator.handoff":
      return "orchestrator.host";
    case "task.status":
    case "orchestrator.projection":
      return null;
  }
};

/** Exact type, or a prefix ending in `.*`. */
export const eventTypeMatches = (patterns: ReadonlyArray<string>, type: string) =>
  patterns.some((pattern) =>
    pattern.endsWith(".*") ? type.startsWith(pattern.slice(0, -1)) : pattern === type,
  );

export const toPeer = (record: PeerRecord, outboxPending: number): Peer => ({
  environmentId: record.environmentId,
  name: record.name,
  httpBaseUrl: record.detail.httpBaseUrl,
  enabled: record.enabled,
  permissions: record.detail.permissions,
  status: record.detail.status,
  statusReason: record.detail.statusReason,
  negotiatedProtocolVersion: record.detail.negotiatedProtocolVersion,
  capabilities: record.detail.capabilities,
  inboundCursor: record.inboundCursor,
  outboxPending: outboxPending,
  lastConnectedAt: record.detail.lastConnectedAt,
  lastObservedAt: record.detail.lastObservedAt,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
});

/**
 * Coverage of an answer assembled from this environment and what it holds
 * about its peers. Peer state here is always a stored projection, so a peer is
 * `stale` with the time it was last observed, or `unavailable` when it never
 * was. Attach this to any such answer; a partial view must say that it is one.
 */
export const coverageOfPeers = (
  self: { readonly environmentId: EnvironmentId; readonly observedAt: string },
  peers: ReadonlyArray<Peer>,
): AggregationCoverage => ({
  consulted: [self],
  unavailable: peers.flatMap((peer) =>
    peer.lastObservedAt === null
      ? [
          {
            environmentId: peer.environmentId,
            reason: peer.statusReason ?? `Never observed (${peer.status}).`,
          },
        ]
      : [],
  ),
  stale: peers.flatMap((peer) =>
    peer.lastObservedAt === null
      ? []
      : [{ environmentId: peer.environmentId, observedAt: peer.lastObservedAt }],
  ),
});
