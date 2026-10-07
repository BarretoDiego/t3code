import {
  AUTOMATION_ADMINISTRATIVE_EVENT_TYPES,
  AUTOMATION_EVENT_MAX_HOPS,
  AuthFederationPeerScope,
  type AutomationError,
  type AutomationErrorCode,
  type AutomationJournalEntry,
  type DelegatedTask,
  type EnvironmentId,
  FEDERATION_PROTOCOL_VERSION,
  IdempotencyKey,
  type PeerConnectionStatus,
  type PeerDeliverResult,
  type PeerMessage,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import { forkParked } from "../../serverActivation.ts";
import {
  type AutomationCaller,
  automationError,
  internalCaller,
  peerSessionSubject,
} from "../Caller.ts";
import * as DelegatedTaskService from "../DelegatedTaskService.ts";
import * as EventJournal from "../EventJournal.ts";
import * as OrchestratorInbox from "../OrchestratorInbox.ts";
import * as PeerService from "../PeerService.ts";
import * as PeerOrchestratorMessages from "./PeerOrchestratorMessages.ts";
import {
  LOCAL_PEER_CAPABILITIES,
  eventTypeMatches,
  peerMessageId,
  peerTokenSecretName,
  requiredPeerAction,
} from "./PeerProtocol.ts";
import * as PeerStore from "./PeerStore.ts";
import * as PeerTransport from "./PeerTransport.ts";

const OUTBOX_BATCH = 50;
const INBOX_BATCH = 50;
const FORWARD_BATCH = 20;
const HEARTBEAT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 30_000;
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 5 * 60_000;
const AVAILABILITY_DEBOUNCE_MS = 30_000;
const MAX_PROCESS_ATTEMPTS = 5;
const MAX_EVENT_TEXT_BYTES = 8 * 1024;
/** Failures that say "not now" rather than "no": the message stays stored and is tried again. */
const TRANSIENT_CODES: ReadonlySet<AutomationErrorCode> = new Set(["INTERNAL", "BACKPRESSURE"]);

const internal = internalCaller("federation");

interface OpenLink {
  readonly scope: Scope.Closeable;
  readonly link: PeerTransport.PeerLink;
  lastCallAt: number;
  /** A fresh link asks once for rejections the peer could not report while it was down. */
  synced: boolean;
}

interface Backoff {
  readonly attempt: number;
  readonly nextAttemptAt: number;
}

/**
 * Drives federation without any client connected: one link per enabled peer
 * (connect, hello, forward events, drain the outbox, reconnect with backoff)
 * and the processor that runs messages peers left in the inbox.
 */
export class FederationReactor extends Context.Service<
  FederationReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /**
     * One pass for one peer. Returns once the pass ends; when a pass is already
     * running it is told to run again and this returns at once.
     */
    readonly syncPeer: (environmentId: EnvironmentId) => Effect.Effect<void>;
    /** Runs every stored inbound message that can run now, in sequence order per peer. */
    readonly processInbox: Effect.Effect<void>;
    /** One pass over every peer, then the inbox. This is what the scheduler runs. */
    readonly tick: Effect.Effect<void>;
  }
>()("t3/automation/federation/FederationReactor") {}

const make = Effect.gen(function* () {
  const store = yield* PeerStore.PeerStore;
  const transport = yield* PeerTransport.PeerTransport;
  const peers = yield* PeerService.PeerService;
  const journal = yield* EventJournal.EventJournal;
  const tasks = yield* DelegatedTaskService.DelegatedTaskService;
  const inbox = yield* OrchestratorInbox.OrchestratorInbox;
  const orchestratorMessages = yield* PeerOrchestratorMessages.PeerOrchestratorMessages;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const scheduler = yield* Scheduler.Scheduler;

  const links = new Map<EnvironmentId, OpenLink>();
  const backoffs = new Map<EnvironmentId, Backoff>();
  const passes = new Map<EnvironmentId, "running" | "rerun">();
  const announced = new Map<EnvironmentId, { status: PeerConnectionStatus; at: number }>();
  const processAttempts = new Map<string, number>();
  const inboxLock = yield* Semaphore.make(1);

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const logFailure = (message: string) => (cause: Cause.Cause<unknown>) =>
    Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logWarning(message, { cause });

  const closeLink = (environmentId: EnvironmentId) =>
    Effect.suspend(() => {
      const open = links.get(environmentId);
      links.delete(environmentId);
      return open === undefined ? Effect.void : Scope.close(open.scope, Exit.void);
    });

  yield* Effect.addFinalizer(() => Effect.forEach([...links.keys()], closeLink, { discard: true }));

  // -------------------------------------------------------------------------
  // Status

  /**
   * Publishes `peer.availability` when the settled status differs from the
   * last one announced. Within the debounce window the change waits for a
   * later pass, so a flapping link produces one event per window, and the
   * state it ends in is always announced.
   */
  const announce = Effect.fn("FederationReactor.announce")(function* (
    environmentId: EnvironmentId,
  ) {
    const record = yield* store.get(environmentId);
    if (record === null || record.detail.status === "connecting") return;
    const now = yield* Clock.currentTimeMillis;
    const last = announced.get(environmentId);
    if (last?.status === record.detail.status) return;
    if (last !== undefined && now - last.at < AVAILABILITY_DEBOUNCE_MS) return;
    yield* journal.append([
      {
        type: "peer.availability",
        scope: {},
        origin: { kind: "service" },
        aggregate: { kind: "peer", id: environmentId },
        payload: {
          environmentId,
          name: record.name,
          status: record.detail.status,
          statusReason: record.detail.statusReason,
          lastConnectedAt: record.detail.lastConnectedAt,
          observedAt: yield* nowIso,
        },
      },
    ]);
    announced.set(environmentId, { status: record.detail.status, at: now });
  });

  const setStatus = (
    environmentId: EnvironmentId,
    status: PeerConnectionStatus,
    statusReason: string | null,
    extra?: (detail: PeerStore.PeerDetail, now: string) => Partial<PeerStore.PeerDetail>,
  ) =>
    Effect.gen(function* () {
      const now = yield* nowIso;
      yield* store.update(environmentId, {
        detail: (current) => ({ ...current, status, statusReason, ...extra?.(current, now) }),
        updatedAt: now,
      });
    });

  const scheduleRetry = Effect.fn("FederationReactor.scheduleRetry")(function* (
    environmentId: EnvironmentId,
    options?: { readonly slow?: boolean },
  ) {
    const attempt = (backoffs.get(environmentId)?.attempt ?? 0) + 1;
    const base =
      options?.slow === true
        ? BACKOFF_MAX_MS
        : Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
    // Jitter keeps peers that lost the same network from reconnecting in step.
    const jitter = yield* Random.nextBetween(0.8, 1.2);
    const now = yield* Clock.currentTimeMillis;
    backoffs.set(environmentId, { attempt, nextAttemptAt: now + Math.round(base * jitter) });
  });

  /** The link failed mid-use: drop it, say so, and come back later. */
  const linkFailed = Effect.fn("FederationReactor.linkFailed")(function* (
    environmentId: EnvironmentId,
    error: AutomationError | PeerTransport.PeerTransportError,
  ) {
    yield* closeLink(environmentId);
    const refused =
      error._tag === "PeerTransportError"
        ? error.reason === "unauthorized"
        : error.code === "PERMISSION_DENIED";
    yield* setStatus(environmentId, refused ? "revoked" : "offline", error.message);
    yield* scheduleRetry(environmentId, { slow: refused });
  });

  // -------------------------------------------------------------------------
  // Outbound

  const connect = Effect.fn("FederationReactor.connect")(function* (record: PeerStore.PeerRecord) {
    const environmentId = record.environmentId;
    const now = yield* Clock.currentTimeMillis;
    const backoff = backoffs.get(environmentId);
    if (backoff !== undefined && now < backoff.nextAttemptAt) return null;

    const token = yield* secrets
      .get(peerTokenSecretName(environmentId))
      .pipe(Effect.orElseSucceed(() => Option.none<Uint8Array>()));
    if (Option.isNone(token)) {
      yield* setStatus(
        environmentId,
        "revoked",
        "No credential is stored for this peer. Add it again with a new peer credential.",
      );
      yield* scheduleRetry(environmentId, { slow: true });
      return null;
    }
    yield* setStatus(environmentId, "connecting", null);
    const self = yield* environment.getEnvironmentId;
    const descriptor = yield* environment.getDescriptor;
    const scope = yield* Scope.make();
    const attempt = yield* Effect.gen(function* () {
      const link = yield* transport
        .open(record.detail.httpBaseUrl, new TextDecoder().decode(token.value))
        .pipe(Scope.provide(scope));
      const hello = yield* link.hello({
        fromEnvironmentId: self,
        name: descriptor.label,
        capabilities: LOCAL_PEER_CAPABILITIES,
        receivedThroughSequence: record.receivedThroughSequence,
      });
      return { link, hello };
    }).pipe(
      Effect.timeoutOrElse({
        duration: CONNECT_TIMEOUT_MS,
        orElse: () =>
          Effect.fail(
            new PeerTransport.PeerTransportError({
              reason: "unreachable",
              origin: record.detail.httpBaseUrl,
            }),
          ),
      }),
      Effect.result,
    );
    if (attempt._tag === "Failure") {
      yield* Scope.close(scope, Exit.void);
      yield* linkFailed(environmentId, attempt.failure);
      return null;
    }
    const { link, hello } = attempt.success;
    // The id pinned at pairing is the identity. A URL that now answers as
    // someone else gets nothing, whatever name it gives.
    if (hello.environmentId !== environmentId) {
      yield* Scope.close(scope, Exit.void);
      yield* setStatus(
        environmentId,
        "offline",
        `The peer URL now answers as a different environment (${hello.environmentId}). Nothing was sent.`,
      );
      yield* scheduleRetry(environmentId, { slow: true });
      return null;
    }
    if (hello.protocolVersion === null || hello.protocolVersion !== FEDERATION_PROTOCOL_VERSION) {
      yield* Scope.close(scope, Exit.void);
      yield* setStatus(
        environmentId,
        "incompatible",
        `No shared federation protocol version (the peer speaks ${hello.capabilities.protocolVersions.join(", ") || "none"}).`,
        () => ({ negotiatedProtocolVersion: null, capabilities: hello.capabilities }),
      );
      yield* scheduleRetry(environmentId, { slow: true });
      return null;
    }
    backoffs.delete(environmentId);
    const open: OpenLink = { scope, link, lastCallAt: now, synced: false };
    links.set(environmentId, open);
    yield* setStatus(environmentId, "connected", null, (_, at) => ({
      negotiatedProtocolVersion: hello.protocolVersion,
      capabilities: hello.capabilities,
      lastConnectedAt: at,
      lastObservedAt: at,
    }));
    return open;
  });

  /**
   * Turns journal entries the peer subscribed to into `events` messages,
   * starting after the persisted cursor. The message and the cursor move in
   * one transaction, so a reconnect resumes exactly where forwarding stopped.
   */
  const forwardEvents = Effect.fn("FederationReactor.forwardEvents")(function* (
    environmentId: EnvironmentId,
  ) {
    const self = yield* environment.getEnvironmentId;
    for (;;) {
      const record = yield* store.get(environmentId);
      const patterns = record?.detail.permissions.forwardEventTypes ?? [];
      if (record === null || patterns.length === 0) return;
      const read = yield* journal
        .read(internal, {
          afterCursor: record.forwardedCursor,
          filter: { types: patterns, originEnvironmentIds: [self] },
          limit: FORWARD_BATCH,
        })
        .pipe(
          Effect.catchIf(
            (error) => error.code === "CURSOR_EXPIRED",
            // Retention removed entries before they were forwarded. That gap is
            // real: log it and continue from the oldest entry still held.
            (error) =>
              Effect.gen(function* () {
                const status = yield* journal.status;
                const resumeAt =
                  status.oldestCursor === null ? status.headCursor : status.oldestCursor - 1;
                yield* Effect.logWarning("Peer event forwarding skipped expired journal entries", {
                  environmentId,
                  forwardedCursor: record.forwardedCursor,
                  resumeAt,
                  detail: error.detail,
                });
                yield* store.update(environmentId, {
                  forwardedCursor: resumeAt,
                  updatedAt: yield* nowIso,
                });
                return null;
              }),
          ),
        );
      if (read === null) continue;
      // The journal filtered already; these checks hold even if it did not.
      // Only events that originated here are forwarded: an event never returns
      // to its origin, and nothing is relayed on another environment's behalf.
      const entries = read.entries.filter(
        (entry) =>
          entry.event.origin.environmentId === self &&
          entry.event.origin.environmentId !== environmentId &&
          entry.event.hops < AUTOMATION_EVENT_MAX_HOPS &&
          !AUTOMATION_ADMINISTRATIVE_EVENT_TYPES.some((type) => type === entry.event.type) &&
          eventTypeMatches(patterns, entry.event.type),
      );
      const now = yield* nowIso;
      const first = entries[0];
      if (first === undefined) {
        yield* store.update(environmentId, { forwardedCursor: read.nextCursor, updatedAt: now });
      } else {
        const messageId = peerMessageId(
          self,
          environmentId,
          `events:${first.cursor}-${entries.at(-1)!.cursor}`,
        );
        yield* store.enqueue({
          environmentId,
          messageId,
          forwardedCursor: read.nextCursor,
          now,
          build: (sequence) => ({
            version: FEDERATION_PROTOCOL_VERSION,
            messageId,
            fromEnvironmentId: self,
            toEnvironmentId: environmentId,
            sequence,
            correlationId: first.event.correlationId,
            sentAt: now,
            expiresAt: null,
            body: { type: "events", entries },
          }),
        });
      }
      if (read.nextCursor <= record.forwardedCursor || read.nextCursor >= read.status.headCursor) {
        return;
      }
    }
  });

  const applyDeliverResult = Effect.fn("FederationReactor.applyDeliverResult")(function* (
    environmentId: EnvironmentId,
    sent: ReadonlyArray<PeerMessage>,
    result: PeerDeliverResult,
  ) {
    const now = yield* nowIso;
    // Rejections can name messages from earlier deliveries: the peer acknowledges
    // storage first and runs the message afterwards.
    for (const rejection of result.rejected) {
      yield* store.setOutboxStatus({
        environmentId,
        messageIds: [rejection.messageId],
        status: "rejected",
        rejection: { code: rejection.code, message: rejection.message },
        now,
      });
    }
    const rejected = new Set(result.rejected.map((entry) => entry.messageId));
    // `delivered` means the peer stored it, nothing more. Whether the work in
    // it was accepted or finished arrives later as a message from the peer.
    const delivered = sent.filter(
      (message) =>
        !rejected.has(message.messageId) && message.sequence <= result.receivedThroughSequence,
    );
    yield* store.setOutboxStatus({
      environmentId,
      messageIds: delivered.map((message) => message.messageId),
      status: "delivered",
      now,
    });
    yield* store.update(environmentId, {
      detail: (current) => ({ ...current, lastObservedAt: now }),
      ackedThroughSequence: result.receivedThroughSequence,
      updatedAt: now,
    });
    return delivered.length + sent.filter((message) => rejected.has(message.messageId)).length;
  });

  const drainOutbox = Effect.fn("FederationReactor.drainOutbox")(function* (
    environmentId: EnvironmentId,
    open: OpenLink,
  ) {
    for (;;) {
      yield* store.expireOutbox(yield* nowIso);
      const batch = (yield* store.outbox({
        environmentId,
        statuses: ["pending_delivery"],
        limit: OUTBOX_BATCH,
      })).map((entry) => entry.message);
      const now = yield* Clock.currentTimeMillis;
      const idle = batch.length === 0;
      if (idle && open.synced && now - open.lastCallAt < HEARTBEAT_MS) return;
      const result = yield* open.link.deliver({ messages: batch }).pipe(Effect.result);
      if (result._tag === "Failure") {
        // Nothing is known about what the peer stored. The entries stay
        // pending and are sent again with the same ids on the next link.
        yield* store.recordSendFailure({
          environmentId,
          messageIds: batch.map((message) => message.messageId),
          error: result.failure.message,
          now: yield* nowIso,
        });
        yield* linkFailed(environmentId, result.failure);
        return;
      }
      open.lastCallAt = now;
      open.synced = true;
      const settled = yield* applyDeliverResult(environmentId, batch, result.success);
      if (idle || settled === 0) return;
    }
  });

  const runPass = Effect.fn("FederationReactor.runPass")(function* (environmentId: EnvironmentId) {
    const record = yield* store.get(environmentId);
    if (record === null) {
      yield* closeLink(environmentId);
      backoffs.delete(environmentId);
      announced.delete(environmentId);
      return;
    }
    if (!record.enabled) {
      yield* closeLink(environmentId);
      backoffs.delete(environmentId);
      if (record.detail.status !== "offline") {
        yield* setStatus(environmentId, "offline", "Disabled on this environment.");
      }
      yield* announce(environmentId);
      return;
    }
    const open = links.get(environmentId) ?? (yield* connect(record));
    if (open !== null) {
      yield* forwardEvents(environmentId);
      yield* drainOutbox(environmentId, open);
    } else {
      // Offline entries still expire on time; they are never reported as sent.
      yield* store.expireOutbox(yield* nowIso);
    }
    yield* announce(environmentId);
  });

  const syncPeer: FederationReactor["Service"]["syncPeer"] = (environmentId) =>
    Effect.suspend(() => {
      if (passes.has(environmentId)) {
        passes.set(environmentId, "rerun");
        return Effect.void;
      }
      passes.set(environmentId, "running");
      const loop: Effect.Effect<void> = runPass(environmentId).pipe(
        Effect.catchCause(logFailure("Peer link pass failed")),
        Effect.andThen(
          Effect.suspend(() => {
            if (passes.get(environmentId) !== "rerun") return Effect.void;
            passes.set(environmentId, "running");
            return loop;
          }),
        ),
      );
      return Effect.ensuring(
        loop,
        Effect.sync(() => passes.delete(environmentId)),
      );
    });

  // -------------------------------------------------------------------------
  // Inbound

  const peerCaller = (environmentId: EnvironmentId): AutomationCaller => ({
    kind: "peer",
    environmentId,
    subject: peerSessionSubject(environmentId),
    scopes: [AuthFederationPeerScope],
  });

  const denied = (message: string, detail?: AutomationError["detail"]) =>
    Effect.fail(automationError("PERMISSION_DENIED", message, detail));

  const reportTaskStatus = (
    environmentId: EnvironmentId,
    task: DelegatedTask,
    message: PeerMessage,
  ) =>
    peers.enqueue({
      toEnvironmentId: environmentId,
      body: { type: "task.status", task },
      correlationId: message.correlationId,
      dedupKey: `task.status:${task.id}:${task.revision}:${task.status}`,
    });

  const importEvents = Effect.fn("FederationReactor.importEvents")(function* (
    environmentId: EnvironmentId,
    entries: ReadonlyArray<AutomationJournalEntry>,
  ) {
    // A peer speaks for itself only. Entries naming any other origin - this
    // environment included - are dropped, as are administrative types and
    // chains at the hop limit. What is kept is stored under the peer's origin
    // and is never a locally privileged fact.
    const accepted = entries.filter(
      (entry) =>
        entry.event.origin.environmentId === environmentId &&
        entry.event.hops < AUTOMATION_EVENT_MAX_HOPS &&
        !AUTOMATION_ADMINISTRATIVE_EVENT_TYPES.some((type) => type === entry.event.type),
    );
    if (accepted.length < entries.length) {
      yield* Effect.logWarning("Dropped forwarded events a peer may not send", {
        environmentId,
        dropped: entries.length - accepted.length,
      });
    }
    if (accepted.length === 0) return;
    yield* journal.importPeerEntries(accepted);
    yield* store.update(environmentId, {
      inboundCursor: Math.max(...accepted.map((entry) => entry.event.originCursor)),
      updatedAt: yield* nowIso,
    });
  });

  const dispatch = Effect.fn("FederationReactor.dispatch")(function* (
    record: PeerStore.PeerRecord,
    message: PeerMessage,
  ) {
    const peer = record.environmentId;
    const self = yield* environment.getEnvironmentId;
    const permissions = record.detail.permissions;
    const body = message.body;
    switch (body.type) {
      case "text": {
        if (body.toOrchestratorId !== undefined) {
          yield* inbox.deliver({
            orchestratorId: body.toOrchestratorId,
            kind: "peer_message",
            dedupKey: `peer:${peer}:${message.messageId}`,
            relevance: "actionable",
            entries: [],
            text: body.text,
            from:
              body.fromOrchestratorId === undefined
                ? null
                : {
                    kind: "orchestrator",
                    orchestratorId: body.fromOrchestratorId,
                    environmentId: peer,
                  },
          });
        }
        const text = Buffer.from(body.text);
        yield* journal.append([
          {
            type: "peer.message.received",
            scope:
              body.toOrchestratorId === undefined ? {} : { orchestratorId: body.toOrchestratorId },
            origin: { kind: "peer", actorId: peer },
            aggregate: { kind: "peer", id: peer },
            correlationId: message.correlationId,
            dedupKey: `peer.message.received:${peer}:${message.messageId}`,
            payload: {
              messageId: message.messageId,
              fromEnvironmentId: peer,
              ...(body.fromOrchestratorId === undefined
                ? {}
                : { fromOrchestratorId: body.fromOrchestratorId }),
              // Untrusted text from another environment: data for a reader, never an instruction.
              text: text.subarray(0, MAX_EVENT_TEXT_BYTES).toString("utf8"),
              truncated: text.byteLength > MAX_EVENT_TEXT_BYTES,
            },
          },
        ]);
        return;
      }
      case "events":
        return yield* importEvents(peer, body.entries);
      case "task.delegate": {
        const task = body.task;
        if (task.originEnvironmentId !== peer) {
          return yield* denied("A peer may delegate only tasks it originated.");
        }
        if (task.executionEnvironmentId !== self) {
          return yield* automationError(
            "INVALID_INPUT",
            "The task names a different execution environment.",
          );
        }
        if (
          permissions.projectIds !== undefined &&
          !permissions.projectIds.includes(task.target.projectId)
        ) {
          return yield* denied("This peer may not delegate into that project.", {
            projectId: task.target.projectId,
          });
        }
        if (
          task.target.nodeId !== undefined &&
          permissions.nodeIds !== undefined &&
          !permissions.nodeIds.includes(task.target.nodeId)
        ) {
          return yield* denied("This peer may not use that node.", { nodeId: task.target.nodeId });
        }
        // Idempotent on the task id: a retried delegation finds the same task and thread.
        const accepted = yield* tasks.acceptRemote(peerCaller(peer), task);
        yield* reportTaskStatus(peer, accepted, message);
        return;
      }
      case "task.cancel": {
        const task = yield* tasks.get(peerCaller(peer), body.taskId);
        if (task.originEnvironmentId !== peer) {
          return yield* denied("A peer may cancel only tasks it originated.");
        }
        const updated = yield* tasks.update(peerCaller(peer), {
          idempotencyKey: IdempotencyKey.make(`peer-cancel:${message.messageId}`),
          taskId: body.taskId,
          action: {
            type: "cancel",
            ...(body.reason === null ? {} : { reason: body.reason }),
          },
        });
        yield* reportTaskStatus(peer, updated, message);
        return;
      }
      case "task.status": {
        if (body.task.executionEnvironmentId !== peer || body.task.originEnvironmentId !== self) {
          return yield* denied("A peer may report only on tasks this environment delegated to it.");
        }
        yield* tasks.applyRemoteStatus(peerCaller(peer), body.task);
        return;
      }
      case "orchestrator.projection": {
        if (body.orchestrator.hostEnvironmentId !== peer) {
          return yield* denied("A peer may project only orchestrators it hosts.");
        }
        return yield* orchestratorMessages.handle({
          fromEnvironmentId: peer,
          message: { ...message, body },
        });
      }
      case "orchestrator.send":
      case "orchestrator.handoff":
        return yield* orchestratorMessages.handle({
          fromEnvironmentId: peer,
          message: { ...message, body },
        });
    }
  });

  /**
   * Runs one stored message. Everything that decides whether it may run is
   * read now, not when it arrived: a peer disabled, a permission withdrawn or
   * a deadline passed while the message waited turns it into a rejection.
   */
  const processMessage = Effect.fn("FederationReactor.processMessage")(function* (
    row: PeerStore.PeerInboxRow,
  ) {
    const message = row.message;
    const record = yield* store.get(row.peerEnvironmentId);
    if (record === null || !record.enabled) {
      return yield* denied(
        record === null ? "The sender is no longer a peer here." : "The sender is disabled here.",
      );
    }
    if (message.expiresAt !== null) {
      const expiresAt = Date.parse(message.expiresAt);
      if (Number.isNaN(expiresAt)) {
        return yield* automationError("INVALID_INPUT", "The message has an unreadable expiry.");
      }
      if (expiresAt <= (yield* Clock.currentTimeMillis)) {
        return yield* automationError(
          "REQUEST_EXPIRED",
          "The message expired before this environment could act on it.",
          { expiresAt: message.expiresAt },
        );
      }
    }
    const action = requiredPeerAction(message.body);
    if (action !== null && !record.detail.permissions.inbound.includes(action)) {
      return yield* denied(`This peer is not permitted to ${action} here.`, { action });
    }
    yield* dispatch(record, message);
  });

  const processInbox: FederationReactor["Service"]["processInbox"] = inboxLock.withPermits(1)(
    Effect.gen(function* () {
      for (;;) {
        const rows = yield* store.storedInbound(INBOX_BATCH);
        // Per peer the order is the sender's. A message that must wait holds
        // back the ones behind it, never the other peers.
        const waiting = new Set<EnvironmentId>();
        let settled = 0;
        for (const row of rows) {
          if (waiting.has(row.peerEnvironmentId)) continue;
          const key = `${row.peerEnvironmentId}/${row.message.messageId}`;
          const outcome = yield* processMessage(row).pipe(
            Effect.as(null),
            Effect.catchDefect((defect) =>
              Effect.logError("Peer message handler crashed", { defect }).pipe(
                Effect.andThen(
                  Effect.fail(automationError("INTERNAL", "The message handler crashed.")),
                ),
              ),
            ),
            Effect.catch((error) => Effect.succeed({ code: error.code, message: error.message })),
          );
          const attempts = (processAttempts.get(key) ?? 0) + 1;
          if (
            outcome !== null &&
            TRANSIENT_CODES.has(outcome.code) &&
            attempts < MAX_PROCESS_ATTEMPTS
          ) {
            processAttempts.set(key, attempts);
            waiting.add(row.peerEnvironmentId);
            continue;
          }
          processAttempts.delete(key);
          yield* store.settleInbound({
            environmentId: row.peerEnvironmentId,
            messageId: row.message.messageId,
            rejection: outcome,
            now: yield* nowIso,
          });
          settled += 1;
        }
        if (settled === 0) return;
      }
    }).pipe(Effect.catchCause(logFailure("Peer inbox pass failed"))),
  );

  // -------------------------------------------------------------------------
  // Runtime

  const tick: FederationReactor["Service"]["tick"] = Effect.gen(function* () {
    const records = yield* store.list;
    yield* Effect.forEach(records, (record) => syncPeer(record.environmentId), {
      concurrency: 4,
      discard: true,
    });
    yield* processInbox;
  }).pipe(Effect.catchCause(logFailure("Federation tick failed")));

  const start: FederationReactor["Service"]["start"] = Effect.fn("FederationReactor.start")(
    function* () {
      // No link survives a restart, whatever the last status written says.
      const now = yield* nowIso;
      yield* store.list.pipe(
        Effect.flatMap(
          Effect.forEach((record) =>
            record.detail.status === "connected" || record.detail.status === "connecting"
              ? store.update(record.environmentId, {
                  detail: (current) => ({
                    ...current,
                    status: "offline",
                    statusReason: "Not connected yet.",
                  }),
                  updatedAt: now,
                })
              : Effect.void,
          ),
        ),
        Effect.catchCause(logFailure("Could not reset peer link status")),
      );
      const scope = yield* Effect.scope;
      // Woken by what changed: a message enqueued for a peer, or one a peer left here.
      yield* forkParked(
        Stream.fromPubSub(store.signals).pipe(
          Stream.runForEach((signal) =>
            (signal.type === "inbound" ? processInbox : syncPeer(signal.environmentId)).pipe(
              Effect.forkIn(scope),
            ),
          ),
        ),
      );
      // The timer covers what no event announces: backoff expiry, heartbeats, message expiry.
      yield* forkParked(scheduler.register("automation-federation", tick));
    },
  );

  return FederationReactor.of({ start, syncPeer, processInbox, tick });
});

/**
 * Needs `PeerStore`, `PeerTransport`, `PeerService`, `EventJournal`,
 * `DelegatedTaskService`, `OrchestratorInbox`, `PeerOrchestratorMessages`,
 * `ServerEnvironment`, `ServerSecretStore` and `Scheduler`.
 */
export const layer = Layer.effect(FederationReactor, make);
