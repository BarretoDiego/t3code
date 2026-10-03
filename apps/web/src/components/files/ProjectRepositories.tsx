import type { EnvironmentId } from "@t3tools/contracts";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";
import { AtSignIcon, ChevronDownIcon, ChevronRightIcon, GitForkIcon } from "lucide-react";
import { useId, useState } from "react";

import { Button } from "~/components/ui/button";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { toastManager } from "~/components/ui/toast";
import { useComposerHandleContext } from "~/composerHandleContext";
import { projectEnvironment } from "~/state/projects";
import { useEnvironmentQuery } from "~/state/query";

export function ProjectRepositories(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly projectName: string;
}) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const composerRef = useComposerHandleContext();
  const repositories = useEnvironmentQuery(
    open
      ? projectEnvironment.listEntries({
          environmentId: props.environmentId,
          input: { cwd: props.cwd, repositoriesOnly: true },
        })
      : null,
  );

  const mention = (path: string) => {
    const inserted = composerRef?.current?.insertTextAtEnd(`${serializeComposerFileLink(path)} `, {
      ensureLeadingBoundary: true,
    });
    if (!inserted)
      toastManager.add({
        type: "error",
        title: "Unable to add to chat",
        description: "Open a chat for this project and try again.",
      });
  };

  return (
    <section className="shrink-0 border-b border-border/60" aria-label="Project repositories">
      <div className="flex items-center gap-1 px-2 py-1">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen(!open)}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-1 text-left text-xs text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-ring"
        >
          {open ? (
            <ChevronDownIcon className="size-3.5" />
          ) : (
            <ChevronRightIcon className="size-3.5" />
          )}
          <GitForkIcon className="size-3.5" />
          <span>Repositories</span>
          {repositories.data ? (
            <span className="ml-auto tabular-nums">{repositories.data.entries.length}</span>
          ) : null}
        </button>
        {open ? (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Refresh repositories"
            onClick={repositories.refresh}
          >
            <RefreshIcon refreshing={repositories.isPending} />
          </Button>
        ) : null}
      </div>
      {open ? (
        <div id={listId} className="max-h-64 overflow-y-auto px-2 pb-2">
          {repositories.isPending ? (
            <p role="status" className="px-2 py-1 text-xs text-muted-foreground">
              Finding repositories…
            </p>
          ) : null}
          {repositories.error ? (
            <button
              type="button"
              onClick={repositories.refresh}
              className="px-2 py-1 text-left text-xs text-destructive"
            >
              {repositories.error} Click to retry.
            </button>
          ) : null}
          {!repositories.isPending &&
          !repositories.error &&
          repositories.data?.entries.length === 0 ? (
            <p className="px-2 py-1 text-xs text-muted-foreground">No Git repositories found.</p>
          ) : null}
          {repositories.data?.entries.map((entry) => (
            <div
              key={entry.path}
              className="group flex items-center gap-1 rounded hover:bg-accent/50"
            >
              <button
                type="button"
                onClick={() => mention(entry.path)}
                aria-label={`Mention ${entry.path} in chat`}
                className="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.5 text-left focus-visible:outline focus-visible:outline-ring"
              >
                <GitForkIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0">
                  <span className="block truncate text-xs">
                    {entry.path === "." ? props.projectName : entry.path.split("/").at(-1)}
                  </span>
                  <span className="block truncate font-mono text-3xs text-muted-foreground">
                    {entry.path}
                  </span>
                </span>
              </button>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Mention ${entry.path} in chat`}
                      onClick={() => mention(entry.path)}
                    />
                  }
                >
                  <AtSignIcon />
                </TooltipTrigger>
                <TooltipPopup>Mention in chat</TooltipPopup>
              </Tooltip>
            </div>
          ))}
          {repositories.data?.truncated ? (
            <p className="px-2 py-1 text-xs text-muted-foreground">
              Some folders could not be scanned. Open a smaller project folder to see more
              repositories.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
