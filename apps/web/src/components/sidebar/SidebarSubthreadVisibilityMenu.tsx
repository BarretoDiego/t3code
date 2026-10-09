import { ListTreeIcon } from "lucide-react";
import { useClientSettings, persistClientSettingsUpdate } from "../../hooks/useSettings";
import { useSidebarArchives } from "../../hooks/useSidebarThreadShells";
import { Menu, MenuCheckboxItem, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { SidebarMenuButton } from "../ui/sidebar";
import { toastManager } from "../ui/toast";

export function SidebarSubthreadVisibilityItem() {
  const checked = useClientSettings((settings) => settings.sidebarShowAllSubthreads);
  const archives = useSidebarArchives();
  return (
    <>
      <MenuCheckboxItem
        checked={checked}
        onCheckedChange={(value) => {
          void persistClientSettingsUpdate((settings) => ({
            ...settings,
            sidebarShowAllSubthreads: value,
          })).catch((error: unknown) => {
            toastManager.add({
              type: "error",
              title: "Failed to save sidebar options",
              description: error instanceof Error ? error.message : "Please try again.",
            });
          });
        }}
      >
        <span className="flex flex-col">
          <span>Show all subthreads</span>
          <span className="text-xs text-muted-foreground">Including settled and archived</span>
        </span>
      </MenuCheckboxItem>
      {checked && archives.error !== null ? (
        <MenuItem onClick={archives.refresh}>Could not load archived subthreads. Retry</MenuItem>
      ) : null}
      {checked && archives.isLoading ? (
        <MenuItem disabled>Loading archived subthreads…</MenuItem>
      ) : null}
    </>
  );
}

export function SidebarSubthreadVisibilityMenu() {
  return (
    <Menu>
      <MenuTrigger
        render={<SidebarMenuButton size="icon" aria-label="Sidebar options" focusRing="sidebar" />}
      >
        <ListTreeIcon />
      </MenuTrigger>
      <MenuPopup align="end">
        <SidebarSubthreadVisibilityItem />
      </MenuPopup>
    </Menu>
  );
}
