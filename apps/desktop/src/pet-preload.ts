// @effect-diagnostics globalDate:off - This isolated Electron preload does not run inside an Effect runtime.
import type { DesktopPetAction, DesktopPetSnapshot } from "@t3tools/contracts";
import { contextBridge, ipcRenderer } from "electron";

import * as IpcChannels from "./ipc/channels.ts";

/** The intentionally tiny capability surface available to the pet data URL. */
export interface DesktopPetBridge {
  getSnapshot: () => Promise<DesktopPetSnapshot | null>;
  onSnapshot: (listener: (snapshot: DesktopPetSnapshot) => void) => () => void;
  dispatchAction: (action: DesktopPetAction) => Promise<void>;
}

contextBridge.exposeInMainWorld("desktopPetBridge", {
  getSnapshot: () => ipcRenderer.invoke(IpcChannels.PET_GET_SNAPSHOT_CHANNEL),
  onSnapshot: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, snapshot: unknown) => {
      if (typeof snapshot !== "object" || snapshot === null) return;
      listener(snapshot as DesktopPetSnapshot);
    };
    ipcRenderer.on(IpcChannels.PET_SNAPSHOT_CHANNEL, wrappedListener);
    return () => ipcRenderer.removeListener(IpcChannels.PET_SNAPSHOT_CHANNEL, wrappedListener);
  },
  dispatchAction: (action) => ipcRenderer.invoke(IpcChannels.PET_ACTION_CHANNEL, action),
} satisfies DesktopPetBridge);
