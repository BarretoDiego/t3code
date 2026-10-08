import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AuthStandardClientScopes,
  AutomationJournalEntry,
  Peer,
  DelegatedTaskId,
  type DelegatedTask,
  EnvironmentId,
  FEDERATION_PROTOCOL_VERSION,
  OrchestratorId,
  type PeerMessage,
  PeerMessageId,
  type PeerMessageBody,
  type PeerPermissions,
  ProjectId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import { automationError, internalCaller, peerSessionSubject } from "../Caller.ts";
import * as EventJournal from "../EventJournal.ts";
import * as PeerService from "../PeerService.ts";
import * as FederationReactor from "./FederationReactor.ts";
import { coverageOfPeers, peerTokenSecretName } from "./PeerProtocol.ts";
import * as PeerTransport from "./PeerTransport.ts";
import {
  addPeer,
  boot,
  makeNetwork,
  makeWorld,
  type Network,
  noPermissions,
  operator,
  pair,
  processInbox,
  type RunningEnvironment,
  syncPeer,
} from "./testkit/FederationTestKit.ts";

const PROJECT = ProjectId.make("project-1");
const encodeJournal = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Array(AutomationJournalEntry)),
);
const encodePeer = Schema.encodeEffect(Schema.fromJsonString(Peer));
const delegating: PeerPermissions = { inbound: ["task.delegate"], forwardEventTypes: [] };

const makeTask = (from: RunningEnvironment, to: RunningEnvironment, id: string): DelegatedTask => ({
  id: DelegatedTaskId.make(id),
  version: 1,
  revision: 1,
  originEnvironmentId: from.world.id,
  executionEnvironmentId: to.world.id,
  nodeId: null,
  orchestratorId: null,
  parentTaskId: null,
  parentThreadId: null,
  threadId: null,
  kind: "managed_thread",
  capabilities: { send: true, answer: true, cancel: true, read: true },
  target: { environmentId: to.world.id, projectId: PROJECT },
  contract: {
    title: "Fix the build",
    objective: "Make the build pass",
    deliverables: ["a passing build"],
    acceptanceCriteria: ["CI is green"],
  },
  status: "pending_delivery",
  statusReason: null,
  attemptCount: 0,
  claim: null,
  result: null,
  usage: { tokens: null, turns: 0 },
  observedAt: "2026-01-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const enqueue = (
  from: RunningEnvironment,
  to: RunningEnvironment,
  body: PeerMessageBody,
  dedupKey: string,
  expiresAt?: string,
) =>
  from.run(
    Effect.flatMap(PeerService.PeerService, (peers) =>
      peers.enqueue({
        toEnvironmentId: to.world.id,
        body,
        correlationId: `corr-${dedupKey}`,
        dedupKey,
        expiresAt,
      }),
    ),
  );

const delegate = (from: RunningEnvironment, to: RunningEnvironment, id: string) =>
  enqueue(from, to, { type: "task.delegate", task: makeTask(from, to, id) }, `delegate:${id}`);

const outbox = (environment: RunningEnvironment) =>
  environment.run(
    Effect.flatMap(PeerService.PeerService, (peers) =>
      peers.outbox(operator, { includeDelivered: true }),
    ),
  );

const peerOf = (environment: RunningEnvironment, other: RunningEnvironment) =>
  environment
    .run(Effect.flatMap(PeerService.PeerService, (peers) => peers.list(operator)))
    .pipe(Effect.map((list) => list.find((peer) => peer.environmentId === other.world.id)!));

const updatePeer = (
  environment: RunningEnvironment,
  other: RunningEnvironment,
  patch: { readonly enabled?: boolean; readonly permissions?: PeerPermissions },
) =>
  environment.run(
    Effect.flatMap(PeerService.PeerService, (peers) =>
      peers.update(operator, { environmentId: other.world.id, ...patch }),
    ),
  );

const inboxRows = (environment: RunningEnvironment) =>
  environment.run(
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) =>
        sql<{
          message_id: string;
          status: string;
          error: string | null;
        }>`SELECT message_id, status, error FROM automation_peer_inbox ORDER BY sequence ASC`,
    ),
  );

const deliveriesTo = (network: Network, environment: RunningEnvironment) =>
  network.calls.filter((call) => call.to === environment.world.origin && call.method === "deliver");

const sentMessages = (network: Network, environment: RunningEnvironment) =>
  deliveriesTo(network, environment).reduce((total, call) => total + call.messages, 0);

const twoEnvironments = Effect.gen(function* () {
  const network = makeNetwork();
  const a = yield* boot(yield* makeWorld("a"), network);
  const b = yield* boot(yield* makeWorld("b"), network);
  return { network, a, b };
});

const appendCustom = (environment: RunningEnvironment, name: string) =>
  environment.run(
    Effect.flatMap(EventJournal.EventJournal, (journal) =>
      journal.append([
        {
          type: `custom.build.${name}`,
          scope: {},
          origin: { kind: "custom" },
          aggregate: { kind: "custom", id: name },
          payload: { name },
        },
      ]),
    ),
  );

it.layer(NodeServices.layer)("federation between two environments", (it) => {
  it.effect("delivers a delegation once after the peer comes back, and traces its status", () =>
    Effect.gen(function* () {
      const { network, a, b } = yield* twoEnvironments;
      yield* pair(a, b, { right: delegating });
      network.unreachable.add(b.world.origin);

      const message = yield* delegate(a, b, "task-1");
      yield* syncPeer(a, b);

      // Offline is not success: the entry waits, and says why.
      const waiting = (yield* outbox(a))[0]!;
      assert.strictEqual(waiting.status, "pending_delivery");
      assert.strictEqual(sentMessages(network, b), 0);
      const offline = yield* peerOf(a, b);
      assert.strictEqual(offline.status, "offline");
      assert.strictEqual(offline.outboxPending, 1);
      assert.strictEqual(b.world.tasks.created, 0);

      network.unreachable.delete(b.world.origin);
      // Still inside the backoff window: no attempt yet.
      yield* syncPeer(a, b);
      assert.strictEqual(sentMessages(network, b), 0);
      yield* TestClock.adjust("10 minutes");
      yield* syncPeer(a, b);

      const delivered = (yield* outbox(a))[0]!;
      assert.strictEqual(delivered.status, "delivered");
      assert.strictEqual(delivered.message.messageId, message.messageId);
      assert.strictEqual((yield* peerOf(a, b)).status, "connected");
      // Stored is not executed: nothing ran until the destination processed it.
      assert.strictEqual(b.world.tasks.created, 0);

      yield* processInbox(b);
      assert.strictEqual(b.world.tasks.created, 1);
      const accepted = b.world.tasks.byId.get("task-1")!;
      assert.strictEqual(accepted.threadId, "thread-task-1");

      // The same delegation enqueued again is the same message, not a second one.
      const repeat = yield* delegate(a, b, "task-1");
      assert.strictEqual(repeat.messageId, message.messageId);
      assert.strictEqual(repeat.sequence, message.sequence);
      yield* syncPeer(a, b);
      yield* processInbox(b);
      assert.strictEqual((yield* outbox(a)).length, 1);
      assert.strictEqual(b.world.tasks.created, 1);

      // Acceptance travels back as its own message and lands on the origin's task.
      yield* syncPeer(b, a);
      yield* processInbox(a);
      assert.strictEqual(a.world.tasks.remoteStatuses.length, 1);
      const reported = a.world.tasks.remoteStatuses[0]!;
      assert.strictEqual(reported.id, "task-1");
      assert.strictEqual(reported.status, "accepted");
      assert.strictEqual(reported.threadId, "thread-task-1");
      const statusMessage = (yield* outbox(b))[0]!;
      assert.strictEqual(statusMessage.status, "delivered");
      assert.strictEqual(statusMessage.message.correlationId, message.correlationId);
    }),
  );

  it.effect("processes a stored message exactly once after the destination restarts", () =>
    Effect.gen(function* () {
      const { network, a, b } = yield* twoEnvironments;
      yield* pair(a, b, { right: delegating });
      yield* delegate(a, b, "task-1");
      yield* syncPeer(a, b);
      assert.strictEqual((yield* outbox(a))[0]!.status, "delivered");
      assert.strictEqual(b.world.tasks.created, 0);

      // The destination acknowledged, then died before running anything.
      yield* b.stop;
      const restarted = yield* boot(b.world, network);
      assert.deepStrictEqual(
        (yield* inboxRows(restarted)).map((row) => row.status),
        ["stored"],
      );
      yield* processInbox(restarted);
      yield* processInbox(restarted);
      assert.strictEqual(b.world.tasks.acceptCalls, 1);
      assert.strictEqual(b.world.tasks.created, 1);
      assert.deepStrictEqual(
        (yield* inboxRows(restarted)).map((row) => row.status),
        ["processed"],
      );
    }),
  );

  it.effect("runs a message again, harmlessly, when the crash came after its effect", () =>
    Effect.gen(function* () {
      const { network, a, b } = yield* twoEnvironments;
      yield* pair(a, b, { right: delegating });
      yield* delegate(a, b, "task-1");
      yield* syncPeer(a, b);
      // The task was created, and the process died before the inbox row was settled.
      b.world.tasks.byId.set("task-1", { ...makeTask(a, b, "task-1"), status: "accepted" });
      b.world.tasks.created = 1;
      yield* b.stop;
      const restarted = yield* boot(b.world, network);
      yield* processInbox(restarted);
      // At-least-once towards an idempotent service: called again, created once.
      assert.strictEqual(b.world.tasks.acceptCalls, 1);
      assert.strictEqual(b.world.tasks.created, 1);
      assert.strictEqual((yield* inboxRows(restarted))[0]!.status, "processed");
    }),
  );

  it.effect("deduplicates a resend when the acknowledgement was lost", () =>
    Effect.gen(function* () {
      const { network, a, b } = yield* twoEnvironments;
      yield* pair(a, b, { right: delegating });
      const message = yield* delegate(a, b, "task-1");
      network.lostResponses.set(b.world.origin, 1);
      yield* syncPeer(a, b);

      // The destination has it; the sender cannot know, so it claims nothing.
      assert.strictEqual((yield* inboxRows(b)).length, 1);
      const unacknowledged = (yield* outbox(a))[0]!;
      assert.strictEqual(unacknowledged.status, "pending_delivery");
      assert.strictEqual(unacknowledged.attemptCount, 1);
      assert.strictEqual((yield* peerOf(a, b)).status, "offline");

      // The sender itself restarts before it retries.
      yield* a.stop;
      const restarted = yield* boot(a.world, network);
      yield* syncPeer(restarted, b);
      const resent = (yield* outbox(restarted))[0]!;
      assert.strictEqual(resent.status, "delivered");
      assert.strictEqual(resent.message.messageId, message.messageId);
      assert.strictEqual(sentMessages(network, b), 2);
      assert.strictEqual((yield* inboxRows(b)).length, 1);
      yield* processInbox(b);
      assert.strictEqual(b.world.tasks.created, 1);
    }),
  );

  it.effect("rejects at execution a message queued before its permission was revoked", () =>
    Effect.gen(function* () {
      const { a, b } = yield* twoEnvironments;
      yield* pair(a, b, { right: delegating });
      yield* delegate(a, b, "task-1");
      yield* syncPeer(a, b);
      assert.strictEqual((yield* outbox(a))[0]!.status, "delivered");

      yield* updatePeer(b, a, { permissions: noPermissions });
      yield* processInbox(b);
      assert.strictEqual(b.world.tasks.acceptCalls, 0);
      const row = (yield* inboxRows(b))[0]!;
      assert.strictEqual(row.status, "rejected");
      assert.include(row.error ?? "", "PERMISSION_DENIED");

      // The next exchange on the link carries the verdict back to the sender.
      yield* TestClock.adjust("31 seconds");
      yield* syncPeer(a, b);
      const rejected = (yield* outbox(a))[0]!;
      assert.strictEqual(rejected.status, "rejected");
      assert.strictEqual(rejected.rejection, "PERMISSION_DENIED");
      assert.strictEqual((yield* inboxRows(b))[0]!.status, "rejected_sent");
      // One more exchange proves the report arrived, and it is not sent again.
      yield* TestClock.adjust("31 seconds");
      yield* syncPeer(a, b);
      assert.strictEqual((yield* inboxRows(b))[0]!.status, "rejected_reported");
    }),
  );

  it.effect("reports a rejection again when the response carrying it was lost", () =>
    Effect.gen(function* () {
      const { network, a, b } = yield* twoEnvironments;
      yield* pair(a, b, { right: noPermissions });
      yield* delegate(a, b, "task-1");
      yield* syncPeer(a, b);
      yield* processInbox(b);
      network.lostResponses.set(b.world.origin, 1);
      yield* TestClock.adjust("31 seconds");
      yield* syncPeer(a, b);
      // The destination stays honest about what it reported; the sender still shows `delivered`.
      assert.strictEqual((yield* outbox(a))[0]!.status, "delivered");
      yield* TestClock.adjust("10 minutes");
      yield* syncPeer(a, b);
      assert.strictEqual((yield* outbox(a))[0]!.status, "rejected");
    }),
  );

  it.effect("refuses a disabled or removed peer on its next call over an open link", () =>
    Effect.gen(function* () {
      const { network, a, b } = yield* twoEnvironments;
      yield* pair(a, b, { right: delegating });
      yield* syncPeer(a, b);
      assert.strictEqual((yield* peerOf(a, b)).status, "connected");
      const helloCalls = network.calls.filter((call) => call.method === "hello").length;

      yield* updatePeer(b, a, { enabled: false });
      yield* delegate(a, b, "task-1");
      yield* syncPeer(a, b);

      // Same link, no new handshake: the refusal came from the service call itself.
      assert.strictEqual(
        network.calls.filter((call) => call.method === "hello").length,
        helloCalls,
      );
      assert.strictEqual((yield* inboxRows(b)).length, 0);
      assert.strictEqual((yield* outbox(a))[0]!.status, "pending_delivery");
      const refused = yield* peerOf(a, b);
      assert.strictEqual(refused.status, "revoked");
      assert.include(refused.statusReason ?? "", "disabled");

      yield* updatePeer(b, a, { enabled: true });
      yield* b.run(
        Effect.flatMap(PeerService.PeerService, (peers) => peers.remove(operator, a.world.id)),
      );
      yield* TestClock.adjust("10 minutes");
      yield* syncPeer(a, b);
      assert.strictEqual((yield* peerOf(a, b)).status, "revoked");
      assert.strictEqual((yield* outbox(a))[0]!.status, "pending_delivery");
      assert.strictEqual(b.world.tasks.acceptCalls, 0);
    }),
  );

  it.effect("takes the sender from the session, not from the message body", () =>
    Effect.gen(function* () {
      const { a, b } = yield* twoEnvironments;
      yield* pair(a, b, { right: delegating });
      const token = yield* a.run(
        Effect.flatMap(ServerSecretStore.ServerSecretStore, (secrets) =>
          secrets.get(peerTokenSecretName(b.world.id)),
        ),
      );
      const link = yield* a.run(
        Effect.flatMap(PeerTransport.PeerTransport, (transport) =>
          transport.open(b.world.origin, new TextDecoder().decode(Option.getOrThrow(token))),
        ),
      );
      const impostor = EnvironmentId.make("env-c");
      const forged: PeerMessage = {
        version: FEDERATION_PROTOCOL_VERSION,
        messageId: PeerMessageId.make("pm_forged"),
        fromEnvironmentId: impostor,
        toEnvironmentId: b.world.id,
        sequence: 1,
        correlationId: "corr",
        sentAt: "2026-01-01T00:00:00.000Z",
        expiresAt: null,
        body: { type: "task.delegate", task: makeTask(a, b, "task-forged") },
      };
      const result = yield* link.deliver({ messages: [forged] });
      assert.deepStrictEqual(
        result.rejected.map((entry) => [entry.messageId, entry.code]),
        [["pm_forged", "PERMISSION_DENIED"]],
      );
      assert.strictEqual((yield* inboxRows(b)).length, 0);

      const hello = yield* link
        .hello({
          fromEnvironmentId: impostor,
          name: "impostor",
          capabilities: {
            protocolVersions: [1],
            eventTypes: [],
            hookTargets: [],
            orchestratorHost: false,
            jobs: false,
          },
          receivedThroughSequence: 0,
        })
        .pipe(Effect.flip);
      assert.strictEqual(hello._tag === "AutomationError" ? hello.code : null, "PERMISSION_DENIED");

      // A task that claims another origin is refused when it runs, too.
      yield* enqueue(
        a,
        b,
        {
          type: "task.delegate",
          task: { ...makeTask(a, b, "task-2"), originEnvironmentId: impostor },
        },
        "delegate:task-2",
      );
      yield* syncPeer(a, b);
      yield* processInbox(b);
      assert.strictEqual(b.world.tasks.acceptCalls, 0);
      assert.include((yield* inboxRows(b))[0]!.error ?? "", "PERMISSION_DENIED");
    }),
  );

  it.effect("marks a peer without a shared protocol version incompatible and sends nothing", () =>
    Effect.gen(function* () {
      const { network, a, b } = yield* twoEnvironments;
      network.descriptorOverrides.set(b.world.origin, { federationProtocolVersions: [2] });
      const added = yield* addPeer(a, b, noPermissions);
      assert.strictEqual(added.status, "incompatible");
      assert.include(added.statusReason ?? "", "No shared federation protocol version");
      assert.strictEqual(added.negotiatedProtocolVersion, null);

      // The handshake is authoritative: it disagrees with us too, so still nothing goes out.
      yield* addPeer(b, a, delegating);
      network.helloOverrides.set(b.world.origin, (result) => ({
        ...result,
        protocolVersion: null,
        capabilities: { ...result.capabilities, protocolVersions: [2] },
      }));
      yield* delegate(a, b, "task-1");
      yield* syncPeer(a, b);
      assert.strictEqual(sentMessages(network, b), 0);
      assert.strictEqual(deliveriesTo(network, b).length, 0);
      assert.strictEqual((yield* peerOf(a, b)).status, "incompatible");
      assert.strictEqual((yield* outbox(a))[0]!.status, "pending_delivery");

      network.descriptorOverrides.set(b.world.origin, { automation: false });
      const withoutAutomation = yield* addPeer(a, b, noPermissions);
      assert.strictEqual(withoutAutomation.status, "incompatible");
      assert.include(withoutAutomation.statusReason ?? "", "automation");
    }),
  );

  it.effect("never executes an expired message, at either end", () =>
    Effect.gen(function* () {
      const { network, a, b } = yield* twoEnvironments;
      yield* pair(a, b, { right: delegating });
      const inOneMinute = DateTime.formatIso(DateTime.add(yield* DateTime.now, { minutes: 1 }));

      // Expires while the destination is unreachable: never sent.
      network.unreachable.add(b.world.origin);
      yield* enqueue(
        a,
        b,
        { type: "task.delegate", task: makeTask(a, b, "task-late") },
        "delegate:task-late",
        inOneMinute,
      );
      yield* syncPeer(a, b);
      yield* TestClock.adjust("10 minutes");
      network.unreachable.delete(b.world.origin);
      yield* syncPeer(a, b);
      assert.strictEqual((yield* outbox(a))[0]!.status, "expired");
      assert.strictEqual(sentMessages(network, b), 0);

      // Stored in time, but its deadline passes before the destination gets to it.
      const later = DateTime.formatIso(DateTime.add(yield* DateTime.now, { minutes: 1 }));
      yield* enqueue(
        a,
        b,
        { type: "task.delegate", task: makeTask(a, b, "task-stale") },
        "delegate:task-stale",
        later,
      );
      yield* syncPeer(a, b);
      assert.strictEqual((yield* inboxRows(b)).length, 1);
      yield* TestClock.adjust("2 minutes");
      yield* processInbox(b);
      assert.strictEqual(b.world.tasks.acceptCalls, 0);
      assert.include((yield* inboxRows(b))[0]!.error ?? "", "REQUEST_EXPIRED");
      yield* syncPeer(a, b);
      const entries = yield* outbox(a);
      assert.deepStrictEqual(
        entries.map((entry) => [entry.status, entry.rejection]),
        [
          ["expired", null],
          ["rejected", "REQUEST_EXPIRED"],
        ],
      );
    }),
  );

  it.effect("forwards events once, never back to their origin, and resumes from the cursor", () =>
    Effect.gen(function* () {
      const { network, a, b } = yield* twoEnvironments;
      const forwarding: PeerPermissions = {
        inbound: ["event.forward"],
        forwardEventTypes: ["custom.build.*"],
      };
      yield* pair(a, b, { left: forwarding, right: forwarding });

      yield* appendCustom(a, "started");
      yield* a.run(
        Effect.flatMap(EventJournal.EventJournal, (journal) =>
          journal.append([
            {
              type: "job.finished",
              scope: {},
              origin: { kind: "service" },
              aggregate: { kind: "job", id: "job-1" },
              payload: {},
            },
          ]),
        ),
      );
      yield* appendCustom(a, "finished");

      // The first delivery is stored and its response lost, so it is sent twice.
      network.lostResponses.set(b.world.origin, 1);
      yield* syncPeer(a, b);
      yield* processInbox(b);
      yield* TestClock.adjust("10 minutes");
      yield* syncPeer(a, b);
      yield* processInbox(b);

      const imported = () =>
        b.world.journal.entries.filter((entry) => entry.event.origin.environmentId === a.world.id);
      // Only the subscribed types, each once, still attributed to where they happened.
      assert.deepStrictEqual(
        imported().map((entry) => [entry.event.type, entry.event.originCursor]),
        [
          ["custom.build.started", 1],
          ["custom.build.finished", 3],
        ],
      );
      assert.strictEqual((yield* peerOf(b, a)).inboundCursor, 3);

      // The receiver forwards the same types to the sender, but not the sender's own events.
      const journalOfA = a.world.journal.entries.length;
      yield* syncPeer(b, a);
      yield* processInbox(a);
      assert.strictEqual(
        (yield* outbox(b)).filter((entry) => entry.message.body.type === "events").length,
        0,
      );
      assert.strictEqual(
        a.world.journal.entries.filter((entry) => entry.event.type.startsWith("custom.build."))
          .length,
        2,
      );
      assert.isAtLeast(a.world.journal.entries.length, journalOfA);

      // New events while the peer is away are forwarded after it returns, the old ones are not resent.
      network.unreachable.add(b.world.origin);
      yield* appendCustom(a, "deployed");
      yield* TestClock.adjust("31 seconds");
      yield* syncPeer(a, b);
      network.unreachable.delete(b.world.origin);
      yield* TestClock.adjust("10 minutes");
      yield* syncPeer(a, b);
      yield* processInbox(b);
      assert.deepStrictEqual(
        imported().map((entry) => entry.event.type),
        ["custom.build.started", "custom.build.finished", "custom.build.deployed"],
      );
      const eventMessages = (yield* outbox(a)).filter(
        (entry) => entry.message.body.type === "events",
      );
      assert.deepStrictEqual(
        eventMessages.map((entry) =>
          entry.message.body.type === "events" ? entry.message.body.entries.length : 0,
        ),
        [2, 1],
      );

      // An event that claims an origin other than the sender is dropped, not stored as fact.
      const forgedOrigin = EnvironmentId.make("env-c");
      yield* enqueue(
        a,
        b,
        {
          type: "events",
          entries: [
            {
              cursor: 99,
              event: {
                ...a.world.journal.entries[0]!.event,
                origin: { environmentId: forgedOrigin, kind: "service" },
                originCursor: 1,
              },
            },
            { cursor: 100, event: { ...b.world.journal.entries[0]!.event } },
          ],
        },
        "events:forged",
      );
      const before = b.world.journal.entries.length;
      yield* syncPeer(a, b);
      yield* processInbox(b);
      assert.strictEqual(
        b.world.journal.entries.filter((entry) => entry.event.origin.environmentId === forgedOrigin)
          .length,
        0,
      );
      assert.isAtMost(b.world.journal.entries.length, before + 1);
    }),
  );

  it.effect("survives a partition with both sides active without duplicates or false success", () =>
    Effect.gen(function* () {
      const { network, a, b } = yield* twoEnvironments;
      yield* pair(a, b, { left: delegating, right: delegating });
      yield* syncPeer(a, b);
      yield* syncPeer(b, a);

      network.unreachable.add(a.world.origin).add(b.world.origin);
      yield* delegate(a, b, "task-from-a");
      yield* delegate(b, a, "task-from-b");
      yield* syncPeer(a, b);
      yield* syncPeer(b, a);
      yield* processInbox(a);
      yield* processInbox(b);

      for (const [side, other] of [
        [a, b],
        [b, a],
      ] as const) {
        const entries = yield* outbox(side);
        assert.deepStrictEqual(
          entries.map((entry) => entry.status),
          ["pending_delivery"],
        );
        assert.strictEqual((yield* peerOf(side, other)).status, "offline");
        assert.strictEqual(side.world.tasks.created, 0);
      }

      // The partition heals in the worst way: the first exchange each way loses its response.
      network.unreachable.clear();
      network.lostResponses.set(a.world.origin, 1).set(b.world.origin, 1);
      yield* TestClock.adjust("10 minutes");
      yield* syncPeer(a, b);
      yield* syncPeer(b, a);
      yield* processInbox(a);
      yield* processInbox(b);
      yield* TestClock.adjust("10 minutes");
      for (let round = 0; round < 3; round += 1) {
        yield* syncPeer(a, b);
        yield* syncPeer(b, a);
        yield* processInbox(a);
        yield* processInbox(b);
      }

      assert.strictEqual(a.world.tasks.created, 1);
      assert.strictEqual(b.world.tasks.created, 1);
      assert.strictEqual(a.world.tasks.byId.get("task-from-b")!.threadId, "thread-task-from-b");
      // Each side holds exactly one delegation and one status report, all confirmed stored.
      for (const side of [a, b]) {
        const entries = yield* outbox(side);
        assert.deepStrictEqual(
          entries.map((entry) => [entry.message.body.type, entry.status]),
          [
            ["task.delegate", "delivered"],
            ["task.status", "delivered"],
          ],
        );
        assert.strictEqual(side.world.tasks.remoteStatuses.length, 1);
      }
    }),
  );

  it.effect(
    "routes text to the orchestrator inbox once and stores unsupported orchestrator messages",
    () =>
      Effect.gen(function* () {
        const { network, a, b } = yield* twoEnvironments;
        yield* pair(a, b, {
          right: { inbound: ["message.send", "orchestrator.send"], forwardEventTypes: [] },
        });
        const orchestratorId = OrchestratorId.make("orch-1");
        yield* enqueue(
          a,
          b,
          { type: "text", toOrchestratorId: orchestratorId, text: "build is red" },
          "text:1",
        );
        yield* enqueue(
          a,
          b,
          { type: "orchestrator.send", orchestratorId, text: "hello", from: { kind: "user" } },
          "orch:1",
        );
        network.lostResponses.set(b.world.origin, 1);
        yield* syncPeer(a, b);
        yield* processInbox(b);
        yield* TestClock.adjust("10 minutes");
        yield* syncPeer(a, b);
        yield* processInbox(b);

        assert.strictEqual(b.world.inbox.entries.length, 1);
        const entry = b.world.inbox.entries[0]!;
        assert.strictEqual(entry.kind, "peer_message");
        assert.strictEqual(entry.text, "build is red");
        const received = b.world.journal.entries.filter(
          (item) => item.event.type === "peer.message.received",
        );
        assert.strictEqual(received.length, 1);
        // Recorded here as something a peer said, not as something that happened there.
        assert.strictEqual(received[0]!.event.origin.environmentId, b.world.id);
        assert.strictEqual(received[0]!.event.origin.kind, "peer");
        assert.strictEqual(received[0]!.event.origin.actorId, a.world.id);

        // Kept and answered, not dropped: the sender learns the capability is missing.
        assert.deepStrictEqual(
          (yield* inboxRows(b)).map((row) => row.status),
          ["processed", "rejected_sent"],
        );
        assert.deepStrictEqual(
          (yield* outbox(a)).map((item) => [item.status, item.rejection]),
          [
            ["delivered", null],
            ["rejected", "CAPABILITY_UNSUPPORTED"],
          ],
        );
      }),
  );

  it.effect("keeps the order and retries a message whose handler is briefly unavailable", () =>
    Effect.gen(function* () {
      const { a, b } = yield* twoEnvironments;
      yield* pair(a, b, { right: delegating });
      yield* delegate(a, b, "task-1");
      yield* delegate(a, b, "task-2");
      yield* syncPeer(a, b);
      // The first message cannot run yet; the second must wait behind it.
      b.world.tasks.failures.push(automationError("INTERNAL", "busy"));
      yield* processInbox(b);
      assert.strictEqual(b.world.tasks.created, 0);
      assert.deepStrictEqual(
        (yield* inboxRows(b)).map((row) => row.status),
        ["stored", "stored"],
      );
      yield* processInbox(b);
      assert.deepStrictEqual([...b.world.tasks.byId.keys()], ["task-1", "task-2"]);
    }),
  );

  it.effect(
    "does not let human pairing grant federation, and keeps credentials out of rows and events",
    () =>
      Effect.gen(function* () {
        const { network, a, b } = yield* twoEnvironments;
        // A link made for a person: standard client scopes, no federation scope.
        const human = yield* b.run(
          Effect.flatMap(EnvironmentAuth.EnvironmentAuth, (auth) =>
            auth.createPairingLink({ scopes: AuthStandardClientScopes, subject: "one-time-token" }),
          ),
        );
        const refused = yield* a
          .run(
            Effect.flatMap(PeerService.PeerService, (peers) =>
              peers.add(operator, {
                name: "B",
                pairingUrl: `${b.world.origin}/pair#token=${human.credential}`,
                permissions: noPermissions,
              }),
            ),
          )
          .pipe(Effect.flip);
        assert.strictEqual(refused.code, "PERMISSION_DENIED");
        assert.strictEqual(
          (yield* a.run(Effect.flatMap(PeerService.PeerService, (peers) => peers.list(operator))))
            .length,
          0,
        );

        // A person's token given directly: the row exists, but the link is refused and nothing is sent.
        const session = yield* b.run(
          Effect.flatMap(EnvironmentAuth.EnvironmentAuth, (auth) =>
            auth.issueSession({ scopes: AuthStandardClientScopes, subject: "someone" }),
          ),
        );
        yield* a.run(
          Effect.flatMap(PeerService.PeerService, (peers) =>
            peers.add(operator, {
              name: "B",
              httpBaseUrl: b.world.origin,
              token: session.token,
              permissions: noPermissions,
            }),
          ),
        );
        yield* delegate(a, b, "task-1");
        yield* syncPeer(a, b);
        assert.strictEqual((yield* peerOf(a, b)).status, "revoked");
        assert.strictEqual(sentMessages(network, b), 0);

        // A federation session for the wrong subject is a client, not a peer.
        const mislabelled = yield* b.run(
          Effect.flatMap(EnvironmentAuth.EnvironmentAuth, (auth) =>
            auth.issueSession({ scopes: ["federation:peer"], subject: "not-a-peer" }),
          ),
        );
        const link = yield* a.run(
          Effect.flatMap(PeerTransport.PeerTransport, (transport) =>
            transport.open(b.world.origin, mislabelled.token),
          ),
        );
        const denied = yield* link.deliver({ messages: [] }).pipe(Effect.flip);
        assert.strictEqual(
          denied._tag === "AutomationError" ? denied.code : null,
          "PERMISSION_DENIED",
        );

        // The stored credential appears nowhere a reader of state or events would find it.
        const stored = yield* a.run(
          Effect.flatMap(
            SqlClient.SqlClient,
            (sql) => sql<{ peer_json: string }>`SELECT peer_json FROM automation_peers`,
          ),
        );
        assert.notInclude(stored.map((row) => row.peer_json).join("\n"), session.token);
        assert.notInclude(yield* encodeJournal(a.world.journal.entries), session.token);
        assert.notInclude(yield* encodePeer(yield* peerOf(a, b)), session.token);
      }),
  );

  it.effect("announces availability on change, once per window while the link flaps", () =>
    Effect.gen(function* () {
      const { network, a, b } = yield* twoEnvironments;
      yield* pair(a, b);
      const announced = () =>
        a.world.journal.entries
          .filter((entry) => entry.event.type === "peer.availability")
          .map((entry) => entry.event.payload["status"]);

      yield* syncPeer(a, b);
      yield* syncPeer(a, b);
      assert.deepStrictEqual(announced(), ["connected"]);

      // Down, up, down within a few seconds.
      const flap = (down: boolean) =>
        Effect.gen(function* () {
          if (down) network.unreachable.add(b.world.origin);
          else network.unreachable.delete(b.world.origin);
          yield* TestClock.adjust("31 seconds");
          yield* syncPeer(a, b);
        });
      yield* TestClock.adjust("5 minutes");
      yield* flap(true);
      assert.deepStrictEqual(announced(), ["connected", "offline"]);
      network.unreachable.delete(b.world.origin);
      yield* a.run(Effect.flatMap(FederationReactor.FederationReactor, (reactor) => reactor.tick));
      // Too soon after the last announcement, whatever the link is doing now.
      assert.deepStrictEqual(announced(), ["connected", "offline"]);
      yield* TestClock.adjust("10 minutes");
      yield* syncPeer(a, b);
      assert.deepStrictEqual(announced(), ["connected", "offline", "connected"]);
      assert.strictEqual((yield* peerOf(a, b)).status, "connected");
      assert.isNotNull((yield* peerOf(a, b)).lastConnectedAt);
    }),
  );

  it.effect("reports which environments an answer covers, and how old each view is", () =>
    Effect.gen(function* () {
      const network = makeNetwork();
      const a = yield* boot(yield* makeWorld("a"), network);
      const b = yield* boot(yield* makeWorld("b"), network);
      const c = yield* boot(yield* makeWorld("c"), network);
      yield* pair(a, b);
      yield* addPeer(a, c, noPermissions);
      network.unreachable.add(c.world.origin);
      yield* syncPeer(a, b);
      yield* syncPeer(a, c);
      const peers = yield* a.run(
        Effect.flatMap(PeerService.PeerService, (service) => service.list(operator)),
      );
      const seenB = peers.find((peer) => peer.environmentId === b.world.id)!.lastObservedAt!;
      // C was reachable when it was added, so there is an old view of it, not a current one.
      const seenC = peers.find((peer) => peer.environmentId === c.world.id)!.lastObservedAt!;
      const coverage = coverageOfPeers(
        { environmentId: a.world.id, observedAt: "2026-01-01T00:00:00.000Z" },
        [
          ...peers,
          { ...peers[0]!, environmentId: EnvironmentId.make("env-d"), lastObservedAt: null },
        ],
      );
      assert.deepStrictEqual(coverage.consulted, [
        { environmentId: a.world.id, observedAt: "2026-01-01T00:00:00.000Z" },
      ]);
      assert.sameDeepMembers(
        [...coverage.stale],
        [
          { environmentId: b.world.id, observedAt: seenB },
          { environmentId: c.world.id, observedAt: seenC },
        ],
      );
      assert.deepStrictEqual(
        coverage.unavailable.map((entry) => entry.environmentId),
        ["env-d"],
      );
    }),
  );

  it.effect("pins the peer's identity and refuses to manage peers for a peer", () =>
    Effect.gen(function* () {
      const network = makeNetwork();
      const a = yield* boot(yield* makeWorld("a"), network);
      const b = yield* boot(yield* makeWorld("b"), network);
      const c = yield* boot(yield* makeWorld("c"), network);
      yield* pair(a, b);
      yield* addPeer(c, a, noPermissions);

      // Renaming and re-pointing are allowed; pointing at another environment is not.
      const moved = yield* a
        .run(
          Effect.flatMap(PeerService.PeerService, (peers) =>
            peers.update(operator, { environmentId: b.world.id, httpBaseUrl: c.world.origin }),
          ),
        )
        .pipe(Effect.flip);
      assert.strictEqual(moved.code, "CONFLICT");
      const renamed = yield* a.run(
        Effect.flatMap(PeerService.PeerService, (peers) =>
          peers.update(operator, { environmentId: b.world.id, name: "Renamed" }),
        ),
      );
      assert.strictEqual(renamed.name, "Renamed");
      assert.strictEqual(renamed.environmentId, b.world.id);

      // The URL is taken over by another environment: the handshake notices and nothing is sent.
      network.nodes.set(b.world.origin, network.nodes.get(c.world.origin)!);
      yield* delegate(a, b, "task-1");
      yield* syncPeer(a, b);
      const hijacked = yield* peerOf(a, b);
      assert.notStrictEqual(hijacked.status, "connected");
      assert.strictEqual((yield* outbox(a))[0]!.status, "pending_delivery");

      const peerCaller = {
        kind: "peer",
        environmentId: b.world.id,
        subject: peerSessionSubject(b.world.id),
        scopes: ["federation:peer"],
      } as const;
      const denied = yield* a
        .run(Effect.flatMap(PeerService.PeerService, (peers) => peers.list(peerCaller)))
        .pipe(Effect.flip);
      assert.strictEqual(denied.code, "PERMISSION_DENIED");
      const notPeer = yield* a
        .run(
          Effect.flatMap(PeerService.PeerService, (peers) =>
            peers.deliver(internalCaller("test"), { messages: [] }),
          ),
        )
        .pipe(Effect.flip);
      assert.strictEqual(notPeer.code, "PERMISSION_DENIED");
    }),
  );
});
