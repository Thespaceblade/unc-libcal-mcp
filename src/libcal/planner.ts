import { LibCalClient, slotDate, slotStartTime } from "./client.js";
import type { AvailabilitySlot } from "./types.js";
import { SPACE_CATEGORIES } from "./constants.js";
import { addMinutesToTime, dayDiff, localDateString, localTimeString } from "./time.js";

export interface PlannerPreferences {
  preferSameDay: boolean;
  minLeadMinutes: number;
  searchHorizonDays: number;
  timezone?: string;
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
      // Skip overlapping starts on same room
      i += need - 1;
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
    if (params.startTime === params.preferredStartTime) {
      score -= 80;
      reasons.push("matches your requested time");
    } else {
      score += Math.abs(params.preferredStartTime.localeCompare(params.startTime));
    }
  }

  return { score, reason: reasons.join("; ") };
}

export async function suggestBookingOptions(params: {
  categoryId: string;
  durationMinutes: number;
  preferredDate?: string;
  preferredStartTime?: string;
  maxOptions?: number;
  prefs?: Partial<PlannerPreferences>;
}): Promise<{ options: BookingOption[]; message: string }> {
  const category = SPACE_CATEGORIES[params.categoryId];
  if (!category) {
    throw new Error(`Unknown category: ${params.categoryId}`);
  }

  const prefs = { ...DEFAULT_PREFS, ...params.prefs };
  const today = localDateString();
  const now = localTimeString();
  const afterToday = addMinutesToTime(now, prefs.minLeadMinutes);
  const maxOptions = params.maxOptions ?? 5;
  const client = new LibCalClient();

  const allOptions: BookingOption[] = [];

  for (let dayOffset = 0; dayOffset < prefs.searchHorizonDays; dayOffset++) {
    const d = new Date(`${today}T12:00:00`);
    d.setDate(d.getDate() + dayOffset);
    const date = d.toISOString().slice(0, 10);

    // If user asked for a specific date, still scan all days but preferred date scores better
    const slots = await client.getAvailability({
      lid: category.lid,
      gid: category.gid,
      date,
    });

    const afterTime = date === today ? afterToday : undefined;
    const blocks = findDurationBlocks(slots, date, params.durationMinutes, afterTime);

    for (const block of blocks) {
      const { score, reason } = scoreOption({
        date,
        startTime: block.startTime,
        today,
        preferSameDay: prefs.preferSameDay,
        preferredDate: params.preferredDate,
        preferredStartTime: params.preferredStartTime,
      });

      const dayLabel = dateLabel(date, today);
      const durationHrs = params.durationMinutes / 60;
      const label = `${dayLabel} · ${block.startTime}–${block.endTime} · room ${block.itemId} · ${durationHrs}hr`;

      allOptions.push({
        optionId: 0,
        date,
        startTime: block.startTime,
        endTime: block.endTime,
        durationMinutes: params.durationMinutes,
        itemId: block.itemId,
        categoryId: params.categoryId,
        label,
        reason,
        score,
      });
    }
  }

  allOptions.sort((a, b) => a.score - b.score || a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));

  const unique = allOptions.filter(
    (opt, i, arr) =>
      arr.findIndex(
        (o) => o.date === opt.date && o.startTime === opt.startTime && o.itemId === opt.itemId,
      ) === i,
  );

  const top = unique.slice(0, maxOptions).map((o, i) => ({ ...o, optionId: i + 1 }));

  if (top.length === 0) {
    return {
      options: [],
      message: `No ${params.durationMinutes}-minute blocks found in the next ${prefs.searchHorizonDays} days for ${category.name}. Try shorter duration or a different category.`,
    };
  }

  const lines = top.map(
    (o) =>
      `[${o.optionId}] ${o.label}\n    Why: ${o.reason}${o.optionId === 1 ? " ← recommended" : ""}`,
  );

  const message = [
    `Found ${top.length} option(s) for ${category.name} (${params.durationMinutes} min).`,
    prefs.preferSameDay ? "Ranking prioritizes same-day, then soonest date/time." : "",
    "",
  ...lines,
    "",
    "Ask the user which option to book, then call libcal_book with that option's date, start_time, space_id, and duration_minutes.",
    "Do NOT book without user confirmation.",
  ]
    .filter(Boolean)
    .join("\n");

  return { options: top, message };
}

export function formatDurationHint(minutes: number): string {
  if (minutes === 180) return "maximum (3 hours — LibCal daily limit per booking)";
  return `${minutes / 60} hour(s)`;
}
