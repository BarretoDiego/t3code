import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  resolveSubthreadStatusLabel,
  resolveThreadNestingSignal,
  type ThreadNestingSignal,
} from "@t3tools/client-runtime/state/thread-nesting";
import { useGT, useMessages } from "gt-react-native";
import { memo } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { RowPressable } from "../../components/ui/RowPressable";
import { useNowAfter } from "../../lib/clock";
import { cn } from "../../lib/cn";
import { useOpenThreadInspector } from "./thread-inspector-navigation";
import {
  selectedThreadRowColors,
  THREAD_LIST_V2_ROW_DIVIDERS,
} from "./thread-list-v2-row-appearance";
import type { ThreadListNestedListItem, ThreadListNestedSummary } from "./threadListNesting";
import { setThreadListNestedExpanded } from "./use-thread-list-nesting";

const SIGNAL_CLASS_NAME: Record<ThreadNestingSignal, string> = {
  approval: "text-warning-foreground",
  input: "text-adaptive-indigo-600-300",
  failed: "text-danger-foreground",
  working: "text-adaptive-sky-600-400",
};

/** The text colors `getThreadListV2RowAppearance` gives a row, without its theme-derived styles. */
function nestedRowAppearance(sidebarPane: boolean) {
  return {
    interactionClassName: sidebarPane ? "bg-thread-hover" : "bg-row-hover",
    foregroundClassName: sidebarPane ? "text-drawer-foreground" : "text-foreground",
    mutedForegroundClassName: sidebarPane
      ? "text-drawer-foreground-muted"
      : "text-foreground-muted",
    tertiaryForegroundClassName: sidebarPane
      ? "text-drawer-foreground-muted"
      : "text-foreground-tertiary",
    mutedIconTintClassName: sidebarPane
      ? "accent-drawer-foreground-muted"
      : "accent-foreground-muted",
  };
}

const INDENT_STEP = 16;
const MAX_INDENT_DEPTH = 4;

function nestedIndent(depth: number, sidebarPane: boolean): number {
  return (sidebarPane ? 16 : 24) + (Math.min(depth, MAX_INDENT_DEPTH) - 1) * INDENT_STEP;
}

function useSignalDescription(signal: ThreadNestingSignal | null): string | undefined {
  const gt = useGT();
  switch (signal) {
    case "approval":
      return gt("A subagent is waiting for approval.");
    case "input":
      return gt("A subagent is waiting for your answer.");
    case "failed":
      return gt("A subagent failed.");
    case "working":
      return gt("A subagent is working.");
    case null:
      return undefined;
  }
}

/**
 * The count on a parent row: how many subagent threads it has, tinted by the most
 * urgent thing any of them is doing, so a collapsed parent still says when one needs
 * the user. Pressing it shows or hides the nested rows.
 */
export function ThreadListNestedToggle(props: {
  readonly threadKey: string;
  readonly nested: ThreadListNestedSummary;
  readonly quietClassName: string;
  readonly tintColorClassName: string;
}) {
  const { nested } = props;
  const gt = useGT();
  const signalDescription = useSignalDescription(nested.signal);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={gt("{count, plural, one {{count} subagent} other {{count} subagents}}", {
        count: nested.total,
      })}
      {...(signalDescription === undefined
        ? {}
        : { accessibilityValue: { text: signalDescription } })}
      accessibilityHint={
        nested.expanded ? gt("Hides the subagent threads.") : gt("Shows the subagent threads.")
      }
      accessibilityState={{ expanded: nested.expanded }}
      hitSlop={10}
      onPress={() => setThreadListNestedExpanded(props.threadKey, !nested.expanded)}
      className="flex-row items-center gap-1"
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <SymbolView
        name={nested.expanded ? "chevron.down" : "chevron.right"}
        size={10}
        tintColorClassName={props.tintColorClassName}
        type="monochrome"
      />
      <Text
        className={cn(
          "text-xs tabular-nums",
          nested.signal === null ? props.quietClassName : SIGNAL_CLASS_NAME[nested.signal],
        )}
      >
        {nested.total}
      </Text>
    </Pressable>
  );
}

/** Subthread labels only depend on the clock through the snooze expiry, so re-read it there. */
function useSubthreadStatusNow(snoozedUntil: string | null | undefined): string {
  return new Date(
    useNowAfter(snoozedUntil == null ? null : Date.parse(snoozedUntil)),
  ).toISOString();
}

/**
 * A subagent thread under its parent: indented behind a rail, one line, with its own
 * status. Deliberately light (no swipe actions, pull request lookup, or menu), so a
 * parent with many subagents stays cheap to scroll. It opens like a subagent from a
 * conversation card: beside its family's thread where an inspector can show it.
 */
export const ThreadListNestedThreadRow = memo(function ThreadListNestedThreadRow(props: {
  readonly thread: EnvironmentThreadShell;
  readonly threadKey: string;
  readonly rootThread: EnvironmentThreadShell;
  readonly depth: number;
  readonly nested: ThreadListNestedSummary | null;
  readonly pane?: "screen" | "sidebar";
  readonly selected?: boolean;
  readonly showTrailingDivider?: boolean;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
}) {
  const { thread, rootThread } = props;
  const gt = useGT();
  const messages = useMessages();
  const openInspector = useOpenThreadInspector();
  const sidebarPane = props.pane === "sidebar";
  const selected = props.selected === true;
  const rowAppearance = nestedRowAppearance(sidebarPane);
  const signal = resolveThreadNestingSignal(thread);
  const status = resolveSubthreadStatusLabel(
    thread,
    useSubthreadStatusNow(thread.snoozedUntil),
    messages,
  );
  const open = () => {
    if (
      openInspector(
        { environmentId: rootThread.environmentId, threadId: rootThread.id },
        { type: "thread", environmentId: thread.environmentId, threadId: thread.id },
      )
    ) {
      return;
    }
    props.onSelectThread(thread);
  };
  return (
    <RowPressable
      interactionClassName={rowAppearance.interactionClassName}
      interactionOpacity={selected ? 0 : 1}
      className={cn(
        sidebarPane && "rounded-xl",
        selected ? "bg-thread-selected" : sidebarPane ? "bg-drawer" : "bg-screen",
      )}
      accessibilityRole="button"
      accessibilityLabel={gt("Subagent: {title}, {status}", { title: thread.title, status })}
      accessibilityState={{ selected }}
      onPress={open}
    >
      <View
        className="min-h-[40px] flex-row items-stretch"
        style={{ paddingLeft: nestedIndent(props.depth, sidebarPane) }}
      >
        <View className={cn("w-px", sidebarPane ? "bg-drawer-border" : "bg-border")} />
        <View
          className="min-w-0 flex-1 flex-row items-center gap-2 py-2 pr-5 pl-3"
          style={sidebarPane ? { paddingRight: 12 } : undefined}
        >
          <Text
            className={cn(
              "min-w-0 flex-1 text-sm",
              selected
                ? selectedThreadRowColors.foregroundClassName
                : signal === null
                  ? rowAppearance.mutedForegroundClassName
                  : rowAppearance.foregroundClassName,
            )}
            numberOfLines={1}
          >
            {thread.title}
          </Text>
          {props.nested ? (
            <ThreadListNestedToggle
              threadKey={props.threadKey}
              nested={props.nested}
              quietClassName={
                selected
                  ? selectedThreadRowColors.mutedForegroundClassName
                  : rowAppearance.tertiaryForegroundClassName
              }
              tintColorClassName={
                selected
                  ? selectedThreadRowColors.mutedIconTintClassName
                  : rowAppearance.mutedIconTintClassName
              }
            />
          ) : null}
          <Text
            className={cn(
              "text-xs tabular-nums",
              signal !== null
                ? SIGNAL_CLASS_NAME[signal]
                : selected
                  ? selectedThreadRowColors.mutedForegroundClassName
                  : rowAppearance.tertiaryForegroundClassName,
            )}
          >
            {status}
          </Text>
        </View>
      </View>
      {!sidebarPane && THREAD_LIST_V2_ROW_DIVIDERS && props.showTrailingDivider === true ? (
        <View className="ml-5 h-px bg-border-subtle" />
      ) : null}
    </RowPressable>
  );
});

/** Stands in for the quiet subagents a long nested list leaves out. */
export const ThreadListNestedMoreRow = memo(function ThreadListNestedMoreRow(props: {
  readonly groupKey: string;
  readonly depth: number;
  readonly hiddenCount: number;
  readonly pane?: "screen" | "sidebar";
  readonly showTrailingDivider?: boolean;
  readonly onShowAll: (groupKey: string) => void;
}) {
  const gt = useGT();
  const sidebarPane = props.pane === "sidebar";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={gt(
        "{count, plural, one {Show {count} more subagent thread} other {Show {count} more subagent threads}}",
        { count: props.hiddenCount },
      )}
      onPress={() => props.onShowAll(props.groupKey)}
      className={sidebarPane ? undefined : "bg-screen"}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <View
        className="min-h-[36px] flex-row items-stretch"
        style={{ paddingLeft: nestedIndent(props.depth, sidebarPane) }}
      >
        <View className={cn("w-px", sidebarPane ? "bg-drawer-border" : "bg-border")} />
        <View className="flex-1 justify-center py-2 pl-3">
          <Text
            className={cn(
              "text-xs font-t3-medium",
              sidebarPane ? "text-drawer-foreground-muted" : "text-foreground-muted",
            )}
          >
            {gt("Show {count} more", { count: props.hiddenCount })}
          </Text>
        </View>
      </View>
      {!sidebarPane && THREAD_LIST_V2_ROW_DIVIDERS && props.showTrailingDivider === true ? (
        <View className="ml-5 h-px bg-border-subtle" />
      ) : null}
    </Pressable>
  );
});

/** The collapsible group of a parent's settled subagents. */
export const ThreadListNestedSettledRow = memo(function ThreadListNestedSettledRow(props: {
  readonly groupKey: string;
  readonly depth: number;
  readonly count: number;
  readonly expanded: boolean;
  readonly pane?: "screen" | "sidebar";
  readonly showTrailingDivider?: boolean;
}) {
  const gt = useGT();
  const sidebarPane = props.pane === "sidebar";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={gt("Settled subagents ({count})", { count: props.count })}
      accessibilityState={{ expanded: props.expanded }}
      onPress={() => setThreadListNestedExpanded(props.groupKey, !props.expanded)}
      className={sidebarPane ? undefined : "bg-screen"}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <View
        className="min-h-[36px] flex-row items-stretch"
        style={{ paddingLeft: nestedIndent(props.depth, sidebarPane) }}
      >
        <View className={cn("w-px", sidebarPane ? "bg-drawer-border" : "bg-border")} />
        <View className="flex-1 flex-row items-center gap-2 py-2 pl-3">
          <SymbolView name={props.expanded ? "chevron.down" : "chevron.right"} size={10} />
          <Text
            className={cn(
              "text-xs font-t3-medium",
              sidebarPane ? "text-drawer-foreground-muted" : "text-foreground-muted",
            )}
          >
            {gt("Settled ({count})", { count: props.count, $context: "group of subagents" })}
          </Text>
        </View>
      </View>
      {!sidebarPane && THREAD_LIST_V2_ROW_DIVIDERS && props.showTrailingDivider === true ? (
        <View className="ml-5 h-px bg-border-subtle" />
      ) : null}
    </Pressable>
  );
});

/** Draws one nested list item; Home and the iPad sidebar share it. */
export function ThreadListNestedListRow(props: {
  readonly item: ThreadListNestedListItem;
  readonly pane: "screen" | "sidebar";
  readonly selectedThreadKey: string | null;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
  readonly onShowAll: (groupKey: string) => void;
}) {
  const { item, pane } = props;
  switch (item.type) {
    case "v2-nested-thread":
      return (
        <ThreadListNestedThreadRow
          thread={item.thread}
          threadKey={item.threadKey}
          rootThread={item.rootThread}
          depth={item.depth}
          nested={item.nested}
          pane={pane}
          selected={item.threadKey === props.selectedThreadKey}
          showTrailingDivider={item.showTrailingDivider}
          onSelectThread={props.onSelectThread}
        />
      );
    case "v2-nested-more":
      return (
        <ThreadListNestedMoreRow
          groupKey={item.groupKey}
          depth={item.depth}
          hiddenCount={item.hiddenCount}
          pane={pane}
          showTrailingDivider={item.showTrailingDivider}
          onShowAll={props.onShowAll}
        />
      );
    case "v2-nested-settled":
      return (
        <ThreadListNestedSettledRow
          groupKey={item.groupKey}
          depth={item.depth}
          count={item.count}
          expanded={item.expanded}
          pane={pane}
          showTrailingDivider={item.showTrailingDivider}
        />
      );
  }
}
