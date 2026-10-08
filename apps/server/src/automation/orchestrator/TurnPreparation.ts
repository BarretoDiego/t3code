import type {
  AutomationError,
  MiniSkillId,
  ModelSelection,
  ServerProvider,
  ServerSettings,
  TurnAgentProfileContext,
} from "@t3tools/contracts";
import { resolveAgentProfile } from "@t3tools/shared/agentProfiles";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";

import { automationError } from "../Caller.ts";

/**
 * Whether T3 Code can hand an orchestrator's agent its own credential and `t3`
 * on this provider. `null` means it can; a string says why it cannot. An
 * orchestrator never takes a turn on a provider that is not listed as
 * supported: its agent would otherwise call the CLI as the user.
 *
 * Supported means the adapter applies `withAgentShellEnvironment` to the
 * process whose shell runs the agent's commands. Every driver is listed, so a
 * new one is refused until someone decides.
 */
const AGENT_SHELL_SUPPORT: Readonly<Record<string, string | null>> = {
  codex: null,
  claudeAgent: null,
  cursor:
    "Cursor sessions take their process environment per provider instance, not per thread, so the orchestrator's credential cannot be scoped to its own thread.",
  grok: "Grok runs as an ACP agent, and T3 Code does not yet pass a per-thread environment to the shell its commands run in.",
  antigravity:
    "Antigravity runs as an ACP agent, and T3 Code does not yet pass a per-thread environment to the shell its commands run in.",
  acpRegistry:
    "ACP registry agents are third-party processes, and T3 Code does not yet pass a per-thread environment to the shell their commands run in.",
  opencode:
    "One OpenCode server serves every thread of a provider instance, so a per-thread environment cannot reach the shell of a single thread.",
  pi: "T3 Code does not yet pass the orchestrator's per-thread environment to Pi's command shell.",
};

/** Why an orchestrator may not take turns on `provider`, as the error it surfaces, or null. */
export const agentShellRefusal = (
  provider: Pick<ServerProvider, "driver" | "instanceId"> | undefined,
  instanceId: string,
): AutomationError | null => {
  if (provider === undefined) {
    return automationError(
      "CAPABILITY_UNSUPPORTED",
      `Provider instance ${instanceId} is not configured on this server, so the orchestrator cannot take a turn on it.`,
      { providerInstanceId: instanceId },
    );
  }
  const reason = Object.hasOwn(AGENT_SHELL_SUPPORT, provider.driver)
    ? AGENT_SHELL_SUPPORT[provider.driver]
    : `T3 Code has not established how to give the ${provider.driver} agent its own credential.`;
  return reason === null || reason === undefined
    ? null
    : automationError(
        "CAPABILITY_UNSUPPORTED",
        `Orchestrators cannot run on the ${provider.driver} provider (${provider.instanceId}): ${reason} Move the orchestrator's main thread to a Codex or Claude provider instance.`,
        { provider: provider.driver, providerInstanceId: provider.instanceId },
      );
};

export interface TurnLibrary {
  readonly modelSelection: ModelSelection;
  readonly miniSkillIds: ReadonlyArray<MiniSkillId>;
  readonly agentProfile: TurnAgentProfileContext | null;
}

/**
 * Applies an orchestrator's agent profile to a turn the way `t3 thread send
 * --profile` does: the profile adapts to the thread's provider instance (model
 * candidate and effort) and brings its instructions and mini skills. Fails,
 * naming the profile, when it is gone, disabled, or has no candidate here.
 */
export const resolveTurnLibrary = (input: {
  readonly profile: string | undefined;
  readonly modelSelection: ModelSelection;
  readonly settings: Pick<
    ServerSettings,
    "agentProfiles" | "agentProfileDefaultWrapper" | "miniSkills"
  >;
  readonly provider: Pick<ServerProvider, "models"> | undefined;
}): Effect.Effect<TurnLibrary, AutomationError> => {
  const { profile: slug, modelSelection, settings, provider } = input;
  if (slug === undefined) {
    return Effect.succeed({ modelSelection, miniSkillIds: [], agentProfile: null });
  }
  const unavailable = (message: string) =>
    Effect.fail(automationError("NOT_FOUND", message, { profile: slug }));
  const profile = settings.agentProfiles.find((candidate) => candidate.slug === slug);
  if (profile === undefined) {
    return unavailable(
      `Agent profile #${slug} no longer exists. Edit the orchestrator to name another profile or none.`,
    );
  }
  if (!profile.enabled) {
    return unavailable(`Agent profile #${slug} is disabled. Enable it or edit the orchestrator.`);
  }
  const resolution = resolveAgentProfile({
    profile,
    instanceId: modelSelection.instanceId,
    availableModelSlugs: provider?.models.map((model) => model.slug) ?? [],
    currentModelSelection: modelSelection,
    currentReasoningEffort:
      getModelSelectionStringOptionValue(modelSelection, "reasoningEffort") ?? null,
    getSupportedReasoningEfforts: (model) => {
      const option = provider?.models
        .find((candidate) => candidate.slug === model)
        ?.capabilities?.optionDescriptors?.find((entry) => entry.id === "reasoningEffort");
      return option?.type === "select" ? option.options.map((item) => item.id) : null;
    },
    defaultWrapper: settings.agentProfileDefaultWrapper,
    knownMiniSkillIds: settings.miniSkills.map((skill) => skill.id),
  });
  if (resolution.status === "unavailable") {
    return unavailable(
      `Agent profile #${slug} cannot run on ${modelSelection.instanceId}: ${resolution.reason}`,
    );
  }
  return Effect.succeed({
    modelSelection: resolution.modelSelection,
    miniSkillIds: resolution.miniSkillIds,
    agentProfile: {
      profileId: resolution.profileId,
      profileName: resolution.profileName,
      instructions: resolution.instructions,
      promptTemplate: resolution.promptTemplate,
      ...(resolution.diagnostics.fallbackIndex === null
        ? {}
        : { fallbackIndex: resolution.diagnostics.fallbackIndex }),
    },
  });
};
