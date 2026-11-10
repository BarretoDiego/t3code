import { describe, expect, it } from "vite-plus/test";

import { resolveComposerControlsOwnership } from "./composerControlsOwnership";

const base = {
  matchesDefault: true,
  collapsed: false,
  measuredHiddenBlockCount: 0,
};

describe("resolveComposerControlsOwnership", () => {
  it("hides the chip at the default and lets the model picker answer composer.mode", () => {
    const result = resolveComposerControlsOwnership(base);
    expect(result).toMatchObject({
      accessDisplay: "hidden",
      showModeBlock: false,
      hiddenBlockIds: [],
      pickerOwnsModeShortcut: true,
    });
  });

  it("shows a labelled chip that owns composer.mode when the mode differs", () => {
    const result = resolveComposerControlsOwnership({ ...base, matchesDefault: false });
    expect(result).toMatchObject({
      accessDisplay: "label",
      showModeBlock: true,
      pickerOwnsModeShortcut: false,
    });
  });

  it("gives an overflowed chip's Permissions to the overflow menu", () => {
    const result = resolveComposerControlsOwnership({
      ...base,
      matchesDefault: false,
      measuredHiddenBlockCount: 1,
    });
    expect(result.hiddenBlockIds).toEqual(["mode"]);
    expect(result.overflowShowsPermissions).toBe(true);
    expect(result.pickerOwnsModeShortcut).toBe(false);
  });

  it("shows the non-default chip as an icon in the compacted row", () => {
    const result = resolveComposerControlsOwnership({
      ...base,
      matchesDefault: false,
      collapsed: true,
    });
    expect(result.accessDisplay).toBe("icon");
  });

  const forkBlocks = {
    leadingBlockIds: ["profile"],
    beforeModeBlockIds: ["mini-skills"],
  };

  it("overflows fork blocks after mode, last block first", () => {
    const result = resolveComposerControlsOwnership({
      ...base,
      ...forkBlocks,
      matchesDefault: false,
      measuredHiddenBlockCount: 2,
    });
    expect(result.hiddenBlockIds).toEqual(["mini-skills", "mode"]);
    expect(result.overflowShowsPermissions).toBe(true);
  });

  it("keeps fork blocks overflowing when no mode block exists", () => {
    const result = resolveComposerControlsOwnership({
      ...base,
      ...forkBlocks,
      measuredHiddenBlockCount: 5,
    });
    expect(result.hiddenBlockIds).toEqual(["profile", "mini-skills"]);
    expect(result.overflowShowsPermissions).toBe(false);
  });

  it("moves Permissions to the overflow while Profile Mode locks the picker", () => {
    const result = resolveComposerControlsOwnership({
      ...base,
      matchesDefault: false,
      measuredHiddenBlockCount: 1,
      modelPickerLocked: true,
    });
    expect(result.overflowShowsPermissions).toBe(true);
    expect(result.pickerOwnsModeShortcut).toBe(false);
  });

  it("never sends composer.mode to a locked picker", () => {
    const result = resolveComposerControlsOwnership({ ...base, modelPickerLocked: true });
    expect(result.accessDisplay).toBe("hidden");
    expect(result.pickerOwnsModeShortcut).toBe(false);
  });
});
