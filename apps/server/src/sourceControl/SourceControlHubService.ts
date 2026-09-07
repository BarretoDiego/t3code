import { SourceControlAccounts } from "./SourceControlAccounts.ts";
import {
  SourceControlHubError,
  RemoteRepositoryListInput,
  RemoteGitRefListInput,
  type SourceControlProviderKind,
  type SourceControlCloneState,
  type SourceControlLocalClone,
  type ProjectId,
  type SourceControlRepositoryMappingInput,
} from "@t3tools/contracts";
import {
  normalizeGitRemoteUrl,
  detectSourceControlProviderFromGitRemoteUrl,
} from "@t3tools/shared/git";
import * as Cache from "effect/Cache";
import * as Exit from "effect/Exit";
import * as Duration from "effect/Duration";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { VcsDriverRegistry } from "../vcs/VcsDriverRegistry.ts";
import { parseWorktreeInventory } from "../git/worktreeInventory.ts";
import { SourceControlProviderRegistry } from "./SourceControlProviderRegistry.ts";
import type { SourceControlRepositoryBrowser } from "./SourceControlRepositoryBrowser.ts";

const decodeRepositoryList = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RemoteRepositoryListInput),
);
const decodeRefList = Schema.decodeUnknownEffect(Schema.fromJsonString(RemoteGitRefListInput));
const failure = () =>
  new SourceControlHubError({
    message: "Could not read source control data. Check the environment and repository access.",
  });
export function repositoryRefFromRemote(url: string) {
  const provider = detectSourceControlProviderFromGitRemoteUrl(url)?.kind;
  if (provider !== "github" && provider !== "bitbucket") return null;
  const [host, ...path] = normalizeGitRemoteUrl(url).split("/");
  if (!host || path.length !== 2) return null;
  return { provider, host, repository: path.join("/") };
}
export class SourceControlHubService extends Context.Service<
  SourceControlHubService,
  {
    readonly browser: (
      provider: SourceControlProviderKind,
    ) => Effect.Effect<SourceControlRepositoryBrowser, SourceControlHubError>;
    readonly repositories: SourceControlRepositoryBrowser["listRepositories"];
    readonly refs: SourceControlRepositoryBrowser["listRefs"];
    readonly clones: Effect.Effect<readonly SourceControlLocalClone[], SourceControlHubError>;
    readonly cloneState: (
      projectId: ProjectId,
    ) => Effect.Effect<SourceControlCloneState, SourceControlHubError>;
    readonly mapRepository: (
      input: SourceControlRepositoryMappingInput,
    ) => Effect.Effect<void, SourceControlHubError>;
    readonly refresh: Effect.Effect<void>;
  }
>()("t3/sourceControl/SourceControlHubService") {}

export const make = Effect.gen(function* () {
  const registry = yield* SourceControlProviderRegistry;
  const accounts = yield* SourceControlAccounts;
  const projections = yield* ProjectionSnapshotQuery;
  const git = yield* GitVcsDriver;
  const vcs = yield* VcsDriverRegistry;
  const browser = Effect.fn(function* (provider: SourceControlProviderKind) {
    const selected = yield* registry.get(provider).pipe(Effect.mapError(failure));
    if (!selected.repositories)
      return yield* new SourceControlHubError({
        message: "Repository browsing is not supported by this provider.",
      });
    return selected.repositories;
  });
  const repositories = yield* Cache.makeWith(
    (key: string) =>
      Effect.gen(function* () {
        const input = yield* decodeRepositoryList(key).pipe(Effect.mapError(failure));
        return yield* (yield* browser(input.provider)).listRepositories(input);
      }),
    {
      capacity: 256,
      timeToLive: Exit.match({
        onSuccess: () => Duration.seconds(30),
        onFailure: () => Duration.zero,
      }),
    },
  );
  const refs = yield* Cache.makeWith(
    (key: string) =>
      Effect.gen(function* () {
        const input = yield* decodeRefList(key).pipe(Effect.mapError(failure));
        return yield* (yield* browser(input.provider)).listRefs(input);
      }),
    {
      capacity: 256,
      timeToLive: Exit.match({
        onSuccess: () => Duration.seconds(30),
        onFailure: () => Duration.zero,
      }),
    },
  );
  const clones = Effect.gen(function* () {
    const mappings = yield* accounts.mappings;
    const snapshot = yield* projections.getShellSnapshot();
    return (yield* Effect.forEach(
      snapshot.projects,
      (project) =>
        Effect.gen(function* () {
          const handle = yield* vcs.resolve({ cwd: project.workspaceRoot });
          const remotes = yield* handle.driver.listRemotes(project.workspaceRoot);
          return remotes.remotes.flatMap((remote) => {
            const manual = mappings.find(
              (mapping) => mapping.projectId === project.id && mapping.remoteName === remote.name,
            );
            const identity = manual?.reference ?? repositoryRefFromRemote(remote.url);
            return identity
              ? [
                  {
                    ...identity,
                    manuallyMapped: manual !== undefined,
                    projectId: project.id,
                    title: project.title,
                    cwd: project.workspaceRoot,
                    remoteName: remote.name,
                  },
                ]
              : [];
          });
        }).pipe(Effect.orElseSucceed(() => [])),
      { concurrency: 4 },
    )).flat();
  }).pipe(Effect.mapError(failure));
  const cloneState = Effect.fn(function* (projectId: ProjectId) {
    const project = (yield* projections.getShellSnapshot()).projects.find(
      (project) => project.id === projectId,
    );
    if (!project)
      return yield* new SourceControlHubError({ message: "Local project no longer exists." });
    const cwd = project.workspaceRoot;
    const [status, inventory] = yield* Effect.all([
      git.statusDetailsLocal(cwd),
      git.execute({
        cwd,
        operation: "SourceControlHub.worktrees",
        args: ["worktree", "list", "--porcelain", "-z"],
      }),
    ]);
    const head = yield* git.execute({
      cwd,
      operation: "SourceControlHub.head",
      args: ["rev-parse", "--verify", "HEAD"],
      allowNonZeroExit: true,
    });
    return {
      projectId,
      cwd,
      branch: status.branch,
      headSha: head.exitCode === 0 ? head.stdout.trim() : null,
      upstream: status.upstreamRef,
      ahead: status.aheadCount,
      behind: status.behindCount,
      worktrees: parseWorktreeInventory(inventory.stdout),
    };
  }, Effect.mapError(failure));
  return SourceControlHubService.of({
    browser,
    repositories: (input) => Cache.get(repositories, JSON.stringify(input)),
    refs: (input) => Cache.get(refs, JSON.stringify(input)),
    clones,
    cloneState,
    mapRepository: Effect.fn(function* (input) {
      const project = (yield* projections.getShellSnapshot()).projects.find(
        (project) => project.id === input.projectId,
      );
      if (!project)
        return yield* new SourceControlHubError({ message: "Local project no longer exists." });
      const handle = yield* vcs.resolve({ cwd: project.workspaceRoot });
      const remotes = yield* handle.driver.listRemotes(project.workspaceRoot);
      if (!remotes.remotes.some((remote) => remote.name === input.remoteName))
        return yield* new SourceControlHubError({
          message: "Choose a remote that exists in this local clone.",
        });
      if (
        input.reference &&
        !(
          (input.reference.provider === "github" && input.reference.host === "github.com") ||
          (input.reference.provider === "bitbucket" && input.reference.host === "bitbucket.org")
        )
      )
        return yield* new SourceControlHubError({
          message: "Choose a supported source control account.",
        });
      yield* accounts.saveMapping(input);
    }, Effect.mapError(failure)),
    refresh: Effect.all([Cache.invalidateAll(repositories), Cache.invalidateAll(refs)], {
      discard: true,
    }),
  });
});
export const layer = Layer.effect(SourceControlHubService, make);
