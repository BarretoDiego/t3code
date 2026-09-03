import { type ApprovalRequestId, type DesktopPetAction } from "@t3tools/contracts";
import { BellRingIcon, ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { PendingUserInput } from "../../session-logic";
import type { PendingUserInputDraftAnswer } from "../../pendingUserInput";
import { cn } from "~/lib/utils";
import { useClientSettings, useUpdateClientSettings } from "~/hooks/useSettings";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";

const PET_EDGE_INSET = 20;
const PET_SIZE = 88;

/** A movable, pixel-art companion with a viewport-relative resting place. */
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
  const savedPosition = useClientSettings((settings) => settings.petCompanionPosition);
  const updateClientSettings = useUpdateClientSettings();
  const [expanded, setExpanded] = useState(false);
  const [position, setPosition] = useState(savedPosition);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const dragged = useRef(false);
  const needsAttention = props.pendingUserInputs.length > 0;
  const activeQuestion = props.pendingUserInputs[0]?.questions[props.questionIndex] ?? null;

  useEffect(() => setPosition(savedPosition), [savedPosition]);

  const snapshot = useMemo(
    () => ({
      enabled: mode === "always-on-top",
      state: needsAttention
        ? ("attention" as const)
        : props.isWorking
          ? ("working" as const)
          : ("idle" as const),
      petId: "pixel-fox",
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
        if (!activeQuestion?.multiSelect) window.setTimeout(props.onAdvance, 200);
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

  const movePet = useCallback((clientX: number, clientY: number) => {
    const maxX = Math.max(PET_EDGE_INSET, window.innerWidth - PET_SIZE - PET_EDGE_INSET);
    const maxY = Math.max(PET_EDGE_INSET, window.innerHeight - PET_SIZE - PET_EDGE_INSET);
    const next = {
      x: Math.min(
        1,
        Math.max(0, (clientX - PET_SIZE / 2 - PET_EDGE_INSET) / Math.max(1, maxX - PET_EDGE_INSET)),
      ),
      y: Math.min(
        1,
        Math.max(0, (clientY - PET_SIZE / 2 - PET_EDGE_INSET) / Math.max(1, maxY - PET_EDGE_INSET)),
      ),
    };
    setPosition(next);
    return next;
  }, []);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      if (dragStart.current === null) return;
      if (
        Math.abs(event.clientX - dragStart.current.x) +
          Math.abs(event.clientY - dragStart.current.y) >
        4
      )
        dragged.current = true;
      movePet(event.clientX, event.clientY);
    };
    const onUp = (event: PointerEvent) => {
      if (dragStart.current === null) return;
      const next = movePet(event.clientX, event.clientY);
      dragStart.current = null;
      updateClientSettings({ petCompanionPosition: next });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [movePet, updateClientSettings]);

  if (mode === "off") return null;
  if (mode === "always-on-top" && window.desktopBridge?.setPetSnapshot) return null;

  const left =
    PET_EDGE_INSET + position.x * Math.max(0, window.innerWidth - PET_SIZE - PET_EDGE_INSET * 2);
  const top =
    PET_EDGE_INSET + position.y * Math.max(0, window.innerHeight - PET_SIZE - PET_EDGE_INSET * 2);

  return (
    <aside
      className="fixed z-50 flex w-[min(23rem,calc(100vw-2rem))] flex-col items-start gap-2"
      style={{ left, top }}
      aria-label="Pixel pet companion"
    >
      {expanded ? (
        <div className="relative w-full border-2 border-foreground bg-popover p-3 font-mono shadow-[5px_5px_0_var(--foreground)]">
          <span className="absolute -bottom-2 left-7 size-3 rotate-45 border-b-2 border-r-2 border-foreground bg-popover" />
          <div className="mb-3 flex items-center justify-between gap-3 text-xs uppercase tracking-wider text-muted-foreground">
            <span>
              {needsAttention ? "Mensagem do pet" : props.isWorking ? "Em missão" : "Pronto"}
            </span>
            <button
              type="button"
              className="p-1 text-muted-foreground hover:text-foreground"
              onClick={() => setExpanded(false)}
              aria-label="Minimize pet companion"
            >
              <XIcon className="size-4" />
            </button>
          </div>
          {needsAttention ? (
            <ComposerPendingUserInputPanel
              pendingUserInputs={props.pendingUserInputs}
              respondingRequestIds={props.respondingRequestIds}
              answers={props.answers}
              questionIndex={props.questionIndex}
              onToggleOption={props.onToggleOption}
              onAdvance={props.onAdvance}
            />
          ) : (
            <p className="text-sm leading-6">
              {props.threadTitle
                ? `Acompanhando: ${props.threadTitle}`
                : "Estou de olho no seu próximo passo."}
            </p>
          )}
        </div>
      ) : needsAttention ? (
        <button
          type="button"
          className="relative max-w-full border-2 border-foreground bg-popover px-3 py-2 text-left font-mono text-xs leading-5 shadow-[4px_4px_0_var(--foreground)]"
          onClick={() => setExpanded(true)}
        >
          <span className="absolute -bottom-2 right-7 size-3 rotate-45 border-b-2 border-r-2 border-foreground bg-popover" />
          {activeQuestion?.question ?? "Tenho uma pergunta para você."}
        </button>
      ) : null}
      <button
        type="button"
        className={cn(
          "group relative size-[88px] touch-none select-none rounded-none bg-transparent p-0",
          props.isWorking && "animate-[pet-pixel-bob_1.2s_steps(2,end)_infinite]",
        )}
        onPointerDown={(event) => {
          dragStart.current = { x: event.clientX, y: event.clientY };
          dragged.current = false;
        }}
        onClick={() => {
          if (dragged.current) return;
          setExpanded((value) => !value);
        }}
        aria-expanded={expanded}
        aria-label={needsAttention ? "Open pet question" : "Open pet companion"}
      >
        <img
          src="/pets/pixel-fox.png"
          alt="Pixel art fox companion"
          draggable={false}
          className="size-full object-contain [image-rendering:pixelated]"
        />
        {needsAttention ? (
          <span className="absolute right-1 top-1 flex size-6 items-center justify-center border-2 border-foreground bg-primary text-primary-foreground shadow-[2px_2px_0_var(--foreground)]">
            <BellRingIcon className="size-3.5" aria-hidden />
          </span>
        ) : null}
        <span className="absolute bottom-1 right-1 flex size-5 items-center justify-center border-2 border-foreground bg-background text-muted-foreground">
          <span className="sr-only">{expanded ? "Collapse" : "Expand"}</span>
          {expanded ? (
            <ChevronDownIcon className="size-3" aria-hidden />
          ) : (
            <ChevronUpIcon className="size-3" aria-hidden />
          )}
        </span>
      </button>
    </aside>
  );
});
