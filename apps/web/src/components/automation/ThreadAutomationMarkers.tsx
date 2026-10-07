import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { OrchestratorThreadMarker } from "@t3tools/client-runtime/state/automation-presentation";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { UserRoundCheckIcon, WorkflowIcon } from "lucide-react";
import { memo, useMemo } from "react";

import { useRightPanelStore } from "../../rightPanelStore";
import { useOrchestratorThreadMarker, useThreadResponsibilityMarker } from "../../state/automation";
import { useEnvironment } from "../../state/environments";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AutomationStatusGlyph } from "./AutomationStatus";

/** Opens the thread details panel, which carries the orchestrator section, in either layout. */
export function openThreadDetailsPanel(ref: ScopedThreadRef) {
  const store = useRightPanelStore.getState();
  store.setThreadPanelOpen(ref, "inline", true);
  store.setThreadPanelOpen(ref, "popover", true);
}

/** Rendered inside the tooltip, so the host label is only resolved while it is open. */
function OrchestratorMarkerDetails({ marker }: { readonly marker: OrchestratorThreadMarker }) {
  const host = useEnvironment(marker.hostEnvironmentId);
  return (
    <div className="flex max-w-64 flex-col gap-0.5 text-left">
      <span className="font-medium">
        {marker.scopeLabel} orchestrator · {marker.name}
      </span>
      <span>
        {marker.state.label}
        {marker.stateReason ? ` · ${marker.stateReason}` : ""}
      </span>
      <span className="text-muted-foreground">
        {marker.hostedHere ? "Hosted on" : "Hosted elsewhere, on"}{" "}
        {host?.label ?? marker.hostEnvironmentId} · {marker.model}
      </span>
      {marker.inboxPending > 0 ? (
        <span className="text-muted-foreground">{marker.inboxPending} waiting in its inbox</span>
      ) : null}
    </div>
  );
}

/**
 * Says a thread is an orchestrator's main thread, and when something other
 * than the user is responsible for a request waiting on it. Renders nothing on
 * an ordinary thread.
 *
 * `row` is two small icons for the sidebar; `header` spells the state out.
 * Neither relies on colour: the state has its own glyph and a text label.
 */
export const ThreadAutomationMarkers = memo(function ThreadAutomationMarkers({
  environmentId,
  threadId,
  variant,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly variant: "row" | "header";
}) {
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const orchestrator = useOrchestratorThreadMarker(threadRef);
  const responsibility = useThreadResponsibilityMarker(threadRef);
  if (orchestrator === null && responsibility === null) return null;

  return (
    <span className="inline-flex shrink-0 items-center gap-1" data-thread-automation-markers>
      {orchestrator !== null ? (
        <Tooltip>
          <TooltipTrigger
            render={
              variant === "header" ? (
                <Button
                  size="xs"
                  variant="outline"
                  aria-label={`${orchestrator.accessibleLabel}. Open orchestrator panel`}
                  onClick={() => openThreadDetailsPanel(threadRef)}
                />
              ) : (
                <span
                  role="img"
                  aria-label={orchestrator.accessibleLabel}
                  className="inline-flex items-center gap-0.5"
                />
              )
            }
          >
            <WorkflowIcon aria-hidden className="size-3 text-muted-foreground" />
            <AutomationStatusGlyph status={orchestrator.state} className="size-3" />
            {variant === "header" ? <span>{orchestrator.state.label}</span> : null}
          </TooltipTrigger>
          <TooltipPopup side="top">
            <OrchestratorMarkerDetails marker={orchestrator} />
          </TooltipPopup>
        </Tooltip>
      ) : null}
      {responsibility !== null ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                role="img"
                aria-label={responsibility.accessibleLabel}
                className="inline-flex items-center gap-0.5 text-2xs text-muted-foreground"
              />
            }
          >
            <UserRoundCheckIcon aria-hidden className="size-3" />
            {variant === "header" ? (
              <span>{responsibility.ownerLabel ?? "Several owners"}</span>
            ) : null}
          </TooltipTrigger>
          <TooltipPopup side="top">{responsibility.accessibleLabel}</TooltipPopup>
        </Tooltip>
      ) : null}
    </span>
  );
});
