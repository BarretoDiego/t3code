import { isMacPlatform } from "./utils";
import { requestConfirmDialog } from "../confirmDialog";

const pending = new Set<string>();

export function isIntentionalInterruption(
  event: { metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean },
  platform: string,
): boolean {
  return (
    !event.altKey &&
    !event.shiftKey &&
    (isMacPlatform(platform) ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)
  );
}

export async function confirmThreadInterruption(
  target: string,
  title: string,
  enabled: boolean,
): Promise<boolean> {
  if (!enabled) return true;
  if (pending.has(target)) return false;
  pending.add(target);
  try {
    return (
      (await requestConfirmDialog(`Stop "${title}"?\nThis interrupts the running work.`, {
        variant: "destructive",
      })) ?? false
    );
  } finally {
    pending.delete(target);
  }
}
