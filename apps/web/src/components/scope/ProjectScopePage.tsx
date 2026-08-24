import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { Link } from "@tanstack/react-router";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { SquarePenIcon } from "lucide-react";
import { useCallback, useMemo } from "react";

import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useClientSettings } from "../../hooks/useSettings";
import { useProject, useServerConfigs, useThreadShells } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { resolveScopeEnvironmentLabel, shelveScopeThreads } from "../../workspaceScope";
import { resolveSidebarThreadStatus } from "../Sidebar.logic";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { WorkspaceBreadcrumbSeparator } from "../WorkspaceBreadcrumb";
import { EnvironmentCrumb, ProjectCrumb } from "../WorkspaceScopeCrumbs";
import { SCOPE_ROW_CLASS, WorkspaceScopePage, WorkspaceScopeSection } from "./WorkspaceScopePage";

/**
 * Everything in one project.
 *
 * Reached by clicking the project crumb. Scoped to the project on *this*
 * environment rather than to the sidebar's logical grouping: the crumb comes
 * from a thread, a thread has exactly one environment, and a page reached from
 * a path should not quietly widen it.
 */
export function ProjectScopePage(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const { environmentId, projectId } = props;
  const { environments } = useEnvironments();
  const projectRef = useMemo(
    () => scopeProjectRef(environmentId, projectId),
    [environmentId, projectId],
  );
  const project = useProject(projectRef);
  const threads = useThreadShells();
  const serverConfigs = useServerConfigs();
  const autoSettleAfterDays = useClientSettings((settings) => settings.sidebarAutoSettleAfterDays);
  const autoSettleOnMerge = useClientSettings((settings) => settings.sidebarAutoSettleOnMerge);
  const environmentLabel = resolveScopeEnvironmentLabel(
    environments.find((entry) => entry.environmentId === environmentId)?.label,
  );
  const handleNewThread = useNewThreadHandler();
  const startNewThread = useCallback(() => {
    void handleNewThread(projectRef);
  }, [handleNewThread, projectRef]);

  // Quantized to the minute: the shelving rule is clock-derived, and a
  // per-render `now` would re-shelve the list on every unrelated re-render.
  const nowMinute = Math.floor(Date.now() / 60_000);
  const shelves = useMemo(
    () =>
      shelveScopeThreads({
        threads: threads.filter(
          (thread) => thread.environmentId === environmentId && thread.projectId === projectId,
        ),
        now: new Date(nowMinute * 60_000).toISOString(),
        autoSettleAfterDays,
        autoSettleOnMerge,
        supportsSettlement: (id) =>
          serverConfigs.get(id)?.environment.capabilities.threadSettlement === true,
        supportsSnooze: (id) =>
          serverConfigs.get(id)?.environment.capabilities.threadSnooze === true,
      }),
    [
      autoSettleAfterDays,
      autoSettleOnMerge,
      environmentId,
      nowMinute,
      projectId,
      serverConfigs,
      threads,
    ],
  );

  const label = project?.title ?? "Unknown project";
  const breadcrumb = (
    <>
      {environmentLabel === null ? null : (
        <>
          <EnvironmentCrumb environmentId={environmentId} label={environmentLabel} />
          <WorkspaceBreadcrumbSeparator />
        </>
      )}
      <ProjectCrumb
        current
        environmentId={environmentId}
        projectId={projectId}
        label={label}
        cwd={project?.workspaceRoot ?? null}
        faviconPath={project?.faviconPath ?? null}
        className="flex-1"
      />
    </>
  );

  if (project === null) {
    return (
      <WorkspaceScopePage breadcrumbLabel="Project" breadcrumb={breadcrumb}>
        <Empty>
          <EmptyHeader className="max-w-md">
            <EmptyTitle className="text-foreground text-xl">Project not found</EmptyTitle>
            <EmptyDescription className="mt-2 text-sm text-muted-foreground/78">
              It may have been removed, or its environment may still be connecting.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </WorkspaceScopePage>
    );
  }

  const total = shelves.active.length + shelves.snoozed.length + shelves.settled.length;

  return (
    <WorkspaceScopePage
      breadcrumbLabel="Project"
      breadcrumb={breadcrumb}
      actions={
        <Button size="sm" variant="outline" onClick={startNewThread}>
          <SquarePenIcon className="size-4" />
          New thread
        </Button>
      }
    >
      {total === 0 ? (
        <Empty>
          <EmptyHeader className="max-w-md">
            <EmptyTitle className="text-foreground text-xl">No threads yet</EmptyTitle>
            <EmptyDescription className="mt-2 text-sm text-muted-foreground/78">
              Start one in {project.title} and it will show up here.
            </EmptyDescription>
            <div className="mt-5 flex justify-center">
              <Button size="sm" onClick={startNewThread}>
                <SquarePenIcon className="size-4" />
                New thread
              </Button>
            </div>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          {/* Same three shelves, same order, same meaning as the sidebar —
              this page is a wider view of that list, not a second opinion. */}
          {shelves.active.length === 0 ? null : (
            <WorkspaceScopeSection title="Active" count={shelves.active.length}>
              {shelves.active.map((thread) => (
                <ThreadRow key={thread.id} thread={thread} />
              ))}
            </WorkspaceScopeSection>
          )}
          {shelves.snoozed.length === 0 ? null : (
            <WorkspaceScopeSection title="Snoozed" count={shelves.snoozed.length}>
              {shelves.snoozed.map((thread) => (
                <ThreadRow key={thread.id} thread={thread} />
              ))}
            </WorkspaceScopeSection>
          )}
          {shelves.settled.length === 0 ? null : (
            <WorkspaceScopeSection title="Settled" count={shelves.settled.length}>
              {shelves.settled.map((thread) => (
                <ThreadRow key={thread.id} thread={thread} />
              ))}
            </WorkspaceScopeSection>
          )}
        </>
      )}
    </WorkspaceScopePage>
  );
}

/** Status words the rows show. Anything else is quiet — an idle thread's
    status is its timestamp, and labelling every row "idle" says nothing. */
const THREAD_STATUS_LABEL: Partial<Record<string, string>> = {
  approval: "Needs approval",
  input: "Needs input",
  failed: "Failed",
  working: "Working",
  monitoring: "Monitoring",
};

function ThreadRow({ thread }: { readonly thread: EnvironmentThreadShell }) {
  const status = THREAD_STATUS_LABEL[resolveSidebarThreadStatus(thread)];
  return (
    <li className="min-w-0">
      <Link
        to="/$environmentId/$threadId"
        params={{ environmentId: thread.environmentId, threadId: thread.id }}
        className={SCOPE_ROW_CLASS}
      >
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">{thread.title}</span>
        {status === undefined ? null : (
          <span className="shrink-0 text-xs font-medium text-muted-foreground">{status}</span>
        )}
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground/50">
          {formatRelativeTimeLabel(thread.updatedAt)}
        </span>
      </Link>
    </li>
  );
}
