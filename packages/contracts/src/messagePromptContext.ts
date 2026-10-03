import * as Schema from "effect/Schema";

/** Snapshot of the prompt composed by the server for this message, independent of later settings edits. */
export const MessagePromptContext = Schema.Struct({
  threadSkills: Schema.Array(Schema.String),
  requestSkills: Schema.Array(Schema.String),
  profileName: Schema.optional(Schema.String),
  prompt: Schema.String,
});
export type MessagePromptContext = typeof MessagePromptContext.Type;
