import { useClientSettings } from "../../hooks/useSettings";
import type { ThreadNestingRow } from "@t3tools/client-runtime/state/thread-relationships";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";

export function ThreadNestedSettledHeader(props: {
  readonly row: Extract<ThreadNestingRow<unknown>, { kind: "settled" }>;
  readonly onToggle: (key: string, expanded: boolean) => void;
}) {
  const { row, onToggle } = props;
  const showAllSubthreads = useClientSettings((settings) => settings.sidebarShowAllSubthreads);
  const Chevron = row.expanded ? ChevronDownIcon : ChevronRightIcon;
  return (
    <button
      type="button"
      aria-label={`Settled subagents (${row.count})`}
      aria-expanded={row.expanded}
      disabled={showAllSubthreads}
      onClick={() => onToggle(row.key, !row.expanded)}
      style={{ paddingLeft: Math.min(row.depth, 5) * 8 }}
      className="flex h-6 w-full cursor-pointer items-center gap-1 rounded-md pr-2 text-left text-xs text-secondary-label outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
    >
      <Chevron className="size-3" aria-hidden="true" />
      Settled <span className="tabular-nums">({row.count})</span>
    </button>
  );
}
