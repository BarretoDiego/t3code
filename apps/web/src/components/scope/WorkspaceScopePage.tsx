import type { ReactNode } from "react";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { SidebarInset } from "../ui/sidebar";
import { WorkspaceBreadcrumb } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";

/**
 * Frame shared by the environment and project pages.
 *
 * Both are the same kind of screen — a scope's path in the header, a list of
 * what is inside it below — so the geometry lives here once and the pages only
 * differ in what they list.
 */
export function WorkspaceScopePage(props: {
  readonly breadcrumbLabel: string;
  readonly breadcrumb: ReactNode;
  /** Trailing header controls, e.g. New thread. */
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <WorkspaceBreadcrumb ariaLabel={props.breadcrumbLabel} className="flex-1">
            {props.breadcrumb}
          </WorkspaceBreadcrumb>
          {props.actions === undefined ? null : (
            <div className="flex shrink-0 items-center gap-2">{props.actions}</div>
          )}
        </WorkspacePageHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <WorkspacePageContainer width="wide">{props.children}</WorkspacePageContainer>
        </div>
      </div>
    </SidebarInset>
  );
}

/**
 * A titled run of rows.
 *
 * The count sits in the heading rather than on the rows because a shelf's
 * whole job here is to say how much of this kind of thing there is.
 */
export function WorkspaceScopeSection(props: {
  readonly title: string;
  readonly count: number;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <section className={cn("flex min-w-0 flex-col gap-2", props.className)}>
      <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground/80">
        <span>{props.title}</span>
        <span className="tabular-nums text-muted-foreground/50">{props.count}</span>
        <span className="h-px flex-1 bg-border" />
      </h2>
      <ul role="list" className="flex min-w-0 list-none flex-col gap-1 p-0">
        {props.children}
      </ul>
    </section>
  );
}

export const SCOPE_ROW_CLASS =
  "flex min-w-0 cursor-pointer items-center gap-3 rounded-lg border border-transparent px-3 py-2.5 text-left transition-colors hover:border-border hover:bg-accent/50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring";
