import type * as Effect from "effect/Effect";
import type {
  RemoteRepositoryListInput,
  RemoteRepositoryPage,
  RemoteRepositoryRef,
  RemoteGitRefListInput,
  RemoteGitRefPage,
  RemotePullRequestCreateInput,
  RemotePullRequestCreated,
  PullRequestRevisions,
  SourceControlHubError,
} from "@t3tools/contracts";

/** Optional catalog capability on the existing provider; none of these operations needs Git. */
export interface SourceControlRepositoryBrowser {
  readonly listRepositories: (
    input: RemoteRepositoryListInput,
  ) => Effect.Effect<RemoteRepositoryPage, SourceControlHubError>;
  readonly listRefs: (
    input: RemoteGitRefListInput,
  ) => Effect.Effect<RemoteGitRefPage, SourceControlHubError>;
  readonly revisions: (
    input: RemoteRepositoryRef & { readonly number: number },
  ) => Effect.Effect<PullRequestRevisions, SourceControlHubError>;
  readonly compare: (
    input: RemoteRepositoryRef & {
      readonly baseSha: string;
      readonly headSha: string;
      readonly mode: "full" | "incremental";
    },
  ) => Effect.Effect<
    { readonly patch: string; readonly truncated: boolean },
    SourceControlHubError
  >;
  readonly readFile?: (
    input: RemoteRepositoryRef & { readonly sha: string; readonly path: string },
  ) => Effect.Effect<
    { readonly content: string; readonly truncated: boolean },
    SourceControlHubError
  >;
  readonly createPullRequest: (
    input: RemotePullRequestCreateInput,
  ) => Effect.Effect<RemotePullRequestCreated, SourceControlHubError>;
}

/** Git tree paths cannot contain parent traversal components. Encode each remaining segment. */
export function encodeRepositoryFilePath(path: string): string {
  if (
    !path ||
    path.startsWith("/") ||
    path.split("/").some((segment) => !segment || segment === "." || segment === "..")
  )
    throw new Error("Invalid repository file path");
  return path.split("/").map(encodeURIComponent).join("/");
}
