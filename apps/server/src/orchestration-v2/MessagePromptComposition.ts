import type {
  MessagePromptContext,
  MiniSkillId,
  ServerSettings,
  ThreadMiniSkillSnapshot,
  TurnAgentProfileContext,
} from "@t3tools/contracts";
import { composeTurnPromptWithAgentProfile } from "@t3tools/shared/agentProfiles";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type * as ServerSettingsService from "../serverSettings.ts";

export interface ComposedMessagePrompt {
  /** The text the provider receives in place of the user's message. */
  readonly prompt: string;
  /** What the client renders next to the sent message. */
  readonly promptContext: MessagePromptContext;
}

/**
 * Composes mini skills and the agent profile around one user message.
 *
 * Thread skills are passed only for the thread's first user turn: provider
 * sessions carry context forward, so re-injecting them would repeat the block
 * on every message. Request skills resolve against the current library;
 * unknown ids are skipped. Returns null when nothing applies, so callers send
 * the message unchanged.
 */
export function composeMessagePrompt(input: {
  readonly text: string;
  readonly threadSkills: ReadonlyArray<ThreadMiniSkillSnapshot>;
  readonly miniSkillIds: ReadonlyArray<MiniSkillId>;
  readonly agentProfile?: TurnAgentProfileContext | undefined;
  readonly settings: Pick<
    ServerSettings,
    "miniSkills" | "miniSkillPromptWrappers" | "agentProfileDefaultWrapper"
  >;
}): ComposedMessagePrompt | null {
  const { agentProfile, settings } = input;
  if (input.threadSkills.length === 0 && input.miniSkillIds.length === 0 && !agentProfile) {
    return null;
  }
  const requestSkills = [...new Set(input.miniSkillIds)].flatMap((skillId) =>
    settings.miniSkills.filter((skill) => skill.id === skillId),
  );
  const prompt = composeTurnPromptWithAgentProfile({
    message: input.text,
    threadSkills: input.threadSkills,
    requestSkills,
    wrappers: settings.miniSkillPromptWrappers,
    defaultAgentProfileWrapper: settings.agentProfileDefaultWrapper,
    ...(agentProfile !== undefined
      ? {
          agentProfile: {
            name: agentProfile.profileName,
            instructions: agentProfile.instructions,
            template: agentProfile.promptTemplate,
          },
        }
      : {}),
  });
  const requestIds = new Set(requestSkills.map((skill) => skill.id));
  return {
    prompt,
    promptContext: {
      threadSkills: input.threadSkills
        .filter((skill) => agentProfile !== undefined || !requestIds.has(skill.skillId))
        .map((skill) => skill.name),
      requestSkills: [...new Set(requestSkills.map((skill) => skill.name))],
      ...(agentProfile !== undefined ? { profileName: agentProfile.profileName } : {}),
      prompt,
    },
  };
}

/**
 * Snapshots the library skills enabled by default for a new thread. The
 * snapshot (not the skill id) travels with the thread, so later library edits
 * never rewrite existing threads. A settings read failure degrades to no
 * skills rather than failing thread creation.
 */
export const defaultThreadMiniSkills = (
  settings: ServerSettingsService.ServerSettingsService["Service"],
): Effect.Effect<ReadonlyArray<ThreadMiniSkillSnapshot>> =>
  Effect.gen(function* () {
    const current = yield* settings.getSettings;
    const defaults = current.miniSkills.filter((skill) => skill.enabledByDefaultForNewThreads);
    if (defaults.length === 0) return [];
    const appliedAt = DateTime.formatIso(yield* DateTime.now);
    return defaults.map((skill) => ({
      skillId: skill.id,
      name: skill.name,
      content: skill.content,
      appliedAt,
    }));
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("failed to resolve default mini skills for new thread", {
        cause: Cause.pretty(cause),
      }).pipe(Effect.as([] as ReadonlyArray<ThreadMiniSkillSnapshot>)),
    ),
  );
