import type {
  AutomationError,
  AutomationEvent,
  AutomationEventEmitInput,
  AutomationEventEmitResult,
  AutomationEventsReadInput,
  AutomationEventsReadResult,
  AutomationEventsStreamItem,
  AutomationEventsSubscribeInput,
  AutomationJournalEntry,
  AutomationJournalStatus,
  EventConsumer,
  EventConsumerAckInput,
  EventConsumerId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { type AutomationCaller, unsupported } from "./Caller.ts";

/**
 * An event a server component records. The journal assigns `eventId`, cursors,
 * the origin environment, `recordedAt`, and the aggregate revision.
 */
export type EventJournalAppend = Pick<AutomationEvent, "type" | "scope" | "payload"> & {
  readonly origin: Omit<AutomationEvent["origin"], "environmentId">;
  readonly aggregate: Omit<AutomationEvent["aggregate"], "revision">;
  readonly occurredAt?: AutomationEvent["occurredAt"];
  readonly correlationId?: AutomationEvent["correlationId"];
  /** The event this one reacts to. Its hop count carries over, plus one. */
  readonly causedBy?: Pick<AutomationEvent, "eventId" | "correlationId" | "hops">;
  readonly refs?: AutomationEvent["refs"];
  /** Stable key that makes a repeated append return the first entry. */
  readonly dedupKey?: string;
};

/** The environment's durable, cursor-addressed journal of public automation events. */
export class EventJournal extends Context.Service<
  EventJournal,
  {
    readonly status: Effect.Effect<AutomationJournalStatus, AutomationError>;
    readonly read: (
      caller: AutomationCaller,
      input: AutomationEventsReadInput,
    ) => Effect.Effect<AutomationEventsReadResult, AutomationError>;
    readonly subscribe: (
      caller: AutomationCaller,
      input: AutomationEventsSubscribeInput,
    ) => Stream.Stream<AutomationEventsStreamItem, AutomationError>;
    readonly emit: (
      caller: AutomationCaller,
      input: AutomationEventEmitInput,
    ) => Effect.Effect<AutomationEventEmitResult, AutomationError>;
    readonly append: (
      events: ReadonlyArray<EventJournalAppend>,
    ) => Effect.Effect<ReadonlyArray<AutomationJournalEntry>, AutomationError>;
    readonly importPeerEntries: (
      entries: ReadonlyArray<AutomationJournalEntry>,
    ) => Effect.Effect<ReadonlyArray<AutomationJournalEntry>, AutomationError>;
    readonly listConsumers: (
      caller: AutomationCaller,
    ) => Effect.Effect<ReadonlyArray<EventConsumer>, AutomationError>;
    readonly ackConsumer: (
      caller: AutomationCaller,
      input: EventConsumerAckInput,
    ) => Effect.Effect<EventConsumer, AutomationError>;
    readonly deleteConsumer: (
      caller: AutomationCaller,
      input: EventConsumerId,
    ) => Effect.Effect<boolean, AutomationError>;
  }
>()("t3/automation/EventJournal") {}

// Replaced by the real implementation; until then every call reports the capability as absent.
export const layer = Layer.succeed(EventJournal, {
  status: Effect.fail(unsupported("EventJournal")),
  read: () => Effect.fail(unsupported("EventJournal")),
  subscribe: () => Stream.fail(unsupported("EventJournal")),
  emit: () => Effect.fail(unsupported("EventJournal")),
  append: () => Effect.fail(unsupported("EventJournal")),
  importPeerEntries: () => Effect.fail(unsupported("EventJournal")),
  listConsumers: () => Effect.fail(unsupported("EventJournal")),
  ackConsumer: () => Effect.fail(unsupported("EventJournal")),
  deleteConsumer: () => Effect.fail(unsupported("EventJournal")),
});
