import { randomUUID } from "../../lib/utils";
import { useMemo, useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  GitBranchIcon,
  GitCommitHorizontalIcon,
  CheckIcon,
  FileDiffIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { vcsEnvironment } from "../../state/vcs";
import { reviewEnvironment } from "../../state/review";
import { useGitStackedAction } from "../../lib/sourceControlActions";
import { useTheme } from "../../hooks/useTheme";
import {
  getRenderablePatch,
  resolveFileDiffPath,
  buildFileDiffRenderKey,
  resolveDiffThemeName,
} from "../../lib/diffRendering";
import { StyledDiffCodeView } from "../diffs/StyledDiffCodeView";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Textarea } from "../ui/textarea";
import { HubSelect } from "./HubSelect";
import { CommitMessageAssistant } from "./CommitMessageAssistant";
import { LocalCloneActions } from "./LocalCloneActions";
import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogClose,
} from "../ui/alert-dialog";

export function LocalChangesWorkbench({
  selection,
  onSelection,
}: {
  selection: string;
  onSelection: (selection: string) => void;
}) {
  const projects = useProjects();
  const { environments } = useEnvironments();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const project = selection
    ? projects.find((project) => `${project.environmentId}:${project.id}` === selection)
    : projects[0];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b px-4 py-3">
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Local repository
        </span>
        <div className="min-w-48 max-w-md flex-1">
          <HubSelect
            label="Repository and environment"
            value={project ? `${project.environmentId}:${project.id}` : ""}
            options={projects.map((project) => ({
              value: `${project.environmentId}:${project.id}`,
              label: `${project.title} · ${environments.find((env) => env.environmentId === project.environmentId)?.label ?? "Environment"}`,
            }))}
            onChange={onSelection}
          />
        </div>
      </div>
      {project ? (
        <LocalRepositoryChanges
          key={`${project.environmentId}:${project.id}`}
          environmentId={project.environmentId}
          cwd={project.workspaceRoot}
          title={project.title}
          message={drafts[`${project.environmentId}:${project.id}`] ?? ""}
          setMessage={(message) =>
            setDrafts((current) => ({
              ...current,
              [`${project.environmentId}:${project.id}`]: message,
            }))
          }
        />
      ) : (
        <div className="grid flex-1 place-content-center gap-3 p-8 text-center">
          <FileDiffIcon className="mx-auto size-8 text-muted-foreground" />
          <h2 className="font-medium">Open a local project to review changes</h2>
          <p className="max-w-md text-sm text-muted-foreground">
            Repositories connected through GitHub or Bitbucket appear in Repositories. Changes and
            commits need a project on one of your environments.
          </p>
        </div>
      )}
    </div>
  );
}

function LocalRepositoryChanges({
  environmentId,
  cwd,
  title,
  message,
  setMessage,
}: {
  environmentId: EnvironmentId;
  cwd: string;
  title: string;
  message: string;
  setMessage: (message: string) => void;
}) {
  const scope = useMemo(() => ({ environmentId, cwd }), [environmentId, cwd]);
  const status = useEnvironmentQuery(vcsEnvironment.status({ environmentId, input: { cwd } }));
  const diff = useEnvironmentQuery(
    reviewEnvironment.diffPreview({ environmentId, input: { cwd } }),
  );
  const refreshStatus = useAtomCommand(vcsEnvironment.refreshStatus);
  const action = useGitStackedAction(scope);
  const { resolvedTheme } = useTheme();
  const [excluded, setExcluded] = useState<string[]>([]);
  const [path, setPath] = useState<string | null>(null);
  const [layout, setLayout] = useState<"split" | "unified">("split");
  const [confirm, setConfirm] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const files = status.data?.workingTree.files ?? [];
  const selectedFiles = files.filter((file) => !excluded.includes(file.path));
  const source = diff.data?.sources.find((source) => source.kind === "working-tree");
  const parsed = useMemo(
    () => getRenderablePatch(source?.diff, `local:${environmentId}:${cwd}:${source?.diffHash}`),
    [source?.diff, source?.diffHash, environmentId, cwd],
  );
  const diffFiles = parsed?.kind === "files" ? parsed.files : [];
  const selectedPath = files.some((file) => file.path === path) ? path : files[0]?.path;
  const selectedDiff = diffFiles.find((file) => resolveFileDiffPath(file) === selectedPath);
  const items = useMemo(
    () =>
      selectedDiff
        ? [
            {
              id: buildFileDiffRenderKey(selectedDiff),
              type: "diff" as const,
              fileDiff: selectedDiff,
            },
          ]
        : [],
    [selectedDiff],
  );
  const refresh = async () => {
    await refreshStatus({ environmentId, input: { cwd } });
    status.refresh();
    diff.refresh();
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      <aside className="flex min-h-0 max-h-[70vh] w-full shrink-0 flex-col overflow-auto border-b bg-muted/15 lg:max-h-none lg:w-80 lg:border-r lg:border-b-0">
        <div className="shrink-0 space-y-3 border-b p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="truncate text-sm font-semibold">{title}</h2>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Refresh local changes"
              onClick={() => void refresh()}
            >
              <RefreshCwIcon className="size-3.5" />
            </Button>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <GitBranchIcon className="size-3.5" />
            <span className="truncate">
              {status.data?.refName ?? (status.isPending ? "Loading branch…" : "Detached HEAD")}
            </span>
            <span className="ml-auto tabular-nums">
              ↑{status.data?.aheadCount ?? 0} ↓{status.data?.behindCount ?? 0}
            </span>
          </div>
          <LocalCloneActions
            environmentId={environmentId}
            cwd={cwd}
            remoteName="origin"
            onChanged={() => void refresh()}
          />
          <Textarea
            aria-label="Commit message"
            placeholder="Write a commit message…"
            rows={3}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            disabled={action.isPending}
          />
          <CommitMessageAssistant
            environmentId={environmentId}
            cwd={cwd}
            filePaths={selectedFiles.map((file) => file.path)}
            onGenerated={setMessage}
          />
          <Button
            className="w-full"
            disabled={
              action.isPending || !message.trim() || !selectedFiles.length || !status.data?.isRepo
            }
            onClick={() => setConfirm(true)}
          >
            <GitCommitHorizontalIcon className="size-4" />
            {action.isPending
              ? "Committing…"
              : `Commit ${selectedFiles.length} ${selectedFiles.length === 1 ? "file" : "files"}`}
          </Button>
          {feedback && (
            <p role="status" className="text-xs text-muted-foreground">
              {feedback}
            </p>
          )}
          {(status.error || diff.error) && (
            <p role="alert" className="text-xs text-destructive">
              {status.error ?? diff.error}
            </p>
          )}
        </div>
        <div className="flex items-center justify-between px-4 py-3 text-xs font-medium">
          <span>
            CHANGES{" "}
            <span className="ml-1 rounded bg-muted px-1.5 py-0.5 tabular-nums">{files.length}</span>
          </span>
          <Button
            size="xs"
            variant="ghost"
            disabled={action.isPending}
            onClick={() =>
              setExcluded(
                selectedFiles.length === files.length ? files.map((file) => file.path) : [],
              )
            }
          >
            {selectedFiles.length === files.length ? "Deselect all" : "Select all"}
          </Button>
        </div>
        <div className="min-h-24 flex-1 overflow-auto pb-3">
          {files.map((file) => (
            <div
              key={file.path}
              className={`flex items-center gap-2 px-4 py-1 ${selectedPath === file.path ? "bg-accent" : "hover:bg-muted/50"}`}
            >
              <Checkbox
                aria-label={`Include ${file.path} in commit`}
                checked={!excluded.includes(file.path)}
                disabled={action.isPending}
                onCheckedChange={(checked) =>
                  setExcluded((current) =>
                    checked
                      ? current.filter((path) => path !== file.path)
                      : [...current, file.path],
                  )
                }
              />
              <button
                className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left text-xs"
                onClick={() => setPath(file.path)}
              >
                <span className="truncate">{file.path}</span>
                <span className="ml-auto shrink-0 tabular-nums">
                  <span className="text-emerald-600 dark:text-emerald-400">+{file.insertions}</span>{" "}
                  <span className="text-red-500">−{file.deletions}</span>
                </span>
              </button>
            </div>
          ))}
        </div>
        <p className="border-t px-4 py-2 text-[11px] text-muted-foreground">
          Checked files are staged when you confirm the commit.
        </p>
      </aside>
      <section className="flex min-h-72 min-w-0 flex-1 flex-col lg:min-h-0">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3">
          <span className="truncate font-mono text-xs">{selectedPath ?? "Working tree"}</span>
          <HubSelect
            label="Diff layout"
            value={layout}
            options={[
              { value: "split", label: "Side by side" },
              { value: "unified", label: "Inline" },
            ]}
            onChange={setLayout}
          />
        </div>
        {selectedDiff ? (
          <StyledDiffCodeView
            className="min-h-0 flex-1 overflow-auto"
            items={items}
            options={{
              diffStyle: layout,
              theme: resolveDiffThemeName(resolvedTheme),
              themeType: resolvedTheme,
            }}
          />
        ) : (
          <div className="grid flex-1 place-content-center gap-3 p-8 text-center text-sm text-muted-foreground">
            <CheckIcon className="mx-auto size-7" />
            {status.isPending || diff.isPending
              ? "Loading changes…"
              : status.data?.isRepo === false
                ? "This project is not a Git repository."
                : files.length
                  ? "Select a file to inspect its diff. Binary or oversized content may not be available."
                  : "Your working tree is clean."}
          </div>
        )}
        {source?.truncated && (
          <p className="border-t px-4 py-2 text-xs text-muted-foreground">
            This diff is larger than the preview limit. Some content is omitted.
          </p>
        )}
      </section>
      <AlertDialog
        open={confirm}
        onOpenChange={(value) => {
          if (!action.isPending) setConfirm(value);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Commit to {status.data?.refName ?? "detached HEAD"}</AlertDialogTitle>
            <AlertDialogDescription>
              {selectedFiles.length} selected files in {title}. Unselected changes remain in the
              working tree. This action does not push.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <pre className="max-h-36 overflow-auto whitespace-pre-wrap px-6 text-sm">{message}</pre>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" disabled={action.isPending} />}>
              Cancel
            </AlertDialogClose>
            <Button
              disabled={action.isPending}
              onClick={async () => {
                const result = await action.run({
                  actionId: randomUUID(),
                  action: "commit",
                  onProgress: (event) => {
                    if (event.kind === "phase_started") setFeedback(event.label);
                    else if (event.kind === "hook_started")
                      setFeedback(`Running ${event.hookName}…`);
                  },
                  commitMessage: message.trim(),
                  filePaths: selectedFiles.map((file) => file.path),
                });
                if (result._tag === "Success") {
                  setMessage("");
                  setExcluded([]);
                  setConfirm(false);
                  setFeedback("Commit created. Your changes are ready to push.");
                  await refresh();
                } else {
                  setConfirm(false);
                  setFeedback(
                    "Commit failed. Check the repository state and commit hooks, then retry.",
                  );
                }
              }}
            >
              Confirm commit
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
