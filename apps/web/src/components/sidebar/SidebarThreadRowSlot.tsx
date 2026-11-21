import type { ScopedThreadRef } from "@t3tools/contracts";
import type {
  PluginStore,
  PluginThreadShell,
  SidebarThreadRowContributionProps,
} from "@t3tools/plugin-sdk/web";

import { useThreadRouteRef } from "~/hooks/useThreadRouteTarget";
import { PluginSlot } from "~/plugins/features";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentThreadShells } from "~/state/threads";

// Shared by every row and read only by contributions, so a sidebar without one
// never mounts it and a shell update re-renders only rows whose selection changed.
const threadShells: PluginStore<readonly PluginThreadShell[]> = {
  get: () => appAtomRegistry.get(environmentThreadShells.quietThreadShellsAtom),
  subscribe: (listener) =>
    appAtomRegistry.subscribe(environmentThreadShells.quietThreadShellsAtom, listener),
};

export function SidebarThreadRowSlot(props: {
  slot: "sidebar.thread.row.accessories" | "sidebar.thread.row.children";
  threadRef: ScopedThreadRef;
}) {
  const activeThreadRef = useThreadRouteRef();
  return (
    <PluginSlot<SidebarThreadRowContributionProps>
      slot={props.slot}
      props={{ threadRef: props.threadRef, activeThreadRef, threads: threadShells }}
    />
  );
}
