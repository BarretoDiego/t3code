import type { EnvironmentId, EnvironmentMachineKind } from "@t3tools/contracts";
import { NetworkIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import {
  resolveProjectEnvironmentSummary,
  type SidebarProjectSnapshot,
} from "~/sidebarProjectGrouping";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/** Project availability, including local-only projects and every linked environment. */
export function ProjectEnvironmentBadge(props: {
  readonly group: Pick<SidebarProjectSnapshot, "memberProjects">;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly machineByEnvironmentId: ReadonlyMap<EnvironmentId, EnvironmentMachineKind>;
  readonly showAllNames?: boolean;
}) {
  const summary = resolveProjectEnvironmentSummary(props.group, props.primaryEnvironmentId);
  if (!summary) return null;
  const first = summary.environments[0]!;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={summary.description}
            className={cn(
              props.showAllNames
                ? "inline-flex min-w-0 flex-wrap items-center gap-1 text-3xs leading-none"
                : "inline-flex max-w-28 shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-3xs leading-none",
              !props.showAllNames && summary.multiple
                ? "bg-primary/10 text-primary"
                : !props.showAllNames &&
                    "bg-sidebar-control-surface/65 text-sidebar-muted-foreground/75",
            )}
          />
        }
      >
        {props.showAllNames ? (
          summary.environments.map((environment) => (
            <span
              key={environment.environmentId}
              className={cn(
                "inline-flex min-w-0 max-w-full items-center gap-1 rounded-full px-1.5 py-0.5",
                summary.multiple
                  ? "bg-primary/10 text-primary"
                  : "bg-sidebar-control-surface/65 text-sidebar-muted-foreground/75",
              )}
            >
              <EnvironmentMachineIcon
                aria-hidden
                kind={
                  props.machineByEnvironmentId.get(environment.environmentId) ??
                  (environment.isLocal ? "laptop" : "server")
                }
                className="size-3 shrink-0"
              />
              <span className="min-w-0 wrap-anywhere leading-snug">
                {environment.label}
                {environment.isLocal && environment.label !== "Local" ? " (local)" : ""}
              </span>
            </span>
          ))
        ) : summary.multiple ? (
          <NetworkIcon aria-hidden className="size-3 shrink-0" />
        ) : (
          <EnvironmentMachineIcon
            aria-hidden
            kind={
              props.machineByEnvironmentId.get(first.environmentId) ??
              (first.isLocal ? "laptop" : "server")
            }
            className="size-3 shrink-0"
          />
        )}
        {props.showAllNames ? null : <span className="truncate">{summary.label}</span>}
      </TooltipTrigger>
      <TooltipPopup side="top">
        <span className="font-medium">
          {summary.multiple
            ? `Available in ${summary.environments.length} environments`
            : first.isLocal
              ? "Local only"
              : "Only in this environment"}
        </span>
        <ul className="mt-1 flex flex-col gap-1">
          {summary.environments.map((environment) => (
            <li key={environment.environmentId} className="flex items-center gap-1.5">
              <EnvironmentMachineIcon
                aria-hidden
                kind={
                  props.machineByEnvironmentId.get(environment.environmentId) ??
                  (environment.isLocal ? "laptop" : "server")
                }
                className="size-3 shrink-0"
              />
              <span>{environment.label}</span>
              {environment.isLocal && environment.label !== "Local" ? (
                <span className="text-muted-foreground">(local)</span>
              ) : null}
            </li>
          ))}
        </ul>
      </TooltipPopup>
    </Tooltip>
  );
}
