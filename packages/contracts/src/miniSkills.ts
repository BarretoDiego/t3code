/**
 * Mini Skills — user-authored, reusable Markdown instruction snippets.
 *
 * A Mini Skill is a named block of instructions the user can attach to a
 * thread (snapshot captured at thread creation when the skill is enabled by
 * default) or to a single request (selected in the composer, injected into
 * that turn's effective prompt only). They are deliberately plain text: no
 * tools, scripts, parameters, or provider-specific behavior. Composition into
 * the effective prompt happens server-side, before any provider adapter sees
 * the turn, so every provider receives the same text.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";

export const MiniSkillId = TrimmedNonEmptyString.pipe(Schema.brand("MiniSkillId"));
export type MiniSkillId = typeof MiniSkillId.Type;

export const MiniSkill = Schema.Struct({
  id: MiniSkillId,
  name: TrimmedNonEmptyString,
  description: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  /** Markdown instructions for the agent. Plain text; never executed. */
  content: Schema.String,
  enabledByDefaultForNewThreads: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type MiniSkill = typeof MiniSkill.Type;

/**
 * Immutable copy of a Mini Skill captured when a thread is created. Later
 * edits or deletion of the library skill must not retroactively change
 * existing threads, so the thread carries everything needed to render the
 * instruction without looking the skill up.
 */
export const ThreadMiniSkillSnapshot = Schema.Struct({
  skillId: MiniSkillId,
  name: TrimmedNonEmptyString,
  content: Schema.String,
  appliedAt: IsoDateTime,
});
export type ThreadMiniSkillSnapshot = typeof ThreadMiniSkillSnapshot.Type;

/** Token inside a prompt wrapper where the rendered skills are inserted. */
export const MINI_SKILLS_WRAPPER_PLACEHOLDER = "{{skills}}";

export const DEFAULT_THREAD_MINI_SKILL_WRAPPER = `<user_preferences scope="thread">

The following are user-defined working preferences for this thread.

Treat these instructions as default preferences throughout this conversation unless they conflict with higher-priority instructions or with an explicit instruction from the user.

${MINI_SKILLS_WRAPPER_PLACEHOLDER}

</user_preferences>`;

export const DEFAULT_REQUEST_MINI_SKILL_WRAPPER = `<user_preferences scope="request">

The following are user-defined instructions selected specifically for this request.

Apply them while completing this request unless they conflict with higher-priority instructions or an explicit instruction from the user.

${MINI_SKILLS_WRAPPER_PLACEHOLDER}

</user_preferences>`;

export const MiniSkillPromptWrappers = Schema.Struct({
  // Per-field defaults keep sparse settings writes encodable: a patch that
  // changes one wrapper persists without re-stating the other.
  thread: Schema.String.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_THREAD_MINI_SKILL_WRAPPER)),
  ),
  request: Schema.String.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_REQUEST_MINI_SKILL_WRAPPER)),
  ),
});
export type MiniSkillPromptWrappers = typeof MiniSkillPromptWrappers.Type;

export const DEFAULT_MINI_SKILL_PROMPT_WRAPPERS: MiniSkillPromptWrappers = {
  thread: DEFAULT_THREAD_MINI_SKILL_WRAPPER,
  request: DEFAULT_REQUEST_MINI_SKILL_WRAPPER,
};

/**
 * Fixed timestamp for the built-in seeds. Mini skills roam across
 * environments through shared-settings sync, which flags value mismatches;
 * seeding every machine with identical bytes keeps a fresh multi-machine
 * setup from warning about its own defaults.
 */
export const DEFAULT_MINI_SKILLS_SEEDED_AT = "2026-01-01T00:00:00.000Z";

const makeDefaultMiniSkill = (input: {
  readonly id: MiniSkillId;
  readonly name: string;
  readonly description: string;
  readonly content: string;
  readonly enabledByDefaultForNewThreads: boolean;
}): MiniSkill => ({
  id: input.id,
  name: input.name,
  description: input.description,
  content: input.content,
  enabledByDefaultForNewThreads: input.enabledByDefaultForNewThreads,
  createdAt: DEFAULT_MINI_SKILLS_SEEDED_AT,
  updatedAt: DEFAULT_MINI_SKILLS_SEEDED_AT,
});

/** Built-in library seeded once per environment (see `miniSkillsSeededAt`). */
export const DEFAULT_MINI_SKILLS: ReadonlyArray<MiniSkill> = [
  makeDefaultMiniSkill({
    id: MiniSkillId.make("default-isolated-feature-workspace"),
    name: "Create Isolated Feature Workspace",
    description:
      "Prepare an isolated worktree, feature branch and VS Code workspace before implementing the feature.",
    enabledByDefaultForNewThreads: true,
    content: `Before implementing the requested feature, isolate the work from the main working tree.

Inspect the repository or repositories involved and identify the correct base branch.

Create a dedicated Git worktree for this feature and create a dedicated feature branch using a clear name derived from the feature being implemented.

Do not perform the implementation directly in the primary worktree.

If multiple related repositories are required for the feature, create the corresponding isolated worktrees and branches for each repository and organize them together as a single development workspace.

Create a VS Code \`.code-workspace\` containing all repositories/worktrees involved in the feature and open that workspace in VS Code.

Publish the new feature branch to \`origin\` and configure upstream tracking.

Before making implementation changes, verify that:
- the correct worktree is active;
- the expected branch is checked out;
- the branch tracks the corresponding remote branch;
- all related repositories are pointing to the correct feature branches.

Keep the work isolated from unrelated changes.`,
  }),
  makeDefaultMiniSkill({
    id: MiniSkillId.make("default-commit-changes"),
    name: "Commit Changes",
    description:
      "Review and commit the implementation using the repository's existing conventions.",
    enabledByDefaultForNewThreads: false,
    content: `After completing the implementation, review the complete diff before creating commits.

Do not include unrelated modifications.

Follow the commit conventions already used by the repository.

Split changes into cohesive commits when doing so improves the history, but avoid unnecessary commit fragmentation.

Before committing, run the relevant validation commands available in the project, including tests, type checking, linting and build checks when applicable.

Only commit the implementation after verifying that the resulting changes are consistent and the repository is in a valid state.

Provide a concise summary of the commits created.`,
  }),
  makeDefaultMiniSkill({
    id: MiniSkillId.make("default-create-pull-request"),
    name: "Create Pull Request",
    description: "Push the implementation and create a pull request after validation.",
    enabledByDefaultForNewThreads: false,
    content: `After the implementation has been completed, validated and committed, ensure the current branch has been pushed to \`origin\`.

Create a pull request from the implementation branch to the appropriate target branch.

If the target branch was explicitly specified in the user's request, use it.

Otherwise determine the appropriate target branch from the repository's existing workflow and branch conventions.

Before creating the pull request, review the final diff and commit history.

The pull request should contain:
- a clear title;
- a concise summary of the implementation;
- the main architectural or behavioral changes;
- relevant validation performed;
- tests executed;
- any important limitations or follow-up work.

Do not merge the pull request automatically unless the user explicitly requested it.`,
  }),
];
