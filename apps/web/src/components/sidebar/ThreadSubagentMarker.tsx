import { CornerDownRightIcon } from "lucide-react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { resolveSubthreadStatusLabel } from "@t3tools/client-runtime/state/models";

/** Stays visible even when a subagent cannot be shown beneath its parent. */
export function ThreadSubagentMarker({
  parentTitle,
}: {
  readonly parentTitle?: string | null | undefined;
}) {
  const label = parentTitle ? `Subagent of ${parentTitle}` : "Subagent";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={label}
            className="inline-flex shrink-0 items-center gap-0.5 rounded bg-muted px-1 py-0.5 text-3xs leading-none text-secondary-label"
          />
        }
      >
        <CornerDownRightIcon aria-hidden className="size-3" />
        Subagent
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

export function ThreadSubagentStatus({
  thread,
}: {
  readonly thread: Parameters<typeof resolveSubthreadStatusLabel>[0];
}) {
  return (
    <span role="status" className="shrink-0 text-xs text-secondary-label">
      {resolveSubthreadStatusLabel(thread, new Date().toISOString())}
    </span>
  );
}
