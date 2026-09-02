import { DesktopPetActionSchema, DesktopPetSnapshotSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopWindow from "../../window/DesktopWindow.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

/** State pushed by the main renderer to the isolated companion renderer. */
export const setPetSnapshot = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_PET_SNAPSHOT_CHANNEL,
  payload: DesktopPetSnapshotSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.pet.setSnapshot")(function* (snapshot) {
    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    yield* desktopWindow.setPetSnapshot(snapshot);
  }),
});

/** The companion asks for cached state after its local data URL has loaded. */
export const getPetSnapshot = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PET_GET_SNAPSHOT_CHANNEL,
  payload: Schema.Void,
  result: Schema.NullOr(DesktopPetSnapshotSchema),
  handler: Effect.fn("desktop.ipc.pet.getSnapshot")(function* () {
    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    return yield* desktopWindow.getPetSnapshot;
  }),
});

/** Companion commands are forwarded to the main renderer, which owns state. */
export const dispatchPetAction = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PET_ACTION_CHANNEL,
  payload: DesktopPetActionSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.pet.dispatchAction")(function* (action) {
    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    yield* desktopWindow.dispatchPetAction(action);
  }),
});
