import { Link } from "@tanstack/react-router";
import { useDebouncedValue } from "../../state/queries";
import { RepositoryMappingDialog } from "./RepositoryMappingDialog";
import { LocalCloneActions } from "./LocalCloneActions";
import { useState } from "react";
import type {
  EnvironmentId,
  ProjectId,
  RemoteRepository,
  RemoteRepositoryRef,
  SourceControlProviderKind,
  RemotePullRequestRef,
} from "@t3tools/contracts";
import { GitBranchIcon, GitForkIcon, RefreshCwIcon } from "lucide-react";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { GitHubIcon, BitbucketIcon } from "../Icons";
import { useHubQuery } from "./useHubQuery";
import { HubSelect } from "./HubSelect";
import { RemotePullRequestPanel } from "./RemotePullRequestPanel";
import { CreatePullRequestDialog } from "./CreatePullRequestDialog";

function RepositoryTree({
  environmentId,
  provider,
  search,
  onSelect,
}: {
  environmentId: EnvironmentId;
  provider: SourceControlProviderKind;
  search: string;
  onSelect: (repository: RemoteRepository) => void;
}) {
  const [cursor, setCursor] = useState<string | undefined>();
  const query = useHubQuery(serverEnvironment.sourceControlHubRepositories, {
    environmentId,
    input: { provider, query: search, ...(cursor ? { cursor } : {}) },
  });
  return (
    <div className="space-y-1 py-2 pl-3">
      {query.error && (
        <p role="alert" className="p-2 text-xs text-destructive">
          {query.error}
        </p>
      )}
      {query.pending && <p className="p-2 text-xs text-muted-foreground">Loading repositories…</p>}
      {query.data?.items.map((repository) => (
        <Button
          key={repository.nameWithOwner}
          variant="ghost"
          size="sm"
          className="h-auto w-full justify-start py-2 text-left"
          onClick={() => onSelect(repository)}
        >
          <span className="break-all">{repository.nameWithOwner}</span>
        </Button>
      ))}
      {query.data?.items.length === 0 && (
        <p className="p-2 text-xs text-muted-foreground">No repositories on this page.</p>
      )}
      <div className="flex gap-2">
        {cursor && (
          <Button size="xs" variant="ghost" onClick={() => setCursor(undefined)}>
            First page
          </Button>
        )}
        {query.data?.nextCursor && (
          <Button
            size="xs"
            variant="outline"
            onClick={() => setCursor(query.data?.nextCursor ?? undefined)}
          >
            Next repositories
          </Button>
        )}
      </div>
    </div>
  );
}
function CloneDetails({
  environmentId,
  projectId,
  remoteName,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  remoteName: string;
}) {
  const query = useHubQuery(serverEnvironment.sourceControlHubCloneState, {
    environmentId,
    input: { projectId },
  });
  const state = query.data;
  return (
    <div className="space-y-2 py-2 text-xs">
      {query.error && <p role="alert">{query.error}</p>}
      {state && (
        <>
          <p className="break-all">
            {state.branch ?? "Detached HEAD"} · {state.headSha?.slice(0, 10) ?? "No commits"} · ↑
            {state.ahead} ↓{state.behind}
          </p>
          <p className="break-all text-muted-foreground">Upstream: {state.upstream ?? "None"}</p>
          <Button
            size="xs"
            variant="ghost"
            render={
              <Link
                to="/environments/$environmentId/projects/$projectId"
                params={{ environmentId, projectId }}
              />
            }
          >
            Open workspace
          </Button>
          <LocalCloneActions
            environmentId={environmentId}
            cwd={state.cwd}
            remoteName={remoteName}
            onChanged={query.refresh}
          />
          {state.worktrees.map((worktree) => (
            <div key={worktree.path} className="rounded-md border p-3">
              <p className="flex items-center gap-2">
                <GitForkIcon className="size-3" />
                {worktree.branch ?? (worktree.bare ? "Bare repository" : "Detached HEAD")} ·{" "}
                {worktree.headSha?.slice(0, 10)}
              </p>
              <p className="mt-1 break-all text-muted-foreground">{worktree.path}</p>
              {worktree.locked && <p>Locked</p>}
              {worktree.prunable && <p>Unavailable checkout</p>}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
function EnvironmentClones({
  environmentId,
  label,
  reference,
}: {
  environmentId: EnvironmentId;
  label: string;
  reference: RemoteRepositoryRef;
}) {
  const mapRepository = useAtomCommand(serverEnvironment.sourceControlHubMapRepository);
  const [mappingError, setMappingError] = useState(false);
  const [expanded, setExpanded] = useState<string[]>([]);
  const query = useHubQuery(serverEnvironment.sourceControlHubClones, { environmentId, input: {} });
  const clones =
    query.data?.filter(
      (clone) =>
        clone.provider === reference.provider &&
        clone.host === reference.host &&
        clone.repository.toLowerCase() === reference.repository.toLowerCase(),
    ) ?? [];
  return (
    <>
      <RepositoryMappingDialog
        environmentId={environmentId}
        label={label}
        reference={reference}
        onChanged={query.refresh}
      />
      {mappingError && (
        <p role="alert" className="text-xs text-destructive">
          Could not restore automatic repository mapping.
        </p>
      )}
      {clones.map((clone) => (
        <details
          key={`${clone.projectId}:${clone.remoteName}`}
          className="rounded-lg border p-3"
          onToggle={(event) => {
            const key = `${clone.projectId}:${clone.remoteName}`;
            const open = event.currentTarget.open;
            setExpanded((current) =>
              open ? [...new Set([...current, key])] : current.filter((item) => item !== key),
            );
          }}
        >
          <summary className="cursor-pointer text-sm">
            {label} · {clone.title} · {clone.remoteName}
            <span className="mt-1 block break-all text-xs text-muted-foreground">{clone.cwd}</span>
          </summary>
          {clone.manuallyMapped && (
            <Button
              size="xs"
              variant="ghost"
              onClick={async () => {
                const result = await mapRepository({
                  environmentId,
                  input: {
                    projectId: clone.projectId,
                    remoteName: clone.remoteName,
                    reference: null,
                  },
                });
                setMappingError(result._tag !== "Success");
                if (result._tag === "Success") query.refresh();
              }}
            >
              Restore automatic association
            </Button>
          )}
          {expanded.includes(`${clone.projectId}:${clone.remoteName}`) && (
            <CloneDetails
              environmentId={environmentId}
              projectId={clone.projectId}
              remoteName={clone.remoteName}
            />
          )}
        </details>
      ))}
      {!query.pending && !query.error && clones.length === 0 && (
        <p className="text-xs text-muted-foreground">{label}: no associated local clone</p>
      )}
      {query.error && (
        <p className="text-xs text-muted-foreground">{label}: clone information unavailable</p>
      )}
    </>
  );
}
function RepositoryPage({
  environmentId,
  repository,
  onPullRequest,
}: {
  environmentId: EnvironmentId;
  repository: RemoteRepository;
  onPullRequest: (reference: RemotePullRequestRef) => void;
}) {
  const [tab, setTab] = useState<"pull-requests" | "branch" | "tag" | "worktrees">("pull-requests");
  const [create, setCreate] = useState(false);
  const reference = {
    provider: repository.provider,
    host: repository.host,
    repository: repository.nameWithOwner,
  };
  const { environments } = useEnvironments();
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="space-y-3 border-b p-4 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="break-all text-lg font-semibold">{repository.nameWithOwner}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{repository.description}</p>
          </div>
          <Button size="sm" onClick={() => setCreate(true)}>
            New pull request
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Default branch: {repository.defaultBranch ?? "Unknown"} ·{" "}
          {repository.private ? "Private" : "Public"}
        </p>
        <div className="flex flex-wrap gap-1">
          {(
            [
              ["pull-requests", "Pull requests"],
              ["branch", "Branches"],
              ["tag", "Tags"],
              ["worktrees", "Clones & worktrees"],
            ] as const
          ).map(([value, label]) => (
            <Button
              key={value}
              size="sm"
              variant={tab === value ? "secondary" : "ghost"}
              onClick={() => setTab(value)}
            >
              {label}
            </Button>
          ))}
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-4 sm:p-6">
        {tab === "pull-requests" ? (
          <RepositoryPullRequests
            key={repository.nameWithOwner}
            environmentId={environmentId}
            reference={reference}
            onSelect={onPullRequest}
          />
        ) : tab === "worktrees" ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Clones belong to their environments. Branch and HEAD information is local; opening
              this view does not fetch or change branches.
            </p>
            {environments.map((environment) => (
              <EnvironmentClones
                key={environment.environmentId}
                environmentId={environment.environmentId}
                label={environment.label}
                reference={reference}
              />
            ))}
          </div>
        ) : (
          <RepositoryRefs
            key={tab}
            environmentId={environmentId}
            reference={reference}
            kind={tab}
          />
        )}
      </div>
      {create && (
        <CreatePullRequestDialog
          environmentId={environmentId}
          reference={reference}
          defaultBranch={repository.defaultBranch ?? "main"}
          onClose={() => setCreate(false)}
          onCreated={(number) => {
            setCreate(false);
            onPullRequest({ ...reference, number });
          }}
        />
      )}
    </section>
  );
}
function RepositoryRefs({
  environmentId,
  reference,
  kind,
}: {
  environmentId: EnvironmentId;
  reference: RemoteRepositoryRef;
  kind: "branch" | "tag";
}) {
  const [cursor, setCursor] = useState<string | undefined>();
  const query = useHubQuery(serverEnvironment.sourceControlHubRefs, {
    environmentId,
    input: { ...reference, kind, ...(cursor ? { cursor } : {}) },
  });
  return (
    <div className="space-y-2">
      {query.error && <p role="alert">{query.error}</p>}
      {query.pending && <p>Loading…</p>}
      {query.data?.items.map((ref) => (
        <div
          key={ref.name}
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
        >
          <div className="min-w-0">
            <p className="break-all text-sm">{ref.name}</p>
            <p className="text-xs text-muted-foreground">
              {ref.sha.slice(0, 10)} {ref.author} {ref.createdAt}
            </p>
          </div>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => void navigator.clipboard.writeText(ref.name)}
          >
            Copy name
          </Button>
        </div>
      ))}
      {query.data?.nextCursor && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => setCursor(query.data?.nextCursor ?? undefined)}
        >
          Next page
        </Button>
      )}
    </div>
  );
}
function RepositoryPullRequests({
  environmentId,
  reference,
  onSelect,
}: {
  environmentId: EnvironmentId;
  reference: RemoteRepositoryRef;
  onSelect: (reference: RemotePullRequestRef) => void;
}) {
  const [state, setState] = useState<"open" | "closed" | "merged" | "all">("open");
  const [involvement, setInvolvement] = useState<"all" | "authored" | "reviewing">("all");
  const [queryText, setQueryText] = useState("");
  const sentQuery = useDebouncedValue(queryText, 300);
  const [cursor, setCursor] = useState<string | undefined>();
  const query = useHubQuery(serverEnvironment.sourceControlHubPullRequests, {
    environmentId,
    input: { ...reference, state, involvement, query: sentQuery, ...(cursor ? { cursor } : {}) },
  });
  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-3">
        <Input
          aria-label="Search pull requests"
          placeholder="Search pull requests"
          value={queryText}
          onChange={(event) => {
            setQueryText(event.target.value);
            setCursor(undefined);
          }}
        />
        <HubSelect
          label="State"
          value={state}
          options={[
            { value: "open", label: "Open" },
            { value: "merged", label: "Merged" },
            { value: "closed", label: "Closed" },
            { value: "all", label: "All states" },
          ]}
          onChange={(value) => {
            setState(value);
            setCursor(undefined);
          }}
        />
        <HubSelect
          label="Involvement"
          value={involvement}
          options={[
            { value: "all", label: "Everyone" },
            { value: "authored", label: "My PRs" },
            { value: "reviewing", label: "Review requested" },
          ]}
          onChange={(value) => {
            setInvolvement(value);
            setCursor(undefined);
          }}
        />
      </div>
      {query.error && (
        <p role="alert" className="text-sm text-destructive">
          {query.error}
        </p>
      )}
      {query.pending && <p className="text-sm text-muted-foreground">Loading pull requests…</p>}
      {query.data?.items.map((pr) => (
        <button
          key={pr.number}
          type="button"
          className="block w-full rounded-lg border p-4 text-left hover:bg-accent focus-visible:outline-ring"
          onClick={() => onSelect({ ...reference, number: pr.number })}
        >
          <p className="break-words font-medium">
            #{pr.number} {pr.title}
          </p>
          <p className="mt-2 break-all text-xs text-muted-foreground">
            {pr.headBranch} → {pr.baseBranch} · {pr.isDraft ? "Draft" : pr.state}
          </p>
          <p className="mt-1 text-xs">
            +{pr.additions} −{pr.deletions}
          </p>
        </button>
      ))}
      {query.data?.nextCursor && (
        <Button variant="outline" onClick={() => setCursor(query.data?.nextCursor ?? undefined)}>
          Next pull requests
        </Button>
      )}
    </div>
  );
}
export function SourceControlHub({
  onOpenReviewPanel,
}: {
  onOpenReviewPanel?: (environmentId: EnvironmentId, reference: RemotePullRequestRef) => void;
} = {}) {
  const { environments } = useEnvironments();
  const [selection, setSelection] = useState<{
    environmentId: EnvironmentId;
    repository: RemoteRepository;
  } | null>(null);
  const [pr, setPr] = useState<RemotePullRequestRef | null>(null);
  const [search, setSearch] = useState("");
  const sentSearch = useDebouncedValue(search, 300);
  const [open, setOpen] = useState<string | null>(null);
  const refresh = useAtomCommand(serverEnvironment.sourceControlHubRefresh);
  const [revision, setRevision] = useState(0);
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-background md:flex-row">
      <aside className="max-h-[35vh] w-full shrink-0 overflow-auto border-b p-3 md:max-h-none md:w-64 md:border-r md:border-b-0">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h1 className="flex items-center gap-2 text-sm font-semibold">
            <GitBranchIcon className="size-4" />
            Source Control
          </h1>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Refresh source control"
            onClick={async () => {
              await Promise.all(
                environments.map((environment) =>
                  refresh({ environmentId: environment.environmentId, input: {} }),
                ),
              );
              setRevision((value) => value + 1);
            }}
          >
            <RefreshCwIcon className="size-4" />
          </Button>
        </div>
        <Input
          aria-label="Search repositories"
          placeholder="Search repositories"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <nav className="mt-3 space-y-3" aria-label="Source control repositories">
          {environments.map((environment) => (
            <div key={environment.environmentId}>
              <p className="px-2 py-1 text-xs font-medium text-muted-foreground">
                {environment.label} ·{" "}
                {environment.connection.phase === "connected" ? "Online" : "Offline"}
              </p>
              {(["github", "bitbucket"] as const).map((provider) => {
                const key = `${environment.environmentId}:${provider}`;
                const Icon = provider === "github" ? GitHubIcon : BitbucketIcon;
                return (
                  <div key={key}>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="w-full justify-start"
                      aria-expanded={open === key}
                      onClick={() => setOpen(open === key ? null : key)}
                    >
                      <Icon className="size-4" />
                      {provider === "github" ? "GitHub" : "Bitbucket"}
                    </Button>
                    {open === key && (
                      <RepositoryTree
                        key={`${key}:${sentSearch}:${revision}`}
                        environmentId={environment.environmentId}
                        provider={provider}
                        search={sentSearch}
                        onSelect={(repository) => {
                          setSelection({ environmentId: environment.environmentId, repository });
                          setPr(null);
                        }}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </nav>
      </aside>
      {selection ? (
        pr ? (
          <RemotePullRequestPanel
            key={`${selection.environmentId}:${pr.provider}:${pr.repository}:${pr.number}`}
            refreshKey={revision}
            environmentId={selection.environmentId}
            reference={pr}
            onClose={() => setPr(null)}
            {...(onOpenReviewPanel
              ? { onOpenReviewPanel: () => onOpenReviewPanel(selection.environmentId, pr) }
              : {})}
          />
        ) : (
          <RepositoryPage
            key={`${selection.environmentId}:${selection.repository.nameWithOwner}:${revision}`}
            {...selection}
            onPullRequest={setPr}
          />
        )
      ) : (
        <div className="grid min-h-40 flex-1 place-items-center p-6 text-center text-sm text-muted-foreground">
          Select an account and repository to browse pull requests, branches, tags, and local
          worktrees.
        </div>
      )}
    </div>
  );
}
