import { describe, expect, it } from "@effect/vitest";
import { parseWorktreeInventory } from "./worktreeInventory.ts";

describe("worktree inventory", () => {
  it("preserves paths and distinguishes branch heads, detached heads and bare repositories", () => {
    const rows = parseWorktreeInventory(
      "worktree /repo main\0HEAD abc123\0branch refs/heads/main\0\0worktree /review\nwith-newline\0HEAD def456\0detached\0locked review in progress\0\0worktree /bare\0bare\0prunable missing\0\0",
    );
    expect(rows).toEqual([
      {
        path: "/repo main",
        headSha: "abc123",
        branch: "main",
        bare: false,
        locked: false,
        prunable: false,
      },
      {
        path: "/review\nwith-newline",
        headSha: "def456",
        branch: null,
        bare: false,
        locked: true,
        prunable: false,
      },
      { path: "/bare", headSha: null, branch: null, bare: true, locked: false, prunable: true },
    ]);
  });
  it("handles empty output and preserves branch slashes", () => {
    expect(parseWorktreeInventory("")).toEqual([]);
    expect(
      parseWorktreeInventory("worktree /repo\0branch refs/heads/feature/review\0")[0]?.branch,
    ).toBe("feature/review");
  });
});
