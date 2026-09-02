import { type ApprovalRequestId } from "@t3tools/contracts";
import { BellRingIcon, ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { memo, useState } from "react";

import type { PendingUserInput } from "../../session-logic";
import type { PendingUserInputDraftAnswer } from "../../pendingUserInput";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";

/** A fixed companion that reuses the canonical pending-input command path. */
export const PetCompanion = memo(function PetCompanion(props: {
  readonly pendingUserInputs: PendingUserInput[];
  readonly respondingRequestIds: ApprovalRequestId[];
  readonly answers: Record<string, PendingUserInputDraftAnswer>;
  readonly questionIndex: number;
  readonly onToggleOption: (questionId: string, optionLabel: string) => void;
  readonly onAdvance: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const needsAttention = props.pendingUserInputs.length > 0;

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
