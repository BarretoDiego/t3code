import { expect, it } from "@effect/vitest";
import { repositoryRefFromRemote } from "./SourceControlHubService.ts";

it("maps SSH and HTTPS GitHub and Bitbucket remotes to the same normalized repository", () => {
  for (const host of ["github.com", "bitbucket.org"] as const) {
    const expected = {
      provider: host === "github.com" ? "github" : "bitbucket",
      host,
      repository: "team/repo",
    };
    for (const url of [
      `git@${host}:team/repo.git`,
      `https://${host}/team/repo.git`,
      `ssh://git@${host}/team/repo.git`,
    ])
      expect(repositoryRefFromRemote(url)).toEqual(expected);
  }
});
it("ignores unknown hosts and preserves separate fork and upstream mappings", () => {
  expect(repositoryRefFromRemote("git@internal.test:team/repo.git")).toBeNull();
  expect(
    ["git@github.com:fork/repo.git", "git@github.com:upstream/repo.git"]
      .map(repositoryRefFromRemote)
      .map((ref) => ref?.repository),
  ).toEqual(["fork/repo", "upstream/repo"]);
});
