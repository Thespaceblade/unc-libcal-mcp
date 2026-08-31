import { LibCalClient, slotDate, slotStartTime } from "./client.js";
import type { AvailabilitySlot } from "./types.js";
import { SPACE_CATEGORIES } from "./constants.js";
import { addMinutesToTime, dayDiff, localDateString, localTimeString } from "./time.js";
import {
  findPiecemealPlans,
  parseTimeWindow,
  type WindowSegment,
} from "./coverage.js";

export type PlanStrategy =
  | "single_cube"
  | "single_cube_in_window"
  | "single_cube_partial_window"
  | "piecemeal_in_window"
  | "single_cube_alt_time";

export interface RecommendedPlan {
  optionId: number;
  strategy: PlanStrategy;
  bookWith: "libcal_book" | "libcal_book_piecemeal";
  categoryId: string;
  date: string;
  label: string;
  reason: string;
  score: number;
  startTime?: string;
  endTime?: string;
  durationMinutes?: number;
  itemId?: number;
  segments?: WindowSegment[];
  gapMinutes?: number;
  coveredMinutes?: number;
}

export interface BookingOption {
  optionId: number;
  date: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  itemId: number;
  categoryId: string;
  label: string;
  reason: string;
  score: number;
  strategy?: PlanStrategy;
  bookWith?: "libcal_book" | "libcal_book_piecemeal";
  segments?: WindowSegment[];
}

const DEFAULT_PREFS: PlannerPreferences = {
  preferSameDay: true,
  minLeadMinutes: 30,
  searchHorizonDays: 7,
};

function dateLabel(date: string, today: string): string {
  if (date === today) return "TODAY";
  const d = new Date(`${date}T12:00:00`);
  const diff = dayDiff(today, date);
  if (diff === 1) return "TOMORROW";
  if (diff > 1 && diff < 7) {
    return d.toLocaleDateString("en-US", { weekday: "long" });
  }
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function slotsNeeded(durationMinutes: number): number {
  return Math.ceil(durationMinutes / 30);
}

function timeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T12:00:00`);
  d.setDate(d.getDate() + days);
  return localDateString(d);
}

/** Find start times where `durationMinutes` of consecutive 30-min slots exist for one room. */
export function findDurationBlocks(
  slots: AvailabilitySlot[],
  date: string,
  durationMinutes: number,
  afterTime?: string,
): Array<{ itemId: number; startTime: string; endTime: string; start: string; end: string }> {
  const need = slotsNeeded(durationMinutes);
  const avail = slots.filter((s) => s.available && slotDate(s) === date);
  const byRoom = new Map<number, AvailabilitySlot[]>();

  for (const s of avail) {
    if (!byRoom.has(s.itemId)) byRoom.set(s.itemId, []);
    byRoom.get(s.itemId)!.push(s);
  }

  const blocks: Array<{ itemId: number; startTime: string; endTime: string; start: string; end: string }> = [];

  for (const [itemId, roomSlots] of byRoom) {
    const sorted = [...roomSlots].sort((a, b) => a.start.localeCompare(b.start));

    for (let i = 0; i <= sorted.length - need; i++) {
      const first = sorted[i];
      const startTime = slotStartTime(first);

      if (afterTime && startTime < afterTime) continue;

      let consecutive = true;
      for (let j = 1; j < need; j++) {
        const prev = new Date(sorted[i + j - 1].end.replace(" ", "T"));
        const next = new Date(sorted[i + j].start.replace(" ", "T"));
        if (sorted[i + j].itemId !== itemId || next.getTime() !== prev.getTime()) {
          consecutive = false;
          break;
        }
      }
      if (!consecutive) continue;

      const last = sorted[i + need - 1];
      blocks.push({
        itemId,
        startTime,
        endTime: last.end.split(" ")[1]?.slice(0, 5) ?? "",
        start: first.start,
        end: last.end,
      });
      // Advance to first slot at or after this block ends (avoids overlapping options).
      const blockEndMs = new Date(last.end.replace(" ", "T")).getTime();
      let next = i + 1;
      while (next < sorted.length) {
        const startMs = new Date(sorted[next].start.replace(" ", "T")).getTime();
        if (startMs >= blockEndMs) break;
        next++;
      }
      i = next - 1;
    }
  }

  return blocks.sort((a, b) => a.startTime.localeCompare(b.startTime));
}

export function scoreOption(params: {
  date: string;
  startTime: string;
  today: string;
  preferSameDay: boolean;
  preferredDate?: string;
  preferredStartTime?: string;
}): { score: number; reason: string } {
  let score = 1000;
  const reasons: string[] = [];

  // Explicit date from user beats same-day default.
  if (params.preferredDate) {
    if (params.date === params.preferredDate) {
      score -= 500;
      reasons.push("matches your requested date");
    } else {
      score += 300 + Math.abs(dayDiff(params.preferredDate, params.date)) * 50;
      reasons.push("not your requested date");
    }
  } else if (params.preferSameDay && params.date === params.today) {
    score -= 100;
    reasons.push("same-day (preferred)");
  } else if (params.date === params.today) {
    score -= 10;
    reasons.push("today");
  } else {
    const out = dayDiff(params.today, params.date);
    score += out * 100;
    reasons.push(`${out} day(s) out`);
  }

  if (params.preferredStartTime) {
    const diff = Math.abs(timeToMinutes(params.startTime) - timeToMinutes(params.preferredStartTime));
    if (diff === 0) {
      score -= 200;
      reasons.push("matches your requested time");
    } else {
      score += diff;
    }
  }

  return { score, reason: reasons.join("; ") };
}

function spaceLabel(itemId: number, spaceNames?: Map<number, string>): string {
  return spaceNames?.get(itemId) ?? `room ${itemId}`;
}

function planSignature(plan: RecommendedPlan): string {
  if (plan.segments?.length) {
    return `${plan.date}|${plan.segments.map((s) => `${s.itemId}@${s.startTime}-${s.endTime}`).join("+")}`;
  }
  return `${plan.date}|${plan.itemId}@${plan.startTime}-${plan.endTime}`;
}

function blockInsideWindow(
  startTime: string,
  endTime: string,
  windowStart: string,
  windowEnd: string,
): boolean {
  const start = timeToMinutes(startTime);
  let end = timeToMinutes(endTime);
  if (end <= start) return false;
  return start >= timeToMinutes(windowStart) && end <= timeToMinutes(windowEnd);
}

function blockOverlapsWindow(
  startTime: string,
  endTime: string,
  windowStart: string,
  windowEnd: string,
): boolean {
  const start = timeToMinutes(startTime);
  let end = timeToMinutes(endTime);
  if (end <= start) end += 24 * 60;
  const wStart = timeToMinutes(windowStart);
  const wEnd = timeToMinutes(windowEnd);
  return start < wEnd && end > wStart;
}

export function scoreRecommendedPlan(params: {
  plan: RecommendedPlan;
  today: string;
  preferSameDay: boolean;
  preferredDate?: string;
  preferredStartTime?: string;
  windowStart?: string;
  windowEnd?: string;
}): { score: number; reason: string } {
  const { plan } = params;
  const startTime = plan.startTime ?? plan.segments?.[0]?.startTime ?? "00:00";
  const base = scoreOption({
    date: plan.date,
    startTime,
    today: params.today,
    preferSameDay: params.preferSameDay,
    preferredDate: params.preferredDate,
    preferredStartTime: params.preferredStartTime,
  });

  let score = base.score;
  const reasons = [base.reason];

  if (params.windowStart && params.windowEnd) {
    const windowMinutes = timeToMinutes(params.windowEnd) - timeToMinutes(params.windowStart);

    switch (plan.strategy) {
      case "single_cube_in_window":
        score -= 600;
        reasons.push("one cube covers your full requested window");
        break;
      case "piecemeal_in_window":
        if ((plan.gapMinutes ?? 0) === 0) {
          score -= 550;
          reasons.push("piecemeal covers your full requested window");
        } else {
          score -= 350 - (plan.gapMinutes ?? 0);
          reasons.push(`piecemeal covers ${plan.coveredMinutes}/${windowMinutes} min of your window`);
        }
        break;
      case "single_cube_partial_window":
        score -= 250 - (windowMinutes - (plan.coveredMinutes ?? 0));
        reasons.push(`one cube partially fits your window (${plan.coveredMinutes}/${windowMinutes} min)`);
        break;
      case "single_cube_alt_time":
        score += 300;
        reasons.push("same day, different time than requested window");
        break;
      default:
        break;
    }
  }

  if (plan.bookWith === "libcal_book") {
    score -= 30;
    reasons.push("single booking");
  } else {
    reasons.push("requires multiple bookings");
  }

  return { score, reason: reasons.join("; ") };
}

/** Unified planner: single-cube, piecemeal, partial-window, and alternate-time options ranked together. */
export async function recommendBookingPlans(params: {
  categoryId: string;
  durationMinutes: number;
  preferredDate?: string;
  preferredStartTime?: string;
  windowStart?: string;
  windowEnd?: string;
  maxOptions?: number;
  prefs?: Partial<PlannerPreferences>;
  spaceNames?: Map<number, string>;
}): Promise<{ plans: RecommendedPlan[]; message: string; window?: { start: string; end: string } }> {
  const category = SPACE_CATEGORIES[params.categoryId];
  if (!category) throw new Error(`Unknown category: ${params.categoryId}`);

  const prefs = { ...DEFAULT_PREFS, ...params.prefs };
  const today = localDateString();
  const now = localTimeString();
  const afterToday = addMinutesToTime(now, prefs.minLeadMinutes);
  const maxOptions = params.maxOptions ?? 5;
  const client = new LibCalClient();

  const window = params.windowStart && params.windowEnd
    ? parseTimeWindow(params.windowStart, params.windowEnd)
    : undefined;
  const targetDuration = window
    ? timeToMinutes(window.windowEnd) - timeToMinutes(window.windowStart)
    : params.durationMinutes;
  const focusDate = params.preferredDate ?? today;

  const candidates: RecommendedPlan[] = [];

  for (let dayOffset = 0; dayOffset < prefs.searchHorizonDays; dayOffset++) {
    const date = addDays(today, dayOffset);
    const slots = await client.getAvailability({
      lid: category.lid,
      gid: category.gid,
      date,
    });

    let afterTime = date === today ? afterToday : undefined;
    if (params.preferredStartTime && (!params.preferredDate || params.preferredDate === date)) {
      if (!afterTime || params.preferredStartTime > afterTime) {
        afterTime = params.preferredStartTime;
      }
    }

    const blocks = findDurationBlocks(slots, date, targetDuration, afterTime);
    const analyzeWindow = window && date === focusDate;

    if (analyzeWindow) {
      const piecemealPlans = findPiecemealPlans(
        slots,
        date,
        window.windowStart,
        window.windowEnd,
        params.spaceNames,
        4,
      );

      for (const piecemeal of piecemealPlans) {
        if (piecemeal.segments.length === 0) continue;
        const strategy: PlanStrategy =
          piecemeal.segments.length === 1 ? "single_cube_partial_window" : "piecemeal_in_window";
        const day = dateLabel(date, today);
        candidates.push({
          optionId: 0,
          strategy,
          bookWith: piecemeal.segments.length === 1 ? "libcal_book" : "libcal_book_piecemeal",
          categoryId: params.categoryId,
          date,
          label: `${day} · ${piecemeal.label}`,
          reason: piecemeal.reason,
          score: 0,
          segments: piecemeal.segments.length === 1 ? undefined : piecemeal.segments,
          gapMinutes: piecemeal.gapMinutes,
          coveredMinutes: piecemeal.coveredMinutes,
          startTime: piecemeal.segments[0]?.startTime,
          endTime: piecemeal.segments[piecemeal.segments.length - 1]?.endTime,
          durationMinutes:
            piecemeal.segments.length === 1
              ? piecemeal.segments[0]?.durationMinutes
              : piecemeal.coveredMinutes,
          itemId: piecemeal.segments[0]?.itemId,
        });
      }
    }

    for (const block of blocks) {
      const day = dateLabel(date, today);
      const durationHrs = targetDuration / 60;
      let strategy: PlanStrategy = "single_cube";

      if (analyzeWindow) {
        if (blockInsideWindow(block.startTime, block.endTime, window.windowStart, window.windowEnd)) {
          strategy = "single_cube_in_window";
        } else if (blockOverlapsWindow(block.startTime, block.endTime, window.windowStart, window.windowEnd)) {
          continue;
        } else if (date === focusDate) {
          strategy = "single_cube_alt_time";
        }
      }

      candidates.push({
        optionId: 0,
        strategy,
        bookWith: "libcal_book",
        categoryId: params.categoryId,
        date,
        label: `${day} · ${spaceLabel(block.itemId, params.spaceNames)} ${block.startTime}–${block.endTime} · ${durationHrs}hr`,
        reason: "",
        score: 0,
        startTime: block.startTime,
        endTime: block.endTime,
        durationMinutes: targetDuration,
        itemId: block.itemId,
        coveredMinutes: targetDuration,
        gapMinutes: 0,
      });
    }
  }

  const unique = new Map<string, RecommendedPlan>();
  for (const candidate of candidates) {
    const key = planSignature(candidate);
    const existing = unique.get(key);
    if (!existing || (candidate.coveredMinutes ?? 0) > (existing.coveredMinutes ?? 0)) {
      unique.set(key, candidate);
    }
  }

  const scored = [...unique.values()].map((plan) => {
    const { score, reason } = scoreRecommendedPlan({
      plan,
      today,
      preferSameDay: prefs.preferSameDay,
      preferredDate: params.preferredDate ?? (window ? focusDate : undefined),
      preferredStartTime: params.preferredStartTime ?? window?.windowStart,
      windowStart: window?.windowStart,
      windowEnd: window?.windowEnd,
    });
    return { ...plan, score, reason };
  });

  scored.sort(
    (a, b) =>
      a.score - b.score ||
      a.date.localeCompare(b.date) ||
      (a.startTime ?? "").localeCompare(b.startTime ?? ""),
  );

  const top = scored.slice(0, maxOptions).map((plan, index) => ({ ...plan, optionId: index + 1 }));

  if (top.length === 0) {
    const windowHint = window ? ` for ${window.windowStart}–${window.windowEnd}` : "";
    return {
      plans: [],
      window: window ? { start: window.windowStart, end: window.windowEnd } : undefined,
      message: `No bookable options${windowHint} in the next ${prefs.searchHorizonDays} days for ${category.name}. Try a shorter window or different day.`,
    };
  }

  const lines = top.map((plan) => {
    const bookHint =
      plan.bookWith === "libcal_book_piecemeal"
        ? "book with libcal_book_piecemeal"
        : "book with libcal_book";
    return `[${plan.optionId}] ${plan.label}\n    ${plan.reason}\n    ${bookHint}${plan.optionId === 1 ? " ← recommended" : ""}`;
  });

  const header = window
    ? `Best options for ${category.name} on ${focusDate === today ? "today" : focusDate}, window ${window.windowStart}–${window.windowEnd} (${targetDuration} min):`
  : `Best options for ${category.name} (${targetDuration} min):`;

  const message = [
    header,
    "Compared single-cube, piecemeal multi-cube, partial-window, and alternate-time options across all cubes.",
    "",
    ...lines,
    "",
    "Present these to the user and only book after they pick one.",
    "Single options → libcal_book. Multi-segment options → libcal_book_piecemeal.",
  ].join("\n");

  return {
    plans: top,
    message,
    window: window ? { start: window.windowStart, end: window.windowEnd } : undefined,
  };
}

export interface PlannerPreferences {
  preferSameDay: boolean;
  minLeadMinutes: number;
  searchHorizonDays: number;
  timezone?: string;
}

export async function suggestBookingOptions(params: {
  categoryId: string;
  durationMinutes: number;
  preferredDate?: string;
  preferredStartTime?: string;
  windowStart?: string;
  windowEnd?: string;
  maxOptions?: number;
  prefs?: Partial<PlannerPreferences>;
  spaceNames?: Map<number, string>;
}): Promise<{ options: BookingOption[]; message: string }> {
  const { plans, message } = await recommendBookingPlans(params);

  const options: BookingOption[] = plans.map((plan) => ({
    optionId: plan.optionId,
    date: plan.date,
    startTime: plan.startTime ?? plan.segments?.[0]?.startTime ?? "",
    endTime: plan.endTime ?? plan.segments?.[plan.segments.length - 1]?.endTime ?? "",
    durationMinutes: plan.durationMinutes ?? plan.coveredMinutes ?? params.durationMinutes,
    itemId: plan.itemId ?? plan.segments?.[0]?.itemId ?? 0,
    categoryId: plan.categoryId,
    label: plan.label,
    reason: plan.reason,
    score: plan.score,
    strategy: plan.strategy,
    bookWith: plan.bookWith,
    segments: plan.segments,
  }));

  const duration = params.windowStart && params.windowEnd
    ? undefined
    : `\n\n(Duration: ${formatDurationHint(params.durationMinutes)})`;

  return {
    options,
    message: message + (duration ?? ""),
  };
}

export function formatDurationHint(minutes: number): string {
  if (minutes === 180) return "maximum (3 hours — LibCal daily limit per booking)";
  return `${minutes / 60} hour(s)`;
}
