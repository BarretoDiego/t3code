import {
  EventId,
  ThreadHandoffError,
  type ModelSelection,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2StoredEvent,
  ProviderInstanceId,
  type ProjectId,
  type ThreadHandoffId,
  type ThreadId,
} from "@t3tools/contracts";

const invalid = (message: string) =>
  new ThreadHandoffError({ code: "verificationFailed", message });

/** Events whose payload is the whole app thread. */
const APP_THREAD_EVENT_TYPES: ReadonlySet<OrchestrationV2DomainEvent["type"]> = new Set([
  "thread.created",
  "thread.archived",
  "thread.unarchived",
  "thread.deleted",
  "thread.settled",
  "thread.unsettled",
  "thread.snoozed",
  "thread.unsnoozed",
  "thread.pinned",
  "thread.auto-settle-set",
  "thread.unpinned",
  "thread.pin-reordered",
  "thread.active-reordered",
  "thread.visited",
  "thread.marked-unread",
  "thread.metadata-updated",
  "thread.pull-request-synced",
  "thread.runtime-mode-updated",
  "thread.interaction-mode-updated",
  "thread.model-selection-updated",
  "thread.provider-switched",
]);

/** Provider processes are environment-local; their records never transfer. */
const ENVIRONMENT_LOCAL_EVENT_TYPES: ReadonlySet<OrchestrationV2DomainEvent["type"]> = new Set([
  "provider-session.attached",
  "provider-session.updated",
  "provider-session.detached",
]);

type AppThreadEvent = Extract<OrchestrationV2DomainEvent, { readonly type: "thread.created" }>;
const isAppThreadEvent = (
  event: OrchestrationV2DomainEvent,
): event is OrchestrationV2DomainEvent & { readonly payload: AppThreadEvent["payload"] } =>
  APP_THREAD_EVENT_TYPES.has(event.type);

/** Replaces one provider instance id everywhere an event records instance ownership. */
function replaceInstanceIds(value: unknown, from: string, to: string, key?: string): unknown {
  if (typeof value === "string")
    return value === from && key !== undefined && /instanceids?$/i.test(key) ? to : value;
  if (Array.isArray(value)) {
    const plural = key !== undefined && /instanceids$/i.test(key);
    return value.map((item) =>
      plural && item === from ? to : replaceInstanceIds(item, from, to, undefined),
    );
  }
  if (value === null || typeof value !== "object" || !isPlainRecord(value)) return value;
  const next: Record<string, unknown> = {};
  for (const [field, item] of Object.entries(value))
    next[field] = replaceInstanceIds(item, from, to, field);
  return next;
}

function isPlainRecord(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** The thread's model and runtime mode as of the last recorded thread change. */
export function latestThreadConfiguration(events: readonly OrchestrationV2DomainEvent[]): {
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: AppThreadEvent["payload"]["runtimeMode"];
} {
  const latest = events.findLast(isAppThreadEvent);
  if (!latest) throw invalid("Transferred history has no thread configuration.");
  return { modelSelection: latest.payload.modelSelection, runtimeMode: latest.payload.runtimeMode };
}

/**
 * History is replayed only into the destination's event store and projection,
 * never into provider reactors. IDs visible in the conversation (messages,
 * runs, turn items, checkpoints) survive; event IDs get an import namespace.
 *
 * Native transfers retarget the source provider instance to the destination
 * one, so the next run resumes the transferred native session. Context
 * transfers keep historical runs on the source instance (renamed when the
 * destination reuses its id), so the next run is a provider switch and the
 * orchestrator hands the conversation to a new native session.
 */
export function remapThreadHandoffEvents(input: {
  readonly handoffId: ThreadHandoffId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly worktreePath: string | null;
  readonly mode: "native" | "context";
  readonly sourceProviderInstanceId: ProviderInstanceId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelSelection?: ModelSelection;
  readonly events: readonly OrchestrationV2StoredEvent[];
}): readonly OrchestrationV2DomainEvent[] {
  const latestCreation = input.events.findLastIndex(
    (stored) => stored.event.type === "thread.created",
  );
  if (latestCreation < 0) throw invalid("Thread archive has no creation event.");
  let previousSequence = -1;
  for (const stored of input.events) {
    if (stored.event.threadId !== input.threadId || stored.sequence <= previousSequence)
      throw invalid("Thread archive contains foreign or unordered events.");
    previousSequence = stored.sequence;
  }
  const historicalInstanceId =
    input.mode === "native"
      ? input.providerInstanceId
      : input.sourceProviderInstanceId === input.providerInstanceId
        ? ProviderInstanceId.make(`${input.sourceProviderInstanceId}-transferred`.slice(0, 64))
        : input.sourceProviderInstanceId;
  const threadModelSelection = (selection: ModelSelection): ModelSelection =>
    input.mode === "context" && input.modelSelection
      ? { ...input.modelSelection, instanceId: input.providerInstanceId }
      : { ...selection, instanceId: input.providerInstanceId };
  return input.events
    .slice(latestCreation)
    .filter((stored) => !ENVIRONMENT_LOCAL_EVENT_TYPES.has(stored.event.type))
    .map((stored, index): OrchestrationV2DomainEvent => {
      const { rawEventId: _rawEventId, ...base } = stored.event;
      const event = (
        historicalInstanceId === input.sourceProviderInstanceId
          ? base
          : replaceInstanceIds(base, input.sourceProviderInstanceId, historicalInstanceId)
      ) as OrchestrationV2DomainEvent;
      const local = { ...event, id: EventId.make(`handoff:${input.handoffId}:${index}`) };
      if (isAppThreadEvent(local)) {
        return {
          ...local,
          payload: {
            ...local.payload,
            projectId: input.projectId,
            worktreePath: input.worktreePath,
            providerInstanceId: input.providerInstanceId,
            modelSelection: threadModelSelection(local.payload.modelSelection),
          },
        } as OrchestrationV2DomainEvent;
      }
      if (local.type === "provider-thread.updated") {
        // The source process is gone; the destination opens its own session.
        return { ...local, payload: { ...local.payload, providerSessionId: null } };
      }
      return local;
    });
}
