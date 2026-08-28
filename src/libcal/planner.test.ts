import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findDurationBlocks, formatDurationHint, scoreOption } from "../libcal/planner.js";
import type { AvailabilitySlot } from "../libcal/types.js";

function slot(
  date: string,
  start: string,
  end: string,
  itemId: number,
  available = true,
): AvailabilitySlot {
  return {
    start: `${date} ${start}:00`,
    end: `${date} ${end}:00`,
    itemId,
    checksum: `${itemId}-${start}`,
    available,
  };
}

describe("findDurationBlocks", () => {
  const date = "2026-08-28";
  const slots: AvailabilitySlot[] = [
    slot(date, "11:00", "11:30", 100),
    slot(date, "11:30", "12:00", 100),
    slot(date, "12:00", "12:30", 100),
    slot(date, "12:30", "13:00", 100),
    slot(date, "11:00", "11:30", 200),
    slot(date, "11:30", "12:00", 200),
    slot(date, "13:00", "13:30", 100),
  ];

  it("finds 2-hour consecutive blocks", () => {
    const blocks = findDurationBlocks(slots, date, 120);
    assert.ok(blocks.some((b) => b.itemId === 100 && b.startTime === "11:00" && b.endTime === "13:00"));
    const oneHour = findDurationBlocks(slots, date, 60);
    assert.ok(oneHour.some((b) => b.itemId === 200 && b.startTime === "11:00" && b.endTime === "12:00"));
  });

  it("respects afterTime filter", () => {
    const blocks = findDurationBlocks(slots, date, 60, "12:00");
    assert.ok(blocks.every((b) => b.startTime >= "12:00"));
  });

  it("skips non-consecutive slots", () => {
    const broken = [
      slot(date, "11:00", "11:30", 300),
      slot(date, "12:00", "12:30", 300),
    ];
    const blocks = findDurationBlocks(broken, date, 60);
    assert.equal(blocks.length, 0);
  });

  it("ignores unavailable slots", () => {
    const mixed = [
      slot(date, "11:00", "11:30", 400, true),
      slot(date, "11:30", "12:00", 400, false),
    ];
    assert.equal(findDurationBlocks(mixed, date, 60).length, 0);
  });

  it("returns later non-overlapping blocks after an earlier block on the same room", () => {
    const overlapping = [
      slot(date, "09:30", "10:00", 500),
      slot(date, "10:00", "10:30", 500),
      slot(date, "10:30", "11:00", 500),
      slot(date, "11:00", "11:30", 500),
      slot(date, "11:00", "11:30", 500),
      slot(date, "11:30", "12:00", 500),
      slot(date, "12:00", "12:30", 500),
      slot(date, "12:30", "13:00", 500),
    ];
    const blocks = findDurationBlocks(overlapping, date, 120, "11:00");
    assert.ok(blocks.some((b) => b.itemId === 500 && b.startTime === "11:00" && b.endTime === "13:00"));
  });
});

describe("scoreOption", () => {
  const today = "2026-08-27";
  const tomorrow = "2026-08-28";

  it("prefers same-day when no explicit date requested", () => {
    const todayScore = scoreOption({
      date: today,
      startTime: "14:00",
      today,
      preferSameDay: true,
    }).score;
    const tomorrowScore = scoreOption({
      date: tomorrow,
      startTime: "14:00",
      today,
      preferSameDay: true,
    }).score;
    assert.ok(todayScore < tomorrowScore);
  });

  it("prefers explicit preferredDate over same-day", () => {
    const todayScore = scoreOption({
      date: today,
      startTime: "14:00",
      today,
      preferSameDay: true,
      preferredDate: tomorrow,
    }).score;
    const tomorrowScore = scoreOption({
      date: tomorrow,
      startTime: "14:00",
      today,
      preferSameDay: true,
      preferredDate: tomorrow,
    }).score;
    assert.ok(tomorrowScore < todayScore);
  });

  it("boosts exact preferred start time", () => {
    const exact = scoreOption({
      date: tomorrow,
      startTime: "11:00",
      today,
      preferSameDay: true,
      preferredDate: tomorrow,
      preferredStartTime: "11:00",
    }).score;
    const nearby = scoreOption({
      date: tomorrow,
      startTime: "11:30",
      today,
      preferSameDay: true,
      preferredDate: tomorrow,
      preferredStartTime: "11:00",
    }).score;
    assert.ok(exact < nearby);
  });
});

describe("formatDurationHint", () => {
  it("labels max duration", () => {
    assert.match(formatDurationHint(180), /3 hours/);
    assert.equal(formatDurationHint(60), "1 hour(s)");
  });
});
