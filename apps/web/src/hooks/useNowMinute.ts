import { minuteTick } from "@t3tools/client-runtime/clock";
import { useSyncExternalStore } from "react";

export function useNowMinute(): string {
  return useSyncExternalStore(minuteTick.subscribe, minuteTick.getSnapshot, minuteTick.getSnapshot);
}

/** `Date.now()` truncated to the minute, for relative ages that only change per minute. */
export function useNowMinuteMs(): number {
  return Date.parse(`${useNowMinute()}Z`);
}
