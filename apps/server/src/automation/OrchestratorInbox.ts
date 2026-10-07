import { type AutomationError, type InboxEntry, InboxEntryId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { randomUuidV4 } from "../orchestration-v2/RandomUuid.ts";
import { automationError } from "./Caller.ts";
import * as EventJournal from "./EventJournal.ts";
import { classifyDelivery } from "./orchestrator/inboxPolicy.ts";
import * as OrchestratorRuntime from "./orchestrator/Runtime.ts";

export type OrchestratorInboxDelivery = Pick<
  InboxEntry,
  "orchestratorId" | "kind" | "dedupKey" | "relevance" | "entries" | "text" | "from"
>;

/**
 * The durable write side of an orchestrator's inbox. Hook delivery, peer
 * messages and user sends all land here; a delivery counts as made only once
 * `deliver` returns, which is after the row is committed.
 */
export class OrchestratorInbox extends Context.Service<
  OrchestratorInbox,
  {
    /** Idempotent on (orchestratorId, dedupKey): a repeat returns the stored entry with `created: false`. */
    readonly deliver: (
      input: OrchestratorInboxDelivery,
    ) => Effect.Effect<{ readonly entry: InboxEntry; readonly created: boolean }, AutomationError>;
  }
>()("t3/automation/OrchestratorInbox") {}

/** Informational entries kept for the next turn; older ones are absorbed. */
const MAX_PENDING_INFORMATIONAL = 20;

const make = Effect.gen(function* () {
  const runtime = yield* OrchestratorRuntime.OrchestratorRuntime;
  const journal = yield* EventJournal.EventJournal;
  const { store } = runtime;

  const deliver: OrchestratorInbox["Service"]["deliver"] = Effect.fn("OrchestratorInbox.deliver")(
    function* (input) {
      const orchestrator = yield* store.requireOrchestrator(input.orchestratorId);
      if (orchestrator.hostEnvironmentId !== runtime.environmentId) {
        return yield* automationError(
          "ENVIRONMENT_UNAVAILABLE",
          `Orchestrator ${orchestrator.id} is hosted by environment ${orchestrator.hostEnvironmentId}.`,
          { hostEnvironmentId: orchestrator.hostEnvironmentId },
        );
      }
      const existing = yield* store.getInboxByDedup(input.orchestratorId, input.dedupKey);
      if (existing !== null) return { entry: existing.entry, created: false };
      // A disabled orchestrator takes nothing from hooks, timers or peers. What
      // the user sends directly is still kept for when it is enabled again.
      if (orchestrator.desiredState === "disabled" && input.kind !== "user_message") {
        return yield* automationError(
          "PAUSED",
          `Orchestrator ${orchestrator.id} is disabled and does not accept deliveries.`,
        );
      }

      const now = DateTime.formatIso(yield* DateTime.now);
      const { relevance, absorb } = classifyDelivery(input, orchestrator);
      const entry: InboxEntry = {
        id: InboxEntryId.make(`inbox:${yield* randomUuidV4}`),
        orchestratorId: input.orchestratorId,
        kind: input.kind,
        dedupKey: input.dedupKey,
        status: absorb ? "absorbed" : "pending",
        relevance,
        entries: input.entries,
        text: input.text,
        from: input.from,
        reservedByRunId: null,
        receivedAt: now,
        updatedAt: now,
      };
      const cause = input.entries[0]?.event;
      const created = yield* store.transact(
        Effect.gen(function* () {
          if (!(yield* store.insertInboxEntry(entry))) return false;
          if (absorb) return true;
          if (relevance === "informational") {
            const backlog = (yield* store.listInbox({
              orchestratorId: input.orchestratorId,
              statuses: ["pending"],
            })).filter((stored) => stored.entry.relevance === "informational");
            for (const stale of backlog.slice(0, -MAX_PENDING_INFORMATIONAL)) {
              yield* store.transitionInboxEntry({
                orchestratorId: input.orchestratorId,
                entryId: stale.entry.id,
                from: ["pending"],
                to: "absorbed",
                now,
              });
            }
          }
          yield* journal.append([
            {
              type: "orchestrator.message.received",
              origin: { kind: "service", actorId: orchestrator.id },
              scope: {
                orchestratorId: orchestrator.id,
                projectId: orchestrator.config.projectId,
                ...(orchestrator.threadId === null ? {} : { threadId: orchestrator.threadId }),
              },
              aggregate: { kind: "orchestrator", id: orchestrator.id },
              payload: { entryId: entry.id, kind: entry.kind, relevance },
              ...(cause === undefined
                ? {}
                : {
                    causedBy: {
                      eventId: cause.eventId,
                      correlationId: cause.correlationId,
                      hops: cause.hops,
                    },
                  }),
              dedupKey: `orchestrator-inbox:${entry.id}`,
            },
          ]);
          return true;
        }),
      );
      if (!created) {
        // Another delivery with the same key committed first.
        const winner = yield* store.getInboxByDedup(input.orchestratorId, input.dedupKey);
        if (winner === null) {
          return yield* automationError("INTERNAL", "The inbox entry could not be stored.");
        }
        return { entry: winner.entry, created: false };
      }
      yield* runtime.notifyChanged;
      if (!absorb && relevance === "actionable") yield* runtime.wake(input.orchestratorId);
      return { entry, created: true };
    },
  );

  return OrchestratorInbox.of({ deliver });
});

/** The inbox alone: the caller provides the runtime and the journal. */
export const layerCore = Layer.effect(OrchestratorInbox, make);

export const layer = layerCore.pipe(
  Layer.provide(OrchestratorRuntime.layer),
  Layer.provide(EventJournal.layer),
);
