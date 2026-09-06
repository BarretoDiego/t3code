/**
 * Agent profile resolution and prompt composition.
 *
 * Resolution is pure: the same (profile, instance, available models, current
 * composer state) inputs always produce the same effective execution config,
 * so the composer, the settings editor, and tests all share one code path.
 * Prompt composition delegates mini skill rendering to `./miniSkills.ts` —
 * there is exactly one skills renderer.
 */
import {
  AGENT_PROFILE_INSTRUCTIONS_PLACEHOLDER,
  AGENT_PROFILE_MINI_SKILLS_PLACEHOLDER,
  AGENT_PROFILE_NAME_PLACEHOLDER,
  AGENT_PROFILE_USER_MESSAGE_PLACEHOLDER,
  DEFAULT_AGENT_PROFILE_WRAPPER,
  isValidAgentProfileTemplate,
  type AgentProfile,
  type AgentProfileId,
  type AgentProfileSlug,
  type MiniSkill,
  type MiniSkillId,
  type MiniSkillPromptWrappers,
  type ModelSelection,
  type ProviderInstanceId,
  type ThreadMiniSkillSnapshot,
} from "@t3tools/contracts";

import { createModelSelection } from "./model.ts";
import {
  composeTurnPromptWithMiniSkills,
  renderMiniSkills,
  renderMiniSkillWrapper,
} from "./miniSkills.ts";

// ── Template rendering ──────────────────────────────────────────────

/**
 * Substitute the four supported placeholders. No template engine: plain
 * replaceAll, and a template missing `{{user_message}}` falls back to the
 * default so the user's text can never be dropped (the settings UI blocks
 * saving such templates; this is the defensive net).
 */
export function renderAgentProfileTemplate(
  template: string,
  values: {
    readonly profileName: string;
    readonly instructions: string;
    readonly miniSkills: string;
    readonly userMessage: string;
  },
): string {
  const effectiveTemplate = isValidAgentProfileTemplate(template)
    ? template
    : DEFAULT_AGENT_PROFILE_WRAPPER;
  return effectiveTemplate
    .replaceAll(AGENT_PROFILE_NAME_PLACEHOLDER, values.profileName)
    .replaceAll(AGENT_PROFILE_INSTRUCTIONS_PLACEHOLDER, values.instructions)
    .replaceAll(AGENT_PROFILE_MINI_SKILLS_PLACEHOLDER, values.miniSkills)
    .replaceAll(AGENT_PROFILE_USER_MESSAGE_PLACEHOLDER, values.userMessage);
}

// ── Resolution ──────────────────────────────────────────────────────

export interface AgentProfileResolutionDiagnostics {
  /** The route that matched the current instance, when one did. */
  readonly routeInstanceId: ProviderInstanceId | null;
  /** 0 = primary candidate, N = Nth fallback, null = model inherited. */
  readonly fallbackIndex: number | null;
  readonly requestedReasoningEffort: string | null;
  readonly reasoningEffortSource: "route" | "base" | "current" | null;
  /** True when the requested effort was dropped because the resolved model does not list it. */
  readonly reasoningEffortSkippedAsUnsupported: boolean;
  readonly unknownMiniSkillIds: ReadonlyArray<MiniSkillId>;
}

export type AgentProfileResolution =
  | {
      readonly status: "resolved";
      readonly profileId: AgentProfileId;
      readonly profileName: string;
      readonly profileSlug: AgentProfileSlug;
      /** Fully resolved selection — inherit cases resolve to the current one. */
      readonly modelSelection: ModelSelection;
      readonly miniSkillIds: ReadonlyArray<MiniSkillId>;
      readonly instructions: string;
      readonly promptTemplate: string;
      readonly diagnostics: AgentProfileResolutionDiagnostics;
    }
  | {
      readonly status: "unavailable";
      readonly profileId: AgentProfileId;
      readonly profileName: string;
      readonly reason: string;
      readonly diagnostics: AgentProfileResolutionDiagnostics;
    };

/**
 * Resolve a profile against the composer's current state.
 *
 * Precedence (documented in docs/user/agent-profiles.md):
 * - Provider instance: never changed; the profile adapts to it.
 * - Model: matching route's first available candidate → otherwise the current
 *   composer model (inherit). A matching route whose candidates are all
 *   unavailable resolves "unavailable" instead of silently picking anything.
 * - Reasoning effort: route override → profile base → current composer value.
 *   An effort the resolved model does not list is dropped with a diagnostic.
 * - Mini skills / instructions / template: provider-independent; mini skills
 *   unknown to the library are skipped with a diagnostic.
 */
export function resolveAgentProfile(input: {
  readonly profile: AgentProfile;
  readonly instanceId: ProviderInstanceId;
  readonly availableModelSlugs: ReadonlyArray<string>;
  readonly currentModelSelection: ModelSelection;
  readonly currentReasoningEffort: string | null;
  /** Capability lookup for a candidate model; null means "unknown, accept". */
  readonly getSupportedReasoningEfforts: (modelSlug: string) => ReadonlyArray<string> | null;
  readonly defaultWrapper: string;
  readonly knownMiniSkillIds: ReadonlyArray<MiniSkillId>;
}): AgentProfileResolution {
  const { profile } = input;
  const route = profile.routes.find((entry) => entry.instanceId === input.instanceId) ?? null;

  const diagnostics: {
    -readonly [K in keyof AgentProfileResolutionDiagnostics]: AgentProfileResolutionDiagnostics[K];
  } = {
    routeInstanceId: route?.instanceId ?? null,
    fallbackIndex: null,
    requestedReasoningEffort: null,
    reasoningEffortSource: null,
    reasoningEffortSkippedAsUnsupported: false,
    unknownMiniSkillIds: [],
  };

  // Model: route candidates with availability fallback, else inherit current.
  let resolvedModel = input.currentModelSelection.model;
  let modelFromRoute = false;
  if (route !== null && route.modelCandidates.length > 0) {
    const available = new Set(input.availableModelSlugs);
    const candidateIndex = route.modelCandidates.findIndex((slug) => available.has(slug));
    if (candidateIndex === -1) {
      return {
        status: "unavailable",
        profileId: profile.id,
        profileName: profile.name,
        reason: `None of the profile's model candidates (${route.modelCandidates.join(", ")}) is available on this provider instance.`,
        diagnostics,
      };
    }
    resolvedModel = route.modelCandidates[candidateIndex]!;
    modelFromRoute = true;
    diagnostics.fallbackIndex = candidateIndex;
  }

  // Reasoning effort: route → base → current, dropped when unsupported.
  const requestedEffort =
    route?.reasoningEffort ?? profile.reasoningEffort ?? input.currentReasoningEffort;
  diagnostics.requestedReasoningEffort = requestedEffort;
  diagnostics.reasoningEffortSource =
    route?.reasoningEffort !== undefined
      ? "route"
      : profile.reasoningEffort !== undefined
        ? "base"
        : requestedEffort !== null
          ? "current"
          : null;
  let appliedEffort: string | null = requestedEffort;
  if (appliedEffort !== null) {
    const supported = input.getSupportedReasoningEfforts(resolvedModel);
    if (supported !== null && !supported.includes(appliedEffort)) {
      appliedEffort = null;
      diagnostics.reasoningEffortSkippedAsUnsupported = true;
    }
  }

  // Options: a profile-driven model switch drops unrelated current options
  // (they may not apply to the new model); keeping the model keeps them.
  const modelChanged = resolvedModel !== input.currentModelSelection.model;
  const currentOptions = input.currentModelSelection.options ?? [];
  const optionsWithoutEffort = currentOptions.filter((option) => option.id !== "reasoningEffort");
  const effortOption =
    appliedEffort !== null ? [{ id: "reasoningEffort", value: appliedEffort }] : [];
  const modelSelection = createModelSelection(
    input.instanceId,
    resolvedModel,
    modelChanged ? effortOption : [...optionsWithoutEffort, ...effortOption],
  );

  const known = new Set<string>(input.knownMiniSkillIds);
  const miniSkillIds = profile.miniSkillIds.filter((id) => known.has(id));
  diagnostics.unknownMiniSkillIds = profile.miniSkillIds.filter((id) => !known.has(id));

  const promptTemplate =
    profile.promptTemplate !== undefined && isValidAgentProfileTemplate(profile.promptTemplate)
      ? profile.promptTemplate
      : input.defaultWrapper;

  return {
    status: "resolved",
    profileId: profile.id,
    profileName: profile.name,
    profileSlug: profile.slug,
    modelSelection,
    miniSkillIds,
    instructions: profile.instructions.trim(),
    promptTemplate,
    diagnostics,
  };
}

/** Profile skills first, then manual picks, deduped by id (spec: send once). */
export function mergeProfileMiniSkillIds(
  profileIds: ReadonlyArray<MiniSkillId>,
  manualIds: ReadonlyArray<MiniSkillId>,
): MiniSkillId[] {
  return [...new Set([...profileIds, ...manualIds])];
}

// ── Turn prompt composition ───────────────────────────────────────────

export interface TurnAgentProfileComposition {
  readonly name: string;
  readonly instructions: string;
  readonly template: string;
}

/**
 * Compose the effective turn prompt. Without a profile this delegates to the
 * mini skills composer unchanged. With a profile, request-scope skills render
 * through the profile template's `{{mini_skills}}` slot (no double wrapper)
 * and the thread-scope block stays untouched.
 */
export function composeTurnPromptWithAgentProfile(input: {
  readonly message: string;
  readonly threadSkills: ReadonlyArray<ThreadMiniSkillSnapshot>;
  readonly requestSkills: ReadonlyArray<MiniSkill>;
  readonly wrappers: MiniSkillPromptWrappers;
  /** The current default wrapper setting, to detect "not a custom template". */
  readonly defaultAgentProfileWrapper: string;
  readonly agentProfile?: TurnAgentProfileComposition | null;
}): string {
  const profile = input.agentProfile ?? null;
  if (profile === null) {
    return composeTurnPromptWithMiniSkills(input);
  }

  const threadBlock = renderMiniSkillWrapper({
    wrapper: input.wrappers.thread,
    scope: "thread",
    skills: input.threadSkills,
  });
  const skillsMarkdown = renderMiniSkills(input.requestSkills);

  // A profile on the default wrapper with nothing to say must not inject an
  // empty preferences block. A custom template is user intent: always render.
  const isDefaultTemplate = profile.template === input.defaultAgentProfileWrapper;
  const profileBlock =
    isDefaultTemplate && profile.instructions.length === 0 && skillsMarkdown.length === 0
      ? null
      : renderAgentProfileTemplate(profile.template, {
          profileName: profile.name,
          instructions: profile.instructions,
          miniSkills: skillsMarkdown,
          userMessage: input.message,
        });

  const blocks = [threadBlock, profileBlock].filter((block) => block !== null);
  if (blocks.length === 0) {
    return input.message;
  }
  return blocks.join("\n\n");
}
