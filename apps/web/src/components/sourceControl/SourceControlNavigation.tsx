import { SourceControlAuthWizard } from "./SourceControlAuthWizard";
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { FileDiffIcon, GitBranchIcon, GitPullRequestIcon, FolderGit2Icon } from "lucide-react";
import { Button } from "../ui/button";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";

export function SourceControlNavigation({
  section,
  onSection,
  children,
}: {
  section: "changes" | "repositories" | "pull-requests";
  onSection?: (value: "changes" | "repositories") => void;
  children?: ReactNode;
}) {
  return (
    <header className="shrink-0 border-b bg-background">
      <div className="flex min-h-12 flex-wrap items-center justify-between gap-2 px-4 py-2">
        <div className="flex items-center gap-2.5">
          <GitBranchIcon className="size-4 text-muted-foreground" />
          <h1 className="text-sm font-semibold tracking-tight">Source Control</h1>
        </div>
        {children ?? <SourceControlAuthWizard />}
      </div>
      <nav aria-label="Source control sections" className="flex gap-1 overflow-x-auto px-3 pb-2">
        <Button
          size="sm"
          variant={section === "changes" ? "secondary" : "ghost"}
          {...(onSection
            ? { onClick: () => onSection("changes") }
            : { render: <Link to="/source-control" search={{ section: "changes" }} /> })}
        >
          <FileDiffIcon className="size-3.5" />
          Changes
        </Button>
        <Button
          size="sm"
          variant={section === "pull-requests" ? "secondary" : "ghost"}
          render={<Link to="/pull-requests" search={readPullRequestListPreferences()} />}
        >
          <GitPullRequestIcon className="size-3.5" />
          Pull requests
        </Button>
        <Button
          size="sm"
          variant={section === "repositories" ? "secondary" : "ghost"}
          {...(onSection
            ? { onClick: () => onSection("repositories") }
            : { render: <Link to="/source-control" search={{ section: "repositories" }} /> })}
        >
          <FolderGit2Icon className="size-3.5" />
          Repositories
        </Button>
      </nav>
    </header>
  );
}
