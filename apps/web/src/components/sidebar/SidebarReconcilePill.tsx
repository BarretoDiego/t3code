import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { useNowMinuteMs } from "../../hooks/useNowMinute";
import { ensureLocalApi } from "../../localApi";
import { cn } from "../../lib/utils";
import { environmentAtomList, environmentIdsKey } from "../../state/environmentAtomList";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Spinner } from "../ui/spinner";
import { SidebarMenuItem } from "../ui/sidebar";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  getReconcileTooltip,
  isReconcileRunning,
  RECONCILE_CONFIRMATION_MESSAGE,
  resolveReconcileTarget,
} from "./SidebarReconcilePill.logic";

const reconcileTasksAtom = environmentAtomList("web-sidebar-reconcile-tasks", (environmentId) =>
  serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
);
const reconcilePermissionsAtom = environmentAtomList(
  "web-sidebar-reconcile-permissions",
  serverEnvironment.runScheduledTaskNow.permissionAtom,
);

export function SidebarReconcilePill() {
  const { environments } = useEnvironments();
  const nowMs = useNowMinuteMs();
  const [isRequestPending, setIsRequestPending] = useState(false);
  const runNow = useAtomCommand(serverEnvironment.runScheduledTaskNow, {
    label: "upstream reconcile run now",
    reportFailure: false,
  });

  const connected = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" && environment.serverConfig !== null,
  );
  const key = environmentIdsKey(connected.map(({ environmentId }) => environmentId));
  const queries = useAtomValue(reconcileTasksAtom(key));
  const permissions = useAtomValue(reconcilePermissionsAtom(key));
  const target = resolveReconcileTarget(
    connected.map((environment, index) => ({
      environmentId: environment.environmentId,
      label: environment.label,
      tasks: AsyncResult.getOrElse(queries[index]!, () => null)?.tasks ?? null,
      canRun: permissions[index] === true,
    })),
  );
  if (target === null) return null;

  const running = isReconcileRunning(target.task, isRequestPending);
  const tooltip = getReconcileTooltip(target, isRequestPending, nowMs);

  const handleClick = async () => {
    if (running) return;
    try {
      const confirmed = await ensureLocalApi().dialogs.confirm(RECONCILE_CONFIRMATION_MESSAGE);
      if (!confirmed) return;
      setIsRequestPending(true);
      const result = await runNow({
        environmentId: target.environmentId,
        input: { id: target.task.id },
      });
      if (result._tag === "Success") {
        toastManager.add(
          stackedThreadToast({
            type: "success",
            title: "Reconcile started",
            description: `Running on ${target.label}.`,
          }),
        );
      } else if (!isAtomCommandInterrupted(result)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not start reconcile",
            description: String(squashAtomCommandFailure(result)),
          }),
        );
      }
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not start reconcile",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        }),
      );
    } finally {
      setIsRequestPending(false);
    }
  };

  return (
    // The update pill drops its own auto margin when it follows this one, so the two sit together.
    <SidebarMenuItem data-sidebar-reconcile className="ml-auto shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={tooltip.replace("\n", ". ")}
              aria-disabled={running || undefined}
              className={cn(
                "inline-flex size-8 items-center justify-center rounded-full text-(--sidebar-icon-color) outline-hidden ring-ring transition-colors focus-visible:ring-2 focus-visible:ring-inset",
                running
                  ? "cursor-not-allowed"
                  : "cursor-pointer hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
              )}
              onClick={() => void handleClick()}
            >
              {running ? <Spinner size="md" /> : <PullRequestGlyph.merged className="size-4" />}
            </button>
          }
        />
        <TooltipPopup align="center" side="top">
          <span className="whitespace-pre-line">{tooltip}</span>
        </TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}
