import type { EnvironmentId, ScheduledMessage, ThreadId } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { formatRateLimitResetCountdown } from "@t3tools/shared/providerRateLimits";
import { ArrowUpIcon, CalendarClockIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerBanner } from "./ComposerBanner";
import { requestScheduleSend } from "./ScheduleSendDialog";

type ScheduledMessageAction = "cancel" | "send" | "reschedule";

/**
 * Messages the environment holds for this thread until their send time. The
 * server dispatches them on its own, so nothing here has to stay open; the
 * list only lets the user send one now, move it, or drop it.
 */
export function ScheduledMessagesControl(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const scheduledMessages =
    useEnvironmentQuery(
      threadEnvironment.scheduledMessages({
        environmentId: props.environmentId,
        input: { threadId: props.threadId },
      }),
    ).data ?? [];
  const updateScheduledMessage = useAtomCommand(threadEnvironment.updateScheduledMessage, {
    reportFailure: false,
  });
  const [expanded, setExpanded] = useState(true);
  const [busyCommandId, setBusyCommandId] = useState<string | null>(null);
  const listId = useId();
  const [nowMs, setNowMs] = useState(() => Date.now());
  const hasScheduledMessages = scheduledMessages.length > 0;
  useEffect(() => {
    if (!hasScheduledMessages) return;
    const syncNow = () => setNowMs(Date.now());
    const timer = window.setInterval(syncNow, 1_000);
    // Browsers throttle intervals in background tabs. The server owns sending,
    // but the countdown catches up as soon as the tab is visible again.
    document.addEventListener("visibilitychange", syncNow);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", syncNow);
    };
  }, [hasScheduledMessages]);

  if (!hasScheduledMessages) return null;

  const update = async (
    entry: ScheduledMessage,
    action: ScheduledMessageAction,
    sendAt?: string,
  ): Promise<void> => {
    setBusyCommandId(entry.command.commandId);
    try {
      const result = await updateScheduledMessage({
        environmentId: props.environmentId,
        input: {
          threadId: entry.command.threadId,
          commandId: entry.command.commandId,
          action,
          ...(sendAt === undefined ? {} : { sendAt }),
        },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Could not update the scheduled message",
          description: error instanceof Error ? error.message : undefined,
        });
      }
    } finally {
      setBusyCommandId(null);
    }
  };

  const reschedule = async (entry: ScheduledMessage) => {
    const choice = await requestScheduleSend(entry.sendAt);
    if (!choice) return;
    // Removing the schedule from the dialog means "stop waiting": send it now.
    await (choice.sendAt ? update(entry, "reschedule", choice.sendAt) : update(entry, "send"));
  };

  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root
        role="region"
        aria-label={`${scheduledMessages.length} scheduled message${scheduledMessages.length === 1 ? "" : "s"}`}
        data-chat-composer-collapsed-controls="true"
        className="relative z-0"
      >
        <ComposerBanner.Row
          render={<button type="button" />}
          aria-label={expanded ? "Collapse scheduled messages" : "Expand scheduled messages"}
          aria-expanded={expanded}
          aria-controls={listId}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => setExpanded((value) => !value)}
        >
          <ComposerBanner.Icon>
            <CalendarClockIcon />
          </ComposerBanner.Icon>
          <ComposerBanner.Content className="text-muted-foreground">
            Scheduled
          </ComposerBanner.Content>
          <ComposerBanner.Actions>
            <ComposerBanner.Count>{scheduledMessages.length}</ComposerBanner.Count>
            <ComposerBanner.ToggleIcon expanded={expanded} />
          </ComposerBanner.Actions>
        </ComposerBanner.Row>
        <ComposerBanner.Scroll className={expanded ? "max-h-32" : "hidden"}>
          <ComposerBanner.Children render={<ol />} id={listId}>
            {scheduledMessages.map((entry) => {
              const { command } = entry;
              const attachmentCount = command.attachments.length;
              const previewText =
                replaceComposerContextReferences(command.text, (reference) => reference.label)
                  .trim()
                  .replace(/\s+/g, " ") ||
                `${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"}`;
              const countdown = formatRateLimitResetCountdown(entry.sendAt, nowMs);
              const sendAtLabel = new Date(entry.sendAt).toLocaleString();
              const busy = busyCommandId !== null;
              return (
                <ComposerBanner.Row render={<li />} key={command.commandId}>
                  <ComposerBanner.Content className="text-foreground/80">
                    <Tooltip>
                      <TooltipTrigger render={<span className="min-w-0 flex-1 truncate" />}>
                        {previewText}
                      </TooltipTrigger>
                      <TooltipPopup side="top" className="max-w-96 break-words">
                        {previewText}
                      </TooltipPopup>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger
                        render={<span className="shrink-0 text-muted-foreground tabular-nums" />}
                      >
                        {entry.error ? "Not sent" : countdown ? `Sends in ${countdown}` : "Sending"}
                      </TooltipTrigger>
                      <TooltipPopup side="top" className="max-w-96 break-words">
                        {entry.error ? `Could not send: ${entry.error}` : `Sends ${sendAtLabel}`}
                      </TooltipPopup>
                    </Tooltip>
                  </ComposerBanner.Content>
                  <ComposerBanner.Actions>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            size="icon-xs"
                            variant="ghost-muted"
                            aria-label="Change scheduled time"
                            disabled={busy}
                            onClick={() => void reschedule(entry)}
                          />
                        }
                      >
                        <CalendarClockIcon />
                      </TooltipTrigger>
                      <TooltipPopup>Change scheduled time</TooltipPopup>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            size="icon-xs"
                            variant="ghost-muted"
                            aria-label="Send now"
                            disabled={busy}
                            onClick={() => void update(entry, "send")}
                          />
                        }
                      >
                        <ArrowUpIcon />
                      </TooltipTrigger>
                      <TooltipPopup>Send now</TooltipPopup>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <ComposerBanner.Dismiss
                            aria-label="Cancel scheduled message"
                            disabled={busy}
                            onClick={() => void update(entry, "cancel")}
                          />
                        }
                      />
                      <TooltipPopup>Cancel scheduled message</TooltipPopup>
                    </Tooltip>
                  </ComposerBanner.Actions>
                </ComposerBanner.Row>
              );
            })}
          </ComposerBanner.Children>
        </ComposerBanner.Scroll>
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
}
