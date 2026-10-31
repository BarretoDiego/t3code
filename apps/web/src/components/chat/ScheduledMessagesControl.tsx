import type { EnvironmentId, ScheduledMessage, ThreadId } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { formatRateLimitResetCountdown } from "@t3tools/shared/providerRateLimits";
import { ArrowUpIcon, CalendarClockIcon, PencilIcon, XIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { QueuedMessage } from "./QueuedRunsControl";
import { requestScheduleSend } from "./ScheduleSendDialog";
import type { ScheduleWindowOption } from "./scheduleSend.logic";

type ScheduledMessageAction = "cancel" | "send" | "reschedule" | "edit";

/**
 * Messages the environment holds for this thread until their send time, laid
 * out like the queue: a dashed bubble per message with its actions beneath.
 * The server dispatches them on its own, so nothing here has to stay open.
 */
export function ScheduledMessagesControl(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** The selected provider's open limit windows, offered when moving a send time. */
  readonly windows: ReadonlyArray<ScheduleWindowOption>;
  /** Older servers cannot store an edited message. */
  readonly canEdit: boolean;
  readonly timestampFormat: TimestampFormat;
  readonly onOpenThread: (threadId: ThreadId) => void;
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
  const [busyCommandId, setBusyCommandId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ commandId: string; text: string } | null>(null);
  const listId = useId();
  const [nowMs, setNowMs] = useState(() => Date.now());
  const hasScheduledMessages = scheduledMessages.length > 0;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- ticks the countdown on an interval and on visibilitychange (background tabs throttle timers); both cleared on cleanup
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
    extra: { readonly sendAt?: string; readonly text?: string } = {},
  ): Promise<boolean> => {
    setBusyCommandId(entry.command.commandId);
    const result = await updateScheduledMessage({
      environmentId: props.environmentId,
      input: {
        threadId: entry.command.threadId,
        commandId: entry.command.commandId,
        action,
        ...extra,
      },
    });
    setBusyCommandId(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not update the scheduled message",
        description: error instanceof Error ? error.message : undefined,
      });
    }
    return result._tag === "Success";
  };

  const reschedule = async (entry: ScheduledMessage) => {
    const choice = await requestScheduleSend({
      initialSendAt: entry.sendAt,
      windows: props.windows,
    });
    if (!choice) return;
    // Removing the schedule from the dialog means "stop waiting": send it now.
    await (choice.sendAt
      ? update(entry, "reschedule", { sendAt: choice.sendAt })
      : update(entry, "send"));
  };

  const saveEdit = async (entry: ScheduledMessage, text: string) => {
    if (await update(entry, "edit", { text })) setEditing(null);
  };

  const busy = busyCommandId !== null;
  return (
    <section
      aria-label={`${scheduledMessages.length} scheduled message${scheduledMessages.length === 1 ? "" : "s"}`}
      data-thread-queue="true"
      className="relative mx-auto flex w-full max-w-(--chat-content-max-width) flex-col gap-2 pb-4"
    >
      <span className="sr-only" aria-live="polite">
        {scheduledMessages.length} scheduled
      </span>
      <ol className="flex flex-col items-end gap-3" id={listId}>
        {scheduledMessages.map((entry, position) => {
          const { command } = entry;
          const attachmentCount = command.attachments.length;
          const previewText = replaceComposerContextReferences(
            command.text,
            (reference) => reference.label,
          ).trim();
          const isEditing = editing?.commandId === command.commandId;
          const countdown = formatRateLimitResetCountdown(entry.sendAt, nowMs);
          const sendAtLabel = new Date(entry.sendAt).toLocaleString();
          const draft = isEditing ? editing.text : "";
          const canSave =
            draft.trim().length > 0 || attachmentCount > 0 ? draft.trim() !== command.text : false;
          return (
            <li
              key={command.commandId}
              aria-label={`Scheduled message ${position + 1} of ${scheduledMessages.length}, not sent`}
              aria-posinset={position + 1}
              aria-setsize={scheduledMessages.length}
              aria-current={isEditing ? "true" : undefined}
              className="group/queued flex w-full flex-col items-end gap-1 transition-opacity duration-150 ease-out starting:opacity-0 motion-reduce:transition-none"
            >
              <QueuedMessage
                environmentId={props.environmentId}
                message={undefined}
                previewText={
                  previewText || `${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"}`
                }
                thumbnails={[]}
                isEditing={isEditing}
                timestampFormat={props.timestampFormat}
                onOpenThread={props.onOpenThread}
                editor={
                  isEditing ? (
                    <Textarea
                      autoFocus
                      aria-label="Edit scheduled message"
                      className="min-h-20"
                      value={draft}
                      onChange={(event) =>
                        setEditing({ commandId: command.commandId, text: event.target.value })
                      }
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          event.stopPropagation();
                          setEditing(null);
                        } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                          event.preventDefault();
                          if (canSave && !busy) void saveEdit(entry, draft);
                        }
                      }}
                    />
                  ) : undefined
                }
              >
                {isEditing ? (
                  <>
                    <span className="px-1 text-foreground">Editing</span>
                    <Button
                      size="xs"
                      variant="ghost"
                      aria-label="Cancel editing scheduled message"
                      onClick={() => setEditing(null)}
                    >
                      Cancel
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost-muted"
                      disabled={!canSave || busy}
                      onClick={() => void saveEdit(entry, draft)}
                    >
                      Save
                    </Button>
                  </>
                ) : (
                  <>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <span
                            className={`flex shrink-0 items-center gap-1 px-1 tabular-nums ${entry.error ? "text-destructive" : ""}`}
                          />
                        }
                      >
                        <CalendarClockIcon aria-hidden className="size-3" />
                        {entry.error ? "Not sent" : countdown ? `Sends in ${countdown}` : "Sending"}
                      </TooltipTrigger>
                      <TooltipPopup side="top" className="max-w-96 break-words">
                        {entry.error ? `Could not send: ${entry.error}` : `Sends ${sendAtLabel}`}
                      </TooltipPopup>
                    </Tooltip>
                    {entry.error ? null : (
                      <>
                        <Tooltip>
                          <TooltipTrigger render={<span className="flex shrink-0" />}>
                            <Button
                              size="xs"
                              variant="ghost-muted"
                              disabled={busy}
                              onClick={() => void update(entry, "send")}
                            >
                              <ArrowUpIcon />
                              Send now
                            </Button>
                          </TooltipTrigger>
                          <TooltipPopup>Send this message now</TooltipPopup>
                        </Tooltip>
                        {props.canEdit ? (
                          <Tooltip>
                            <TooltipTrigger render={<span className="flex shrink-0" />}>
                              <Button
                                size="icon-xs"
                                variant="ghost-muted"
                                aria-label="Edit scheduled message"
                                disabled={busy || editing !== null}
                                onClick={() =>
                                  setEditing({ commandId: command.commandId, text: command.text })
                                }
                              >
                                <PencilIcon />
                              </Button>
                            </TooltipTrigger>
                            <TooltipPopup>Edit message</TooltipPopup>
                          </Tooltip>
                        ) : null}
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
                      </>
                    )}
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            size="icon-xs"
                            variant="ghost-muted"
                            aria-label="Cancel scheduled message"
                            disabled={busy}
                            onClick={() => void update(entry, "cancel")}
                          />
                        }
                      >
                        <XIcon />
                      </TooltipTrigger>
                      <TooltipPopup>Cancel scheduled message</TooltipPopup>
                    </Tooltip>
                  </>
                )}
              </QueuedMessage>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
