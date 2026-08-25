import { ArrowUpDownIcon, CheckIcon, FunnelIcon, GroupIcon } from "lucide-react";
import { memo, useCallback } from "react";
import type {
  SidebarProjectGroupingMode,
  SidebarSectionOrderMode,
  SidebarThreadGroupingAxis,
  SidebarThreadSortOrder,
} from "@t3tools/contracts";

import { cn } from "../../lib/utils";
import type { SidebarThreadProviderIdentity } from "../sidebarThreadGrouping";
import {
  Menu,
  MenuGroup,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * The compact layout bar under the project scope row.
 *
 * Three menus, each one axis of the same question "how is this inbox laid
 * out": how sections are cut (grouping), which providers are in scope
 * (filter), and how rows are ordered (sort). Each trigger is an icon plus the
 * current choice in short form, so the bar doubles as the readout of how the
 * list is arranged — no need to open a menu to find out.
 */

const GROUPING_AXIS_LABELS: Record<SidebarThreadGroupingAxis, string> = {
  none: "None",
  environment: "Environment",
  project: "Project",
  provider: "Provider",
};

const PROJECT_GROUPING_MODE_LABELS: Record<SidebarProjectGroupingMode, string> = {
  repository: "Repository",
  repository_path: "Folder",
  separate: "Project",
};

const THREAD_SORT_ORDER_LABELS: Record<SidebarThreadSortOrder, string> = {
  updated_at: "Last activity",
  created_at: "Date created",
};

// Sections and threads are ordered by two different questions, so the menu
// spells the section one out rather than reusing "Last activity": what moves a
// section up is work arriving anywhere inside it.
const SECTION_ORDER_MODE_LABELS: Record<SidebarSectionOrderMode, string> = {
  activity: "Busiest first",
  alphabetical: "Name (A–Z)",
  manual: "Custom (drag to arrange)",
};

/** Trigger readouts: one word each — the bar is ~350px wide with three of them. */
const GROUPING_AXIS_SHORT: Record<SidebarThreadGroupingAxis, string> = {
  none: "Group",
  environment: "Env",
  project: "Project",
  provider: "Provider",
};

const THREAD_SORT_ORDER_SHORT: Record<SidebarThreadSortOrder, string> = {
  updated_at: "Activity",
  created_at: "Created",
};

const GROUPING_AXES: ReadonlyArray<SidebarThreadGroupingAxis> = [
  "none",
  "environment",
  "project",
  "provider",
];

const TRIGGER_CLASS =
  "inline-flex h-6 min-w-0 cursor-pointer items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-icon-muted transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-3.5 [&_svg]:shrink-0";

const ACTIVE_TRIGGER_CLASS = "text-foreground";

// Group labels are small caps so they can never be mistaken for a choice;
// choices keep the menu's normal item size and show a check when selected.
const MENU_LABEL_CLASS =
  "px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70";
const MENU_ITEM_CLASS = "min-h-7 py-1 sm:text-xs";

/** Radio item body with a trailing check that only the selected option shows. */
function Choice(props: { children: string }) {
  return (
    <span className="flex min-w-0 items-center justify-between gap-3">
      <span className="min-w-0 truncate">{props.children}</span>
      <CheckIcon
        aria-hidden
        className="size-3.5 shrink-0 opacity-0 in-data-[checked]:opacity-100"
      />
    </span>
  );
}

function groupingReadout(
  primaryAxis: SidebarThreadGroupingAxis,
  secondaryAxis: SidebarThreadGroupingAxis,
): string {
  if (primaryAxis === "none") {
    return GROUPING_AXIS_SHORT.none;
  }
  if (secondaryAxis === "none" || secondaryAxis === primaryAxis) {
    return GROUPING_AXIS_SHORT[primaryAxis];
  }
  return `${GROUPING_AXIS_SHORT[primaryAxis]} › ${GROUPING_AXIS_SHORT[secondaryAxis]}`;
}

/** Tooltip copy for the grouping trigger, with the axes spelled out in full. */
function groupingTooltip(
  primaryAxis: SidebarThreadGroupingAxis,
  secondaryAxis: SidebarThreadGroupingAxis,
): string {
  if (primaryAxis === "none") {
    return "Group threads";
  }
  const primary = GROUPING_AXIS_LABELS[primaryAxis];
  if (secondaryAxis === "none" || secondaryAxis === primaryAxis) {
    return `Grouped by ${primary.toLowerCase()}`;
  }
  return `Grouped by ${primary.toLowerCase()}, then ${GROUPING_AXIS_LABELS[secondaryAxis].toLowerCase()}`;
}

export interface SidebarGroupingBarProps {
  primaryAxis: SidebarThreadGroupingAxis;
  secondaryAxis: SidebarThreadGroupingAxis;
  projectGroupingMode: SidebarProjectGroupingMode;
  threadSortOrder: SidebarThreadSortOrder;
  providerFilter: string | null;
  providerOptions: ReadonlyArray<SidebarThreadProviderIdentity>;
  onPrimaryAxisChange: (axis: SidebarThreadGroupingAxis) => void;
  onSecondaryAxisChange: (axis: SidebarThreadGroupingAxis) => void;
  onProjectGroupingModeChange: (mode: SidebarProjectGroupingMode) => void;
  onThreadSortOrderChange: (sortOrder: SidebarThreadSortOrder) => void;
  onProviderFilterChange: (providerFilter: string | null) => void;
  sectionOrderMode: SidebarSectionOrderMode;
  onSectionOrderModeChange: (mode: SidebarSectionOrderMode) => void;
  onSectionOrderReset: () => void;
}

export const SidebarGroupingBar = memo(function SidebarGroupingBar(props: SidebarGroupingBarProps) {
  const {
    onPrimaryAxisChange,
    onProjectGroupingModeChange,
    onProviderFilterChange,
    onSecondaryAxisChange,
    onSectionOrderModeChange,
    onThreadSortOrderChange,
  } = props;

  const handlePrimaryAxisChange = useCallback(
    (value: string) => onPrimaryAxisChange(value as SidebarThreadGroupingAxis),
    [onPrimaryAxisChange],
  );
  const handleSecondaryAxisChange = useCallback(
    (value: string) => onSecondaryAxisChange(value as SidebarThreadGroupingAxis),
    [onSecondaryAxisChange],
  );
  const handleProjectGroupingModeChange = useCallback(
    (value: string) => onProjectGroupingModeChange(value as SidebarProjectGroupingMode),
    [onProjectGroupingModeChange],
  );
  const handleThreadSortOrderChange = useCallback(
    (value: string) => onThreadSortOrderChange(value as SidebarThreadSortOrder),
    [onThreadSortOrderChange],
  );
  const handleProviderFilterChange = useCallback(
    (value: string) => onProviderFilterChange(value === "all" ? null : value),
    [onProviderFilterChange],
  );
  const handleSectionOrderModeChange = useCallback(
    (value: string) => onSectionOrderModeChange(value as SidebarSectionOrderMode),
    [onSectionOrderModeChange],
  );

  const groupingActive = props.primaryAxis !== "none";
  const providerFilterActive = props.providerFilter !== null;
  const activeProviderLabel =
    props.providerOptions.find((option) => option.driverKind === props.providerFilter)?.label ??
    props.providerFilter;
  const providerMenuAvailable = props.providerOptions.length > 1 || providerFilterActive;

  return (
    <div
      data-testid="sidebar-grouping-bar"
      className="flex items-center gap-0.5 ps-[calc(var(--sidebar-row-content-inset)-1px)] pe-1"
    >
      <Menu>
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger
                aria-label="Group threads"
                className={cn(TRIGGER_CLASS, groupingActive && ACTIVE_TRIGGER_CLASS)}
              />
            }
          >
            <GroupIcon />
            <span className="min-w-0 truncate">
              {groupingReadout(props.primaryAxis, props.secondaryAxis)}
            </span>
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            {groupingTooltip(props.primaryAxis, props.secondaryAxis)}
          </TooltipPopup>
        </Tooltip>
        <MenuPopup align="start" side="bottom" className="min-w-56">
          <MenuGroup>
            <div className={MENU_LABEL_CLASS}>Group by</div>
            <MenuRadioGroup value={props.primaryAxis} onValueChange={handlePrimaryAxisChange}>
              {GROUPING_AXES.map((axis) => (
                <MenuRadioItem key={axis} value={axis} className={MENU_ITEM_CLASS}>
                  <Choice>
                    {axis === "none" ? "Nothing (flat list)" : GROUPING_AXIS_LABELS[axis]}
                  </Choice>
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
          {groupingActive ? (
            <>
              <MenuSeparator />
              <MenuGroup>
                <div className={MENU_LABEL_CLASS}>Then by</div>
                <MenuRadioGroup
                  value={props.secondaryAxis}
                  onValueChange={handleSecondaryAxisChange}
                >
                  {GROUPING_AXES.filter((axis) => axis !== props.primaryAxis).map((axis) => (
                    <MenuRadioItem key={axis} value={axis} className={MENU_ITEM_CLASS}>
                      <Choice>{axis === "none" ? "Nothing" : GROUPING_AXIS_LABELS[axis]}</Choice>
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </MenuGroup>
            </>
          ) : null}
          <MenuSeparator />
          <MenuGroup>
            <div className={MENU_LABEL_CLASS}>One project is</div>
            <MenuRadioGroup
              value={props.projectGroupingMode}
              onValueChange={handleProjectGroupingModeChange}
            >
              {(
                Object.keys(
                  PROJECT_GROUPING_MODE_LABELS,
                ) as ReadonlyArray<SidebarProjectGroupingMode>
              ).map((mode) => (
                <MenuRadioItem key={mode} value={mode} className={MENU_ITEM_CLASS}>
                  <Choice>{PROJECT_GROUPING_MODE_LABELS[mode]}</Choice>
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
        </MenuPopup>
      </Menu>

      {providerMenuAvailable ? (
        <Menu>
          <Tooltip>
            <TooltipTrigger
              render={
                <MenuTrigger
                  aria-label="Filter threads by provider"
                  className={cn(TRIGGER_CLASS, providerFilterActive && ACTIVE_TRIGGER_CLASS)}
                />
              }
            >
              <FunnelIcon />
              <span className="min-w-0 truncate">
                {providerFilterActive ? activeProviderLabel : "All"}
              </span>
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              {providerFilterActive ? `Showing ${activeProviderLabel}` : "Filter by provider"}
            </TooltipPopup>
          </Tooltip>
          <MenuPopup align="start" side="bottom" className="min-w-52">
            <MenuGroup>
              <div className={MENU_LABEL_CLASS}>Provider</div>
              <MenuRadioGroup
                value={props.providerFilter ?? "all"}
                onValueChange={handleProviderFilterChange}
              >
                <MenuRadioItem value="all" className={MENU_ITEM_CLASS}>
                  <Choice>All providers</Choice>
                </MenuRadioItem>
                {props.providerOptions.map((option) => (
                  <MenuRadioItem
                    key={option.driverKind}
                    value={option.driverKind}
                    className={MENU_ITEM_CLASS}
                  >
                    <Choice>{option.label}</Choice>
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuGroup>
          </MenuPopup>
        </Menu>
      ) : null}

      <Menu>
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger aria-label="Sort threads" className={cn(TRIGGER_CLASS, "ms-auto")} />
            }
          >
            <ArrowUpDownIcon />
            <span className="min-w-0 truncate">
              {THREAD_SORT_ORDER_SHORT[props.threadSortOrder]}
            </span>
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            {`Sorted by ${THREAD_SORT_ORDER_LABELS[props.threadSortOrder].toLowerCase()}`}
          </TooltipPopup>
        </Tooltip>
        <MenuPopup align="end" side="bottom" className="min-w-52">
          <MenuGroup>
            <div className={MENU_LABEL_CLASS}>Sort threads</div>
            <MenuRadioGroup
              value={props.threadSortOrder}
              onValueChange={handleThreadSortOrderChange}
            >
              {(Object.keys(THREAD_SORT_ORDER_LABELS) as ReadonlyArray<SidebarThreadSortOrder>).map(
                (sortOrder) => (
                  <MenuRadioItem key={sortOrder} value={sortOrder} className={MENU_ITEM_CLASS}>
                    <Choice>{THREAD_SORT_ORDER_LABELS[sortOrder]}</Choice>
                  </MenuRadioItem>
                ),
              )}
            </MenuRadioGroup>
          </MenuGroup>
          {/* Sections and the rows inside them are two orders, and this is the
              menu about order — so both live here rather than the section one
              hiding under a grouping menu that is about which sections exist. */}
          {groupingActive ? (
            <>
              <MenuSeparator />
              <MenuGroup>
                <div className={MENU_LABEL_CLASS}>Order sections</div>
                <MenuRadioGroup
                  value={props.sectionOrderMode}
                  onValueChange={handleSectionOrderModeChange}
                >
                  {(
                    Object.keys(SECTION_ORDER_MODE_LABELS) as ReadonlyArray<SidebarSectionOrderMode>
                  ).map((mode) => (
                    <MenuRadioItem key={mode} value={mode} className={MENU_ITEM_CLASS}>
                      <Choice>{SECTION_ORDER_MODE_LABELS[mode]}</Choice>
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
                {/* Only offered once there is an arrangement to undo: with
                    Busiest first selected there is nothing stored to reset. */}
                {props.sectionOrderMode === "activity" ? null : (
                  <MenuItem className={MENU_ITEM_CLASS} onClick={props.onSectionOrderReset}>
                    Reset section order
                  </MenuItem>
                )}
              </MenuGroup>
            </>
          ) : null}
        </MenuPopup>
      </Menu>
    </div>
  );
});
