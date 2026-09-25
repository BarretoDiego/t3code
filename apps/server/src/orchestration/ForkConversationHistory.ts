import type { MessageId, OrchestrationCommand, OrchestrationEvent } from "@t3tools/contracts";

type ImportedMessage = Extract<
  OrchestrationCommand,
  { type: "thread.history.import" }
>["messages"][number];

/** Include every delta and the completion event for the selected message. */
export function selectForkHistory(
  events: ReadonlyArray<OrchestrationEvent>,
  throughMessageId: MessageId,
): ReadonlyArray<OrchestrationEvent> | null {
  const boundary = events.findLastIndex(
    (event) => event.type === "thread.message-sent" && event.payload.messageId === throughMessageId,
  );
  return boundary < 0 ? null : events.slice(0, boundary + 1);
}

/** Rebuild visible messages from their event deltas before importing a fork. */
export function forkMessagesFromHistory(events: ReadonlyArray<OrchestrationEvent>) {
  const messages = new Map<MessageId, ImportedMessage>();
  for (const event of events) {
    if (event.type !== "thread.message-sent") continue;
    const message = event.payload;
    if (message.role !== "user" && message.role !== "assistant") continue;
    const previous = messages.get(message.messageId);
    messages.set(message.messageId, {
      messageId: message.messageId,
      role: message.role,
      text: previous
        ? message.streaming
          ? previous.text + message.text
          : message.text || previous.text
        : message.text,
      ...(message.attachments !== undefined
        ? { attachments: message.attachments }
        : previous?.attachments !== undefined
          ? { attachments: previous.attachments }
          : {}),
      ...(message.context !== undefined
        ? { context: message.context }
        : previous?.context !== undefined
          ? { context: previous.context }
          : {}),
      createdAt: previous?.createdAt ?? message.createdAt,
    });
  }
  return [...messages.values()];
}
