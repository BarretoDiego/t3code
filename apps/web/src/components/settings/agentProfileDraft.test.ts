import { describe, expect, it } from "vite-plus/test";
import {
  AgentProfileId,
  AgentProfileSlug,
  MiniSkillId,
  type AgentProfile,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  duplicateAgentProfileDraft,
  profileDraftFromProfile,
  validateAgentProfileDraft,
} from "./AgentProfileEditorDialog";

const profile: AgentProfile = {
  id: AgentProfileId.make("reviewer"),
  name: "Reviewer",
  slug: "reviewer",
  description: "Review changes",
  enabled: true,
  instructions: "Review the diff.",
  miniSkillIds: [],
  routes: [],
  createdAt: "2026-09-06T00:00:00.000Z",
  updatedAt: "2026-09-06T00:00:00.000Z",
};
const isSlug = Schema.is(AgentProfileSlug);

describe("profile editor drafts", () => {
  it("duplicates into a saveable unique shortcut without changing the source", () => {
    const first = duplicateAgentProfileDraft(profile, [profile]);
    expect(first.slug).toBe("reviewer-copy");
    const existingCopy = { ...profile, id: AgentProfileId.make("copy"), slug: first.slug };
    const second = duplicateAgentProfileDraft(profile, [profile, existingCopy]);
    expect(second.slug).toBe("reviewer-copy-2");
    expect(validateAgentProfileDraft(second, [profile, existingCopy], null, [], [])).toEqual([]);
    second.miniSkillIds.push(MiniSkillId.make("added"));
    expect(profile.miniSkillIds).toEqual([]);
  });
  it("keeps duplicated shortcuts within the persisted schema limit, including collision suffixes", () => {
    const long = { ...profile, name: "Reviewer ".repeat(20) };
    const first = duplicateAgentProfileDraft(long, []);
    const second = duplicateAgentProfileDraft(long, [{ ...profile, slug: first.slug }]);
    expect(isSlug(first.slug)).toBe(true);
    expect(isSlug(second.slug)).toBe(true);
    expect(second.slug).not.toBe(first.slug);
  });
  it("rejects shortcuts the server cannot persist", () => {
    const draft = { ...profileDraftFromProfile(profile), slug: "a".repeat(49) };
    expect(validateAgentProfileDraft(draft, [profile], profile.id, [], [])).not.toEqual([]);
  });
  it("allows a profile to be repaired by removing unavailable skill references", () => {
    const draft = profileDraftFromProfile({
      ...profile,
      miniSkillIds: [MiniSkillId.make("deleted")],
    });
    expect(validateAgentProfileDraft(draft, [profile], profile.id, [], [])).not.toEqual([]);
    draft.miniSkillIds = [];
    expect(validateAgentProfileDraft(draft, [profile], profile.id, [], [])).toEqual([]);
  });
});
