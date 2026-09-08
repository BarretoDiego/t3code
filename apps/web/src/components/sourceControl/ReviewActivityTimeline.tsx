import { BotIcon, CheckIcon, CircleIcon, TerminalIcon } from "lucide-react";
import type { AiReviewRun } from "@t3tools/contracts";

import { streamedReviewText } from "./reviewActivityText";

export function ReviewActivityTimeline({ run }: { run: AiReviewRun }) {
  if (!run.activity?.length) return null;
  const running = !["draft", "failed", "cancelled"].includes(run.stage);
  return (
    <section
      className="overflow-hidden rounded-lg border bg-muted/10"
      aria-label="Review agent activity"
    >
      <header className="flex items-center justify-between border-b px-4 py-3">
        <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider">
          <BotIcon className="size-4" />
          Review agents
        </h3>
        <span className="text-xs text-muted-foreground">
          {running ? "Provider activity" : "Execution history"}
        </span>
      </header>
      <div className="max-h-[28rem] space-y-1 overflow-auto p-3">
        {run.activity.map((item) => {
          const writing = item.kind === "agent" ? streamedReviewText(item.text) : [];
          const active = item.status === "running" && running;
          return (
            <details
              key={item.id}
              open={active && item.kind === "agent"}
              className="rounded-md border border-transparent bg-background/70 open:border-border"
            >
              <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-xs">
                {item.kind === "tool" ? (
                  <TerminalIcon className="size-3.5" />
                ) : (
                  <BotIcon className="size-3.5" />
                )}
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.status === "completed" ? (
                  <CheckIcon className="size-3.5 text-emerald-600" />
                ) : (
                  <CircleIcon
                    className={`size-2 ${active ? "fill-amber-500 text-amber-500" : "text-muted-foreground"}`}
                  />
                )}
                <span className="text-muted-foreground">
                  {active ? "In progress" : item.status === "running" ? run.stage : item.status}
                </span>
              </summary>
              <div className="space-y-3 border-t px-3 py-3 text-sm">
                {writing.length ? (
                  writing.map((field) => (
                    <p
                      key={field.id}
                      className={
                        field.field === "title"
                          ? "font-medium"
                          : "whitespace-pre-wrap text-muted-foreground"
                      }
                    >
                      {field.text}
                    </p>
                  ))
                ) : (
                  <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
                    {(item.kind === "agent" && /^[\s`]*[[{]/.test(item.text)
                      ? "Writing the review draft…"
                      : item.text) ||
                      (active ? "Waiting for provider output." : "No public output recorded.")}
                  </p>
                )}
                {active && (
                  <p className="text-[11px] text-muted-foreground">
                    Draft findings become selectable after validation.
                  </p>
                )}
              </div>
            </details>
          );
        })}
      </div>
    </section>
  );
}
