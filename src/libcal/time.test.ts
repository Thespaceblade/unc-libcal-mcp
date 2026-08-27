import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  addMinutesToDateTime,
  addMinutesToTime,
  calendarHeadingForDate,
  dayDiff,
  localDateString,
  parseCalendarHeading,
  timeTo12HourLabel,
  toFormStart,
} from "../libcal/time.js";

describe("timeTo12HourLabel", () => {
  it("converts morning times", () => {
    assert.equal(timeTo12HourLabel("09:00"), "9:00am");
    assert.equal(timeTo12HourLabel("11:30"), "11:30am");
  });

  it("converts afternoon and midnight edge cases", () => {
    assert.equal(timeTo12HourLabel("13:00"), "1:00pm");
    assert.equal(timeTo12HourLabel("00:00"), "12:00am");
    assert.equal(timeTo12HourLabel("12:00"), "12:00pm");
    assert.equal(timeTo12HourLabel("23:59"), "11:59pm");
  });

  it("rejects invalid input", () => {
    assert.throws(() => timeTo12HourLabel("25:00"));
    assert.throws(() => timeTo12HourLabel("ab:cd"));
  });
});

describe("addMinutesToTime", () => {
  it("adds within same day", () => {
    assert.equal(addMinutesToTime("11:00", 120), "13:00");
  });

  it("wraps past midnight", () => {
    assert.equal(addMinutesToTime("23:30", 60), "00:30");
  });
});

describe("addMinutesToDateTime", () => {
  it("extends booking end across hour boundary", () => {
    assert.equal(
      addMinutesToDateTime("2026-08-28 11:00:00", 120),
      "2026-08-28 13:00:00",
    );
  });

  it("rolls to next calendar day when needed", () => {
    assert.equal(
      addMinutesToDateTime("2026-08-28 23:30:00", 60),
      "2026-08-29 00:30:00",
    );
  });
});

describe("toFormStart", () => {
  it("formats LibCal cart start param", () => {
    assert.equal(toFormStart("2026-08-28 14:00:00"), "2026-08-28+14:00");
  });
});

describe("calendarHeadingForDate / parseCalendarHeading", () => {
  it("round-trips LibCal calendar headings", () => {
    const heading = calendarHeadingForDate("2026-08-28");
    assert.equal(heading, "Friday, August 28, 2026");
    assert.equal(parseCalendarHeading(heading), "2026-08-28");
  });

  it("returns null for garbage", () => {
    assert.equal(parseCalendarHeading("not a date"), null);
  });
});

describe("dayDiff", () => {
  it("counts forward days", () => {
    assert.equal(dayDiff("2026-08-27", "2026-08-28"), 1);
    assert.equal(dayDiff("2026-08-27", "2026-08-30"), 3);
  });
});

describe("localDateString", () => {
  it("uses local calendar components", () => {
    const d = new Date(2026, 7, 28, 23, 30); // Aug 28 local
    assert.equal(localDateString(d), "2026-08-28");
  });
});
