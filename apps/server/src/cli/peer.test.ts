import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AuthFederationPeerScope,
  AuthStandardClientScopes,
  EnvironmentId,
  type Peer,
  type PeerOutboxEntry,
  PeerMessageId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import { callerFromSession } from "../automation/rpcHandlers.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  formatOutboxLine,
  formatPeer,
  formatPeerLine,
  issuePeerCredential,
  parsePeerPermissions,
} from "./peer.ts";

const CALLER = EnvironmentId.make("env-caller");

const authLayer = EnvironmentAuth.layer.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.identityLayer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-peer-cli-test-" })),
);

const peer: Peer = {
  environmentId: EnvironmentId.make("env-remote"),
  name: "Build box",
  httpBaseUrl: "https://build.example",
  enabled: true,
  permissions: { inbound: ["task.delegate"], forwardEventTypes: ["task.*"] },
  status: "offline",
  statusReason: "Could not reach the peer at https://build.example.",
  negotiatedProtocolVersion: 1,
  capabilities: null,
  inboundCursor: 12,
  outboxPending: 3,
  lastConnectedAt: null,
  lastObservedAt: "2026-01-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

it.layer(NodeServices.layer)("peer CLI", (it) => {
  it.effect("reads a permissions file and refuses what it does not understand", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* parsePeerPermissions(
          '{"inbound": ["task.delegate", "message.send"], "forwardEventTypes": ["task.*"]}',
        ),
        { inbound: ["task.delegate", "message.send"], forwardEventTypes: ["task.*"] },
      );
      // An unknown action or a missing list is an error, never read as "allow".
      for (const text of [
        '{"inbound": ["everything"], "forwardEventTypes": []}',
        '{"inbound": ["task.delegate"]}',
        "task.delegate",
        "",
      ]) {
        const error = yield* parsePeerPermissions(text).pipe(Effect.flip);
        assert.include(error.message, "permissions file must be JSON");
      }
    }),
  );

  it("prints the link's real state and what is still waiting", () => {
    const line = formatPeerLine(peer);
    assert.include(line, "offline");
    assert.include(line, "outbox 3");
    assert.include(line, "never connected");
    assert.include(line, "Could not reach the peer");
    assert.include(formatPeerLine({ ...peer, enabled: false }), "disabled");
    const shown = formatPeer(peer);
    assert.include(shown, "may ask:     task.delegate");
    assert.include(shown, "forwarded:   task.*");
    assert.include(
      formatPeer({ ...peer, permissions: { inbound: [], forwardEventTypes: [] } }),
      "may ask:     nothing",
    );
  });

  it("says that delivered means stored, and shows a rejection with its code", () => {
    const entry: PeerOutboxEntry = {
      message: {
        version: 1,
        messageId: PeerMessageId.make("pm_1"),
        fromEnvironmentId: EnvironmentId.make("env-here"),
        toEnvironmentId: peer.environmentId,
        sequence: 4,
        correlationId: "corr",
        sentAt: "2026-01-01T00:00:00.000Z",
        expiresAt: null,
        body: { type: "text", text: "hello" },
      },
      status: "delivered",
      attemptCount: 0,
      lastError: null,
      rejection: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    assert.include(formatOutboxLine(entry), "delivered (stored by the peer)");
    const rejected = formatOutboxLine({
      ...entry,
      status: "rejected",
      rejection: "PERMISSION_DENIED",
      lastError: "This peer is not permitted to message.send here.",
      attemptCount: 2,
    });
    assert.include(rejected, "rejected  PERMISSION_DENIED");
    assert.include(rejected, "2 failed attempts");
  });

  it.effect("mints a session that is a peer of exactly one environment and nothing else", () =>
    Effect.gen(function* () {
      const issued = yield* issuePeerCredential({
        callerEnvironmentId: CALLER,
        session: true,
        ttl: Option.none(),
      });
      assert.strictEqual(issued.kind, "session");
      const session = yield* (yield* SessionStore.SessionStore).verify(issued.secret);
      assert.deepStrictEqual(session.scopes, [AuthFederationPeerScope]);
      const caller = callerFromSession(session);
      assert.strictEqual(caller.kind, "peer");
      assert.strictEqual(caller.kind === "peer" ? caller.environmentId : null, CALLER);
    }).pipe(Effect.provide(authLayer)),
  );

  it.effect("mints a pairing link that cannot be exchanged for client access", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const forClient = yield* issuePeerCredential({
        callerEnvironmentId: CALLER,
        session: false,
        ttl: Option.none(),
      });
      assert.strictEqual(forClient.kind, "pairing");
      const refused = yield* auth
        .exchangeBootstrapCredentialForAccessToken(forClient.secret, AuthStandardClientScopes, {
          deviceType: "bot",
        })
        .pipe(Effect.flip);
      assert.strictEqual(refused._tag, "ServerAuthScopeNotGrantedError");

      const forPeer = yield* issuePeerCredential({
        callerEnvironmentId: CALLER,
        session: false,
        ttl: Option.none(),
      });
      const exchanged = yield* auth.exchangeBootstrapCredentialForAccessToken(
        forPeer.secret,
        [AuthFederationPeerScope],
        { deviceType: "bot" },
      );
      const session = yield* (yield* SessionStore.SessionStore).verify(exchanged.access_token);
      assert.deepStrictEqual(session.scopes, [AuthFederationPeerScope]);
      assert.strictEqual(session.subject, `peer:${CALLER}`);
    }).pipe(Effect.provide(authLayer)),
  );
});
