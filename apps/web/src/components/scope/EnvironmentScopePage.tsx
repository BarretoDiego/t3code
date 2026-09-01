import { Link } from "@tanstack/react-router";
import type { EnvironmentId } from "@t3tools/contracts";
import { FolderPlusIcon } from "lucide-react";
import { useCallback, useMemo } from "react";

import { openCommandPalette } from "../../commandPaletteBus";
import { useProjects, useServerConfigs, useThreadShells } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import {
  resolveScopeEnvironmentLabel,
  shelveScopeThreads,
  summarizeEnvironmentProjects,
} from "../../workspaceScope";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { EnvironmentCrumb } from "../WorkspaceScopeCrumbs";
import { SCOPE_ROW_CLASS, WorkspaceScopePage, WorkspaceScopeSection } from "./WorkspaceScopePage";

/**
 * Everything on one server.
 *
 * Reached by clicking the environment crumb, so it answers the question that
 * click asks: which projects live here, and which of them have work running.
 */
export function EnvironmentScopePage({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const { environments } = useEnvironments();
  const projects = useProjects();
  const threads = useThreadShells();
  const serverConfigs = useServerConfigs();
  const environment = environments.find((entry) => entry.environmentId === environmentId) ?? null;

  const openAddProject = useCallback(
    () => openCommandPalette({ open: "add-project", environmentId }),
    [environmentId],
  );

  // Quantized to the minute: the shelving rule is clock-derived, and a
  // per-render `now` would rebuild this list on every keystroke elsewhere.
  const nowMinute = Math.floor(Date.now() / 60_000);
  const summaries = useMemo(() => {
    const now = new Date(nowMinute * 60_000).toISOString();
    const environmentThreads = threads.filter((thread) => thread.environmentId === environmentId);
    const shelves = shelveScopeThreads({
      threads: environmentThreads,
      now,
      supportsSettlement: (id) =>
        serverConfigs.get(id)?.environment.capabilities.threadSettlement === true,
      supportsSnooze: (id) => serverConfigs.get(id)?.environment.capabilities.threadSnooze === true,
    });
    const activeThreadIds = new Set(shelves.active.map((thread) => thread.id));
    return summarizeEnvironmentProjects({
      environmentId,
      projects,
      threads: environmentThreads,
      isActiveThread: (thread) => activeThreadIds.has(thread.id),
    });
  }, [
    environmentId,
    nowMinute,
    projects,
    serverConfigs,
    threads,
  ]);

  if (environment === null) {
    return (
      <WorkspaceScopePage
        breadcrumbLabel="Environment"
        breadcrumb={<EnvironmentCrumb current environmentId={environmentId} label="Unknown" />}
      >
        <Empty className="flex-1">
          <EmptyHeader className="max-w-md">
            <EmptyTitle className="text-foreground text-xl">Environment not connected</EmptyTitle>
            <EmptyDescription className="mt-2 text-sm text-muted-foreground/78">
              This link points at a server this device is not connected to. Add it under
              Connections, then open the link again.
            </EmptyDescription>
            <div className="mt-5 flex justify-center">
              <Button render={<Link to="/settings/connections" />} size="sm">
                Open Connections
              </Button>
            </div>
          </EmptyHeader>
        </Empty>
      </WorkspaceScopePage>
    );
  }

  // A server that named itself blank still needs a heading to sit under.
  const environmentLabel = resolveScopeEnvironmentLabel(environment.label) ?? "Environment";

  return (
    <WorkspaceScopePage
      breadcrumbLabel="Environment"
      breadcrumb={
        <EnvironmentCrumb current environmentId={environmentId} label={environmentLabel} />
      }
      actions={
        <Button size="sm" variant="outline" onClick={openAddProject}>
          <FolderPlusIcon className="size-4" />
          New project
        </Button>
      }
    >
      {summaries.length === 0 ? (
        <Empty>
          <EmptyHeader className="max-w-md">
            <EmptyTitle className="text-foreground text-xl">No projects here yet</EmptyTitle>
            <EmptyDescription className="mt-2 text-sm text-muted-foreground/78">
              Add a project on {environmentLabel} to start working on it.
            </EmptyDescription>
            <div className="mt-5 flex justify-center">
              <Button size="sm" onClick={openAddProject}>
                <FolderPlusIcon className="size-4" />
                New project
              </Button>
            </div>
          </EmptyHeader>
        </Empty>
      ) : (
        <WorkspaceScopeSection title="Projects" count={summaries.length}>
          {summaries.map(({ project, activeThreadCount, threadCount, lastActivityAt }) => (
            <li key={project.id} className="min-w-0">
              <Link
                to="/environments/$environmentId/projects/$projectId"
                params={{ environmentId, projectId: project.id }}
                className={SCOPE_ROW_CLASS}
              >
                <ProjectFavicon
                  environmentId={environmentId}
                  cwd={project.workspaceRoot}
                  faviconPath={project.faviconPath}
                  className="size-4 shrink-0"
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium text-foreground">
                    {project.title}
                  </span>
                  <span className="truncate text-xs text-muted-foreground/70">
                    {project.workspaceRoot}
                  </span>
                </span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground/70">
                  {/* The live count leads, because that is what decides where
                      to go next; the total only earns space when it differs. */}
                  {activeThreadCount > 0
                    ? `${activeThreadCount} active`
                    : threadCount > 0
                      ? `${threadCount} settled`
                      : "No threads"}
                </span>
                {lastActivityAt === null ? null : (
                  <span className="hidden shrink-0 text-xs tabular-nums text-muted-foreground/50 sm:inline">
                    {formatRelativeTimeLabel(lastActivityAt)}
                  </span>
                )}
              </Link>
            </li>
          ))}
        </WorkspaceScopeSection>
      )}
    </WorkspaceScopePage>
  );
}
