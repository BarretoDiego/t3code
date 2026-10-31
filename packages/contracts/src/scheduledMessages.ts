import * as Schema from "effect/Schema";
import { CommandId, IsoDateTime, ThreadId } from "./baseSchemas.ts";
import { OrchestrationV2MessageDispatchCommand } from "./orchestrationV2.ts";

/**
 * A `message.dispatch` command the server holds until `sendAt`. The stored
 * command never carries `sendAt` itself; the server dispatches it verbatim
 * once due, so delivery follows the thread's state at that moment.
 */
export const ScheduledMessage = Schema.Struct({
  command: OrchestrationV2MessageDispatchCommand,
  sendAt: IsoDateTime,
  error: Schema.NullOr(Schema.String),
});
export type ScheduledMessage = typeof ScheduledMessage.Type;
export const ScheduledMessageUpdate = Schema.Struct({
  threadId: ThreadId,
  commandId: CommandId,
  action: Schema.Literals(["cancel", "send", "reschedule", "edit"]),
  sendAt: Schema.optional(IsoDateTime),
  /** The replacement message text for `edit`; attachments stay as scheduled. */
  text: Schema.optional(Schema.String),
});
export type ScheduledMessageUpdate = typeof ScheduledMessageUpdate.Type;
