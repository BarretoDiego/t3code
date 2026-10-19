import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  readConfirmDialogState,
  registerConfirmDialogHost,
  resetConfirmDialogForTests,
  respondToConfirmDialog,
} from "../confirmDialog";
import { confirmThreadInterruption, isIntentionalInterruption } from "./threadInterruption";

afterEach(resetConfirmDialogForTests);

describe("thread interruption guard", () => {
  it("waits for approval and cancellation does not authorize interruption", async () => {
    registerConfirmDialogHost();
    const result = confirmThreadInterruption("environment:thread", "My task", true);
    expect(readConfirmDialogState().status).toBe("confirming");
    respondToConfirmDialog(false);
    await expect(result).resolves.toBe(false);
  });

  it("authorizes only the confirmed request and ignores duplicate clicks", async () => {
    registerConfirmDialogHost();
    const first = confirmThreadInterruption("environment:thread", "My task", true);
    await expect(confirmThreadInterruption("environment:thread", "My task", true)).resolves.toBe(
      false,
    );
    respondToConfirmDialog(true);
    await expect(first).resolves.toBe(true);
  });

  it("allows opt-out and fails closed without a dialog host", async () => {
    await expect(confirmThreadInterruption("a", "Task", false)).resolves.toBe(true);
    await expect(confirmThreadInterruption("a", "Task", true)).resolves.toBe(false);
  });

  it.each(["MacIntel", "Win32", "Linux"])("requires the platform modifier on %s", (platform) => {
    const event = {
      metaKey: platform === "MacIntel",
      ctrlKey: platform !== "MacIntel",
      shiftKey: false,
      altKey: false,
    };
    expect(isIntentionalInterruption(event, platform)).toBe(true);
    expect(isIntentionalInterruption({ ...event, metaKey: false, ctrlKey: false }, platform)).toBe(
      false,
    );
    expect(
      isIntentionalInterruption(
        { ...event, metaKey: !event.metaKey, ctrlKey: !event.ctrlKey },
        platform,
      ),
    ).toBe(false);
    expect(isIntentionalInterruption({ ...event, altKey: true }, platform)).toBe(false);
    expect(isIntentionalInterruption({ ...event, shiftKey: true }, platform)).toBe(false);
  });
});
