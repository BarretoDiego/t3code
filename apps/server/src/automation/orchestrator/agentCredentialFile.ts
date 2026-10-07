import * as Schema from "effect/Schema";

/**
 * Names the file an orchestrator's agent reads its turn credential from. The
 * `t3` CLI honours it without flags. The variable carries no secret, so it can
 * sit in a long-lived provider process while the credential behind it rotates.
 */
export const AGENT_CREDENTIAL_FILE_ENV = "T3CODE_AGENT_CREDENTIAL_FILE";

/**
 * What the credential file holds. `token` is null between turns and after the
 * orchestrator is paused, disabled, deleted or handed off: the CLI then refuses
 * instead of falling back to the user's own identity.
 */
export const AgentCredentialDocument = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    /** Origin of the server that issued the credential, when it had published one. */
    origin: Schema.NullOr(Schema.String),
    token: Schema.NullOr(Schema.String),
  }),
);
