import type { ProviderRateLimitWindow } from "@t3tools/contracts";

/** Waits past the provider's stated reset, so the new window has opened when the message goes out. */
export const WINDOW_RESET_BUFFER_MS = 2 * 60_000;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const MAX_RELATIVE_MS = 30 * 24 * HOUR_MS;

export interface ScheduleWindowOption {
  readonly id: string;
  readonly label: string;
  readonly usedPercent: number;
  readonly resetsAt: string;
  /** `resetsAt` plus the buffer. */
  readonly sendAt: string;
}

export interface ClockTime {
  /** 0 to 23. */
  readonly hour: number;
  /** 0 to 59. */
  readonly minute: number;
}

/** The provider's open windows, soonest reset first; a window with no known reset has nothing to wait for. */
export function scheduleWindowOptions(
  windows: ReadonlyArray<ProviderRateLimitWindow> | undefined,
  nowMs: number,
): ReadonlyArray<ScheduleWindowOption> {
  const options: Array<ScheduleWindowOption> = [];
  for (const window of windows ?? []) {
    if (window.resetsAt === null) continue;
    const resetMs = Date.parse(window.resetsAt);
    if (!Number.isFinite(resetMs)) continue;
    const sendMs = resetMs + WINDOW_RESET_BUFFER_MS;
    if (sendMs <= nowMs) continue;
    options.push({
      id: window.id,
      label: window.label,
      usedPercent: window.usedPercent,
      resetsAt: window.resetsAt,
      sendAt: new Date(sendMs).toISOString(),
    });
  }
  return options.toSorted((a, b) => Date.parse(a.sendAt) - Date.parse(b.sendAt));
}

/** "In 1h 30m": null for a zero or out-of-range wait. */
export function relativeSendAt(
  wait: { readonly hours: number; readonly minutes: number },
  nowMs: number,
): string | null {
  const waitMs = wait.hours * HOUR_MS + wait.minutes * MINUTE_MS;
  if (!Number.isFinite(waitMs) || waitMs <= 0 || waitMs > MAX_RELATIVE_MS) return null;
  return new Date(nowMs + waitMs).toISOString();
}

/** A local wall-clock time on a local calendar day; null once that instant has passed. */
export function clockSendAt(day: Date, time: ClockTime, nowMs: number): string | null {
  const target = new Date(day.getFullYear(), day.getMonth(), day.getDate(), time.hour, time.minute);
  return target.getTime() > nowMs ? target.toISOString() : null;
}

/** Today when the time is still ahead, otherwise tomorrow. */
export function nextClockDay(time: ClockTime, nowMs: number): Date {
  const now = new Date(nowMs);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (clockSendAt(today, time, nowMs) !== null) return today;
  return new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
}

/** The next whole hour: the default a person usually wants for "later today". */
export function nextFullHour(nowMs: number): ClockTime {
  const next = new Date(nowMs + HOUR_MS);
  return { hour: next.getHours(), minute: 0 };
}

export function clockTimeFromIso(iso: string): ClockTime | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return { hour: date.getHours(), minute: date.getMinutes() };
}

export function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function wrapInto(value: number, min: number, max: number): number {
  const span = max - min + 1;
  return ((((value - min) % span) + span) % span) + min;
}

export function to12Hour(hour: number): { readonly hour: number; readonly pm: boolean } {
  return { hour: ((hour + 11) % 12) + 1, pm: hour >= 12 };
}

export function from12Hour(hour: number, pm: boolean): number {
  return (wrapInto(hour, 1, 12) % 12) + (pm ? 12 : 0);
}
