import { Link } from "@tanstack/react-router";
import type { ScopedThreadRef, ThreadHandoffPhase } from "@t3tools/contracts";
import { createEnvironmentRpcSubscriptionAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironments } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { buildThreadRouteParams } from "../threadRoutes";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const watchHandoff = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "thread-handoff-owner",
  tag: "threadHandoff.watch",
  idleTtlMs: 0,
});

const phaseLabels: Record<ThreadHandoffPhase, string> = {
  preflighting: "Checking destination",
  pausing: "Pausing agent",
  checkpointing: "Creating checkpoint",
  syncingProjects: "Synchronizing project",
  transferringSession: "Transferring native session",
  verifying: "Verifying destination",
  ready: "Destination ready",
  committed: "Activating destination",
  completed: "Transfer completed",
  rollingBack: "Restoring source",
  failed: "Transfer failed",
  cancelled: "Transfer cancelled",
};

/** Follows the durable owner journal, including transfers initiated by another client. */
export function ThreadHandoffIndicator({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const { environments } = useEnvironments();
  const source = environments.find((entry) => entry.environmentId === threadRef.environmentId);
  const supported = source?.serverConfig?.environment.capabilities.threadHandoff === true;
  const query = useEnvironmentQuery(
    supported
      ? watchHandoff({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        })
      : null,
  );
  if (!supported) return null;
  const record = query.data;
  const committed = record?.phase === "committed" || record?.phase === "completed";
  const ownerId = committed
    ? record.destinationEnvironmentId
    : (record?.owner.environmentId ?? threadRef.environmentId);
  const ownerLabel =
    environments.find((entry) => entry.environmentId === ownerId)?.label ?? ownerId;
  const destinationLabel = record
    ? (environments.find((entry) => entry.environmentId === record.destinationEnvironmentId)
        ?.label ?? record.destinationEnvironmentId)
    : null;
  const moved = ownerId !== threadRef.environmentId;
  const ownerText = query.error
    ? record
      ? `Last known owner: ${ownerLabel}`
      : "Execution owner unavailable"
    : query.isPending && !record
      ? "Checking execution owner…"
      : `Running on ${ownerLabel}`;
  const status = query.error
    ? "Ownership connection unavailable"
    : record && record.phase !== "completed"
      ? phaseLabels[record.phase]
      : null;
  const description =
    query.error ??
    record?.failure ??
    (record
      ? `${phaseLabels[record.phase]} · ${source?.label ?? threadRef.environmentId} → ${destinationLabel}`
      : `Execution environment: ${ownerLabel}`);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div className="flex min-w-0 max-w-44 shrink flex-col text-xs text-muted-foreground" />
        }
      >
        {moved ? (
          <Link
            to="/$environmentId/$threadId"
            params={buildThreadRouteParams({
              environmentId: ownerId,
              threadId: threadRef.threadId,
            })}
            className="truncate rounded-sm underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          >
            {ownerText}
          </Link>
        ) : (
          <span className="truncate">{ownerText}</span>
        )}
        {status && (
          <span
            role="status"
            className={record?.failure || query.error ? "truncate text-destructive" : "truncate"}
          >
            {status}
          </span>
        )}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{description}</TooltipPopup>
    </Tooltip>
  );
}
