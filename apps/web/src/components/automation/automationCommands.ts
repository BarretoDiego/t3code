import {
  type AutomationErrorPresentation,
  presentAutomationError,
} from "@t3tools/client-runtime/state/automation-presentation";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { randomUUID } from "../../lib/utils";
import { stackedThreadToast, toastManager } from "../ui/toast";

/**
 * Shows why an automation command failed and returns what it showed, or null
 * when the command succeeded or was interrupted.
 *
 * An unknown outcome is a warning, not an error: the change may have happened.
 */
export function reportAutomationFailure(
  title: string,
  result: AtomCommandResult<unknown, unknown>,
): AutomationErrorPresentation | null {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return null;
  const error = presentAutomationError(squashAtomCommandFailure(result));
  toastManager.add(
    stackedThreadToast({
      type: error.outcomeUnknown ? "warning" : "error",
      title: error.outcomeUnknown ? `${title}: outcome unknown` : title,
      description: error.message,
    }),
  );
  return error;
}

/** A fresh nonce for one user action. A retry of the same action reuses it. */
export function newActionNonce(): string {
  return randomUUID();
}
