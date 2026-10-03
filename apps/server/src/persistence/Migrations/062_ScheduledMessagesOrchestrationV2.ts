import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Held messages were stored as V1 `thread.turn.start` commands. Rewrite each
 * as the V2 `message.dispatch` the scheduler now replays, keeping the command
 * and message ids so a dispatch that already landed stays deduplicated. A
 * row that is not a readable turn start cannot be shown or cancelled by any
 * client, so it is dropped.
 */
export function scheduledTurnStartToMessageDispatch(command: unknown): JsonRecord | null {
  if (!isRecord(command) || command.type !== "thread.turn.start") return null;
  const message = command.message;
  if (!isRecord(message) || typeof message.messageId !== "string") return null;
  return {
    type: "message.dispatch",
    createdBy: "user",
    creationSource: "web",
    commandId: command.commandId,
    threadId: command.threadId,
    messageId: message.messageId,
    text: typeof message.text === "string" ? message.text : "",
    attachments: Array.isArray(message.attachments) ? message.attachments : [],
    ...(message.context !== undefined ? { context: message.context } : {}),
    ...(command.modelSelection !== undefined ? { modelSelection: command.modelSelection } : {}),
    ...(command.titleSeed !== undefined ? { titleSeed: command.titleSeed } : {}),
    ...(Array.isArray(command.miniSkillIds) && command.miniSkillIds.length > 0
      ? { miniSkillIds: command.miniSkillIds }
      : {}),
    ...(command.agentProfile !== undefined ? { agentProfile: command.agentProfile } : {}),
    deliveryIntent: "auto",
    dispatchMode: { type: "start_immediately" },
  };
}

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly command_id: string; readonly command_json: string }>`
    SELECT command_id, command_json FROM scheduled_messages
  `;
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.command_json);
    } catch {
      parsed = undefined;
    }
    if (isRecord(parsed) && parsed.type === "message.dispatch") continue;
    const converted = scheduledTurnStartToMessageDispatch(parsed);
    if (converted === null) {
      yield* sql`DELETE FROM scheduled_messages WHERE command_id = ${row.command_id}`;
      continue;
    }
    yield* sql`
      UPDATE scheduled_messages SET command_json = ${JSON.stringify(converted)}
      WHERE command_id = ${row.command_id}
    `;
  }
});
