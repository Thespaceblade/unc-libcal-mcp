import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findDurationBlocks } from "../libcal/planner.js";
import { filterSlots } from "../libcal/client.js";
import { timeTo12HourLabel } from "../libcal/time.js";
import type { AvailabilitySlot } from "../libcal/types.js";

/**
 * End-to-end style test using recorded slot shapes (no network).
 * Simulates: user asks for tomorrow 11:00–13:00 cube booking.
 */
describe("booking scenario: tomorrow 11am–1pm cube", () => {
  const date = "2026-08-28";
  const slots: AvailabilitySlot[] = [];

  for (const itemId of [29085, 29086, 29089, 29091]) {
    for (const [start, end] of [
      ["11:00", "11:30"],
      ["11:30", "12:00"],
      ["12:00", "12:30"],
      ["12:30", "13:00"],
    ] as const) {
      slots.push({
        start: `${date} ${start}:00`,
        end: `${date} ${end}:00`,
        itemId,
        checksum: `${itemId}-${start}`,
        available: true,
        className: "s-lc-eq-avail",
      });
    }
  }

  it("finds 2-hour blocks at 11:00 for multiple cubes", () => {
    const blocks = findDurationBlocks(slots, date, 120, "11:00");
    const at11 = blocks.filter((b) => b.startTime === "11:00" && b.endTime === "13:00");
    assert.ok(at11.length >= 3);
  });

  it("maps start time to LibCal UI label used by browser automation", () => {
    assert.equal(timeTo12HourLabel("11:00"), "11:00am");
    assert.equal(timeTo12HourLabel("13:00"), "1:00pm");
  });

  it("filterSlots returns 11:00 starts before 13:00 bound", () => {
    const open = filterSlots(slots, { afterTime: "11:00", beforeTime: "13:00" });
    assert.ok(open.every((s) => s.start.includes("11:") || s.start.includes("12:")));
    assert.ok(open.some((s) => s.start.endsWith("11:00:00")));
  });
});
