import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  filterSlots,
  isSlotAvailable,
  parseAvailabilitySlots,
  slotDate,
  slotStartTime,
} from "../libcal/client.js";
import type { AvailabilitySlot } from "../libcal/types.js";

describe("isSlotAvailable", () => {
  it("marks checkout and unavail classes as taken", () => {
    assert.equal(isSlotAvailable("s-lc-eq-checkout"), false);
    assert.equal(isSlotAvailable("s-lc-eq-unavail"), false);
    assert.equal(isSlotAvailable("s-lc-eq-avail"), true);
    assert.equal(isSlotAvailable(undefined), true);
  });
});

describe("parseAvailabilitySlots", () => {
  it("parses API grid payload", () => {
    const slots = parseAvailabilitySlots([
      {
        start: "2026-08-28 11:00:00",
        end: "2026-08-28 11:30:00",
        itemId: 29085,
        checksum: "abc123",
        className: "s-lc-eq-avail",
      },
      {
        start: "2026-08-28 11:30:00",
        end: "2026-08-28 12:00:00",
        itemId: 29085,
        checksum: "def456",
        className: "s-lc-eq-checkout s-lc-eq-checkout",
      },
    ]);

    assert.equal(slots.length, 2);
    assert.equal(slots[0].available, true);
    assert.equal(slots[1].available, false);
    assert.equal(slots[0].itemId, 29085);
  });
});

describe("slotDate / slotStartTime", () => {
  const slot: AvailabilitySlot = {
    start: "2026-08-28 13:30:00",
    end: "2026-08-28 14:00:00",
    itemId: 1,
    checksum: "x",
    available: true,
  };

  it("extracts date and time", () => {
    assert.equal(slotDate(slot), "2026-08-28");
    assert.equal(slotStartTime(slot), "13:30");
  });
});

describe("filterSlots", () => {
  const slots: AvailabilitySlot[] = [
    { start: "2026-08-28 09:00:00", end: "2026-08-28 09:30:00", itemId: 1, checksum: "a", available: true },
    { start: "2026-08-28 11:00:00", end: "2026-08-28 11:30:00", itemId: 1, checksum: "b", available: true },
    { start: "2026-08-28 12:00:00", end: "2026-08-28 12:30:00", itemId: 2, checksum: "c", available: true },
    { start: "2026-08-28 13:00:00", end: "2026-08-28 13:30:00", itemId: 1, checksum: "d", available: false },
    { start: "2026-08-28 11:00:00", end: "2026-08-28 11:15:00", itemId: 3, checksum: "e", available: true },
  ];

  it("filters by afterTime", () => {
    const result = filterSlots(slots, { afterTime: "10:30" });
    assert.deepEqual(result.map((s) => slotStartTime(s)), ["11:00", "12:00"]);
  });

  it("filters by beforeTime (exclusive end bound)", () => {
    const result = filterSlots(slots, { beforeTime: "12:00" });
    assert.deepEqual(result.map((s) => slotStartTime(s)), ["09:00", "11:00"]);
  });

  it("filters by itemId", () => {
    const result = filterSlots(slots, { itemId: 2 });
    assert.equal(result.length, 1);
    assert.equal(result[0].itemId, 2);
  });

  it("excludes unavailable and sub-30-minute slots", () => {
    const result = filterSlots(slots, {});
    assert.equal(result.length, 3);
    assert.ok(result.every((s) => s.available));
  });
});
