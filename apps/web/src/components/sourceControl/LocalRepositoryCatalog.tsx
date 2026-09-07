import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { Link } from "@tanstack/react-router";
import { DownloadIcon, FolderGit2Icon, FolderPlusIcon, ChevronRightIcon } from "lucide-react";
import { useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { openCommandPalette } from "../../commandPaletteBus";
import { useEnvironments } from "../../state/environments";
import { useProjects } from "../../state/entities";
import type { Project } from "../../types";
import { Button } from "../ui/button";
import { HubSelect } from "./HubSelect";
import { filterLocalProjects } from "./localRepositoryCatalog.logic";

export function RepositoryImportActions({
  environmentId,
  repositoryUrl,
}: {
  environmentId?: EnvironmentId;
  repositoryUrl?: string;
}) {
  const { environments } = useEnvironments();
  const [chosen, setChosen] = useState("");
  const target = environmentId
    ? environments.find((environment) => environment.environmentId === environmentId)
    : (environments.find((environment) => environment.environmentId === chosen) ??
      environments.find((environment) => environment.connection.phase === "connected") ??
      environments[0]);
  const available = target?.connection.phase === "connected";
  const open = (projectSource: "url" | "local") => {
    if (!target || !available) return;
    openCommandPalette({
      open: "add-project",
      environmentId: target.environmentId,
      projectSource,
      ...(repositoryUrl ? { repositoryUrl } : {}),
    });
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      {!environmentId && environments.length > 1 && (
        <HubSelect
          label="Destination environment"
          value={target?.environmentId ?? ""}
          options={environments.map((environment) => ({
            value: environment.environmentId,
            label: `${environment.label}${environment.connection.phase === "connected" ? "" : " · Offline"}`,
          }))}
          onChange={setChosen}
        />
      )}
      {!repositoryUrl && (
        <Button size="sm" variant="outline" disabled={!available} onClick={() => open("local")}>
          <FolderPlusIcon className="size-3.5" />
          Add existing
        </Button>
      )}
      <Button size="sm" disabled={!available} onClick={() => open("url")}>
        <DownloadIcon className="size-3.5" />
        Clone repository
      </Button>
    </div>
  );
}

export function LocalRepositoryCatalog({
  search,
  onSelect,
}: {
  search: string;
  onSelect: (project: Project) => void;
}) {
  const projects = useProjects();
  const { environments } = useEnvironments();
  const filtered = filterLocalProjects(projects, search);
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="shrink-0 space-y-3 border-b p-4">
        <div>
          <h2 className="text-base font-semibold">On your devices</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Repositories and folders associated with T3 projects. Browse a checkout to inspect its
            branch and worktrees.
          </p>
        </div>
        <RepositoryImportActions />
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {projects.length === 0 ? (
          <div className="mx-auto grid max-w-md gap-3 py-12 text-center">
            <FolderGit2Icon className="mx-auto size-8 text-muted-foreground" />
            <h3 className="font-medium">Bring a repository into T3 Code</h3>
            <p className="text-sm text-muted-foreground">
              Add a folder already on your device, or clone a Git URL and open it as a project. Your
              Git credentials are used in the destination environment.
            </p>
          </div>
        ) : filtered.length === 0 ? (
          <p role="status" className="py-8 text-center text-sm text-muted-foreground">
            No local projects match this search.
          </p>
        ) : (
          environments.map((environment) => {
            const local = filtered.filter(
              (project) => project.environmentId === environment.environmentId,
            );
            if (!local.length) return null;
            const connected = environment.connection.phase === "connected";
            return (
              <section
                key={environment.environmentId}
                className="mb-6"
                aria-label={`${environment.label} projects`}
              >
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h3 className="text-xs font-semibold">
                    {environment.label}{" "}
                    <span className="ml-1 text-muted-foreground">{local.length}</span>
                  </h3>
                  <span className="text-xs text-muted-foreground">
                    {connected ? "Online" : "Offline"}
                  </span>
                </div>
                <div className="divide-y overflow-hidden rounded-lg border">
                  {local.map((project) => (
                    <div
                      key={`${project.environmentId}:${project.id}`}
                      className="group flex min-w-0 items-center gap-2 px-3 py-2 hover:bg-muted/40"
                    >
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-3 rounded-md py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => onSelect(project)}
                      >
                        <FolderGit2Icon className="size-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">
                            {project.title}
                          </span>
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <span className="mt-1 block truncate font-mono text-[11px] text-muted-foreground" />
                              }
                            >
                              {project.workspaceRoot}
                            </TooltipTrigger>
                            <TooltipPopup>{project.workspaceRoot}</TooltipPopup>
                          </Tooltip>
                          {project.repositoryIdentity?.displayName && (
                            <span className="mt-1 block truncate text-xs text-muted-foreground">
                              {project.repositoryIdentity.displayName}
                            </span>
                          )}
                        </span>
                        <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
                      </button>
                      <Button
                        size="xs"
                        variant="ghost"
                        render={
                          <Link
                            to="/environments/$environmentId/projects/$projectId"
                            params={{ environmentId: project.environmentId, projectId: project.id }}
                          />
                        }
                      >
                        Open project
                      </Button>
                    </div>
                  ))}
                </div>
              </section>
            );
          })
        )}
      </div>
    </section>
  );
}
