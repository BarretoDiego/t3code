import {
  CommandId,
  EventId,
  ThreadHandoffError,
  type OrchestrationEvent,
  type ModelSelection,
  type ProjectId,
  type ProviderInstanceId,
  type ThreadHandoffId,
  type ThreadId,
} from "@t3tools/contracts";

/** History is replayed only into persistence/projectors, never into provider
 * reactors. IDs visible in the conversation (messages, turns, checkpoints)
 * survive. Environment-local event/command IDs get a new import namespace. */
export function remapThreadHandoffEvents(input: {
  readonly handoffId: ThreadHandoffId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly worktreePath: string | null;
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelSelection?: ModelSelection;
  readonly events: readonly OrchestrationEvent[];
}): readonly OrchestrationEvent[] {
  const latestCreation = input.events.findLastIndex((event) => event.type === "thread.created");
  if (latestCreation < 0)
    throw new ThreadHandoffError({
      code: "verificationFailed",
      message: "Thread archive has no creation event.",
    });
  let previousSequence = -1;
  return input.events.slice(latestCreation).map((event, index): OrchestrationEvent => {
    if (
      event.aggregateKind !== "thread" ||
      event.aggregateId !== input.threadId ||
      !("threadId" in event.payload) ||
      event.payload.threadId !== input.threadId ||
      event.sequence <= previousSequence
    ) {
      throw new ThreadHandoffError({
        code: "verificationFailed",
        message: "Thread archive contains foreign or unordered events.",
      });
    }
    previousSequence = event.sequence;
    const local = {
      ...event,
      eventId: EventId.make(`${input.handoffId}-${index}`),
      commandId: event.commandId ? CommandId.make(`${input.handoffId}-${index}`) : null,
      causationEventId: null,
      correlationId: null,
      metadata: { ...event.metadata, historyImport: true },
    };
    switch (local.type) {
      case "thread.created":
        return {
          ...local,
          payload: {
            ...local.payload,
            projectId: input.projectId,
            worktreePath: input.worktreePath,
            modelSelection: {
              ...(input.modelSelection ?? local.payload.modelSelection),
              instanceId: input.providerInstanceId,
            },
          },
        };
      case "thread.meta-updated":
        return {
          ...local,
          payload: {
            ...local.payload,
            ...(local.payload.worktreePath !== undefined
              ? { worktreePath: input.worktreePath }
              : {}),
            ...(local.payload.modelSelection
              ? {
                  modelSelection: {
                    ...(input.modelSelection ?? local.payload.modelSelection),
                    instanceId: input.providerInstanceId,
                  },
                }
              : {}),
          },
        };
      case "thread.session-set":
        return {
          ...local,
          payload: {
            ...local.payload,
            session: local.payload.session
              ? { ...local.payload.session, providerInstanceId: input.providerInstanceId }
              : local.payload.session,
          },
        };
      default:
        return local;
    }
  });
}
