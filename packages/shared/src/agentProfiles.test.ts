import { describe, expect, it } from "vite-plus/test";

import {
  AgentProfileId,
  DEFAULT_AGENT_PROFILE_WRAPPER,
  MiniSkillId,
  ProviderInstanceId,
  type AgentProfile,
  type MiniSkill,
  type ModelSelection,
  type ThreadMiniSkillSnapshot,
} from "@t3tools/contracts";

import {
  composeTurnPromptWithAgentProfile,
  mergeProfileMiniSkillIds,
  renderAgentProfileTemplate,
  resolveAgentProfile,
} from "./agentProfiles.js";
import { DEFAULT_MINI_SKILL_PROMPT_WRAPPERS } from "@t3tools/contracts";

const CLAUDE = ProviderInstanceId.make("claudeAgent");
const CODEX = ProviderInstanceId.make("codex");
const OPENCODE = ProviderInstanceId.make("opencode");

const makeProfile = (overrides: Partial<AgentProfile> = {}): AgentProfile => ({
  id: AgentProfileId.make("profile-reviewer"),
  name: "Reviewer Pre-Commit",
  slug: "reviewer" as AgentProfile["slug"],
  description: "",
  enabled: true,
  miniSkillIds: [],
  instructions: "",
  routes: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const makeSelection = (
  instanceId: ProviderInstanceId,
  model: string,
  effort?: string,
): ModelSelection => ({
  instanceId,
  model,
  ...(effort !== undefined ? { options: [{ id: "reasoningEffort", value: effort }] } : {}),
});

const baseInput = {
  availableModelSlugs: ["sonnet", "haiku"],
  currentModelSelection: makeSelection(CLAUDE, "sonnet-current", "high"),
  currentReasoningEffort: "high",
  getSupportedReasoningEfforts: () => ["low", "medium", "high"],
  defaultWrapper: DEFAULT_AGENT_PROFILE_WRAPPER,
  knownMiniSkillIds: [] as ReadonlyArray<MiniSkillId>,
};

describe("resolveAgentProfile", () => {
  it("routes to the model candidate configured for the current provider instance", () => {
    const profile = makeProfile({
      routes: [
        { id: "r1", instanceId: CLAUDE, modelCandidates: ["sonnet"] },
        { id: "r2", instanceId: CODEX, modelCandidates: ["terra"] },
      ],
    });
    const resolved = resolveAgentProfile({ ...baseInput, profile, instanceId: CLAUDE });
    expect(resolved.status).toBe("resolved");
    if (resolved.status !== "resolved") return;
    expect(resolved.modelSelection.model).toBe("sonnet");
    expect(resolved.diagnostics.fallbackIndex).toBe(0);
  });

  it("re-resolves when the provider instance changes", () => {
    const profile = makeProfile({
      routes: [
        { id: "r1", instanceId: CLAUDE, modelCandidates: ["sonnet"] },
        { id: "r2", instanceId: CODEX, modelCandidates: ["terra"] },
      ],
    });
    const resolved = resolveAgentProfile({
      ...baseInput,
      profile,
      instanceId: CODEX,
      availableModelSlugs: ["terra", "luna"],
      currentModelSelection: makeSelection(CODEX, "luna"),
    });
    expect(resolved.status).toBe("resolved");
    if (resolved.status !== "resolved") return;
    expect(resolved.modelSelection.model).toBe("terra");
    expect(resolved.modelSelection.instanceId).toBe(CODEX);
  });

  it("picks the primary candidate when available", () => {
    const profile = makeProfile({
      routes: [{ id: "r1", instanceId: CLAUDE, modelCandidates: ["sonnet", "haiku"] }],
    });
    const resolved = resolveAgentProfile({ ...baseInput, profile, instanceId: CLAUDE });
    expect(resolved.status).toBe("resolved");
    if (resolved.status !== "resolved") return;
    expect(resolved.modelSelection.model).toBe("sonnet");
    expect(resolved.diagnostics.fallbackIndex).toBe(0);
  });

  it("falls back to the next candidate when the primary is unavailable", () => {
    const profile = makeProfile({
      routes: [{ id: "r1", instanceId: CLAUDE, modelCandidates: ["sonnet", "haiku"] }],
    });
    const resolved = resolveAgentProfile({
      ...baseInput,
      profile,
      instanceId: CLAUDE,
      availableModelSlugs: ["haiku"],
    });
    expect(resolved.status).toBe("resolved");
    if (resolved.status !== "resolved") return;
    expect(resolved.modelSelection.model).toBe("haiku");
    expect(resolved.diagnostics.fallbackIndex).toBe(1);
  });

  it("resolves unavailable when no candidate is available", () => {
    const profile = makeProfile({
      routes: [{ id: "r1", instanceId: CLAUDE, modelCandidates: ["sonnet", "haiku"] }],
    });
    const resolved = resolveAgentProfile({
      ...baseInput,
      profile,
      instanceId: CLAUDE,
      availableModelSlugs: ["opus-only"],
    });
    expect(resolved.status).toBe("unavailable");
    if (resolved.status !== "unavailable") return;
    expect(resolved.reason).toContain("sonnet");
  });

  it("inherits the current composer model when no route matches the instance", () => {
    const profile = makeProfile({
      routes: [{ id: "r1", instanceId: CODEX, modelCandidates: ["terra"] }],
    });
    const resolved = resolveAgentProfile({ ...baseInput, profile, instanceId: OPENCODE });
    expect(resolved.status).toBe("resolved");
    if (resolved.status !== "resolved") return;
    expect(resolved.modelSelection.model).toBe("sonnet-current");
    expect(resolved.diagnostics.routeInstanceId).toBeNull();
    expect(resolved.diagnostics.fallbackIndex).toBeNull();
  });

  it("inherits the current composer model when the route has no candidates", () => {
    const profile = makeProfile({
      routes: [{ id: "r1", instanceId: CLAUDE, modelCandidates: [], reasoningEffort: "low" }],
    });
    const resolved = resolveAgentProfile({ ...baseInput, profile, instanceId: CLAUDE });
    expect(resolved.status).toBe("resolved");
    if (resolved.status !== "resolved") return;
    expect(resolved.modelSelection.model).toBe("sonnet-current");
    expect(resolved.diagnostics.reasoningEffortSource).toBe("route");
    expect(resolved.modelSelection.options).toEqual([{ id: "reasoningEffort", value: "low" }]);
  });

  it("applies route reasoning effort over the base effort", () => {
    const profile = makeProfile({
      reasoningEffort: "medium",
      routes: [{ id: "r1", instanceId: CLAUDE, modelCandidates: [], reasoningEffort: "high" }],
    });
    const resolved = resolveAgentProfile({
      ...baseInput,
      profile,
      instanceId: CLAUDE,
      currentReasoningEffort: "low",
    });
    expect(resolved.status).toBe("resolved");
    if (resolved.status !== "resolved") return;
    expect(resolved.modelSelection.options).toEqual([{ id: "reasoningEffort", value: "high" }]);
    expect(resolved.diagnostics.reasoningEffortSource).toBe("route");
  });

  it("applies the base effort when the route inherits", () => {
    const profile = makeProfile({
      reasoningEffort: "medium",
      routes: [{ id: "r1", instanceId: CLAUDE, modelCandidates: ["sonnet"] }],
    });
    const resolved = resolveAgentProfile({
      ...baseInput,
      profile,
      instanceId: CLAUDE,
      currentReasoningEffort: "low",
    });
    expect(resolved.status).toBe("resolved");
    if (resolved.status !== "resolved") return;
    expect(resolved.modelSelection.options).toEqual([{ id: "reasoningEffort", value: "medium" }]);
    expect(resolved.diagnostics.reasoningEffortSource).toBe("base");
  });

  it("inherits the current effort when the profile does not define one", () => {
    const profile = makeProfile();
    const resolved = resolveAgentProfile({ ...baseInput, profile, instanceId: CLAUDE });
    expect(resolved.status).toBe("resolved");
    if (resolved.status !== "resolved") return;
    expect(resolved.modelSelection.options).toEqual([{ id: "reasoningEffort", value: "high" }]);
    expect(resolved.diagnostics.reasoningEffortSource).toBe("current");
  });

  it("drops a requested effort the resolved model does not support", () => {
    const profile = makeProfile({ reasoningEffort: "xhigh" });
    const resolved = resolveAgentProfile({
      ...baseInput,
      profile,
      instanceId: CLAUDE,
      getSupportedReasoningEfforts: () => ["low", "medium"],
    });
    expect(resolved.status).toBe("resolved");
    if (resolved.status !== "resolved") return;
    expect(resolved.modelSelection.options ?? []).toEqual([]);
    expect(resolved.diagnostics.reasoningEffortSkippedAsUnsupported).toBe(true);
  });

  it("accepts the requested effort when capabilities are unknown", () => {
    const profile = makeProfile({ reasoningEffort: "medium" });
    const resolved = resolveAgentProfile({
      ...baseInput,
      profile,
      instanceId: CLAUDE,
      getSupportedReasoningEfforts: () => null,
    });
    expect(resolved.status).toBe("resolved");
    if (resolved.status !== "resolved") return;
    expect(resolved.modelSelection.options).toEqual([{ id: "reasoningEffort", value: "medium" }]);
  });

  it("keeps unrelated current options when the model stays, drops them on a model switch", () => {
    const currentModelSelection: ModelSelection = {
      instanceId: CLAUDE,
      model: "sonnet-current",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ],
    };
    const stays = resolveAgentProfile({
      ...baseInput,
      profile: makeProfile({ reasoningEffort: "low" }),
      instanceId: CLAUDE,
      currentModelSelection,
    });
    expect(stays.status).toBe("resolved");
    if (stays.status !== "resolved") return;
    expect(stays.modelSelection.options).toEqual([
      { id: "fastMode", value: true },
      { id: "reasoningEffort", value: "low" },
    ]);

    const switches = resolveAgentProfile({
      ...baseInput,
      profile: makeProfile({
        reasoningEffort: "low",
        routes: [{ id: "r1", instanceId: CLAUDE, modelCandidates: ["haiku"] }],
      }),
      instanceId: CLAUDE,
      currentModelSelection,
    });
    expect(switches.status).toBe("resolved");
    if (switches.status !== "resolved") return;
    expect(switches.modelSelection.options).toEqual([{ id: "reasoningEffort", value: "low" }]);
  });

  it("skips mini skills unknown to the library with a diagnostic", () => {
    const known = MiniSkillId.make("skill-known");
    const unknown = MiniSkillId.make("skill-deleted");
    const profile = makeProfile({ miniSkillIds: [known, unknown] });
    const resolved = resolveAgentProfile({
      ...baseInput,
      profile,
      instanceId: CLAUDE,
      knownMiniSkillIds: [known],
    });
    expect(resolved.status).toBe("resolved");
    if (resolved.status !== "resolved") return;
    expect(resolved.miniSkillIds).toEqual([known]);
    expect(resolved.diagnostics.unknownMiniSkillIds).toEqual([unknown]);
  });

  it("falls back to the default wrapper for a template without {{user_message}}", () => {
    const profile = makeProfile({ promptTemplate: "broken template without the slot" });
    const resolved = resolveAgentProfile({ ...baseInput, profile, instanceId: CLAUDE });
    expect(resolved.status).toBe("resolved");
    if (resolved.status !== "resolved") return;
    expect(resolved.promptTemplate).toBe(DEFAULT_AGENT_PROFILE_WRAPPER);
  });
});

describe("mergeProfileMiniSkillIds", () => {
  it("merges profile and manual selections, deduped, profile first", () => {
    const b = MiniSkillId.make("skill-b");
    const c = MiniSkillId.make("skill-c");
    const d = MiniSkillId.make("skill-d");
    expect(mergeProfileMiniSkillIds([b, c], [c, d])).toEqual([b, c, d]);
  });
});

describe("renderAgentProfileTemplate", () => {
  it("substitutes all four placeholders", () => {
    const rendered = renderAgentProfileTemplate(
      "<profile_request>\n\n{{profile_instructions}}\n\n{{mini_skills}}\n\n<user_request>\n\n{{user_message}}\n\n</user_request>\n\n</profile_request>",
      {
        profileName: "Reviewer Pre-Commit",
        instructions: "Act as a reviewer.",
        miniSkills: "### Commit Changes\n\nCommit when done.",
        userMessage: "Review this diff.",
      },
    );
    expect(rendered).toContain("Act as a reviewer.");
    expect(rendered).toContain("### Commit Changes");
    expect(rendered).toContain("Review this diff.");
    expect(rendered).not.toContain("{{user_message}}");
  });

  it("never drops the user message: invalid templates fall back to the default", () => {
    const rendered = renderAgentProfileTemplate("no slot here", {
      profileName: "P",
      instructions: "Do things.",
      miniSkills: "",
      userMessage: "The actual ask.",
    });
    expect(rendered).toContain("The actual ask.");
    expect(rendered).toContain('<user_profile_preferences profile="P">');
  });
});

describe("composeTurnPromptWithAgentProfile", () => {
  const makeSkill = (id: string, name: string, content: string): MiniSkill => ({
    id: MiniSkillId.make(id),
    name,
    description: "",
    content,
    enabledByDefaultForNewThreads: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  const makeSnapshot = (
    skillId: string,
    name: string,
    content: string,
  ): ThreadMiniSkillSnapshot => ({
    skillId: MiniSkillId.make(skillId),
    name,
    content,
    appliedAt: "2026-01-01T00:00:00.000Z",
  });

  const baseCompose = {
    wrappers: DEFAULT_MINI_SKILL_PROMPT_WRAPPERS,
    defaultAgentProfileWrapper: DEFAULT_AGENT_PROFILE_WRAPPER,
  };

  it("matches the mini skills composer byte-for-byte when no profile is active", () => {
    const message = "Implement pagination.";
    const threadSkills = [makeSnapshot("skill-a", "Skill A", "Thread rule.")];
    const requestSkills = [makeSkill("skill-b", "Skill B", "Request rule.")];
    const withProfile = composeTurnPromptWithAgentProfile({
      ...baseCompose,
      message,
      threadSkills,
      requestSkills,
    });
    expect(withProfile).toContain('<user_preferences scope="thread">');
    expect(withProfile).toContain('<user_preferences scope="request">');
    expect(withProfile.endsWith(message)).toBe(true);
  });

  it("renders instructions and skills through the profile template without a double wrapper", () => {
    const prompt = composeTurnPromptWithAgentProfile({
      ...baseCompose,
      message: "Review this diff.",
      threadSkills: [],
      requestSkills: [makeSkill("skill-commit", "Commit Changes", "Commit when done.")],
      agentProfile: {
        name: "Reviewer Pre-Commit",
        instructions: "Act as a pre-commit reviewer.",
        template: DEFAULT_AGENT_PROFILE_WRAPPER,
      },
    });
    expect(prompt).toContain('<user_profile_preferences profile="Reviewer Pre-Commit">');
    expect(prompt).toContain("Act as a pre-commit reviewer.");
    expect(prompt).toContain("### Commit Changes\n\nCommit when done.");
    expect(prompt).not.toContain('<user_preferences scope="request">');
    expect(prompt.endsWith("Review this diff.")).toBe(true);
  });

  it("keeps the thread block ahead of the profile block", () => {
    const prompt = composeTurnPromptWithAgentProfile({
      ...baseCompose,
      message: "Go.",
      threadSkills: [makeSnapshot("skill-a", "Skill A", "Thread rule.")],
      requestSkills: [],
      agentProfile: {
        name: "Deep Implementation",
        instructions: "Be thorough.",
        template: DEFAULT_AGENT_PROFILE_WRAPPER,
      },
    });
    const threadIndex = prompt.indexOf('<user_preferences scope="thread">');
    const profileIndex = prompt.indexOf('<user_profile_preferences profile="Deep Implementation">');
    expect(threadIndex).toBeGreaterThanOrEqual(0);
    expect(profileIndex).toBeGreaterThan(threadIndex);
    expect(prompt.endsWith("Go.")).toBe(true);
  });

  it("does not emit an empty preferences block for a routing-only profile", () => {
    const prompt = composeTurnPromptWithAgentProfile({
      ...baseCompose,
      message: "Just do it.",
      threadSkills: [],
      requestSkills: [],
      agentProfile: {
        name: "Fast Implementation",
        instructions: "",
        template: DEFAULT_AGENT_PROFILE_WRAPPER,
      },
    });
    expect(prompt).toBe("Just do it.");
  });

  it("always renders a custom template, even with empty instructions and skills", () => {
    const prompt = composeTurnPromptWithAgentProfile({
      ...baseCompose,
      message: "Ship it.",
      threadSkills: [],
      requestSkills: [],
      agentProfile: {
        name: "Wrapper Fan",
        instructions: "",
        template: "<task>\n{{user_message}}\n</task>",
      },
    });
    expect(prompt).toBe("<task>\nShip it.\n</task>");
  });
});
