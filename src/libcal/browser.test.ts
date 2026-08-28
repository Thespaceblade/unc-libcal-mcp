import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  calendarStepDirection,
  findSlotAtTime,
  isBookingConfirmed,
  parseResourceItemId,
  pickEndTimeOption,
  SLOT_MATCH_TOLERANCE_PX,
} from "../libcal/browser.js";

describe("parseResourceItemId", () => {
  it("parses LibCal eid_ prefix", () => {
    assert.equal(parseResourceItemId("eid_29085"), 29085);
  });

  it("parses plain numeric ids", () => {
    assert.equal(parseResourceItemId("29085"), 29085);
  });

  it("returns null for garbage", () => {
    assert.equal(parseResourceItemId(undefined), null);
    assert.equal(parseResourceItemId("foo"), null);
  });
});

describe("calendarStepDirection", () => {
  it("stops when dates match", () => {
    assert.equal(calendarStepDirection("2026-08-28", "2026-08-28"), "done");
  });

  it("steps forward for later dates", () => {
    assert.equal(calendarStepDirection("2026-08-27", "2026-08-28"), "next");
  });

  it("steps backward for earlier dates", () => {
    assert.equal(calendarStepDirection("2026-08-29", "2026-08-28"), "prev");
  });

  it("returns unknown when heading cannot be parsed", () => {
    assert.equal(calendarStepDirection(null, "2026-08-28"), "unknown");
  });
});

describe("isBookingConfirmed", () => {
  it("detects confirmation phrases", () => {
    assert.equal(isBookingConfirmed("<h1>Booking Confirmed</h1>"), true);
    assert.equal(
      isBookingConfirmed("Your booking has been submitted. Check your email."),
      true,
    );
    assert.equal(isBookingConfirmed("<p>Still loading...</p>"), false);
  });
});

describe("pickEndTimeOption", () => {
  const options = [
    "11:30am Friday, August 28, 2026",
    "12:00pm Friday, August 28, 2026",
    "1:00pm Friday, August 28, 2026",
    "1:30pm Friday, August 28, 2026",
  ];

  it("finds exact end label", () => {
    assert.equal(pickEndTimeOption(options, "1:00pm"), "1:00pm Friday, August 28, 2026");
  });

  it("returns null when missing", () => {
    assert.equal(pickEndTimeOption(options, "3:00pm"), null);
  });

  it("handles empty options", () => {
    assert.equal(pickEndTimeOption([], "1:00pm"), null);
  });
});

describe("findSlotAtTime", () => {
  const headers = [
    { label: "10:00am", centerX: 200 },
    { label: "11:00am", centerX: 300 },
    { label: "12:00pm", centerX: 400 },
  ];

  const slots = [
    { centerX: 298, room: "Cube 1" },
    { centerX: 350, room: "Cube 2" },
    { centerX: 500, room: "Cube 3" },
  ];

  it("matches slot within tolerance", () => {
    const hit = findSlotAtTime(headers, slots, "11:00am", SLOT_MATCH_TOLERANCE_PX);
    assert.equal(hit?.room, "Cube 1");
  });

  it("returns null when header missing", () => {
    assert.equal(findSlotAtTime(headers, slots, "9:00am"), null);
  });

  it("returns null when no slot aligns", () => {
    const far = [{ centerX: 100, room: "Cube 9" }];
    assert.equal(findSlotAtTime(headers, far, "11:00am"), null);
  });

  it("is case-insensitive on header label", () => {
    const hit = findSlotAtTime(headers, slots, "11:00AM");
    assert.ok(hit);
  });
});
