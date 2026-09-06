import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_MINI_SKILL_PROMPT_WRAPPERS,
  DEFAULT_REQUEST_MINI_SKILL_WRAPPER,
  DEFAULT_THREAD_MINI_SKILL_WRAPPER,
  MiniSkillId,
  type MiniSkill,
  type ThreadMiniSkillSnapshot,
} from "@t3tools/contracts";

import {
  composeTurnPromptWithMiniSkills,
  hasMiniSkillsPlaceholder,
  renderMiniSkills,
  renderMiniSkillWrapper,
} from "./miniSkills.js";

const makeSkill = (id: string, name: string, content: string): MiniSkill => ({
  id: MiniSkillId.make(id),
  name,
  description: "",
  content,
  enabledByDefaultForNewThreads: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const makeSnapshot = (skillId: string, name: string, content: string): ThreadMiniSkillSnapshot => ({
  skillId: MiniSkillId.make(skillId),
  name,
  content,
  appliedAt: "2026-01-01T00:00:00.000Z",
});

describe("renderMiniSkills", () => {
  it("renders each skill as a markdown section in order", () => {
    expect(
      renderMiniSkills([
        { name: "Commit Changes", content: "Review the diff." },
        { name: "Create Pull Request", content: "Push the branch." },
      ]),
    ).toBe("### Commit Changes\n\nReview the diff.\n\n### Create Pull Request\n\nPush the branch.");
  });

  it("trims surrounding whitespace from content", () => {
    expect(renderMiniSkills([{ name: "A", content: "\n  content  \n" }])).toBe("### A\n\ncontent");
  });
});

describe("hasMiniSkillsPlaceholder", () => {
  it("accepts the default wrappers and rejects wrapper text without the token", () => {
    expect(hasMiniSkillsPlaceholder(DEFAULT_THREAD_MINI_SKILL_WRAPPER)).toBe(true);
    expect(hasMiniSkillsPlaceholder(DEFAULT_REQUEST_MINI_SKILL_WRAPPER)).toBe(true);
    expect(hasMiniSkillsPlaceholder("no token here")).toBe(false);
  });
});

describe("renderMiniSkillWrapper", () => {
  it("returns null when there are no skills so no empty wrapper is emitted", () => {
    expect(
      renderMiniSkillWrapper({
        wrapper: DEFAULT_THREAD_MINI_SKILL_WRAPPER,
        scope: "thread",
        skills: [],
      }),
    ).toBeNull();
  });

  it("inserts the rendered skills at the placeholder", () => {
    const rendered = renderMiniSkillWrapper({
      wrapper: "before {{skills}} after",
      scope: "request",
      skills: [{ name: "A", content: "do A" }],
    });
    expect(rendered).toBe("before ### A\n\ndo A after");
  });

  it("falls back to the scope default when the wrapper lost its placeholder", () => {
    const rendered = renderMiniSkillWrapper({
      wrapper: "custom wrapper without token",
      scope: "thread",
      skills: [{ name: "A", content: "do A" }],
    });
    expect(rendered).toContain('<user_preferences scope="thread">');
    expect(rendered).toContain("### A\n\ndo A");
  });
});

describe("composeTurnPromptWithMiniSkills", () => {
  it("returns the message untouched when no skills apply", () => {
    expect(
      composeTurnPromptWithMiniSkills({
        message: "Implement pagination.",
        threadSkills: [],
        requestSkills: [],
        wrappers: DEFAULT_MINI_SKILL_PROMPT_WRAPPERS,
      }),
    ).toBe("Implement pagination.");
  });

  it("orders thread block, request block, then the user message", () => {
    const prompt = composeTurnPromptWithMiniSkills({
      message: "Implement pagination.",
      threadSkills: [makeSnapshot("skill-workspace", "Create Isolated Workspace", "Isolate work.")],
      requestSkills: [makeSkill("skill-commit", "Commit Changes", "Commit when done.")],
      wrappers: DEFAULT_MINI_SKILL_PROMPT_WRAPPERS,
    });

    const threadBlockIndex = prompt.indexOf('<user_preferences scope="thread">');
    const requestBlockIndex = prompt.indexOf('<user_preferences scope="request">');
    const messageIndex = prompt.indexOf("Implement pagination.");
    expect(threadBlockIndex).toBeGreaterThanOrEqual(0);
    expect(requestBlockIndex).toBeGreaterThan(threadBlockIndex);
    expect(messageIndex).toBeGreaterThan(requestBlockIndex);
    expect(prompt).toContain("### Create Isolated Workspace\n\nIsolate work.");
    expect(prompt).toContain("### Commit Changes\n\nCommit when done.");
  });

  it("renders multiple request skills inside one wrapper", () => {
    const prompt = composeTurnPromptWithMiniSkills({
      message: "Ship it.",
      threadSkills: [],
      requestSkills: [
        makeSkill("skill-commit", "Commit Changes", "Commit when done."),
        makeSkill("skill-pr", "Create Pull Request", "Open the PR."),
      ],
      wrappers: DEFAULT_MINI_SKILL_PROMPT_WRAPPERS,
    });

    expect(prompt.match(/<user_preferences scope="request">/g)).toHaveLength(1);
    expect(prompt).toContain(
      "### Commit Changes\n\nCommit when done.\n\n### Create Pull Request\n\nOpen the PR.",
    );
  });

  it("lets an explicitly selected request skill win over its thread snapshot", () => {
    const prompt = composeTurnPromptWithMiniSkills({
      message: "Continue.",
      threadSkills: [makeSnapshot("skill-commit", "Commit Changes", "Old snapshot content.")],
      requestSkills: [makeSkill("skill-commit", "Commit Changes", "Fresh library content.")],
      wrappers: DEFAULT_MINI_SKILL_PROMPT_WRAPPERS,
    });

    expect(prompt).not.toContain("Old snapshot content.");
    expect(prompt).toContain("Fresh library content.");
    expect(prompt.match(/### Commit Changes/g)).toHaveLength(1);
  });

  it("deduplicates repeated request selections by id", () => {
    const skill = makeSkill("skill-commit", "Commit Changes", "Commit when done.");
    const prompt = composeTurnPromptWithMiniSkills({
      message: "Go.",
      threadSkills: [],
      requestSkills: [skill, skill],
      wrappers: DEFAULT_MINI_SKILL_PROMPT_WRAPPERS,
    });

    expect(prompt.match(/### Commit Changes/g)).toHaveLength(1);
  });

  it("honors custom wrappers for both scopes", () => {
    const prompt = composeTurnPromptWithMiniSkills({
      message: "Do the thing.",
      threadSkills: [makeSnapshot("skill-a", "Skill A", "Thread rule.")],
      requestSkills: [makeSkill("skill-b", "Skill B", "Request rule.")],
      wrappers: {
        thread: "THREAD[{{skills}}]",
        request: "REQUEST[{{skills}}]",
      },
    });

    expect(prompt).toContain("THREAD[### Skill A\n\nThread rule.]");
    expect(prompt).toContain("REQUEST[### Skill B\n\nRequest rule.]");
  });
});
