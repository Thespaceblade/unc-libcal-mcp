import { slotDate, slotStartTime } from "./client.js";
import type { AvailabilitySlot } from "./types.js";
import { addMinutesToTime, timeDiffMinutes } from "./time.js";

export interface WindowSegment {
  itemId: number;
  startTime: string;
  endTime: string;
  durationMinutes: number;
}

export interface CubeWindowCoverage {
  itemId: number;
  spaceName?: string;
  segments: WindowSegment[];
  totalMinutes: number;
}

export interface PiecemealPlan {
  planId: number;
  segments: WindowSegment[];
  coveredMinutes: number;
  windowMinutes: number;
  gapMinutes: number;
  cubeSwitches: number;
  label: string;
  reason: string;
}

function timeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function clampSegmentToWindow(
  segment: WindowSegment,
  windowStart: string,
  windowEnd: string,
): WindowSegment | null {
  const start = Math.max(timeToMinutes(segment.startTime), timeToMinutes(windowStart));
  const end = Math.min(timeToMinutes(segment.endTime), timeToMinutes(windowEnd));
  if (end <= start) return null;
  const startTime = `${String(Math.floor(start / 60)).padStart(2, "0")}:${String(start % 60).padStart(2, "0")}`;
  const endTime = `${String(Math.floor(end / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}`;
  return { ...segment, startTime, endTime, durationMinutes: end - start };
}

/** Maximal contiguous available segments for one cube inside a time window. */
export function findCubeSegmentsInWindow(
  slots: AvailabilitySlot[],
  date: string,
  windowStart: string,
  windowEnd: string,
  itemId?: number,
): WindowSegment[] {
  const startMin = timeToMinutes(windowStart);
  const endMin = timeToMinutes(windowEnd);

  const roomSlots = slots
    .filter((slot) => slot.available && slotDate(slot) === date && (!itemId || slot.itemId === itemId))
    .filter((slot) => {
      const slotStart = timeToMinutes(slotStartTime(slot));
      const slotEnd = timeToMinutes(slot.end.split(" ")[1]?.slice(0, 5) ?? "");
      return slotEnd > startMin && slotStart < endMin;
    })
    .sort((a, b) => a.start.localeCompare(b.start));

  const segments: WindowSegment[] = [];
  let current: WindowSegment | null = null;

  for (const slot of roomSlots) {
    const slotStart = slotStartTime(slot);
    const slotEnd = slot.end.split(" ")[1]?.slice(0, 5) ?? "";
    const piece = clampSegmentToWindow(
      {
        itemId: slot.itemId,
        startTime: slotStart,
        endTime: slotEnd,
        durationMinutes: timeDiffMinutes(slotStart, slotEnd),
      },
      windowStart,
      windowEnd,
    );
    if (!piece) continue;

    if (!current) {
      current = piece;
      continue;
    }

    if (current.endTime === piece.startTime && current.itemId === piece.itemId) {
      current = {
        ...current,
        endTime: piece.endTime,
        durationMinutes: timeToMinutes(piece.endTime) - timeToMinutes(current.startTime),
      };
      continue;
    }

    segments.push(current);
    current = piece;
  }

  if (current) segments.push(current);
  return segments;
}

/** Coverage for every cube that has availability in the window. */
export function analyzeWindowCoverage(
  slots: AvailabilitySlot[],
  date: string,
  windowStart: string,
  windowEnd: string,
  spaceNames?: Map<number, string>,
): CubeWindowCoverage[] {
  const itemIds = [...new Set(slots.filter((s) => s.available && slotDate(s) === date).map((s) => s.itemId))];

  return itemIds
    .map((itemId) => {
      const segments = findCubeSegmentsInWindow(slots, date, windowStart, windowEnd, itemId);
      return {
        itemId,
        spaceName: spaceNames?.get(itemId),
        segments,
        totalMinutes: segments.reduce((sum, segment) => sum + segment.durationMinutes, 0),
      };
    })
    .filter((cube) => cube.segments.length > 0)
    .sort((a, b) => b.totalMinutes - a.totalMinutes || a.itemId - b.itemId);
}

function planSignature(plan: PiecemealPlan): string {
  return plan.segments.map((s) => `${s.itemId}:${s.startTime}-${s.endTime}`).join("|");
}

function buildPlan(
  segments: WindowSegment[],
  windowStart: string,
  windowEnd: string,
  spaceNames?: Map<number, string>,
): PiecemealPlan {
  const windowMinutes = timeToMinutes(windowEnd) - timeToMinutes(windowStart);
  const coveredMinutes = segments.reduce((sum, segment) => sum + segment.durationMinutes, 0);
  const firstStart = segments[0] ? timeToMinutes(segments[0].startTime) : timeToMinutes(windowStart);
  const lastEnd = segments.length
    ? timeToMinutes(segments[segments.length - 1].endTime)
    : timeToMinutes(windowStart);
  const leadingGap = Math.max(0, firstStart - timeToMinutes(windowStart));
  const trailingGap = Math.max(0, timeToMinutes(windowEnd) - lastEnd);
  const internalGap = Math.max(0, windowMinutes - coveredMinutes - leadingGap - trailingGap);
  const gapMinutes = leadingGap + trailingGap + internalGap;
  const cubeSwitches = Math.max(0, segments.length - 1);

  const segmentLabels = segments.map((segment) => {
    const name = spaceNames?.get(segment.itemId) ?? `space ${segment.itemId}`;
    return `${name} ${segment.startTime}–${segment.endTime}`;
  });

  const label =
    segments.length === 0
      ? `No coverage in ${windowStart}–${windowEnd}`
      : segments.length === 1
        ? segmentLabels[0]
        : `${segmentLabels.join(" + ")}`;

  const reason =
    gapMinutes === 0
      ? `Covers full ${windowStart}–${windowEnd} window${cubeSwitches ? ` across ${segments.length} cubes` : ""}`
      : `Covers ${coveredMinutes} of ${windowMinutes} min (${gapMinutes} min unavailable in window)`;

  return {
    planId: 0,
    segments,
    coveredMinutes,
    windowMinutes,
    gapMinutes,
    cubeSwitches,
    label,
    reason,
  };
}

/**
 * Greedy piecemeal plan: chain back-to-back segments across cubes to cover as much of
 * [windowStart, windowEnd] as possible. At each boundary, pick the longest segment that starts there.
 */
export function findGreedyPiecemealPlan(
  slots: AvailabilitySlot[],
  date: string,
  windowStart: string,
  windowEnd: string,
  spaceNames?: Map<number, string>,
): PiecemealPlan {
  const coverage = analyzeWindowCoverage(slots, date, windowStart, windowEnd, spaceNames);
  const allSegments = coverage.flatMap((cube) => cube.segments);
  const endMin = timeToMinutes(windowEnd);
  let current = timeToMinutes(windowStart);
  const picked: WindowSegment[] = [];

  while (current < endMin) {
    let candidates = allSegments.filter((segment) => timeToMinutes(segment.startTime) === current);

    if (candidates.length === 0) {
      candidates = allSegments
        .filter((segment) => {
          const start = timeToMinutes(segment.startTime);
          return start > current && start < endMin;
        })
        .sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));

      if (candidates.length === 0) break;

      const earliestStart = timeToMinutes(candidates[0]!.startTime);
      candidates = candidates.filter((segment) => timeToMinutes(segment.startTime) === earliestStart);
    }

    const best = candidates.reduce((longest, segment) =>
      timeToMinutes(segment.endTime) > timeToMinutes(longest.endTime) ? segment : longest,
    );
    const clamped = clampSegmentToWindow(best, windowStart, windowEnd);
    if (!clamped) break;

    picked.push(clamped);
    current = timeToMinutes(clamped.endTime);
  }

  return buildPlan(picked, windowStart, windowEnd, spaceNames);
}

/** Ranked piecemeal and single-cube options for a requested window. */
export function findPiecemealPlans(
  slots: AvailabilitySlot[],
  date: string,
  windowStart: string,
  windowEnd: string,
  spaceNames?: Map<number, string>,
  maxPlans = 5,
): PiecemealPlan[] {
  const coverage = analyzeWindowCoverage(slots, date, windowStart, windowEnd, spaceNames);
  const plans: PiecemealPlan[] = [findGreedyPiecemealPlan(slots, date, windowStart, windowEnd, spaceNames)];

  for (const cube of coverage) {
    for (const segment of cube.segments) {
      plans.push(buildPlan([segment], windowStart, windowEnd, spaceNames));
    }
  }

  const unique = new Map<string, PiecemealPlan>();
  for (const plan of plans) {
    if (plan.segments.length === 0) continue;
    const key = planSignature(plan);
    const existing = unique.get(key);
    if (!existing || plan.coveredMinutes > existing.coveredMinutes) {
      unique.set(key, plan);
    }
  }

  const ranked = [...unique.values()].sort((a, b) => {
    if (b.coveredMinutes !== a.coveredMinutes) return b.coveredMinutes - a.coveredMinutes;
    if (a.gapMinutes !== b.gapMinutes) return a.gapMinutes - b.gapMinutes;
    if (a.cubeSwitches !== b.cubeSwitches) return a.cubeSwitches - b.cubeSwitches;
    return timeToMinutes(a.segments[0]?.startTime ?? "99:99") - timeToMinutes(b.segments[0]?.startTime ?? "99:99");
  });

  return ranked.slice(0, maxPlans).map((plan, index) => ({ ...plan, planId: index + 1 }));
}

export function formatWindowCoverageReport(params: {
  date: string;
  windowStart: string;
  windowEnd: string;
  coverage: CubeWindowCoverage[];
  plans: PiecemealPlan[];
}): string {
  const { date, windowStart, windowEnd, coverage, plans } = params;
  const windowMinutes = timeToMinutes(windowEnd) - timeToMinutes(windowStart);

  const cubeLines =
    coverage.length === 0
      ? ["No cubes have availability in this window."]
      : coverage.map((cube) => {
          const name = cube.spaceName ?? `space ${cube.itemId}`;
          const ranges = cube.segments.map((s) => `${s.startTime}–${s.endTime}`).join(", ");
          return `- ${name}: ${ranges} (${cube.totalMinutes} min total)`;
        });

  const planLines =
    plans.length === 0
      ? ["No bookable piecemeal plans in this window."]
      : plans.map((plan) => {
          const tag =
            plan.gapMinutes === 0
              ? "full coverage"
              : `${plan.coveredMinutes}/${windowMinutes} min`;
          return `[${plan.planId}] ${plan.label}\n    ${tag}; ${plan.reason}${plan.planId === 1 ? " ← recommended" : ""}`;
        });

  return [
    `Window coverage for ${date} ${windowStart}–${windowEnd} (${windowMinutes} min):`,
    "",
    "Per-cube availability:",
    ...cubeLines,
    "",
    "Piecemeal booking options (may use multiple cubes):",
    ...planLines,
    "",
    "Piecemeal plans require libcal_book_piecemeal with user_confirmed=true.",
    "Single-segment plans can use libcal_book instead.",
  ].join("\n");
}

/** Parse a user window like 11-1 or 11:00-13:00 on a given date. */
export function parseTimeWindow(
  windowStart: string,
  windowEnd: string,
): { windowStart: string; windowEnd: string } {
  const normalize = (value: string): string => {
    const trimmed = value.trim();
    if (/^\d{1,2}:\d{2}$/.test(trimmed)) return trimmed.padStart(5, "0").replace(/^(\d):/, "0$1:");
    const hourOnly = trimmed.match(/^(\d{1,2})$/);
    if (hourOnly) {
      const hour = Number(hourOnly[1]);
      return `${String(hour).padStart(2, "0")}:00`;
    }
    throw new Error(`Invalid time window value: ${value}`);
  };

  let start = normalize(windowStart);
  let end = normalize(windowEnd);
  if (timeToMinutes(end) <= timeToMinutes(start)) {
    end = addMinutesToTime(end, 12 * 60);
  }
  return { windowStart: start, windowEnd: end };
}
