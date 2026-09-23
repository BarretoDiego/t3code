import * as Schema from "effect/Schema";
import { CommandId, IsoDateTime, ThreadId } from "./baseSchemas.ts";
import { ThreadTurnStartCommand } from "./orchestration.ts";

export const ScheduledMessage = Schema.Struct({
  command: ThreadTurnStartCommand,
  sendAt: IsoDateTime,
  error: Schema.NullOr(Schema.String),
});
export type ScheduledMessage = typeof ScheduledMessage.Type;
export const ScheduledMessageUpdate = Schema.Struct({
  threadId: ThreadId,
  commandId: CommandId,
  action: Schema.Literals(["cancel", "send", "reschedule"]),
  sendAt: Schema.optional(IsoDateTime),
});
export type ScheduledMessageUpdate = typeof ScheduledMessageUpdate.Type;
