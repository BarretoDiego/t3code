import { SourceControlHubError, type AiReviewAgentSelection } from "@t3tools/contracts";
import {
  composeTurnPromptWithAgentProfile,
  mergeProfileMiniSkillIds,
  resolveAgentProfile,
} from "@t3tools/shared/agentProfiles";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import { ServerSettingsService } from "../serverSettings.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";

/** One profile/skill resolver for source-control tasks; harness execution remains in its provider. */
export const resolveAgentTaskConfiguration = Effect.fn(function* (
  selection: AiReviewAgentSelection,
) {
  const settings = yield* (yield* ServerSettingsService).getSettings;
  const instance = yield* (yield* ProviderInstanceRegistry).getInstance(
    selection.modelSelection.instanceId,
  );
  if (!instance?.enabled)
    return yield* new SourceControlHubError({ message: "Selected agent is unavailable." });
  const snapshot = yield* instance.snapshot.getSnapshot;
  const profile = selection.profileId
    ? settings.agentProfiles.find((profile) => profile.id === selection.profileId)
    : undefined;
  if (selection.profileId && !profile?.enabled)
    return yield* new SourceControlHubError({
      message: "Selected Agent Profile no longer exists.",
    });
  const resolved = profile
    ? resolveAgentProfile({
        profile,
        instanceId: instance.instanceId,
        availableModelSlugs: snapshot.models.map((model) => model.slug),
        currentModelSelection: selection.modelSelection,
        currentReasoningEffort:
          getModelSelectionStringOptionValue(selection.modelSelection, "reasoningEffort") ?? null,
        getSupportedReasoningEfforts: (slug) => {
          const descriptor = snapshot.models
            .find((model) => model.slug === slug)
            ?.capabilities?.optionDescriptors?.find((option) => option.id === "reasoningEffort");
          return descriptor?.type === "select"
            ? descriptor.options.map((option) => option.id)
            : null;
        },
        defaultWrapper: settings.agentProfileDefaultWrapper,
        knownMiniSkillIds: settings.miniSkills.map((skill) => skill.id),
      })
    : undefined;
  if (resolved?.status === "unavailable")
    return yield* new SourceControlHubError({ message: resolved.reason });
  const agent = {
    ...selection,
    modelSelection: resolved?.modelSelection ?? selection.modelSelection,
    miniSkillIds: mergeProfileMiniSkillIds(resolved?.miniSkillIds ?? [], selection.miniSkillIds),
  };
  return {
    agent,
    compose: (message: string) =>
      composeTurnPromptWithAgentProfile({
        message,
        threadSkills: [],
        requestSkills: settings.miniSkills.filter((skill) => agent.miniSkillIds.includes(skill.id)),
        wrappers: settings.miniSkillPromptWrappers,
        defaultAgentProfileWrapper: settings.agentProfileDefaultWrapper,
        ...(resolved
          ? {
              agentProfile: {
                name: resolved.profileName,
                instructions: resolved.instructions,
                template: resolved.promptTemplate,
              },
            }
          : {}),
      }),
  };
});
