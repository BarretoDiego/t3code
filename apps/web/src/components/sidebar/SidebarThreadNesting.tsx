import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { SideThreadOpenIntent } from "@t3tools/client-runtime/side-thread";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  flattenThreadNesting,
  resolveSubthreadStatusLabel,
  resolveThreadNestingExpanded,
  resolveThreadNestingSignal,
  THREAD_NESTING_CHILD_LIMIT,
  type ThreadNestingNode,
  type ThreadNestingRow,
  type ThreadNestingSummary,
} from "@t3tools/client-runtime/state/thread-nesting";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { T, useGT, useMessages, Var } from "gt-react";
import { ChevronDownIcon, ChevronRightIcon, CornerDownRightIcon } from "lucide-react";
import {
  memo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { useThreadRouteRef } from "../../hooks/useThreadRouteTarget";
import { openSideThread } from "../../lib/sideChatPane";
import { cn, isMacPlatform } from "../../lib/utils";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useUiStateStore } from "../../uiStateStore";
import { hasUnseenCompletion, resolveThreadLastVisitedAt } from "../Sidebar.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useSidebar } from "../ui/sidebar";
import {
  sidebarThreadNestingNodeAtom,
  useSidebarThreadNestingStore,
} from "./sidebarThreadNestingState";

type SidebarNestingNode = ThreadNestingNode<EnvironmentThreadShell>;
type SidebarNestedThreadItem = Extract<
  ThreadNestingRow<EnvironmentThreadShell>,
  { kind: "thread" }
>;
type NestedAttention = "approval" | "input" | "failed" | "unread" | "working";

const NO_KEYS: ReadonlySet<string> = new Set();

const ATTENTION_DOT_CLASS: Record<NestedAttention, string> = {
  approval: "bg-amber-600 dark:bg-amber-300",
  input: "bg-indigo-600 dark:bg-indigo-300",
  failed: "bg-red-600 dark:bg-red-300",
  unread: "bg-success",
  working: "bg-sky-600 dark:bg-sky-400",
};

const NESTED_DEPTH_CLASS = ["pl-2", "pl-6", "pl-10", "pl-14"] as const;
function nestedDepthClass(depth: number): string {
  return NESTED_DEPTH_CLASS[Math.min(Math.max(depth, 1), NESTED_DEPTH_CLASS.length) - 1]!;
}

function useNestedSummaryLabel(summary: ThreadNestingSummary): string {
  const gt = useGT();
  const { approval, input, failed, working } = summary.counts;
  return [
    gt("{count, plural, one {{count} subagent} other {{count} subagents}}", {
      count: summary.total,
    }),
    approval > 0 ? gt("{count} awaiting approval", { count: approval }) : null,
    input > 0 ? gt("{count} awaiting input", { count: input }) : null,
    failed > 0 ? gt("{count} failed", { count: failed }) : null,
    working > 0 ? gt("{count} working", { count: working }) : null,
  ]
    .filter((part) => part !== null)
    .join(", ");
}

/** The open thread and the rows between it and `node`, so a collapsed parent still draws it. */
function activePathKeys(node: SidebarNestingNode, routeKey: string | null): ReadonlySet<string> {
  if (routeKey === null) return NO_KEYS;
  const path: string[] = [];
  const visit = (current: SidebarNestingNode): boolean => {
    for (const child of current.children) {
      path.push(child.key);
      if (child.key === routeKey || visit(child)) return true;
      path.pop();
    }
    return false;
  };
  return visit(node) ? new Set(path) : NO_KEYS;
}

function useNestedExpandedOverrides() {
  return useSidebarThreadNestingStore((state) => state.expandedByKey);
}

/**
 * The count on a parent row: how many subagents it has and the most urgent
 * thing any of them is doing, so a collapsed parent still says when one needs
 * the user. Clicking it shows or hides the nested rows.
 */
export function SidebarNestedThreadsToggle(props: { threadKey: string }) {
  const node = useAtomValue(sidebarThreadNestingNodeAtom(props.threadKey));
  if (node === null || node.summary === null) return null;
  return <NestedToggle threadKey={props.threadKey} summary={node.summary} />;
}

function NestedToggle(props: { threadKey: string; summary: ThreadNestingSummary }) {
  const { threadKey, summary } = props;
  const gt = useGT();
  const override = useSidebarThreadNestingStore((state) => state.expandedByKey[threadKey]);
  const setExpanded = useSidebarThreadNestingStore((state) => state.setExpanded);
  const expanded = resolveThreadNestingExpanded(summary, override);
  const label = useNestedSummaryLabel(summary);
  const Chevron = expanded ? ChevronDownIcon : ChevronRightIcon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            data-testid="sidebar-nested-toggle"
            aria-expanded={expanded}
            aria-label={expanded ? gt("Hide {label}", { label }) : gt("Show {label}", { label })}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setExpanded(threadKey, !expanded);
            }}
            onDoubleClick={(event) => event.stopPropagation()}
            className="inline-flex h-5 shrink-0 cursor-pointer items-center gap-1 rounded-sm px-1 text-xs tabular-nums text-secondary-label outline-none hover:bg-sidebar-row-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          />
        }
      >
        <Chevron aria-hidden className="size-3 shrink-0" />
        {summary.signal !== null ? (
          <span
            aria-hidden
            className={cn("size-1.5 shrink-0 rounded-full", ATTENTION_DOT_CLASS[summary.signal])}
          />
        ) : null}
        <CornerDownRightIcon aria-hidden className="size-3 shrink-0" />
        {summary.total}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

/** The subagent rows hanging from one top-level row, on a tree rail. */
export function SidebarNestedThreads(props: { threadKey: string; parentRef: ScopedThreadRef }) {
  const node = useAtomValue(sidebarThreadNestingNodeAtom(props.threadKey));
  if (node === null) return null;
  return <NestedThreadList node={node} parentRef={props.parentRef} />;
}

function NestedThreadList(props: { node: SidebarNestingNode; parentRef: ScopedThreadRef }) {
  const { node, parentRef } = props;
  const gt = useGT();
  const overrides = useNestedExpandedOverrides();
  const setExpanded = useSidebarThreadNestingStore((state) => state.setExpanded);
  const routeRef = useThreadRouteRef();
  const routeKey = routeRef === null ? null : scopedThreadKey(routeRef);
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
      aria-label={gt("Subagents")}
      data-testid="sidebar-nested-list"
      // Nested rows belong to their parent's row: a press here must not drag,
      // open, or show the menu of the parent.
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
      className="mt-0.5 mb-1 ml-4 flex flex-col gap-px border-l border-sidebar-border"
    >
      {display.rows.map((row) =>
        row.kind === "settled" ? (
          <li key={row.key} className="list-none">
            <button
              type="button"
              aria-expanded={row.expanded}
              onClick={() => setExpanded(row.key, !row.expanded)}
              className={cn(
                "flex h-6 w-full cursor-pointer items-center gap-1 rounded-md pr-2 text-left text-xs text-secondary-label outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                nestedDepthClass(row.depth),
              )}
            >
              {row.expanded ? (
                <ChevronDownIcon aria-hidden className="size-3" />
              ) : (
                <ChevronRightIcon aria-hidden className="size-3" />
              )}
              <T>
                Settled{" "}
                <span className="tabular-nums">
                  (<Var>{row.count}</Var>)
                </span>
              </T>
            </button>
          </li>
        ) : row.kind === "more" ? (
          <li key={row.key} className="list-none">
            <button
              type="button"
              onClick={() => setShowAllKeys((current) => new Set(current).add(row.parentKey))}
              className={cn(
                "flex h-6 w-full cursor-pointer items-center rounded-md pr-2 text-left text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                nestedDepthClass(row.depth),
              )}
            >
              <T>
                Show <Var>{row.hiddenCount}</Var> more
              </T>
            </button>
          </li>
        ) : (
          <SidebarNestedThreadRow
            key={row.key}
            row={row}
            parentRef={parentRef}
            isActive={row.key === routeKey}
            parentIsRoute={routeKey === scopedThreadKey(parentRef)}
          />
        ),
      )}
    </ul>
  );
}

/**
 * One subagent under its parent. Deliberately light: it reads only the shell
 * it is given, so a parent with dozens of children adds no git, pull request,
 * or terminal subscriptions.
 */
const SidebarNestedThreadRow = memo(function SidebarNestedThreadRow(props: {
  row: SidebarNestedThreadItem;
  parentRef: ScopedThreadRef;
  isActive: boolean;
  parentIsRoute: boolean;
}) {
  const { row, parentRef, isActive, parentIsRoute } = props;
  const thread = row.thread;
  const messages = useMessages();
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const nowMinute = useNowMinute();
  const localLastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[row.key]);
  const lastVisitedAt = resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt);
  const signal = resolveThreadNestingSignal(thread);
  const attention: NestedAttention | null =
    signal ?? (hasUnseenCompletion({ ...thread, lastVisitedAt }) ? "unread" : null);
  const statusLabel = resolveSubthreadStatusLabel(thread, `${nowMinute}:00.000Z`, messages);

  const goTo = (threadRef: ScopedThreadRef) => {
    if (isMobile) setOpenMobile(false);
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(threadRef) });
  };
  // Opens beside the parent like the Agents panel does, or in the main view as the click asks.
  const open = (intent: SideThreadOpenIntent) => {
    const target = openSideThread({
      threadRef: scopeThreadRef(thread.environmentId, thread.id),
      panelRef: parentRef,
      intent,
      navigate: goTo,
    });
    if (target === "panel" && !parentIsRoute) goTo(parentRef);
  };
  const isModified = (event: ReactMouseEvent | ReactKeyboardEvent) =>
    isMacPlatform(navigator.platform) ? event.metaKey : event.ctrlKey;

  return (
    <li className="list-none">
      <div
        role="button"
        tabIndex={0}
        data-testid="sidebar-row-nested"
        aria-current={isActive ? "page" : undefined}
        aria-label={`${thread.title}, ${statusLabel}`}
        className={cn(
          "group/sidebar-row relative flex h-7 w-full cursor-pointer items-center gap-1.5 rounded-md pr-2 text-left text-xs outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          nestedDepthClass(row.depth),
          isActive
            ? "bg-sidebar-row-active text-sidebar-foreground"
            : attention === null
              ? "text-secondary-label hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
              : "text-sidebar-foreground hover:bg-sidebar-row-hover",
        )}
        onClick={(event) => open(isModified(event) ? "alternate" : "primary")}
        onAuxClick={(event) => {
          if (event.button === 1) open("alternate");
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget || event.key !== "Enter") return;
          event.preventDefault();
          open(isModified(event) ? "alternate" : "primary");
        }}
      >
        {attention !== null ? (
          <span
            aria-hidden
            className={cn("size-1.5 shrink-0 rounded-full", ATTENTION_DOT_CLASS[attention])}
          />
        ) : null}
        <CornerDownRightIcon aria-hidden className="size-3 shrink-0 opacity-60" />
        <span dir="auto" className="min-w-0 flex-1 truncate">
          {thread.title}
        </span>
        {row.summary !== null ? <NestedToggle threadKey={row.key} summary={row.summary} /> : null}
        <span aria-hidden className="shrink-0 text-secondary-label">
          {statusLabel}
        </span>
      </div>
    </li>
  );
});
