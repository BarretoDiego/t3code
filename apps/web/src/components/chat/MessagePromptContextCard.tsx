import type { MessagePromptContext } from "@t3tools/contracts";

export function MessagePromptContextCard({ context }: { context: MessagePromptContext }) {
  return (
    <details className="mb-3 min-w-0 rounded-lg border border-border/70 bg-background/40 text-xs">
      <summary className="cursor-pointer space-y-2 px-3 py-2 marker:text-muted-foreground">
        <span className="font-medium">Applied context</span>
        <span className="flex flex-wrap gap-1.5">
          {context.profileName && (
            <span className="rounded bg-primary/10 px-2 py-1 text-primary">
              Profile · {context.profileName}
            </span>
          )}
          {context.threadSkills.map((name) => (
            <span key={name} className="rounded bg-muted px-2 py-1">
              Thread skill · {name}
            </span>
          ))}
          {context.requestSkills.map((name) => (
            <span key={name} className="rounded bg-muted px-2 py-1">
              Mini Skill · {name}
            </span>
          ))}
        </span>
      </summary>
      <div className="border-t border-border/70 px-3 py-2">
        <p className="mb-2 text-muted-foreground">
          Prompt sent to the agent, including the profile wrapper and applied instructions.
        </p>
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">
          {context.prompt}
        </pre>
      </div>
    </details>
  );
}
