import { ChevronDownIcon, LayersIcon, SparklesIcon, UserCogIcon } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { MessagePromptContext } from "@t3tools/contracts";

import { cn } from "~/lib/utils";

/**
 * Visibility strip for prompt additions: which profile and mini skills were
 * appended to a user message before it went to the agent. The chips are
 * always visible; the full composed prompt stays one click away.
 */
export function MessagePromptContextCard({ context }: { context: MessagePromptContext }) {
  return (
    <details className="group/prompt-context mb-2 min-w-0 rounded-lg border border-border/70 bg-background/60 text-xs">
      <summary
        className="flex cursor-pointer list-none flex-wrap items-center gap-1.5 px-2.5 py-2 [&::-webkit-details-marker]:hidden"
        aria-label="Prompt additions sent with this message"
      >
        <LayersIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-medium text-muted-foreground">Also sent:</span>
        {context.profileName ? (
          <PromptContextChip accent icon={UserCogIcon} label={context.profileName} />
        ) : null}
        {context.threadSkills.map((name) => (
          <PromptContextChip key={`thread:${name}`} icon={SparklesIcon} label={name} />
        ))}
        {context.requestSkills.map((name) => (
          <PromptContextChip key={`request:${name}`} icon={SparklesIcon} label={name} />
        ))}
        <span className="ms-auto flex shrink-0 items-center gap-1 text-muted-foreground/70">
          Full prompt
          <ChevronDownIcon className="size-3 transition-transform group-open/prompt-context:rotate-180" />
        </span>
      </summary>
      <div className="border-t border-border/70 px-2.5 py-2">
        <p className="mb-2 text-muted-foreground">
          Prompt sent to the agent, including the profile wrapper and applied instructions.
        </p>
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words font-mono text-muted-foreground text-xs">
          {context.prompt}
        </pre>
      </div>
    </details>
  );
}

function PromptContextChip(props: {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly accent?: boolean;
}) {
  const Icon = props.icon;
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5",
        props.accent
          ? "border-primary/30 bg-primary/10 text-primary"
          : "border-border/70 bg-muted/60 text-foreground/85",
      )}
    >
      <Icon className="size-3 shrink-0" />
      <span className="truncate">{props.label}</span>
    </span>
  );
}
