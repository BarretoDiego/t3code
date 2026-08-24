import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import { LayoutGridIcon, MessageSquareIcon, XIcon } from "lucide-react";
import { useCallback, useLayoutEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { useComposerDraftStore } from "~/composerDraftStore";
import { isElectron } from "~/env";
import { cn } from "~/lib/utils";
import { useProject, useThreadDetail, useThreadShell, useThreadStatus } from "~/state/entities";
import { buildDraftThreadRouteParams, buildThreadRouteParams } from "~/threadRoutes";
import { resolveThreadSyncPhase } from "~/threadSync";
import {
  selectActiveThreadWorkspaceTarget,
  threadWorkspaceTargetKey,
  type ThreadWorkspaceLayout,
  type ThreadWorkspacePane,
  type ThreadWorkspaceTarget,
  useThreadWorkspaceStore,
} from "~/threadWorkspaceStore";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";

import { ChatViewWithoutDiffWorkerPool } from "../ChatView";
import { DiffWorkerPoolProvider } from "../DiffWorkerPoolProvider";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const LAYOUT_OPTIONS: ReadonlyArray<{
  readonly value: ThreadWorkspaceLayout;
  readonly label: string;
  readonly columns: number;
  readonly rows: number;
}> = [
  { value: "single", label: "Single", columns: 1, rows: 1 },
  { value: "two-columns", label: "2 columns", columns: 2, rows: 1 },
  { value: "three-columns", label: "3 columns", columns: 3, rows: 1 },
  { value: "two-rows", label: "2 rows", columns: 1, rows: 2 },
  { value: "three-rows", label: "3 rows", columns: 1, rows: 3 },
  { value: "grid-2x2", label: "2 × 2 grid", columns: 2, rows: 2 },
];

const GRID_CLASS_BY_LAYOUT: Record<ThreadWorkspaceLayout, string> = {
  single: "grid-cols-1 grid-rows-1",
  "two-columns": "grid-cols-2 grid-rows-1",
  "three-columns": "grid-cols-3 grid-rows-1",
  "two-rows": "grid-cols-1 grid-rows-2",
  "three-rows": "grid-cols-1 grid-rows-3",
  "grid-2x2": "grid-cols-2 grid-rows-2",
};

function LayoutPreview({ columns, rows }: { readonly columns: number; readonly rows: number }) {
  return (
    <span
      aria-hidden
      className="grid size-4 shrink-0 gap-px rounded-[3px] border border-current/45 p-0.5"
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {Array.from({ length: columns * rows }, (_, index) => (
        <span key={index} className="rounded-[1px] bg-current/55" />
      ))}
    </span>
  );
}

function ThreadLayoutMenu({ layout }: { readonly layout: ThreadWorkspaceLayout }) {
  const setLayout = useThreadWorkspaceStore((state) => state.setLayout);
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button
                  aria-label="Configure thread layout"
                  className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
                  size="icon-xs"
                  variant="ghost"
                />
              }
            />
          }
        >
          <LayoutGridIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="bottom">Configure thread layout</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" side="bottom" sideOffset={6} className="min-w-44">
        <MenuGroupLabel>Thread layout</MenuGroupLabel>
        <MenuSeparator />
        <MenuRadioGroup
          value={layout}
          onValueChange={(value) => setLayout(value as ThreadWorkspaceLayout)}
        >
          {LAYOUT_OPTIONS.map((option) => (
            <MenuRadioItem key={option.value} value={option.value} closeOnClick>
              <span className="flex items-center gap-2">
                <LayoutPreview columns={option.columns} rows={option.rows} />
                {option.label}
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

function WorkspaceTabLabel({ target }: { readonly target: ThreadWorkspaceTarget }) {
  const threadRef = useMemo(
    () => scopeThreadRef(target.environmentId, target.threadId),
    [target.environmentId, target.threadId],
  );
  const shell = useThreadShell(target.routeKind === "server" ? threadRef : null);
  const draft = useComposerDraftStore((state) =>
    target.routeKind === "draft" ? state.getDraftSession(target.draftId) : null,
  );
  const draftProjectRef = draft ? scopeProjectRef(draft.environmentId, draft.projectId) : null;
  const draftProject = useProject(draftProjectRef);
  const title = shell?.title ?? (draftProject ? `New · ${draftProject.title}` : "New thread");

  return <span className="truncate">{title}</span>;
}

function navigateToTarget(
  navigate: ReturnType<typeof useNavigate>,
  target: ThreadWorkspaceTarget,
): void {
  if (target.routeKind === "draft") {
    void navigate({
      to: "/draft/$draftId",
      params: buildDraftThreadRouteParams(target.draftId),
    });
    return;
  }
  void navigate({
    to: "/$environmentId/$threadId",
    params: buildThreadRouteParams(scopeThreadRef(target.environmentId, target.threadId)),
  });
}

function ThreadPaneTabs(props: {
  readonly pane: ThreadWorkspacePane;
  readonly active: boolean;
  readonly layout: ThreadWorkspaceLayout;
  readonly reserveCollapsedSidebarInset: boolean;
  readonly reserveNativeControlsInset: boolean;
  readonly windowDragRegion: boolean;
  readonly totalTabs: number;
  readonly routedTargetKey: string;
  readonly onActivateTab: (target: ThreadWorkspaceTarget) => void;
  readonly onCloseTab: (target: ThreadWorkspaceTarget) => void;
}) {
  return (
    <div
      data-thread-pane-tabbar
      className={cn(
        "flex h-8 min-h-8 items-center border-b border-border/75 bg-background px-1.5",
        isElectron && props.windowDragRegion && "drag-region",
        props.reserveCollapsedSidebarInset && COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        props.reserveNativeControlsInset && "wco:pr-[var(--workspace-native-controls-inset)]",
      )}
    >
      <div
        role="tablist"
        aria-label="Threads in pane"
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {props.pane.tabs.map((target) => {
          const tabKey = threadWorkspaceTargetKey(target);
          const selected = props.pane.activeTabKey === tabKey;
          const routed = props.routedTargetKey === tabKey;
          return (
            <div
              key={tabKey}
              className={cn(
                "group/tab flex h-6 min-w-24 max-w-48 shrink-0 items-center gap-1 rounded-md pr-1 pl-2 text-xs",
                selected
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
              data-active-tab={selected ? "true" : undefined}
            >
              <button
                type="button"
                role="tab"
                aria-selected={selected}
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left"
                onClick={() => props.onActivateTab(target)}
              >
                <span
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    routed ? "bg-primary" : "bg-muted-foreground/35",
                  )}
                  aria-hidden
                />
                <WorkspaceTabLabel target={target} />
              </button>
              {props.totalTabs > 1 ? (
                <button
                  type="button"
                  aria-label="Close thread tab"
                  className="flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground group-hover/tab:opacity-100 focus-visible:opacity-100"
                  onClick={(event) => {
                    event.stopPropagation();
                    props.onCloseTab(target);
                  }}
                >
                  <XIcon className="size-3" />
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
      {props.active ? (
        <div className="ml-1 hidden shrink-0 items-center md:flex">
          <ThreadLayoutMenu layout={props.layout} />
        </div>
      ) : null}
    </div>
  );
}

function ServerThreadPane({
  active,
  onRightPanelMaximizedChange,
  reserveNativeControlsInset,
  rightPanelHost,
  target,
}: {
  readonly active: boolean;
  readonly onRightPanelMaximizedChange: (maximized: boolean) => void;
  readonly reserveNativeControlsInset: boolean;
  readonly rightPanelHost: HTMLElement | null;
  readonly target: Extract<ThreadWorkspaceTarget, { routeKind: "server" }>;
}) {
  const threadRef = useMemo(
    () => scopeThreadRef(target.environmentId, target.threadId),
    [target.environmentId, target.threadId],
  );
  const shell = useThreadShell(threadRef);
  const detail = useThreadDetail(threadRef);
  const status = useThreadStatus(threadRef);
  const threadSyncPhase = resolveThreadSyncPhase({
    detailExists: detail !== null,
    shellExists: shell !== null,
    status,
  });

  return (
    <ChatViewWithoutDiffWorkerPool
      environmentId={target.environmentId}
      threadId={target.threadId}
      routeKind="server"
      threadSyncPhase={threadSyncPhase}
      reserveTitleBarControlInset={reserveNativeControlsInset}
      workspace={{ active, rightPanelHost, onRightPanelMaximizedChange }}
    />
  );
}

function DraftThreadPane({
  active,
  onRightPanelMaximizedChange,
  reserveNativeControlsInset,
  rightPanelHost,
  target,
}: {
  readonly active: boolean;
  readonly onRightPanelMaximizedChange: (maximized: boolean) => void;
  readonly reserveNativeControlsInset: boolean;
  readonly rightPanelHost: HTMLElement | null;
  readonly target: Extract<ThreadWorkspaceTarget, { routeKind: "draft" }>;
}) {
  return (
    <ChatViewWithoutDiffWorkerPool
      draftId={target.draftId}
      environmentId={target.environmentId}
      threadId={target.threadId}
      routeKind="draft"
      reserveTitleBarControlInset={reserveNativeControlsInset}
      workspace={{ active, rightPanelHost, onRightPanelMaximizedChange }}
    />
  );
}

function ThreadPaneContent(props: {
  readonly active: boolean;
  readonly onRightPanelMaximizedChange: (maximized: boolean) => void;
  readonly reserveNativeControlsInset: boolean;
  readonly rightPanelHost: HTMLElement | null;
  readonly target: ThreadWorkspaceTarget | null;
}) {
  if (!props.target) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-background p-8 text-center">
        <div className="max-w-60 text-muted-foreground">
          <MessageSquareIcon className="mx-auto size-5 opacity-55" aria-hidden />
          <p className="mt-3 text-sm font-medium text-foreground">This pane is ready</p>
          <p className="mt-1 text-xs leading-relaxed">
            Select a thread from the sidebar to open it here.
          </p>
        </div>
      </div>
    );
  }
  return props.target.routeKind === "server" ? (
    <ServerThreadPane
      active={props.active}
      reserveNativeControlsInset={props.reserveNativeControlsInset}
      target={props.target}
      rightPanelHost={props.rightPanelHost}
      onRightPanelMaximizedChange={props.onRightPanelMaximizedChange}
    />
  ) : (
    <DraftThreadPane
      active={props.active}
      reserveNativeControlsInset={props.reserveNativeControlsInset}
      target={props.target}
      rightPanelHost={props.rightPanelHost}
      onRightPanelMaximizedChange={props.onRightPanelMaximizedChange}
    />
  );
}

export function ThreadWorkspace({
  routedTarget,
}: {
  readonly routedTarget: ThreadWorkspaceTarget;
}) {
  const navigate = useNavigate();
  const [rightPanelHost, setRightPanelHost] = useState<HTMLDivElement | null>(null);
  const [rightPanelMaximized, setRightPanelMaximized] = useState(false);
  const { activePaneId, bindRouteTarget, closeTab, layout, panes, activatePane, activateTab } =
    useThreadWorkspaceStore(
      useShallow((state) => ({
        activePaneId: state.activePaneId,
        activatePane: state.activatePane,
        activateTab: state.activateTab,
        bindRouteTarget: state.bindRouteTarget,
        closeTab: state.closeTab,
        layout: state.layout,
        panes: state.panes,
      })),
    );
  const routedTargetKey = threadWorkspaceTargetKey(routedTarget);
  const totalTabs = panes.reduce((count, pane) => count + pane.tabs.length, 0);
  const columnCount = LAYOUT_OPTIONS.find((option) => option.value === layout)?.columns ?? 1;

  useLayoutEffect(() => {
    if (routedTarget.routeKind === "draft") {
      bindRouteTarget({
        routeKind: "draft",
        draftId: routedTarget.draftId,
        environmentId: routedTarget.environmentId,
        threadId: routedTarget.threadId,
      });
      return;
    }
    bindRouteTarget({
      routeKind: "server",
      environmentId: routedTarget.environmentId,
      threadId: routedTarget.threadId,
    });
  }, [
    bindRouteTarget,
    routedTarget.environmentId,
    routedTarget.routeKind,
    routedTarget.routeKind === "draft" ? routedTarget.draftId : null,
    routedTarget.threadId,
    routedTargetKey,
  ]);

  const activateTarget = useCallback(
    (paneId: string, target: ThreadWorkspaceTarget) => {
      activateTab(paneId, threadWorkspaceTargetKey(target));
      navigateToTarget(navigate, target);
    },
    [activateTab, navigate],
  );

  const activatePaneAndRoute = useCallback(
    (pane: ThreadWorkspacePane) => {
      if (pane.id === activePaneId) return;
      activatePane(pane.id);
      const target = pane.activeTabKey
        ? (pane.tabs.find(
            (candidate) => threadWorkspaceTargetKey(candidate) === pane.activeTabKey,
          ) ?? null)
        : null;
      if (target) navigateToTarget(navigate, target);
    },
    [activatePane, activePaneId, navigate],
  );

  const closeTarget = useCallback(
    (paneId: string, target: ThreadWorkspaceTarget) => {
      const closingKey = threadWorkspaceTargetKey(target);
      closeTab(paneId, closingKey);
      const state = useThreadWorkspaceStore.getState();
      const nextTarget = selectActiveThreadWorkspaceTarget(state);
      if (nextTarget && threadWorkspaceTargetKey(nextTarget) !== routedTargetKey) {
        navigateToTarget(navigate, nextTarget);
      }
    },
    [closeTab, navigate, routedTargetKey],
  );

  return (
    <DiffWorkerPoolProvider>
      <div
        ref={setRightPanelHost}
        className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-background"
        data-thread-workspace-right-panel-host
      >
        <div
          className={cn(
            "grid min-h-0 min-w-0 gap-px bg-border/75",
            "max-md:grid-cols-1 max-md:grid-rows-1",
            rightPanelMaximized ? "w-0 flex-none overflow-hidden" : "flex-1",
            GRID_CLASS_BY_LAYOUT[layout],
          )}
          data-thread-workspace-layout={layout}
        >
          {panes.map((pane, index) => {
            const active = pane.id === activePaneId;
            const target = pane.activeTabKey
              ? (pane.tabs.find(
                  (candidate) => threadWorkspaceTargetKey(candidate) === pane.activeTabKey,
                ) ?? null)
              : null;
            const topRow = index < columnCount;
            const reserveCollapsedSidebarInset = topRow && index === 0;
            const reserveNativeControlsInset = topRow && index === columnCount - 1;
            return (
              <section
                key={pane.id}
                aria-label={`Thread pane ${index + 1}`}
                className={cn(
                  "relative flex min-h-0 min-w-0 flex-col overflow-hidden bg-background",
                  !active && "max-md:hidden",
                  active && "ring-1 ring-inset ring-primary/35",
                )}
                data-active-thread-pane={active ? "true" : undefined}
                onPointerDownCapture={(event) => {
                  if (
                    event.target instanceof Element &&
                    event.target.closest("[data-thread-pane-tabbar]")
                  ) {
                    activatePane(pane.id);
                    return;
                  }
                  activatePaneAndRoute(pane);
                }}
              >
                <ThreadPaneTabs
                  pane={pane}
                  active={active}
                  layout={layout}
                  reserveCollapsedSidebarInset={reserveCollapsedSidebarInset}
                  reserveNativeControlsInset={reserveNativeControlsInset}
                  windowDragRegion={topRow}
                  totalTabs={totalTabs}
                  routedTargetKey={routedTargetKey}
                  onActivateTab={(nextTarget) => activateTarget(pane.id, nextTarget)}
                  onCloseTab={(nextTarget) => closeTarget(pane.id, nextTarget)}
                />
                <ThreadPaneContent
                  active={active}
                  target={target}
                  reserveNativeControlsInset={reserveNativeControlsInset}
                  rightPanelHost={active ? rightPanelHost : null}
                  onRightPanelMaximizedChange={setRightPanelMaximized}
                />
              </section>
            );
          })}
        </div>
      </div>
    </DiffWorkerPoolProvider>
  );
}
