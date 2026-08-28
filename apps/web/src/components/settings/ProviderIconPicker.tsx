"use client";

import { XIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PROVIDER_ICON_CHOICES, resolveProviderIconChoice } from "../providerIcons";
import { cn } from "../../lib/utils";

function ProviderIconPickerPanel(props: {
  readonly value: string | undefined;
  readonly onCommit: (value: string | undefined) => void;
}) {
  return (
    <div className="w-72 bg-popover">
      <ScrollArea className="h-56">
        <div className="grid grid-cols-6 gap-1 p-2">
          {PROVIDER_ICON_CHOICES.map((choice) => (
            <Tooltip key={choice.key}>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    className={cn(
                      "flex size-10 cursor-pointer items-center justify-center rounded-md text-foreground/80 transition-colors hover:bg-muted",
                      props.value === choice.key && "bg-muted ring-1 ring-ring text-foreground",
                    )}
                    onClick={() =>
                      props.onCommit(props.value === choice.key ? undefined : choice.key)
                    }
                    aria-label={`Use ${choice.label} icon`}
                    aria-pressed={props.value === choice.key}
                  >
                    <choice.Icon className="size-5" aria-hidden />
                  </button>
                }
              />
              <TooltipPopup side="bottom">{choice.label}</TooltipPopup>
            </Tooltip>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

/**
 * Popover grid that lets a provider instance override its driver icon with any
 * AI brand icon from @lobehub/icons. The selection persists as a plain string
 * key on `ProviderInstanceConfig.icon`.
 */
export function ProviderIconPicker(props: {
  readonly displayName: string;
  readonly value: string | undefined;
  readonly onCommit: (value: string | undefined) => void;
  readonly description?: string;
}) {
  const selected = resolveProviderIconChoice(props.value);

  return (
    <div className="grid gap-2">
      <span className="text-xs font-medium text-foreground">Icon</span>
      <div className="flex min-w-0 items-center gap-2">
        <Popover>
          <PopoverTrigger
            render={
              <button
                type="button"
                className={cn(
                  "flex size-9 cursor-pointer items-center justify-center rounded-lg border border-border/70 bg-card text-foreground/80 transition-colors hover:bg-muted/60",
                )}
                aria-label={`Choose an icon for ${props.displayName}`}
              >
                {selected ? (
                  <selected.Icon className="size-5" aria-hidden />
                ) : (
                  <span className="text-[10px] font-medium text-muted-foreground">Auto</span>
                )}
              </button>
            }
          />
          <PopoverPopup
            side="bottom"
            align="start"
            sideOffset={6}
            className="overflow-hidden rounded-md p-0 [--viewport-inline-padding:0px] [&_[data-slot=popover-viewport]]:p-0"
          >
            <ProviderIconPickerPanel value={props.value} onCommit={props.onCommit} />
          </PopoverPopup>
        </Popover>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {selected ? selected.label : "Driver default"}
        </span>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className={cn(
            "size-7 shrink-0 text-muted-foreground transition-opacity",
            selected ? "opacity-100" : "pointer-events-none opacity-0",
          )}
          onClick={() => props.onCommit(undefined)}
          aria-label={`Clear custom icon for ${props.displayName}`}
          aria-hidden={!selected}
          tabIndex={selected ? 0 : -1}
        >
          <XIcon className="size-3.5" aria-hidden />
        </Button>
      </div>
      {props.description ? (
        <span className="text-xs text-muted-foreground">{props.description}</span>
      ) : null}
    </div>
  );
}
