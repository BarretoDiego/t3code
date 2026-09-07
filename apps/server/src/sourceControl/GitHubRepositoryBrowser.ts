import { encodeRepositoryFilePath } from "./SourceControlRepositoryBrowser.ts";
import { SourceControlHubError, type RemoteRepositoryRef } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { GitHubCli } from "./GitHubCli.ts";
import type { SourceControlRepositoryBrowser } from "./SourceControlRepositoryBrowser.ts";

const Repository = Schema.Struct({
  full_name: Schema.String,
  html_url: Schema.String,
  ssh_url: Schema.String,
  default_branch: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
  private: Schema.Boolean,
});
const GitRef = Schema.Struct({
  name: Schema.String,
  commit: Schema.Struct({ sha: Schema.String }),
});
const PullRequest = Schema.Struct({
  number: Schema.Number,
  html_url: Schema.String,
  base: Schema.Struct({ sha: Schema.String }),
  head: Schema.Struct({
    sha: Schema.String,
    repo: Schema.NullOr(Schema.Struct({ full_name: Schema.String })),
  }),
});
const failure = () =>
  new SourceControlHubError({
    message: "GitHub request failed. Check account access and refresh.",
  });
const repositoryPath = (ref: RemoteRepositoryRef) =>
  `/repos/${ref.repository.split("/").map(encodeURIComponent).join("/")}`;
export const pageNumber = (cursor?: string) =>
  cursor && /^[1-9]\d{0,6}$/.test(cursor) ? Number(cursor) : 1;

export function makeGitHubRepositoryBrowser(
  github: Pick<GitHubCli["Service"], "execute">,
  cwd: string,
): SourceControlRepositoryBrowser {
  const rawRequest = (path: string, body?: unknown, patch = false) =>
    github
      .execute({
        cwd,
        args: [
          "api",
          "--hostname",
          "github.com",
          "--method",
          body === undefined ? "GET" : "POST",
          "--header",
          `Accept: ${patch ? "application/vnd.github.diff" : "application/vnd.github+json"}`,
          path,
          ...(body === undefined ? [] : ["--input", "-"]),
        ],
        ...(body === undefined ? {} : { stdin: JSON.stringify(body) }),
        maxOutputBytes: 4_000_000,
      })
      .pipe(Effect.mapError(failure));
  const request = (path: string, body?: unknown, patch = false) =>
    rawRequest(path, body, patch).pipe(
      Effect.flatMap((result) =>
        result.stdoutTruncated
          ? Effect.fail(
              new SourceControlHubError({ message: "GitHub response exceeded the size limit." }),
            )
          : Effect.succeed(result.stdout),
      ),
    );
  const json = <S extends Schema.Top>(path: string, schema: S, body?: unknown) =>
    request(path, body).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(schema))),
      Effect.mapError(failure),
    );
  const supported = (ref: RemoteRepositoryRef) =>
    ref.host === "github.com" && ref.provider === "github"
      ? Effect.void
      : Effect.fail(
          new SourceControlHubError({ message: "This account supports github.com repositories." }),
        );
  return {
    listRepositories: (input) =>
      Effect.gen(function* () {
        const page = pageNumber(input.cursor);
        const rows = yield* json(
          `/user/repos?per_page=50&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`,
          Schema.Array(Repository),
        );
        return {
          items: rows
            .filter(
              (row) =>
                !input.query || row.full_name.toLowerCase().includes(input.query.toLowerCase()),
            )
            .map((row) => ({
              provider: "github" as const,
              nameWithOwner: row.full_name,
              url: row.html_url,
              sshUrl: row.ssh_url,
              host: "github.com",
              defaultBranch: row.default_branch,
              description: row.description ?? "",
              private: row.private,
            })),
          nextCursor: rows.length === 50 ? String(page + 1) : null,
        };
      }),
    listRefs: (input) =>
      Effect.gen(function* () {
        yield* supported(input);
        const page = pageNumber(input.cursor);
        const rows = yield* json(
          `${repositoryPath(input)}/${input.kind === "branch" ? "branches" : "tags"}?per_page=50&page=${page}`,
          Schema.Array(GitRef),
        );
        return {
          items: rows.map((row) => ({
            name: row.name,
            sha: row.commit.sha,
            kind: input.kind,
            author: null,
            createdAt: null,
          })),
          nextCursor: rows.length === 50 ? String(page + 1) : null,
        };
      }),
    revisions: (input) =>
      Effect.gen(function* () {
        yield* supported(input);
        const pr = yield* json(`${repositoryPath(input)}/pulls/${input.number}`, PullRequest);
        return {
          baseSha: pr.base.sha,
          headSha: pr.head.sha,
          headRepository: pr.head.repo?.full_name ?? input.repository,
        };
      }),
    compare: (input) =>
      Effect.gen(function* () {
        yield* supported(input);
        // GitHub compares through the merge base. An incremental comparison is only
        // exact when the previous head is an ancestor; reject rebases explicitly.
        if (input.mode === "incremental") {
          const comparison = yield* json(
            `${repositoryPath(input)}/compare/${encodeURIComponent(input.baseSha)}...${encodeURIComponent(input.headSha)}`,
            Schema.Struct({ merge_base_commit: Schema.Struct({ sha: Schema.String }) }),
          );
          if (comparison.merge_base_commit.sha !== input.baseSha)
            return yield* new SourceControlHubError({
              message:
                "The PR history was rewritten. Run a full review to establish a new baseline.",
            });
        }
        const result = yield* rawRequest(
          `${repositoryPath(input)}/compare/${encodeURIComponent(input.baseSha)}...${encodeURIComponent(input.headSha)}`,
          undefined,
          true,
        );
        return { patch: result.stdout, truncated: result.stdoutTruncated };
      }),
    readFile: (input) =>
      Effect.gen(function* () {
        yield* supported(input);
        const path = yield* Effect.try({
          try: () => encodeRepositoryFilePath(input.path),
          catch: failure,
        });
        const file = yield* json(
          `${repositoryPath(input)}/contents/${path}?ref=${encodeURIComponent(input.sha)}`,
          Schema.Struct({
            type: Schema.String,
            encoding: Schema.String,
            content: Schema.String,
            size: Schema.Number,
          }),
        );
        if (file.type !== "file" || file.encoding !== "base64")
          return yield* new SourceControlHubError({
            message: "File content is unavailable or too large.",
          });
        const bytes = Buffer.from(file.content, "base64");
        if (bytes.includes(0))
          return yield* new SourceControlHubError({
            message: "Binary file content is omitted from review context.",
          });
        return {
          content: bytes.subarray(0, 64_000).toString("utf8"),
          truncated: file.size > 64_000,
        };
      }),
    createPullRequest: (input) =>
      Effect.gen(function* () {
        yield* supported(input);
        const pr = yield* json(`${repositoryPath(input)}/pulls`, PullRequest, {
          title: input.title,
          body: input.body,
          head: input.source,
          base: input.target,
          draft: input.draft,
        });
        const warnings: string[] = [];
        // A failed reviewer request must not turn successful creation into a retry.
        if (input.reviewers.length)
          yield* request(`${repositoryPath(input)}/pulls/${pr.number}/requested_reviewers`, {
            reviewers: input.reviewers,
          }).pipe(
            Effect.catch(() =>
              Effect.sync(() => {
                warnings.push(
                  "The pull request was created, but reviewers could not be assigned. Check their repository access.",
                );
              }),
            ),
          );
        return { number: pr.number, url: pr.html_url, warnings };
      }),
  };
}
