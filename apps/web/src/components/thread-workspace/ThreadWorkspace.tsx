import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import { ArrowDownToLineIcon, LayoutGridIcon, MessageSquareIcon, XIcon } from "lucide-react";
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useState,
  type PointerEventHandler,
  type ReactNode,
} from "react";
import { useShallow } from "zustand/react/shallow";

import { useComposerDraftStore } from "~/composerDraftStore";
import { isElectron } from "~/env";
import { cn } from "~/lib/utils";
import { useProject, useThreadDetail, useThreadShell, useThreadStatus } from "~/state/entities";
import { buildDraftThreadRouteParams, buildThreadRouteParams } from "~/threadRoutes";
import { resolveThreadSyncPhase } from "~/threadSync";
import {
  closeThreadTabFromMiddleClick,
  preventThreadTabMiddleClickDefault,
} from "~/threadWorkspaceTabInteractions";
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
  MenuGroup,
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
  { value: "four-columns", label: "4 columns", columns: 4, rows: 1 },
  { value: "two-rows", label: "2 rows", columns: 1, rows: 2 },
  { value: "three-rows", label: "3 rows", columns: 1, rows: 3 },
  { value: "grid-2x2", label: "2 × 2 grid", columns: 2, rows: 2 },
];

const GRID_CLASS_BY_LAYOUT: Record<ThreadWorkspaceLayout, string> = {
  single: "grid-cols-1 grid-rows-1",
  "two-columns": "grid-cols-2 grid-rows-1",
  "three-columns": "grid-cols-3 grid-rows-1",
  "four-columns": "grid-cols-4 grid-rows-1",
  "two-rows": "grid-cols-1 grid-rows-2",
  "three-rows": "grid-cols-1 grid-rows-3",
  "grid-2x2": "grid-cols-2 grid-rows-2",
};

const THREAD_PANE_DROP_PREFIX = "thread-pane-drop:";

type ThreadTabDragData = {
  readonly type: "thread-tab";
  readonly paneId: string;
  readonly tabKey: string;
};

type ThreadPaneDropData = {
  readonly type: "thread-pane";
  readonly paneId: string;
};

function threadPaneDropId(paneId: string): string {
  return `${THREAD_PANE_DROP_PREFIX}${paneId}`;
}

function isThreadTabDragData(value: unknown): value is ThreadTabDragData {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ThreadTabDragData>;
  return (
    candidate.type === "thread-tab" &&
    typeof candidate.paneId === "string" &&
    typeof candidate.tabKey === "string"
  );
}

function isThreadPaneDropData(value: unknown): value is ThreadPaneDropData {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ThreadPaneDropData>;
  return candidate.type === "thread-pane" && typeof candidate.paneId === "string";
}

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
        <MenuGroup>
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
        </MenuGroup>
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

function SortableThreadTab(props: {
  readonly target: ThreadWorkspaceTarget;
  readonly paneId: string;
  readonly selected: boolean;
  readonly routed: boolean;
  readonly totalTabs: number;
  readonly onActivate: () => void;
  readonly onClose: () => void;
}) {
  const tabKey = threadWorkspaceTargetKey(props.target);
  const {
    attributes,
    isDragging,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
  } = useSortable({
    id: tabKey,
    data: {
      type: "thread-tab",
      paneId: props.paneId,
      tabKey,
    } satisfies ThreadTabDragData,
  });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "group/tab flex h-6 min-w-24 max-w-48 shrink-0 items-center gap-1 rounded-md pr-1 pl-2 text-xs [-webkit-app-region:no-drag]",
        props.selected
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
        isDragging && "z-10 opacity-30",
      )}
      data-active-tab={props.selected ? "true" : undefined}
      data-dragging-thread-tab={isDragging ? "true" : undefined}
      onAuxClick={(event) => closeThreadTabFromMiddleClick(event, props.onClose)}
      onMouseDown={preventThreadTabMiddleClickDefault}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <button
        ref={setActivatorNodeRef}
        type="button"
        {...attributes}
        {...listeners}
        role="tab"
        aria-selected={props.selected}
        className="flex min-w-0 flex-1 touch-none cursor-grab items-center gap-1.5 text-left active:cursor-grabbing"
        onClick={props.onActivate}
      >
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            props.routed ? "bg-primary" : "bg-muted-foreground/35",
          )}
          aria-hidden
        />
        <WorkspaceTabLabel target={props.target} />
      </button>
      {props.totalTabs > 1 ? (
        <button
          type="button"
          aria-label="Close thread tab"
          className="flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground group-hover/tab:opacity-100 focus-visible:opacity-100"
          onClick={(event) => {
            event.stopPropagation();
            props.onClose();
          }}
        >
          <XIcon className="size-3" />
        </button>
      ) : null}
    </div>
  );
}

// The hint stays mounted so its fade in and out is a one-shot transition instead of a mount
// animation, and it never repaints while idle because opacity is the only animated property.
function ThreadPaneDropHint(props: {
  readonly dragging: boolean;
  readonly over: boolean;
  readonly paneNumber: number;
}) {
  return (
    <div
      aria-hidden
      data-thread-pane-drop-hint={props.dragging ? "true" : undefined}
      className={cn(
        "pointer-events-none absolute inset-x-1.5 bottom-1.5 top-[calc(2rem+0.375rem)] z-20 flex items-center justify-center rounded-lg border border-dashed transition-[opacity,background-color,border-color] duration-150 ease-out motion-reduce:transition-none",
        props.dragging ? "opacity-100" : "opacity-0",
        props.over ? "border-primary/70 bg-primary/10" : "border-border bg-background/65",
      )}
    >
      <span
        className={cn(
          "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium shadow-sm transition-[transform,color,background-color,border-color] duration-150 ease-out motion-reduce:transform-none motion-reduce:transition-none",
          props.over
            ? "scale-105 border-primary/70 bg-primary text-primary-foreground"
            : "border-border/75 bg-popover text-muted-foreground",
        )}
      >
        <ArrowDownToLineIcon className="size-3.5 shrink-0" />
        {props.over
          ? `Release to open in pane ${props.paneNumber}`
          : `Drop here · pane ${props.paneNumber}`}
      </span>
    </div>
  );
}

function ThreadPaneSection(props: {
  readonly paneId: string;
  readonly paneNumber: number;
  readonly label: string;
  readonly className: string;
  readonly active: boolean;
  readonly dragging: boolean;
  readonly onPointerDownCapture: PointerEventHandler<HTMLElement>;
  readonly children: ReactNode;
}) {
  const { isOver, setNodeRef } = useDroppable({
    id: threadPaneDropId(props.paneId),
    data: { type: "thread-pane", paneId: props.paneId } satisfies ThreadPaneDropData,
  });

  return (
    <section
      ref={setNodeRef}
      aria-label={props.label}
      className={cn(props.className, isOver && "ring-2 ring-inset ring-primary/65")}
      data-active-thread-pane={props.active ? "true" : undefined}
      data-thread-pane-drop-over={isOver ? "true" : undefined}
      onPointerDownCapture={props.onPointerDownCapture}
    >
      {props.children}
      <ThreadPaneDropHint dragging={props.dragging} over={isOver} paneNumber={props.paneNumber} />
    </section>
  );
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
        <SortableContext
          items={props.pane.tabs.map(threadWorkspaceTargetKey)}
          strategy={horizontalListSortingStrategy}
        >
          {props.pane.tabs.map((target) => {
            const tabKey = threadWorkspaceTargetKey(target);
            return (
              <SortableThreadTab
                key={tabKey}
                target={target}
                paneId={props.pane.id}
                selected={props.pane.activeTabKey === tabKey}
                routed={props.routedTargetKey === tabKey}
                totalTabs={props.totalTabs}
                onActivate={() => props.onActivateTab(target)}
                onClose={() => props.onCloseTab(target)}
              />
            );
          })}
        </SortableContext>
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
            Select a thread from the sidebar, or drag a thread tab into this pane.
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
  const [draggedTabKey, setDraggedTabKey] = useState<string | null>(null);
  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const {
    activePaneId,
    bindRouteTarget,
    closeTab,
    layout,
    moveTab,
    panes,
    activatePane,
    activateTab,
  } = useThreadWorkspaceStore(
    useShallow((state) => ({
      activePaneId: state.activePaneId,
      activatePane: state.activatePane,
      activateTab: state.activateTab,
      bindRouteTarget: state.bindRouteTarget,
      closeTab: state.closeTab,
      layout: state.layout,
      moveTab: state.moveTab,
      panes: state.panes,
    })),
  );
  const routedTargetKey = threadWorkspaceTargetKey(routedTarget);
  const totalTabs = panes.reduce((count, pane) => count + pane.tabs.length, 0);
  const columnCount = LAYOUT_OPTIONS.find((option) => option.value === layout)?.columns ?? 1;
  const draggedTarget = useMemo(
    () =>
      draggedTabKey
        ? (panes
            .flatMap((pane) => pane.tabs)
            .find((target) => threadWorkspaceTargetKey(target) === draggedTabKey) ?? null)
        : null,
    [draggedTabKey, panes],
  );

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

  const handleTabDragStart = useCallback(
    (event: DragStartEvent) => {
      const dragData: unknown = event.active.data.current;
      if (!isThreadTabDragData(dragData)) return;
      const sourcePane = panes.find((pane) => pane.id === dragData.paneId);
      const target = sourcePane?.tabs.find(
        (candidate) => threadWorkspaceTargetKey(candidate) === dragData.tabKey,
      );
      if (!sourcePane || !target) return;
      setDraggedTabKey(dragData.tabKey);
      activateTarget(sourcePane.id, target);
    },
    [activateTarget, panes],
  );

  const handleTabDragEnd = useCallback(
    (event: DragEndEvent) => {
      setDraggedTabKey(null);
      const dragData: unknown = event.active.data.current;
      const dropData: unknown = event.over?.data.current;
      if (!isThreadTabDragData(dragData) || !event.over) return;

      let destinationPaneId: string;
      let destinationIndex: number;
      if (isThreadTabDragData(dropData)) {
        destinationPaneId = dropData.paneId;
        const destinationPane = panes.find((pane) => pane.id === destinationPaneId);
        destinationIndex =
          destinationPane?.tabs.findIndex(
            (target) => threadWorkspaceTargetKey(target) === dropData.tabKey,
          ) ?? -1;
      } else if (isThreadPaneDropData(dropData)) {
        destinationPaneId = dropData.paneId;
        destinationIndex = panes.find((pane) => pane.id === destinationPaneId)?.tabs.length ?? -1;
      } else {
        return;
      }

      if (destinationIndex < 0) return;
      moveTab(dragData.tabKey, destinationPaneId, destinationIndex);
    },
    [moveTab, panes],
  );

  return (
    <DiffWorkerPoolProvider>
      <div
        ref={setRightPanelHost}
        className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-background"
        data-thread-workspace-right-panel-host
      >
        <DndContext
          sensors={dndSensors}
          collisionDetection={closestCenter}
          onDragStart={handleTabDragStart}
          onDragEnd={handleTabDragEnd}
          onDragCancel={() => setDraggedTabKey(null)}
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
                <ThreadPaneSection
                  key={pane.id}
                  paneId={pane.id}
                  paneNumber={index + 1}
                  label={`Thread pane ${index + 1}`}
                  active={active}
                  dragging={draggedTabKey !== null}
                  className={cn(
                    "relative flex min-h-0 min-w-0 flex-col overflow-hidden bg-background",
                    !active && "max-md:hidden",
                    active && "ring-1 ring-inset ring-primary/35",
                  )}
                  onPointerDownCapture={(event) => {
                    if (event.button === 1) return;
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
                </ThreadPaneSection>
              );
            })}
          </div>
          <DragOverlay>
            {draggedTarget ? (
              <div className="pointer-events-none flex h-7 min-w-32 max-w-52 items-center gap-1.5 rounded-md border border-border/75 bg-popover px-2 text-xs text-foreground shadow-lg">
                <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-hidden />
                <WorkspaceTabLabel target={draggedTarget} />
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      </div>
    </DiffWorkerPoolProvider>
  );
}
