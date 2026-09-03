import { Link } from "@tanstack/react-router";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { HardDriveIcon, ServerIcon } from "lucide-react";

import { cn } from "../lib/utils";
import { usePrimaryEnvironmentId } from "../state/environments";
import { ProjectFavicon } from "./ProjectFavicon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { WorkspaceBreadcrumbItem } from "./WorkspaceBreadcrumb";

/**
 * The clickable halves of a thread's path: its environment and its project.
 *
 * Both crumbs render the same way wherever the path is shown — the chat
 * header, the environment page, the project page — so a scope always looks
 * like the same thing and always leads to the same place. Shared as
 * components rather than as a `crumbs` array because each one carries its own
 * icon rule and its own tooltip copy.
 */

const CRUMB_LINK_CLASS =
  "inline-flex min-w-0 cursor-pointer items-center gap-1.5 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring";

/** A crumb that is the page you are on: no link, no hover affordance. */
const CRUMB_CURRENT_CLASS = "inline-flex min-w-0 items-center gap-1.5 text-foreground";

export function EnvironmentCrumb(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** True when this crumb *is* the current page, so it stops being a link. */
  readonly current?: boolean;
}) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  // The machine you are sitting at gets a drive; anything reached over the
  // network gets a server. One glance answers "is this work happening here".
  const Icon = props.environmentId === primaryEnvironmentId ? HardDriveIcon : ServerIcon;
  const body = (
    <>
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <span className="max-w-32 truncate">{props.label}</span>
    </>
  );
  if (props.current === true) {
    return (
      <WorkspaceBreadcrumbItem current>
        <span className={CRUMB_CURRENT_CLASS}>{body}</span>
      </WorkspaceBreadcrumbItem>
    );
  }
  return (
    <WorkspaceBreadcrumbItem>
      <Tooltip>
        <TooltipTrigger
          render={
            <Link
              to="/environments/$environmentId"
              params={{ environmentId: props.environmentId }}
              aria-label={`Open ${props.label}`}
              className={CRUMB_LINK_CLASS}
            />
          }
        >
          {body}
        </TooltipTrigger>
        <TooltipPopup side="bottom">Every project in {props.label}</TooltipPopup>
      </Tooltip>
    </WorkspaceBreadcrumbItem>
  );
}

export function ProjectCrumb(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly label: string;
  readonly cwd: string | null;
  readonly faviconPath: string | null;
  readonly current?: boolean;
  readonly className?: string | undefined;
}) {
  const body = (
    <>
      <ProjectFavicon
        environmentId={props.environmentId}
        cwd={props.cwd ?? ""}
        projectName={props.label}
        faviconPath={props.faviconPath}
        className="size-3.5"
      />
      <span className={cn("truncate", props.current === true ? "min-w-0" : "max-w-40")}>
        {props.label}
      </span>
    </>
  );
  if (props.current === true) {
    return (
      <WorkspaceBreadcrumbItem current className={props.className}>
        <span className={CRUMB_CURRENT_CLASS}>{body}</span>
      </WorkspaceBreadcrumbItem>
    );
  }
  return (
    <WorkspaceBreadcrumbItem className={props.className}>
      <Tooltip>
        <TooltipTrigger
          render={
            <Link
              to="/environments/$environmentId/projects/$projectId"
              params={{ environmentId: props.environmentId, projectId: props.projectId }}
              aria-label={`Open ${props.label}`}
              className={CRUMB_LINK_CLASS}
            />
          }
        >
          {body}
        </TooltipTrigger>
        <TooltipPopup side="bottom">Every thread in {props.label}</TooltipPopup>
      </Tooltip>
    </WorkspaceBreadcrumbItem>
  );
}
