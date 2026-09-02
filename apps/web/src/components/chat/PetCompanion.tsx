import { type ApprovalRequestId, type DesktopPetAction } from "@t3tools/contracts";
import { BellRingIcon, ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";

import type { PendingUserInput } from "../../session-logic";
import type { PendingUserInputDraftAnswer } from "../../pendingUserInput";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { useClientSettings, useUpdateClientSettings } from "~/hooks/useSettings";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";

/** A fixed companion that reuses the canonical pending-input command path. */
export const PetCompanion = memo(function PetCompanion(props: {
  readonly pendingUserInputs: PendingUserInput[];
  readonly respondingRequestIds: ApprovalRequestId[];
  readonly answers: Record<string, PendingUserInputDraftAnswer>;
  readonly questionIndex: number;
  readonly onToggleOption: (questionId: string, optionLabel: string) => void;
  readonly onAdvance: () => void;
  readonly threadId: string | null;
  readonly threadTitle: string | null;
  readonly isWorking: boolean;
}) {
  const mode = useClientSettings((settings) => settings.petCompanionMode);
  const updateClientSettings = useUpdateClientSettings();
  const [expanded, setExpanded] = useState(false);
  const needsAttention = props.pendingUserInputs.length > 0;
  const activeQuestion = props.pendingUserInputs[0]?.questions[props.questionIndex] ?? null;
  const snapshot = useMemo(
    () => ({
      enabled: mode === "always-on-top",
      state: needsAttention
        ? ("attention" as const)
        : props.isWorking
          ? ("working" as const)
          : ("idle" as const),
      petId: "amber-fox",
      threadId: props.threadId,
      threadTitle: props.threadTitle,
      requestId: props.pendingUserInputs[0]?.requestId ?? null,
      questionId: activeQuestion?.id ?? null,
      question: activeQuestion?.question ?? null,
      options: activeQuestion?.options.map((option) => ({ label: option.label })) ?? [],
    }),
    [
      activeQuestion,
      mode,
      needsAttention,
      props.isWorking,
      props.pendingUserInputs,
      props.threadId,
      props.threadTitle,
    ],
  );

  useEffect(() => {
    void window.desktopBridge?.setPetSnapshot?.(snapshot).catch(() => undefined);
  }, [snapshot]);

  useEffect(() => {
    const unsubscribe = window.desktopBridge?.onPetAction?.((action: DesktopPetAction) => {
      if (action.type === "open") setExpanded(true);
      if (action.type === "close") updateClientSettings({ petCompanionMode: "off" });
      if (
        action.type === "select-option" &&
        action.requestId === snapshot.requestId &&
        action.questionId === snapshot.questionId
      ) {
        props.onToggleOption(action.questionId, action.optionLabel);
        if (!activeQuestion?.multiSelect) {
          window.setTimeout(props.onAdvance, 200);
        }
      }
    });
    return unsubscribe;
  }, [
    activeQuestion?.multiSelect,
    props.onAdvance,
    props.onToggleOption,
    snapshot.questionId,
    snapshot.requestId,
    updateClientSettings,
  ]);

  if (mode === "off") return null;
  if (mode === "always-on-top" && window.desktopBridge?.setPetSnapshot) return null;

  return (
    <aside
      className="fixed bottom-5 right-5 z-50 flex max-w-[min(23rem,calc(100vw-2.5rem))] flex-col items-end gap-2"
      aria-label="Pet companion"
    >
      {expanded && needsAttention ? (
        <div className="w-full overflow-hidden rounded-2xl border border-border/80 bg-popover/95 shadow-xl backdrop-blur">
          <ComposerPendingUserInputPanel
            pendingUserInputs={props.pendingUserInputs}
            respondingRequestIds={props.respondingRequestIds}
            answers={props.answers}
            questionIndex={props.questionIndex}
            onToggleOption={props.onToggleOption}
            onAdvance={props.onAdvance}
          />
        </div>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        className={cn(
          "group relative h-20 w-20 rounded-full bg-transparent p-0 shadow-lg transition-transform hover:scale-105",
          needsAttention && "ring-2 ring-primary ring-offset-2 ring-offset-background",
        )}
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-label={needsAttention ? "Open pet question" : "Open pet companion"}
      >
        <img
          src="/pets/amber-fox.png"
          alt="Amber fox companion"
          draggable={false}
          className="size-full object-contain"
        />
        {needsAttention ? (
          <span className="absolute right-0 top-0 flex size-6 items-center justify-center rounded-full bg-primary text-primary-foreground shadow">
            <BellRingIcon className="size-3.5" aria-hidden />
          </span>
        ) : null}
        <span className="absolute bottom-0 right-0 flex size-5 items-center justify-center rounded-full bg-background text-muted-foreground shadow">
          {expanded ? <ChevronDownIcon className="size-3" /> : <ChevronUpIcon className="size-3" />}
        </span>
      </Button>
    </aside>
  );
});
