import { assert, describe, it } from "@effect/vitest";
import {
  AgentProfileId,
  DEFAULT_AGENT_PROFILE_WRAPPER,
  DEFAULT_MINI_SKILL_PROMPT_WRAPPERS,
  type MiniSkill,
  MiniSkillId,
} from "@t3tools/contracts";

import { composeMessagePrompt } from "./MessagePromptComposition.ts";

const skill = (id: string, name: string): MiniSkill => ({
  id: MiniSkillId.make(id),
  name,
  description: "",
  content: `${name} instructions`,
  enabledByDefaultForNewThreads: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});
const settings = {
  miniSkills: [skill("tests", "Write tests"), skill("terse", "Be terse")],
  miniSkillPromptWrappers: DEFAULT_MINI_SKILL_PROMPT_WRAPPERS,
  agentProfileDefaultWrapper: DEFAULT_AGENT_PROFILE_WRAPPER,
};
const threadSkill = {
  skillId: MiniSkillId.make("terse"),
  name: "Be terse",
  content: "Be terse instructions",
  appliedAt: "2026-01-01T00:00:00.000Z",
};

describe("composeMessagePrompt", () => {
  it("leaves a message without skills or profile untouched", () => {
    assert.isNull(
      composeMessagePrompt({ text: "Fix it", threadSkills: [], miniSkillIds: [], settings }),
    );
  });

  it("wraps the message and records what was applied", () => {
    const composed = composeMessagePrompt({
      text: "Fix it",
      threadSkills: [threadSkill],
      miniSkillIds: [MiniSkillId.make("tests"), MiniSkillId.make("missing")],
      settings,
    });
    assert.isNotNull(composed);
    assert.include(composed!.prompt, "Fix it");
    assert.include(composed!.prompt, "Write tests instructions");
    assert.include(composed!.prompt, "Be terse instructions");
    assert.deepEqual(composed!.promptContext.threadSkills, ["Be terse"]);
    assert.deepEqual(composed!.promptContext.requestSkills, ["Write tests"]);
    assert.equal(composed!.promptContext.prompt, composed!.prompt);
  });

  it("renders the agent profile and names it", () => {
    const composed = composeMessagePrompt({
      text: "Review this",
      threadSkills: [],
      miniSkillIds: [],
      agentProfile: {
        profileId: AgentProfileId.make("reviewer"),
        profileName: "Reviewer",
        instructions: "Look for bugs first.",
        promptTemplate: DEFAULT_AGENT_PROFILE_WRAPPER,
      },
      settings,
    });
    assert.equal(composed?.promptContext.profileName, "Reviewer");
    assert.include(composed!.prompt, "Look for bugs first.");
    assert.include(composed!.prompt, "Review this");
  });
});
