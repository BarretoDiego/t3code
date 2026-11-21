import { memo, useState, useSyncExternalStore, type SyntheticEvent } from "react";
import type { ScopedThreadRef } from "@t3tools/plugin-sdk/contracts";
import type {
  PluginThreadShell,
  SidebarThreadRowContributionProps,
  WebPluginHost,
} from "@t3tools/plugin-sdk/web";

import {
  buildThreadNesting,
  flattenThreadNesting,
  markRunningSubagents,
  resolveSubthreadStatusLabel,
  resolveThreadNestingExpanded,
  resolveThreadNestingSignal,
  sameNestedChildren,
  THREAD_NESTING_CHILD_LIMIT,
  type ThreadNesting,
  type ThreadNestingNode,
  type ThreadNestingRow,
  type ThreadNestingSummary,
} from "./threadNesting.ts";

type Shell = PluginThreadShell & { readonly subagentRunning?: boolean };
type Node = ThreadNestingNode<Shell>;
type NestedAttention = "approval" | "input" | "failed" | "unread" | "working";

const NO_KEYS: ReadonlySet<string> = new Set();
const STORAGE_KEY = "t3code:plugin:subagent-nesting:expanded:v1";

const keyOf = (ref: ScopedThreadRef) => `${ref.environmentId}:${ref.threadId}`;

// One forest per shell list, shared by every row.
let forestSource: readonly PluginThreadShell[] | null = null;
let forest: ThreadNesting<Shell> = { roots: [], nodeByKey: new Map() };
function forestFor(threads: readonly PluginThreadShell[]): ThreadNesting<Shell> {
  if (threads !== forestSource) {
    forestSource = threads;
    // Side chats open from their parent's panel and archived threads leave the list.
    forest = buildThreadNesting<Shell>({
      threads: markRunningSubagents<Shell>(threads),
      isListed: (thread) => thread.archivedAt === null && thread.lineage.sideChat !== true,
    });
  }
  return forest;
}

// A row keeps its node while its nested rows are unchanged, so an update elsewhere skips it.
const lastNodeByKey = new Map<string, Node | null>();
function selectRowNode(threads: readonly PluginThreadShell[], key: string): Node | null {
  const node = forestFor(threads).nodeByKey.get(key) ?? null;
  const next = node === null || node.parentKey !== null || node.summary === null ? null : node;
  const previous = lastNodeByKey.get(key) ?? null;
  if (previous !== null && next !== null && sameNestedChildren(previous, next)) return previous;
  lastNodeByKey.set(key, next);
  return next;
}

function useRowNode({ threadRef, threads }: SidebarThreadRowContributionProps): Node | null {
  const key = keyOf(threadRef);
  return useSyncExternalStore(threads.subscribe, () => selectRowNode(threads.get(), key));
}

/** The user's show/hide choice per parent and per settled group, kept in this browser. */
function readExpanded(): Readonly<Record<string, boolean>> {
  try {
    const parsed: unknown = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) ?? "{}");
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}
let expandedByKey = readExpanded();
const expandedListeners = new Set<() => void>();
function subscribeExpanded(listener: () => void) {
  expandedListeners.add(listener);
  return () => {
    expandedListeners.delete(listener);
  };
}
function setExpanded(key: string, expanded: boolean) {
  expandedByKey = { ...expandedByKey, [key]: expanded };
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(expandedByKey));
  } catch {
    // Storage can be unavailable; the choice still holds for this session.
  }
  for (const listener of expandedListeners) listener();
}
// Snooze ends on a wall-clock boundary; a minute tick is enough and runs only while rows show.
const minuteListeners = new Set<() => void>();
let minuteTimer: ReturnType<typeof setInterval> | null = null;
let nowMinute = new Date().toISOString();
function subscribeMinute(listener: () => void) {
  minuteListeners.add(listener);
  // A clock stopped while nothing showed is stale; React re-reads the snapshot after subscribing.
  if (minuteTimer === null) nowMinute = new Date().toISOString();
  minuteTimer ??= setInterval(() => {
    nowMinute = new Date().toISOString();
    for (const each of minuteListeners) each();
  }, 60_000);
  return () => {
    minuteListeners.delete(listener);
    if (minuteListeners.size === 0 && minuteTimer !== null) {
      clearInterval(minuteTimer);
      minuteTimer = null;
    }
  };
}
const useNowMinute = () => useSyncExternalStore(subscribeMinute, () => nowMinute);

const useExpandedOverrides = () => useSyncExternalStore(subscribeExpanded, () => expandedByKey);

function summaryLabel(summary: ThreadNestingSummary): string {
  const { approval, input, failed, working } = summary.counts;
  return [
    `${summary.total} ${summary.total === 1 ? "subagent" : "subagents"}`,
    approval > 0 ? `${approval} awaiting approval` : null,
    input > 0 ? `${input} awaiting input` : null,
    failed > 0 ? `${failed} failed` : null,
    working > 0 ? `${working} working` : null,
  ]
    .filter((part) => part !== null)
    .join(", ");
}

/** The open thread and the rows between it and `node`, so a collapsed parent still draws it. */
function activePathKeys(node: Node, routeKey: string | null): ReadonlySet<string> {
  if (routeKey === null) return NO_KEYS;
  const path: string[] = [];
  const visit = (current: Node): boolean => {
    for (const child of current.children) {
      path.push(child.key);
      if (child.key === routeKey || visit(child)) return true;
      path.pop();
    }
    return false;
  };
  return visit(node) ? new Set(path) : NO_KEYS;
}

function hasUnseenCompletion(thread: Shell): boolean {
  const completedAt = thread.latestRun?.completedAt;
  if (!completedAt || !thread.lastVisitedAt) return false;
  if (thread.latestRun?.status === "interrupted" || thread.latestRun?.status === "cancelled")
    return false;
  const completed = Date.parse(completedAt);
  const visited = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(completed)) return false;
  return Number.isNaN(visited) || completed > visited;
}

// Nested rows belong to their parent's row: a press here must not drag, open, or show its menu.
const stop = (event: SyntheticEvent) => event.stopPropagation();

const Chevron = ({ open }: { open: boolean }) => (
  <svg aria-hidden viewBox="0 0 24 24" className="t3sn-icon">
    <path d={open ? "m6 9 6 6 6-6" : "m9 18 6-6-6-6"} />
  </svg>
);
const CornerDownRight = () => (
  <svg aria-hidden viewBox="0 0 24 24" className="t3sn-icon t3sn-faint">
    <path d="m15 10 5 5-5 5" />
    <path d="M4 4v7a4 4 0 0 0 4 4h12" />
  </svg>
);
const Dot = ({ attention }: { attention: NestedAttention }) => (
  <span aria-hidden className="t3sn-dot" data-attention={attention} />
);

function NestedToggle({
  threadKey,
  summary,
}: {
  threadKey: string;
  summary: ThreadNestingSummary;
}) {
  const override = useExpandedOverrides()[threadKey];
  const expanded = resolveThreadNestingExpanded(summary, override);
  const label = summaryLabel(summary);
  return (
    <button
      type="button"
      className="t3sn-toggle"
      aria-expanded={expanded}
      aria-label={`${expanded ? "Hide" : "Show"} ${label}`}
      onPointerDown={stop}
      onDoubleClick={stop}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setExpanded(threadKey, !expanded);
      }}
    >
      <Chevron open={expanded} />
      {summary.signal !== null ? <Dot attention={summary.signal} /> : null}
      <CornerDownRight />
      {summary.total}
    </button>
  );
}

const NestedThreadRow = memo(function NestedThreadRow(props: {
  row: Extract<ThreadNestingRow<Shell>, { kind: "thread" }>;
  isActive: boolean;
  open: (thread: Shell) => void;
}) {
  const { row, isActive, open } = props;
  const thread = row.thread;
  const attention: NestedAttention | null =
    resolveThreadNestingSignal(thread) ?? (hasUnseenCompletion(thread) ? "unread" : null);
  const status = resolveSubthreadStatusLabel(thread, useNowMinute());
  return (
    <li className="t3sn-item">
      <div
        role="button"
        tabIndex={0}
        className="t3sn-row"
        data-depth={Math.min(row.depth, 4)}
        data-active={isActive || undefined}
        data-attention={attention ?? undefined}
        aria-current={isActive ? "page" : undefined}
        aria-label={`${thread.title}, ${status}`}
        onClick={() => open(thread)}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget || event.key !== "Enter") return;
          event.preventDefault();
          open(thread);
        }}
      >
        {attention !== null ? <Dot attention={attention} /> : null}
        <CornerDownRight />
        <span dir="auto" className="t3sn-title">
          {thread.title}
        </span>
        {row.summary !== null ? <NestedToggle threadKey={row.key} summary={row.summary} /> : null}
        <span aria-hidden className="t3sn-status">
          {status}
        </span>
      </div>
    </li>
  );
});

function NestedThreadList(props: {
  node: Node;
  activeThreadRef: ScopedThreadRef | null;
  open: (thread: Shell) => void;
}) {
  const { node, activeThreadRef, open } = props;
  const overrides = useExpandedOverrides();
  const routeKey = activeThreadRef === null ? null : keyOf(activeThreadRef);
  // Opening a long child list in full is a glance: it does not outlive the session.
  const [showAllKeys, setShowAllKeys] = useState<ReadonlySet<string>>(NO_KEYS);
  const display = flattenThreadNesting({
    node,
    expandedOverrides: overrides,
    activePathKeys: activePathKeys(node, routeKey),
    childLimit: THREAD_NESTING_CHILD_LIMIT,
    showAllKeys,
  });
  if (display === null || display.rows.length === 0) return null;
  return (
    <ul
      role="group"
      aria-label="Subagents"
      className="t3sn-list"
      onPointerDown={stop}
      onClick={stop}
      onDoubleClick={stop}
      onContextMenu={stop}
    >
      {display.rows.map((row) =>
        row.kind === "settled" ? (
          <li key={row.key} className="t3sn-item">
            <button
              type="button"
              className="t3sn-row t3sn-group"
              data-depth={Math.min(row.depth, 4)}
              aria-expanded={row.expanded}
              onClick={() => setExpanded(row.key, !row.expanded)}
            >
              <Chevron open={row.expanded} />
              Settled <span className="t3sn-count">({row.count})</span>
            </button>
          </li>
        ) : row.kind === "more" ? (
          <li key={row.key} className="t3sn-item">
            <button
              type="button"
              className="t3sn-row t3sn-group"
              data-depth={Math.min(row.depth, 4)}
              onClick={() => setShowAllKeys((current) => new Set(current).add(row.parentKey))}
            >
              Show {row.hiddenCount} more
            </button>
          </li>
        ) : (
          <NestedThreadRow key={row.key} row={row} isActive={row.key === routeKey} open={open} />
        ),
      )}
    </ul>
  );
}

const CSS = `
.t3sn-icon { width: 0.75rem; height: 0.75rem; flex-shrink: 0; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.t3sn-faint { opacity: 0.6; }
.t3sn-dot { width: 0.375rem; height: 0.375rem; flex-shrink: 0; border-radius: 9999px; background: var(--color-info); }
.t3sn-dot[data-attention="approval"] { background: var(--color-warning); }
.t3sn-dot[data-attention="input"] { background: var(--color-primary); }
.t3sn-dot[data-attention="failed"] { background: var(--color-error); }
.t3sn-dot[data-attention="unread"] { background: var(--color-success); }
.t3sn-toggle { display: inline-flex; height: 1.25rem; flex-shrink: 0; align-items: center; gap: 0.25rem; border-radius: 0.125rem; padding: 0 0.25rem; font-size: 0.75rem; font-variant-numeric: tabular-nums; color: var(--color-secondary-label); cursor: pointer; outline: none; }
.t3sn-toggle:hover { background: var(--color-sidebar-row-hover); color: var(--color-foreground); }
.t3sn-toggle:focus-visible, .t3sn-row:focus-visible { box-shadow: inset 0 0 0 2px var(--color-ring); }
.t3sn-list { margin: 0.125rem 0 0.25rem 1rem; display: flex; flex-direction: column; gap: 1px; border-left: 1px solid var(--color-sidebar-border); }
.t3sn-item { list-style: none; }
.t3sn-row { display: flex; height: 1.75rem; width: 100%; align-items: center; gap: 0.375rem; border-radius: 0.375rem; padding: 0 0.5rem 0 0.5rem; text-align: left; font-size: 0.75rem; color: var(--color-secondary-label); cursor: pointer; user-select: none; outline: none; }
.t3sn-row[data-depth="2"] { padding-left: 1.5rem; }
.t3sn-row[data-depth="3"] { padding-left: 2.5rem; }
.t3sn-row[data-depth="4"] { padding-left: 3.5rem; }
.t3sn-row:hover { background: var(--color-sidebar-row-hover); color: var(--color-sidebar-foreground); }
.t3sn-row[data-attention] { color: var(--color-sidebar-foreground); }
.t3sn-row[data-active] { background: var(--color-sidebar-row-active); color: var(--color-sidebar-foreground); }
.t3sn-group { height: 1.5rem; gap: 0.25rem; }
.t3sn-title { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.t3sn-status { flex-shrink: 0; color: var(--color-secondary-label); }
.t3sn-count { font-variant-numeric: tabular-nums; }
`;

export function activate(host: WebPluginHost) {
  const open = (thread: Shell) => {
    // Plugin navigation is bound to this plugin's environment, which is the row's.
    if (thread.environmentId !== host.environmentId) return;
    host.navigation.open(
      `/${encodeURIComponent(thread.environmentId)}/${encodeURIComponent(thread.id)}`,
    );
  };

  /** The count beside a parent's title, with the most urgent child's dot; it shows or hides them. */
  function Accessory(props: SidebarThreadRowContributionProps) {
    const node = useRowNode(props);
    if (node === null || node.summary === null) return null;
    return <NestedToggle threadKey={node.key} summary={node.summary} />;
  }

  /** The subagent rows under a top-level row, on a tree rail. */
  function Children(props: SidebarThreadRowContributionProps) {
    const node = useRowNode(props);
    if (node === null) return null;
    return <NestedThreadList node={node} activeThreadRef={props.activeThreadRef} open={open} />;
  }

  host.style(CSS);
  host.register<SidebarThreadRowContributionProps>([
    { slot: "sidebar.thread.row.accessories", id: "subagent-count", component: Accessory },
    { slot: "sidebar.thread.row.children", id: "subagents", component: Children },
  ]);
}
