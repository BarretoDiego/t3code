import { describe, expect, it } from "vite-plus/test";

import { AgentProfileId, type AgentProfile } from "@t3tools/contracts";

import { searchAgentProfiles } from "./agentProfileSearch";

const makeProfile = (
  id: string,
  name: string,
  slug: string,
  description = "",
  enabled = true,
): AgentProfile => ({
  id: AgentProfileId.make(id),
  name,
  slug: slug as AgentProfile["slug"],
  description,
  enabled,
  miniSkillIds: [],
  instructions: "",
  routes: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const PROFILES = [
  makeProfile("p1", "Reviewer Pre-Commit", "reviewer", "Review changes before committing."),
  makeProfile("p2", "Deep Implementation", "deep"),
  makeProfile("p3", "Fast Implementation", "fast", "", false),
];

describe("searchAgentProfiles", () => {
  it("lists enabled profiles when the query is empty and hides disabled ones", () => {
    const results = searchAgentProfiles(PROFILES, "");
    expect(results.map((profile) => profile.slug)).toEqual(["reviewer", "deep"]);
  });

  it("matches by slug, name, and description", () => {
    expect(searchAgentProfiles(PROFILES, "rev").map((profile) => profile.slug)).toEqual([
      "reviewer",
    ]);
    expect(searchAgentProfiles(PROFILES, "implementation").map((profile) => profile.slug)).toEqual([
      "deep",
    ]);
    expect(searchAgentProfiles(PROFILES, "before committing")).toHaveLength(1);
  });

  it("returns nothing for a non-matching query", () => {
    expect(searchAgentProfiles(PROFILES, "zzz")).toEqual([]);
  });
});
