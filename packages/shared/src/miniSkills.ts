/**
 * Mini skill prompt rendering — the single place where skill content becomes
 * prompt text. Kept pure so the server composition path and the settings UI
 * share exactly one string-concatenation implementation.
 *
 * Scopes are distinct on purpose: thread skills were snapshotted onto the
 * thread at creation; request skills were picked in the composer for one
 * message. A skill explicitly picked for a request wins over its (possibly
 * stale) thread snapshot, so the two blocks never repeat the same skill.
 */
import {
  DEFAULT_MINI_SKILL_PROMPT_WRAPPERS,
  MINI_SKILLS_WRAPPER_PLACEHOLDER,
  type MiniSkill,
  type MiniSkillId,
  type MiniSkillPromptWrappers,
  type ThreadMiniSkillSnapshot,
} from "@t3tools/contracts";

export interface MiniSkillRenderable {
  readonly name: string;
  readonly content: string;
}

/** Render the `{{skills}}` replacement: one `### Name` section per skill, in order. */
export function renderMiniSkills(skills: ReadonlyArray<MiniSkillRenderable>): string {
  return skills.map((skill) => `### ${skill.name}\n\n${skill.content.trim()}`).join("\n\n");
}

export function hasMiniSkillsPlaceholder(wrapper: string): boolean {
  return wrapper.includes(MINI_SKILLS_WRAPPER_PLACEHOLDER);
}

/**
 * Wrap rendered skills in the scope's wrapper. Returns null when there is
 * nothing to render, so callers never emit an empty `<user_preferences>`
 * block. A wrapper without the placeholder falls back to the default: the
 * settings UI blocks saving one, this keeps composition correct regardless.
 */
export function renderMiniSkillWrapper(input: {
  readonly wrapper: string;
  readonly scope: keyof MiniSkillPromptWrappers;
  readonly skills: ReadonlyArray<MiniSkillRenderable>;
}): string | null {
  if (input.skills.length === 0) {
    return null;
  }
  const wrapper = hasMiniSkillsPlaceholder(input.wrapper)
    ? input.wrapper
    : DEFAULT_MINI_SKILL_PROMPT_WRAPPERS[input.scope];
  return wrapper.replaceAll(MINI_SKILLS_WRAPPER_PLACEHOLDER, renderMiniSkills(input.skills));
}

const dedupeById = <Skill extends MiniSkill | ThreadMiniSkillSnapshot>(
  skills: ReadonlyArray<Skill>,
  getId: (skill: Skill) => MiniSkillId,
): Skill[] => {
  const seen = new Set<string>();
  return skills.filter((skill) => {
    const id = getId(skill);
    if (seen.has(id)) {
      return false;
    }
    seen.add(id);
    return true;
  });
};

/**
 * Compose the effective turn prompt: thread-scope block, then request-scope
 * block, then the user's message. With no skills selected anywhere the
 * message passes through untouched — identical to the pre-feature behavior.
 */
export function composeTurnPromptWithMiniSkills(input: {
  readonly message: string;
  readonly threadSkills: ReadonlyArray<ThreadMiniSkillSnapshot>;
  readonly requestSkills: ReadonlyArray<MiniSkill>;
  readonly wrappers: MiniSkillPromptWrappers;
}): string {
  const requestSkills = dedupeById(input.requestSkills, (skill) => skill.id);
  const requestSkillIds = new Set<string>(requestSkills.map((skill) => skill.id));
  const threadSkills = dedupeById(input.threadSkills, (skill) => skill.skillId).filter(
    (skill) => !requestSkillIds.has(skill.skillId),
  );

  const blocks = [
    renderMiniSkillWrapper({
      wrapper: input.wrappers.thread,
      scope: "thread",
      skills: threadSkills,
    }),
    renderMiniSkillWrapper({
      wrapper: input.wrappers.request,
      scope: "request",
      skills: requestSkills,
    }),
  ].filter((block) => block !== null);

  if (blocks.length === 0) {
    return input.message;
  }
  return [...blocks, input.message].join("\n\n");
}
