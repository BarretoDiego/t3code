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
import {
  scopeProjectRef,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowDownToLineIcon,
  BookmarkIcon,
  BookmarkPlusIcon,
  Columns2Icon,
  LayoutGridIcon,
  MessageSquareIcon,
  Rows2Icon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEventHandler,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useShallow } from "zustand/react/shallow";

import { useComposerDraftStore } from "~/composerDraftStore";
import { isElectron } from "~/env";
import { cn } from "~/lib/utils";
import {
  useProject,
  useThreadDetail,
  useThreadRefs,
  useThreadShell,
  useThreadStatus,
  useThreadWorkspacePruneScope,
} from "~/state/entities";
import { buildDraftThreadRouteParams, buildThreadRouteParams } from "~/threadRoutes";
import { resolveThreadSyncPhase } from "~/threadSync";
import {
  closeThreadTabFromMiddleClick,
  preventThreadTabMiddleClickDefault,
} from "~/threadWorkspaceTabInteractions";
import { createThreadWorkspaceRetain } from "~/threadWorkspacePrune";
import {
  selectActiveThreadWorkspaceTarget,
  threadWorkspaceTargetKey,
  type SavedThreadWorkspace,
  type ThreadWorkspaceLayout,
  type ThreadWorkspacePane,
  type ThreadWorkspacePaneTree,
  type ThreadWorkspaceTarget,
  useThreadWorkspaceStore,
} from "~/threadWorkspaceStore";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";

import { ChatViewWithoutDiffWorkerPool } from "../ChatView";
import { DiffWorkerPoolProvider } from "../DiffWorkerPoolProvider";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
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

function treePaneIdsForUi(tree: ThreadWorkspacePaneTree): readonly string[] {
  return tree.type === "pane"
    ? [tree.paneId]
    : [...treePaneIdsForUi(tree.first), ...treePaneIdsForUi(tree.second)];
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

function formatSavedWorkspaceSummary(entry: SavedThreadWorkspace): string {
  const label =
    LAYOUT_OPTIONS.find((option) => option.value === entry.layout)?.label ?? entry.layout;
  const threads = entry.panes.reduce((count, pane) => count + pane.tabs.length, 0);
  return `${label} · ${threads} ${threads === 1 ? "thread" : "threads"}`;
}

function SaveWorkspaceDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly suggestedName: string;
}) {
  const saveWorkspace = useThreadWorkspaceStore((state) => state.saveWorkspace);
  const [name, setName] = useState(props.suggestedName);

  // The suggestion is derived from the live workspace, so it has to catch up
  // each time the dialog is opened rather than freezing at first mount.
  useEffect(() => {
    if (props.open) setName(props.suggestedName);
  }, [props.open, props.suggestedName]);

  const trimmed = name.trim();
  const submit = () => {
    if (trimmed.length === 0) return;
    saveWorkspace(trimmed);
    props.onOpenChange(false);
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Save workspace</DialogTitle>
          <DialogDescription>
            Stores the current layout, open tabs and selected threads so you can come back to them.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <Input
            autoFocus
            aria-label="Workspace name"
            value={name}
            placeholder="Workspace name"
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              submit();
            }}
          />
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
          <Button disabled={trimmed.length === 0} onClick={submit}>
            Save
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function ThreadLayoutMenu({ layout }: { readonly layout: ThreadWorkspaceLayout }) {
  const navigate = useNavigate();
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const { deleteWorkspace, restoreWorkspace, saved, setLayout, splitActivePane, totalTabs } =
    useThreadWorkspaceStore(
      useShallow((state) => ({
        deleteWorkspace: state.deleteWorkspace,
        restoreWorkspace: state.restoreWorkspace,
        saved: state.saved,
        setLayout: state.setLayout,
        splitActivePane: state.splitActivePane,
        totalTabs: state.panes.reduce((count, pane) => count + pane.tabs.length, 0),
      })),
    );
  const layoutLabel = LAYOUT_OPTIONS.find((option) => option.value === layout)?.label ?? layout;
  const suggestedName = `${layoutLabel} · ${totalTabs} ${totalTabs === 1 ? "thread" : "threads"}`;

  return (
    <>
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
        <MenuPopup align="end" side="bottom" sideOffset={6} className="min-w-56">
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
          <MenuSeparator />
          <MenuGroup>
            <MenuGroupLabel>Split active pane</MenuGroupLabel>
            <MenuItem closeOnClick onClick={() => splitActivePane("horizontal")}>
              <Columns2Icon className="size-3.5 shrink-0" /> Split into columns
            </MenuItem>
            <MenuItem closeOnClick onClick={() => splitActivePane("vertical")}>
              <Rows2Icon className="size-3.5 shrink-0" /> Split into rows
            </MenuItem>
          </MenuGroup>
          <MenuSeparator />
          <MenuGroup>
            <MenuGroupLabel>Saved workspaces</MenuGroupLabel>
            {saved.length === 0 ? (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">
                Nothing saved yet. The current workspace is restored automatically on reload.
              </p>
            ) : (
              saved.map((entry) => (
                <MenuItem
                  key={entry.id}
                  closeOnClick
                  className="group/saved gap-2"
                  onClick={() => {
                    restoreWorkspace(entry.id);
                    // Without this the URL still names the thread that was open,
                    // and binding it back would inject it into the workspace the
                    // user just restored.
                    const target = selectActiveThreadWorkspaceTarget(
                      useThreadWorkspaceStore.getState(),
                    );
                    if (target) navigateToTarget(navigate, target);
                  }}
                >
                  <BookmarkIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{entry.name}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {formatSavedWorkspaceSummary(entry)}
                    </span>
                  </span>
                  <button
                    type="button"
                    aria-label={`Delete workspace ${entry.name}`}
                    className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground group-hover/saved:opacity-100 focus-visible:opacity-100"
                    onClick={(event) => {
                      // The row itself restores; deleting must not also load the
                      // workspace it just removed.
                      event.stopPropagation();
                      event.preventDefault();
                      deleteWorkspace(entry.id);
                    }}
                  >
                    <Trash2Icon className="size-3" />
                  </button>
                </MenuItem>
              ))
            )}
            <MenuSeparator />
            <MenuItem closeOnClick onClick={() => setSaveDialogOpen(true)}>
              <BookmarkPlusIcon className="size-3.5 shrink-0" aria-hidden />
              Save current workspace…
            </MenuItem>
          </MenuGroup>
        </MenuPopup>
      </Menu>
      <SaveWorkspaceDialog
        open={saveDialogOpen}
        onOpenChange={setSaveDialogOpen}
        suggestedName={suggestedName}
      />
    </>
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

function ThreadWorkspaceDivider(props: {
  readonly axis: "horizontal" | "vertical";
  readonly ratio: number;
  readonly onRatioChange: (ratio: number) => void;
}) {
  const draggingRef = useRef(false);
  const updateRatio = (event: ReactPointerEvent<HTMLDivElement>) => {
    const parent = event.currentTarget.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    const length = props.axis === "horizontal" ? rect.width : rect.height;
    const offset =
      props.axis === "horizontal" ? event.clientX - rect.left : event.clientY - rect.top;
    if (length > 0) props.onRatioChange(offset / length);
  };
  return (
    <div
      role="separator"
      aria-orientation={props.axis === "horizontal" ? "vertical" : "horizontal"}
      aria-valuemin={15}
      aria-valuemax={85}
      aria-valuenow={Math.round(props.ratio * 100)}
      tabIndex={0}
      className={cn(
        "group relative z-30 shrink-0 bg-border/75 outline-none hover:bg-primary/70 focus-visible:bg-primary",
        props.axis === "horizontal" ? "w-px cursor-col-resize" : "h-px cursor-row-resize",
      )}
      onKeyDown={(event) => {
        const decrease = props.axis === "horizontal" ? "ArrowLeft" : "ArrowUp";
        const increase = props.axis === "horizontal" ? "ArrowRight" : "ArrowDown";
        if (event.key !== decrease && event.key !== increase) return;
        event.preventDefault();
        props.onRatioChange(props.ratio + (event.key === increase ? 0.05 : -0.05));
      }}
      onPointerDown={(event) => {
        event.preventDefault();
        draggingRef.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        updateRatio(event);
      }}
      onPointerMove={(event) => {
        if (draggingRef.current) updateRatio(event);
      }}
      onPointerUp={(event) => {
        draggingRef.current = false;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        draggingRef.current = false;
      }}
    >
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute rounded-full bg-primary opacity-0 shadow-sm transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100",
          props.axis === "horizontal"
            ? "left-1/2 top-1/2 h-8 w-1.5 -translate-x-1/2 -translate-y-1/2"
            : "left-1/2 top-1/2 h-1.5 w-8 -translate-x-1/2 -translate-y-1/2",
        )}
      />
    </div>
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
    root,
    pruneTargets,
    setSplitRatio,
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
      root: state.root,
      pruneTargets: state.pruneTargets,
      setSplitRatio: state.setSplitRatio,
    })),
  );
  const routedTargetKey = threadWorkspaceTargetKey(routedTarget);
  const pruneScope = useThreadWorkspacePruneScope();
  const threadRefs = useThreadRefs();
  const knownThreadKeys = useMemo(
    () => new Set(threadRefs.map((ref) => scopedThreadKey(ref))),
    [threadRefs],
  );
  // Both sources above recompute on ordinary thread traffic while their
  // membership is unchanged. Pruning on every one of those would write the
  // persisted workspace to storage on each incoming message, so the pass is
  // gated on what actually decides the outcome.
  const pruneSignature = useMemo(() => {
    const threads = [...knownThreadKeys].sort();
    if (pruneScope === null) return JSON.stringify(["pending", threads]);
    return JSON.stringify([[...pruneScope.known].sort(), [...pruneScope.loaded].sort(), threads]);
  }, [knownThreadKeys, pruneScope]);
  const totalTabs = panes.reduce((count, pane) => count + pane.tabs.length, 0);
  const paneOrder = useMemo(() => {
    const visit = (node: ThreadWorkspacePaneTree): readonly string[] =>
      node.type === "pane" ? [node.paneId] : [...visit(node.first), ...visit(node.second)];
    return visit(root);
  }, [root]);
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

  // A restored workspace can name threads that were deleted since it was
  // written. Prune once the owning environments have actually loaded, so an
  // offline or still-syncing environment keeps its tabs instead of losing them.
  //
  // Deliberately not dependency-driven: the effect runs after every render and
  // leaves immediately unless the signature moved. That keeps the values it
  // reads current without turning ordinary render churn into storage writes.
  const lastPrunedSignatureRef = useRef<string | null>(null);
  useEffect(() => {
    const signature = JSON.stringify([pruneSignature, routedTargetKey]);
    if (lastPrunedSignatureRef.current === signature) return;
    lastPrunedSignatureRef.current = signature;
    pruneTargets(
      createThreadWorkspaceRetain({
        scope: pruneScope,
        knownThreadKeys,
        retainedKeys: new Set([routedTargetKey]),
        // Drafts change on every keystroke, so this reads the store instead of
        // subscribing to it: a draft that disappears is caught by the next
        // prune pass rather than re-running this one while the user types.
        hasDraft: (draftId) => useComposerDraftStore.getState().getDraftSession(draftId) !== null,
      }),
    );
  });

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

  const renderPane = (paneId: string) => {
    const pane = panes.find((candidate) => candidate.id === paneId);
    if (!pane) return null;
    const index = paneOrder.indexOf(pane.id);
    const active = pane.id === activePaneId;
    const target = pane.activeTabKey
      ? (pane.tabs.find((candidate) => threadWorkspaceTargetKey(candidate) === pane.activeTabKey) ??
        null)
      : null;
    const reserveCollapsedSidebarInset = index === 0;
    const reserveNativeControlsInset = index === paneOrder.length - 1;
    return (
      <ThreadPaneSection
        key={pane.id}
        paneId={pane.id}
        paneNumber={index + 1}
        label={`Thread pane ${index + 1}`}
        active={active}
        dragging={draggedTabKey !== null}
        className={cn(
          "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background",
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
          windowDragRegion={index === 0}
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
  };

  const renderTree = (node: ThreadWorkspacePaneTree): ReactNode => {
    if (node.type === "pane") return renderPane(node.paneId);
    return (
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1 bg-border/75",
          node.axis === "horizontal" ? "flex-row" : "flex-col",
        )}
      >
        <div className="flex min-h-0 min-w-0" style={{ flex: `${node.ratio} 1 0%` }}>
          {renderTree(node.first)}
        </div>
        <ThreadWorkspaceDivider
          axis={node.axis}
          ratio={node.ratio}
          onRatioChange={(ratio) => setSplitRatio(treePaneIdsForUi(node.first)[0] ?? "", ratio)}
        />
        <div className="flex min-h-0 min-w-0" style={{ flex: `${1 - node.ratio} 1 0%` }}>
          {renderTree(node.second)}
        </div>
      </div>
    );
  };

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
              "flex min-h-0 min-w-0 bg-border/75",
              rightPanelMaximized ? "w-0 flex-none overflow-hidden" : "flex-1",
            )}
            data-thread-workspace-layout={layout}
          >
            {renderTree(root)}
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
