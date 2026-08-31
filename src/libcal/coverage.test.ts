import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  analyzeWindowCoverage,
  findGreedyPiecemealPlan,
  findPiecemealPlans,
  parseTimeWindow,
} from "../libcal/coverage.js";
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

describe("parseTimeWindow", () => {
  it("normalizes hour-only shorthand", () => {
    assert.deepEqual(parseTimeWindow("11", "1"), { windowStart: "11:00", windowEnd: "13:00" });
  });
});

describe("analyzeWindowCoverage", () => {
  const date = "2026-08-31";
  const slots: AvailabilitySlot[] = [
    slot(date, "11:00", "11:30", 1),
    slot(date, "11:30", "12:00", 1),
    slot(date, "11:30", "12:00", 2),
    slot(date, "12:00", "12:30", 2),
    slot(date, "12:30", "13:00", 2),
  ];

  it("reports per-cube segments inside the window", () => {
    const coverage = analyzeWindowCoverage(slots, date, "11:00", "13:00");
    const cube1 = coverage.find((cube) => cube.itemId === 1);
    const cube2 = coverage.find((cube) => cube.itemId === 2);
    assert.equal(cube1?.totalMinutes, 60);
    assert.equal(cube2?.totalMinutes, 90);
  });
});

describe("findGreedyPiecemealPlan", () => {
  const date = "2026-08-31";

  it("chains cubes to cover the full window", () => {
    const slots: AvailabilitySlot[] = [
      slot(date, "11:00", "11:30", 1),
      slot(date, "11:30", "12:00", 2),
      slot(date, "12:00", "12:30", 2),
      slot(date, "12:30", "13:00", 2),
    ];

    const plan = findGreedyPiecemealPlan(slots, date, "11:00", "13:00");
    assert.equal(plan.coveredMinutes, 120);
    assert.equal(plan.gapMinutes, 0);
    assert.equal(plan.segments.length, 2);
    assert.equal(plan.segments[0]?.itemId, 1);
    assert.equal(plan.segments[1]?.itemId, 2);
  });

  it("returns partial coverage when the window cannot be fully covered", () => {
    const slots: AvailabilitySlot[] = [
      slot(date, "11:30", "12:00", 6),
      slot(date, "12:00", "12:30", 6),
      slot(date, "12:30", "13:00", 6),
    ];

    const plan = findGreedyPiecemealPlan(slots, date, "11:00", "13:00");
    assert.equal(plan.coveredMinutes, 90);
    assert.equal(plan.gapMinutes, 30);
    assert.equal(plan.segments[0]?.startTime, "11:30");
    assert.equal(plan.segments[0]?.endTime, "13:00");
  });
});

describe("findPiecemealPlans", () => {
  it("includes both greedy and single-cube options", () => {
    const date = "2026-08-31";
    const slots: AvailabilitySlot[] = [
      slot(date, "11:30", "12:00", 6),
      slot(date, "12:00", "12:30", 6),
      slot(date, "12:30", "13:00", 6),
      slot(date, "11:30", "12:00", 4),
      slot(date, "12:00", "12:30", 4),
      slot(date, "12:30", "13:00", 4),
    ];

    const plans = findPiecemealPlans(slots, date, "11:00", "13:00");
    assert.ok(plans.length >= 2);
    assert.equal(plans[0]?.coveredMinutes, 90);
  });
});
