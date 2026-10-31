import type { ProviderRateLimitWindow } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  WINDOW_RESET_BUFFER_MS,
  clockSendAt,
  from12Hour,
  nextClockDay,
  relativeSendAt,
  scheduleWindowOptions,
  to12Hour,
  wrapInto,
} from "./scheduleSend.logic";

const NOW = new Date(2026, 9, 30, 15, 30).getTime();

const window = (overrides: Partial<ProviderRateLimitWindow>): ProviderRateLimitWindow =>
  ({
    id: "five_hour",
    label: "5-hour",
    kind: "session",
    usedPercent: 80,
    resetsAt: null,
    status: "ok",
    ...overrides,
  }) as ProviderRateLimitWindow;

describe("scheduleWindowOptions", () => {
  it("sends two minutes after the window resets, soonest first", () => {
    const options = scheduleWindowOptions(
      [
        window({
          id: "weekly",
          label: "Weekly",
          resetsAt: new Date(NOW + 3 * 86_400_000).toISOString(),
        }),
        window({ resetsAt: new Date(NOW + 3_600_000).toISOString() }),
      ],
      NOW,
    );
    expect(options.map((option) => option.id)).toEqual(["five_hour", "weekly"]);
    expect(Date.parse(options[0]!.sendAt) - Date.parse(options[0]!.resetsAt)).toBe(
      WINDOW_RESET_BUFFER_MS,
    );
  });

  it("skips windows with no reset time or whose reset already passed", () => {
    expect(
      scheduleWindowOptions(
        [
          window({ resetsAt: null }),
          window({ id: "old", resetsAt: new Date(NOW - 10 * 60_000).toISOString() }),
        ],
        NOW,
      ),
    ).toEqual([]);
  });

  it("still offers a window that reset less than the buffer ago", () => {
    const justReset = new Date(NOW - 60_000).toISOString();
    // The reset was a minute ago, so reset + 2m is still a minute away.
    expect(scheduleWindowOptions([window({ resetsAt: justReset })], NOW)).toHaveLength(1);
  });
});

describe("relativeSendAt", () => {
  it("adds hours and minutes to now", () => {
    expect(relativeSendAt({ hours: 1, minutes: 30 }, NOW)).toBe(
      new Date(NOW + 90 * 60_000).toISOString(),
    );
  });

  it("rejects an empty or runaway wait", () => {
    expect(relativeSendAt({ hours: 0, minutes: 0 }, NOW)).toBeNull();
    expect(relativeSendAt({ hours: 24 * 31, minutes: 0 }, NOW)).toBeNull();
    expect(relativeSendAt({ hours: Number.NaN, minutes: 5 }, NOW)).toBeNull();
  });
});

describe("clockSendAt and nextClockDay", () => {
  const today = new Date(2026, 9, 30);

  it("resolves a time still ahead today", () => {
    expect(clockSendAt(today, { hour: 18, minute: 0 }, NOW)).toBe(
      new Date(2026, 9, 30, 18, 0).toISOString(),
    );
  });

  it("refuses a time that has passed", () => {
    expect(clockSendAt(today, { hour: 9, minute: 0 }, NOW)).toBeNull();
    expect(clockSendAt(today, { hour: 15, minute: 30 }, NOW)).toBeNull();
  });

  it("moves a passed time to tomorrow, including across a month end", () => {
    expect(nextClockDay({ hour: 18, minute: 0 }, NOW).getDate()).toBe(30);
    const tomorrow = nextClockDay({ hour: 9, minute: 0 }, NOW);
    expect([tomorrow.getMonth(), tomorrow.getDate()]).toEqual([9, 31]);
    const monthEnd = new Date(2026, 9, 31, 23, 0).getTime();
    const rolled = nextClockDay({ hour: 9, minute: 0 }, monthEnd);
    expect([rolled.getMonth(), rolled.getDate()]).toEqual([10, 1]);
  });
});

describe("12-hour helpers", () => {
  it("maps midnight and noon", () => {
    expect(to12Hour(0)).toEqual({ hour: 12, pm: false });
    expect(to12Hour(12)).toEqual({ hour: 12, pm: true });
    expect(to12Hour(15)).toEqual({ hour: 3, pm: true });
  });

  it("round-trips every hour", () => {
    for (let hour = 0; hour < 24; hour += 1) {
      const { hour: h12, pm } = to12Hour(hour);
      expect(from12Hour(h12, pm)).toBe(hour);
    }
  });

  it("wraps out-of-range steps", () => {
    expect(wrapInto(60, 0, 59)).toBe(0);
    expect(wrapInto(-1, 0, 59)).toBe(59);
    expect(wrapInto(13, 1, 12)).toBe(1);
    expect(wrapInto(0, 1, 12)).toBe(12);
  });
});
