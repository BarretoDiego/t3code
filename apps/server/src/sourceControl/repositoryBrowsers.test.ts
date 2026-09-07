import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import { makeGitHubRepositoryBrowser } from "./GitHubRepositoryBrowser.ts";
import { bitbucketPagePath, makeBitbucketRepositoryBrowser } from "./BitbucketRepositoryBrowser.ts";
import type { GitHubCli } from "./GitHubCli.ts";
import type { BitbucketApi } from "./BitbucketApi.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const sha = "a".repeat(40);
const head = "b".repeat(40);
const githubRef = { provider: "github" as const, host: "github.com", repository: "owner/repo" };
const bitbucketRef = {
  provider: "bitbucket" as const,
  host: "bitbucket.org",
  repository: "team/repo",
};
// Browser ports deliberately require only their transport, leaving CLI discovery out of API tests.
const gh = (response: string, truncated = false) =>
  ({
    execute: () =>
      Effect.succeed({
        stdout: response,
        stderr: "",
        exitCode: 0,
        stdoutTruncated: truncated,
        stderrTruncated: false,
      }),
  }) as unknown as GitHubCli["Service"];
const bb = (response: string, paths: string[]) =>
  ({
    request: (input: { url: string }) => {
      paths.push(input.url);
      return Effect.succeed({ body: response, truncated: false });
    },
  }) as unknown as BitbucketApi["Service"];

describe("source control repository adapters", () => {
  it.effect("normalizes GitHub repositories and preserves pagination", () =>
    Effect.gen(function* () {
      const repository = {
        full_name: "owner/repo",
        html_url: "https://github.com/owner/repo",
        ssh_url: "git@github.com:owner/repo.git",
        default_branch: "main",
        description: null,
        private: true,
      };
      const browser = makeGitHubRepositoryBrowser(
        gh(encodeJson(Array.from({ length: 50 }, () => repository))),
        "/tmp",
      );
      const page = yield* browser.listRepositories({ provider: "github" });
      expect(page.nextCursor).toBe("2");
      expect(page.items[0]).toMatchObject({
        nameWithOwner: "owner/repo",
        host: "github.com",
        defaultBranch: "main",
        description: "",
        private: true,
      });
    }),
  );
  it.effect("normalizes branches, revisions and rejects truncated JSON", () =>
    Effect.gen(function* () {
      const refs = yield* makeGitHubRepositoryBrowser(
        gh('[{"name":"main","commit":{"sha":"abc"}}]'),
        "/tmp",
      ).listRefs({ ...githubRef, kind: "branch" });
      expect(refs.items[0]).toMatchObject({ name: "main", sha: "abc", kind: "branch" });
      const invalid = makeGitHubRepositoryBrowser(gh("[]", true), "/tmp");
      expect(
        yield* invalid.listRepositories({ provider: "github" }).pipe(Effect.flip),
      ).toBeDefined();
    }),
  );
  it.effect("refuses incremental GitHub comparisons across rewritten history", () =>
    Effect.gen(function* () {
      const browser = makeGitHubRepositoryBrowser(
        gh(encodeJson({ merge_base_commit: { sha: "c".repeat(40) } })),
        "/tmp",
      );
      const error = yield* browser
        .compare({ ...githubRef, mode: "incremental", baseSha: sha, headSha: head })
        .pipe(Effect.flip);
      expect(error.message).toContain("rewritten");
    }),
  );
  it("rejects pagination URLs outside the original Bitbucket endpoint", () => {
    expect(
      bitbucketPagePath(
        "/repositories/team",
        "https://api.bitbucket.org/2.0/repositories/team?page=2",
      ),
    ).toBe("/repositories/team?page=2");
    expect(() =>
      bitbucketPagePath("/repositories/team", "https://other.test/2.0/repositories/team?page=2"),
    ).toThrow();
    expect(() =>
      bitbucketPagePath("/repositories/team", "https://api.bitbucket.org/2.0/user?page=2"),
    ).toThrow();
  });
  it.effect("uses distinct Bitbucket full and incremental diff semantics", () =>
    Effect.gen(function* () {
      const paths: string[] = [];
      const browser = makeBitbucketRepositoryBrowser(bb("patch", paths), Effect.succeed("team"));
      yield* browser.compare({ ...bitbucketRef, baseSha: sha, headSha: head, mode: "full" });
      yield* browser.compare({ ...bitbucketRef, baseSha: sha, headSha: head, mode: "incremental" });
      expect(paths).toEqual([
        `/repositories/team/repo/diff/${head}..${sha}?topic=true`,
        `/repositories/team/repo/diff/${head}..${sha}?topic=false`,
      ]);
    }),
  );
  it.effect("normalizes Bitbucket tags and next-page tokens", () =>
    Effect.gen(function* () {
      const paths: string[] = [];
      const next = "https://api.bitbucket.org/2.0/repositories/team/repo/refs/tags?page=2";
      const browser = makeBitbucketRepositoryBrowser(
        bb(
          encodeJson({
            values: [
              { name: "v1", target: { hash: sha, date: "2026-09-01", author: { raw: "Dev" } } },
            ],
            next,
          }),
          paths,
        ),
        Effect.succeed("team"),
      );
      const page = yield* browser.listRefs({ ...bitbucketRef, kind: "tag" });
      expect(page.nextCursor).toBe(next);
      expect(page.items[0]).toEqual({
        name: "v1",
        sha,
        kind: "tag",
        author: "Dev",
        createdAt: "2026-09-01",
      });
    }),
  );
});

it.effect("lists workspace integration repositories without a user role filter", () =>
  Effect.gen(function* () {
    const paths: string[] = [];
    yield* makeBitbucketRepositoryBrowser(
      bb('{"values":[]}', paths),
      Effect.succeed("team"),
    ).listRepositories({ provider: "bitbucket" });
    expect(paths[0]).not.toContain("role=");
    expect(paths[0]).toContain("/repositories/team");
  }),
);
it.effect("discovers a repository-scoped integration without requiring workspace enumeration", () =>
  Effect.gen(function* () {
    const paths: string[] = [];
    const repository = {
      full_name: "team/repo",
      name: "repo",
      description: "",
      links: { html: { href: "https://bitbucket.org/team/repo" }, clone: [] },
      is_private: true,
    };
    const page = yield* makeBitbucketRepositoryBrowser(
      bb(encodeJson(repository), paths),
      Effect.succeed("team"),
      Effect.succeed("repo"),
    ).listRepositories({ provider: "bitbucket" });
    expect(paths).toEqual(["/repositories/team/repo"]);
    expect(page.items[0]?.nameWithOwner).toBe("team/repo");
    expect(page.nextCursor).toBeNull();
  }),
);
