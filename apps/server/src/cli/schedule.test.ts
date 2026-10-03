import { assert, describe, it } from "@effect/vitest";

import { describeSchedule, parseWeekdays } from "./schedule.ts";

describe("schedule CLI", () => {
  it("reads --days as names, numbers, lists, and ranges", () => {
    assert.deepStrictEqual(parseWeekdays("mon-fri"), [1, 2, 3, 4, 5]);
    assert.deepStrictEqual(parseWeekdays("weekdays"), [1, 2, 3, 4, 5]);
    assert.deepStrictEqual(parseWeekdays("Sat, sun"), [0, 6]);
    assert.deepStrictEqual(parseWeekdays("monday,WEDNESDAY,5"), [1, 3, 5]);
    // A range may wrap around the end of the week.
    assert.deepStrictEqual(parseWeekdays("fri-mon"), [0, 1, 5, 6]);
  });

  it("treats every day as no day restriction", () => {
    assert.deepStrictEqual(parseWeekdays("daily"), []);
    assert.deepStrictEqual(parseWeekdays("sun-sat"), []);
    assert.deepStrictEqual(parseWeekdays("0,1,2,3,4,5,6"), []);
  });

  it("rejects days it cannot read rather than guessing", () => {
    assert.strictEqual(parseWeekdays("someday"), null);
    assert.strictEqual(parseWeekdays("7"), null);
    assert.strictEqual(parseWeekdays("mon-"), null);
    assert.strictEqual(parseWeekdays("mon-wed-fri"), null);
    assert.strictEqual(parseWeekdays(""), null);
  });

  it("describes a schedule the way it was asked for", () => {
    assert.strictEqual(describeSchedule({ type: "interval", everyMs: 7_200_000 }), "every 2h");
    assert.strictEqual(describeSchedule({ type: "interval", everyMs: 5_400_000 }), "every 90m");
    assert.strictEqual(describeSchedule({ type: "interval", everyMs: 86_400_000 }), "every 1d");
    // Schedules saved before the one-minute minimum still list correctly.
    assert.strictEqual(describeSchedule({ type: "interval", everyMs: 1500 }), "every 1500ms");
    assert.strictEqual(
      describeSchedule({ type: "fixed_time", timeOfDay: "09:00" }),
      "daily at 09:00",
    );
    assert.strictEqual(
      describeSchedule({ type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] }),
      "weekdays at 09:00",
    );
    assert.strictEqual(
      describeSchedule({ type: "fixed_time", timeOfDay: "18:30", weekdays: [1, 3] }),
      "Mon, Wed at 18:30",
    );
  });
});
