/**
 * Where the permissions chip shows, whether the mode block overflows, and which control answers
 * the composer.mode shortcut. The model picker's footer always holds Permissions, so the chip
 * only shows while the mode differs from the default. The rule: composer.mode has one target.
 */
export function resolveComposerControlsOwnership(input: {
  /** Permissions hide while the mode is the default, or while the new-thread strip names it. */
  readonly matchesDefault: boolean;
  readonly collapsed: boolean;
  /** How many trailing blocks the width measurement moved into the overflow menu. */
  readonly measuredHiddenBlockCount: number;
  /** Fork-only: Profile Mode owns the model, so the picker cannot open to offer Permissions. */
  readonly modelPickerLocked?: boolean;
  /** Fork-only blocks that render first and overflow last. */
  readonly leadingBlockIds?: ReadonlyArray<string>;
  /** Fork-only blocks that render just before mode. */
  readonly beforeModeBlockIds?: ReadonlyArray<string>;
}) {
  const accessDisplay = input.matchesDefault
    ? ("hidden" as const)
    : input.collapsed
      ? ("icon" as const)
      : ("label" as const);
  const showModeBlock = accessDisplay !== "hidden";
  const blockIds = [
    ...(input.leadingBlockIds ?? []),
    ...(input.beforeModeBlockIds ?? []),
    ...(showModeBlock ? ["mode" as const] : []),
  ];
  const hiddenBlockIds = blockIds.slice(
    blockIds.length - Math.min(input.measuredHiddenBlockCount, blockIds.length),
  );
  const modeHidden = hiddenBlockIds.includes("mode");
  const overflowShowsPermissions = modeHidden;
  return {
    accessDisplay,
    showModeBlock,
    hiddenBlockCount: hiddenBlockIds.length,
    hiddenBlockIds,
    overflowShowsPermissions,
    /** Without a visible chip or an overflow menu holding it, the model picker answers composer.mode. */
    pickerOwnsModeShortcut:
      input.modelPickerLocked !== true &&
      !overflowShowsPermissions &&
      (accessDisplay === "hidden" || modeHidden),
  };
}
