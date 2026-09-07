import { encodeRepositoryFilePath } from "./SourceControlRepositoryBrowser.ts";
import { SourceControlHubError, type RemoteRepositoryRef } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { BitbucketApi } from "./BitbucketApi.ts";
import type { SourceControlRepositoryBrowser } from "./SourceControlRepositoryBrowser.ts";

const Link = Schema.Struct({ href: Schema.String });
const Repository = Schema.Struct({
  full_name: Schema.String,
  description: Schema.String,
  is_private: Schema.Boolean,
  mainbranch: Schema.optional(Schema.NullOr(Schema.Struct({ name: Schema.String }))),
  links: Schema.Struct({
    html: Link,
    clone: Schema.Array(Schema.Struct({ name: Schema.String, href: Schema.String })),
  }),
});
const GitRef = Schema.Struct({
  name: Schema.String,
  target: Schema.Struct({
    hash: Schema.String,
    date: Schema.optional(Schema.String),
    author: Schema.optional(Schema.Struct({ raw: Schema.String })),
  }),
});
const Revision = Schema.Struct({
  commit: Schema.Struct({ hash: Schema.String }),
  repository: Schema.Struct({ full_name: Schema.String }),
});
const PullRequest = Schema.Struct({
  id: Schema.Number,
  links: Schema.Struct({ html: Link }),
  source: Revision,
  destination: Revision,
});
const pageSchema = <S extends Schema.Top>(item: S) =>
  Schema.Struct({ values: Schema.Array(item), next: Schema.optional(Schema.String) });
const failure = () =>
  new SourceControlHubError({
    message: "Bitbucket request failed. Check account access and refresh.",
  });
const repositoryPath = (ref: RemoteRepositoryRef) =>
  `/repositories/${ref.repository.split("/").map(encodeURIComponent).join("/")}`;

/** Cursors retain only the query on the expected endpoint; never follow arbitrary response URLs. */
export function bitbucketPagePath(path: string, cursor?: string): string {
  if (!cursor) return `${path}${path.includes("?") ? "&" : "?"}pagelen=50`;
  const url = new URL(cursor, "https://api.bitbucket.org/2.0/");
  const expected = new URL(`/2.0${path}`, "https://api.bitbucket.org");
  if (
    url.origin !== expected.origin ||
    url.pathname !== expected.pathname ||
    url.username ||
    url.password
  )
    throw new Error("Invalid pagination cursor");
  return `${path.split("?")[0]}${url.search}`;
}

export function makeBitbucketRepositoryBrowser(
  bitbucket: Pick<BitbucketApi["Service"], "request">,
  workspace: Effect.Effect<string, SourceControlHubError>,
): SourceControlRepositoryBrowser {
  const request = (path: string, body?: unknown) =>
    bitbucket
      .request({
        method: body === undefined ? "GET" : "POST",
        url: path,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        maxBytes: 4_000_000,
      })
      .pipe(Effect.mapError(failure));
  const json = <S extends Schema.Top>(path: string, schema: S, body?: unknown) =>
    request(path, body).pipe(
      Effect.flatMap((result) =>
        result.truncated
          ? Effect.fail(failure())
          : Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(result.body).pipe(
              Effect.mapError(failure),
            ),
      ),
      Effect.mapError(failure),
    );
  const pagePath = (path: string, cursor?: string) =>
    Effect.try({
      try: () => bitbucketPagePath(path, cursor),
      catch: () =>
        new SourceControlHubError({
          message: "Invalid Bitbucket pagination cursor. Refresh this list.",
        }),
    });
  const supported = (ref: RemoteRepositoryRef) =>
    ref.host === "bitbucket.org" && ref.provider === "bitbucket"
      ? Effect.void
      : Effect.fail(
          new SourceControlHubError({
            message: "This account supports bitbucket.org repositories.",
          }),
        );
  return {
    listRepositories: (input) =>
      Effect.gen(function* () {
        const selectedWorkspace = yield* workspace;
        const path = selectedWorkspace
          ? `/repositories/${encodeURIComponent(selectedWorkspace)}?role=member`
          : "/repositories?role=member";
        const page = yield* json(yield* pagePath(path, input.cursor), pageSchema(Repository));
        return {
          items: page.values
            .filter(
              (row) =>
                !input.query || row.full_name.toLowerCase().includes(input.query.toLowerCase()),
            )
            .map((row) => ({
              provider: "bitbucket" as const,
              nameWithOwner: row.full_name,
              url: row.links.html.href,
              sshUrl: row.links.clone.find((link) => link.name === "ssh")?.href ?? "",
              host: "bitbucket.org",
              defaultBranch: row.mainbranch?.name ?? null,
              description: row.description,
              private: row.is_private,
            })),
          nextCursor: page.next ?? null,
        };
      }),
    listRefs: (input) =>
      Effect.gen(function* () {
        yield* supported(input);
        const page = yield* json(
          yield* pagePath(
            `${repositoryPath(input)}/refs/${input.kind === "branch" ? "branches" : "tags"}`,
            input.cursor,
          ),
          pageSchema(GitRef),
        );
        return {
          items: page.values.map((row) => ({
            name: row.name,
            sha: row.target.hash,
            kind: input.kind,
            author: row.target.author?.raw ?? null,
            createdAt: row.target.date ?? null,
          })),
          nextCursor: page.next ?? null,
        };
      }),
    revisions: (input) =>
      Effect.gen(function* () {
        yield* supported(input);
        const pr = yield* json(
          `${repositoryPath(input)}/pullrequests/${input.number}`,
          PullRequest,
        );
        return {
          baseSha: pr.destination.commit.hash,
          headSha: pr.source.commit.hash,
          headRepository: pr.source.repository.full_name,
        };
      }),
    compare: (input) =>
      Effect.gen(function* () {
        yield* supported(input);
        // Bitbucket's spec is HEAD..BASE, opposite to git diff BASE HEAD.
        const result = yield* request(
          `${repositoryPath(input)}/diff/${encodeURIComponent(input.headSha)}..${encodeURIComponent(input.baseSha)}?topic=${input.mode === "full"}`,
        );
        return { patch: result.body, truncated: result.truncated };
      }),
    readFile: (input) =>
      Effect.gen(function* () {
        yield* supported(input);
        const path = yield* Effect.try({
          try: () => encodeRepositoryFilePath(input.path),
          catch: failure,
        });
        const result = yield* bitbucket
          .request({
            method: "GET",
            url: `${repositoryPath(input)}/src/${encodeURIComponent(input.sha)}/${path}`,
            maxBytes: 64_000,
          })
          .pipe(Effect.mapError(failure));
        if (result.body.includes("\0"))
          return yield* new SourceControlHubError({
            message: "Binary file content is omitted from review context.",
          });
        return { content: result.body, truncated: result.truncated };
      }),
    createPullRequest: (input) =>
      Effect.gen(function* () {
        yield* supported(input);
        const pr = yield* json(`${repositoryPath(input)}/pullrequests`, PullRequest, {
          title: input.title,
          description: input.body,
          source: { branch: { name: input.source } },
          destination: { branch: { name: input.target } },
          draft: input.draft,
          reviewers: input.reviewers.map((uuid) => ({ uuid })),
        });
        return { number: pr.id, url: pr.links.html.href, warnings: [] };
      }),
  };
}
