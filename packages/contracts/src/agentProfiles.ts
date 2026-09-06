/**
 * Agent Profiles — named, reusable execution presets for the composer.
 *
 * A profile is an *intent* ("reviewer", "fast", "deep"), not a model: it
 * carries provider-independent preferences (reasoning effort, mini skills,
 * instructions, prompt template) plus per-instance routes that map the intent
 * onto concrete model candidates for each provider instance. Resolution
 * adapts the profile to whatever backend the thread is using — a profile
 * never switches providers on its own.
 *
 * Profiles are global user configuration (server settings, shared-settings
 * sync). Unlike thread mini skills they are not snapshotted: editing a
 * profile affects future sends, while each sent turn keeps its own record of
 * what was resolved (see `ThreadTurnStartCommand.agentProfile`).
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";
import { MiniSkillId } from "./miniSkills.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const AgentProfileId = TrimmedNonEmptyString.pipe(Schema.brand("AgentProfileId"));
export type AgentProfileId = typeof AgentProfileId.Type;

/**
 * Lowercase `letters-digits-hyphen`, starting with a letter so the `#slug`
 * composer shortcut can never collide with issue references like `#123`.
 */
export const AGENT_PROFILE_SLUG_PATTERN = "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$";
export const AgentProfileSlug = TrimmedNonEmptyString.check(
  Schema.isPattern(new RegExp(AGENT_PROFILE_SLUG_PATTERN)),
  Schema.isMaxLength(48),
);
export type AgentProfileSlug = typeof AgentProfileSlug.Type;

/** Default `name → slug` derivation; the user can edit the result. */
export function slugifyAgentProfileName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^[^a-z]+/, "");
}

/**
 * Per-instance routing: an ordered list of model candidates (primary first,
 * then configuration fallbacks) plus an optional reasoning effort override.
 * This is availability-based *configuration* fallback — never a request retry
 * or a provider switch.
 */
export const AgentProfileRoute = Schema.Struct({
  // Stable row id so the settings editor can key/edit/delete entries without
  // depending on the instance id staying unique across edits.
  id: TrimmedNonEmptyString,
  instanceId: ProviderInstanceId,
  modelCandidates: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  reasoningEffort: Schema.optionalKey(TrimmedNonEmptyString),
});
export type AgentProfileRoute = typeof AgentProfileRoute.Type;

export const AgentProfile = Schema.Struct({
  id: AgentProfileId,
  name: TrimmedNonEmptyString,
  slug: AgentProfileSlug,
  description: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  enabled: Schema.Boolean,
  // Base reasoning effort. Absent = inherit the composer's current selection.
  reasoningEffort: Schema.optionalKey(TrimmedNonEmptyString),
  // Request-scope mini skills, referenced by id; the mini skills system owns
  // their content and prompt rendering.
  miniSkillIds: Schema.Array(MiniSkillId).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  // Profile-owned Markdown instructions (not a mini skill).
  instructions: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  // Custom prompt template; absent = the global default wrapper setting.
  promptTemplate: Schema.optionalKey(Schema.String),
  routes: Schema.Array(AgentProfileRoute).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type AgentProfile = typeof AgentProfile.Type;

// ── Prompt template ─────────────────────────────────────────────────

export const AGENT_PROFILE_USER_MESSAGE_PLACEHOLDER = "{{user_message}}";
export const AGENT_PROFILE_INSTRUCTIONS_PLACEHOLDER = "{{profile_instructions}}";
export const AGENT_PROFILE_MINI_SKILLS_PLACEHOLDER = "{{mini_skills}}";
export const AGENT_PROFILE_NAME_PLACEHOLDER = "{{profile_name}}";

/**
 * A profile template is only valid when the user's message has a slot;
 * otherwise sending would silently drop what the user typed.
 */
export function isValidAgentProfileTemplate(template: string): boolean {
  return template.includes(AGENT_PROFILE_USER_MESSAGE_PLACEHOLDER);
}

export const DEFAULT_AGENT_PROFILE_WRAPPER = `<user_profile_preferences profile="${AGENT_PROFILE_NAME_PLACEHOLDER}">

The user selected the following execution profile for this request.

Apply these profile-specific working preferences while completing the request unless they conflict with higher-priority instructions or an explicit request from the user.

${AGENT_PROFILE_INSTRUCTIONS_PLACEHOLDER}

${AGENT_PROFILE_MINI_SKILLS_PLACEHOLDER}

</user_profile_preferences>

${AGENT_PROFILE_USER_MESSAGE_PLACEHOLDER}`;

/**
 * What a turn carried about the active profile: the composer's resolution
 * snapshot for prompt composition plus enough metadata for history/debugging.
 * Persisted on the turn-start event, so old turns keep the values resolved at
 * send time even when the profile is later edited or deleted.
 */
export const TurnAgentProfileContext = Schema.Struct({
  profileId: AgentProfileId,
  profileName: TrimmedNonEmptyString,
  instructions: Schema.String,
  promptTemplate: Schema.String,
  // Model candidate used from the matched route: 0 = primary, N = Nth
  // fallback. Absent when the model was inherited from the composer.
  fallbackIndex: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type TurnAgentProfileContext = typeof TurnAgentProfileContext.Type;

// ── Built-in seeds ────────────────────────────────────────────────────

// Fixed timestamp, matching the mini skills seeds: profiles roam through
// shared-settings sync, so every machine seeds byte-identical defaults and
// no sync mismatch warning fires on a fresh setup.
export const DEFAULT_AGENT_PROFILES_SEEDED_AT = "2026-01-01T00:00:00.000Z";

const makeDefaultAgentProfile = (input: {
  readonly id: AgentProfileId;
  readonly name: string;
  readonly slug: string;
  readonly description: string;
  readonly reasoningEffort?: string;
  readonly miniSkillIds?: ReadonlyArray<MiniSkillId>;
  readonly instructions: string;
}): AgentProfile => ({
  id: input.id,
  name: input.name,
  slug: input.slug as AgentProfileSlug,
  description: input.description,
  enabled: true,
  ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
  miniSkillIds: [...(input.miniSkillIds ?? [])],
  instructions: input.instructions,
  routes: [],
  createdAt: DEFAULT_AGENT_PROFILES_SEEDED_AT,
  updatedAt: DEFAULT_AGENT_PROFILES_SEEDED_AT,
});

/**
 * Built-in library seeded once per environment (`agentProfilesSeededAt`).
 * Seeds carry no routes: concrete model ids are installation-specific, and a
 * profile without a matching route inherits the composer's current model.
 */
export const DEFAULT_AGENT_PROFILES: ReadonlyArray<AgentProfile> = [
  makeDefaultAgentProfile({
    id: AgentProfileId.make("default-reviewer"),
    name: "Reviewer Pre-Commit",
    slug: "reviewer",
    description: "Review current changes before creating a commit.",
    reasoningEffort: "medium",
    miniSkillIds: [MiniSkillId.make("default-commit-changes")],
    instructions: `Act as a pre-commit reviewer.

Inspect the complete implementation and current diff before creating or recommending a commit.

Prioritize:
- correctness;
- regressions;
- architectural consistency;
- unnecessary complexity;
- security issues;
- error handling;
- missing tests;
- unintended changes.

Separate blocking issues from optional improvements.

If the implementation is valid, prepare an appropriate commit following the conventions already used by the repository.`,
  }),
  makeDefaultAgentProfile({
    id: AgentProfileId.make("default-fast-implementation"),
    name: "Fast Implementation",
    slug: "fast",
    description: "Low-latency configuration for simple implementation tasks.",
    reasoningEffort: "low",
    instructions: `Implement the requested change efficiently.

Prefer the smallest correct solution consistent with the existing architecture.

Avoid unnecessary refactoring or architectural expansion unrelated to the request.

Validate the affected code before finishing.`,
  }),
  makeDefaultAgentProfile({
    id: AgentProfileId.make("default-deep-implementation"),
    name: "Deep Implementation",
    slug: "deep",
    description: "Stronger configuration for complex implementation tasks.",
    reasoningEffort: "high",
    instructions: `Treat this as a complex implementation task.

Inspect the relevant architecture before modifying code.

Consider interactions, regressions, compatibility, edge cases and tests.

Prefer robust architectural consistency over quick local patches while avoiding unnecessary overengineering.`,
  }),
];
