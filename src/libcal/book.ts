import type { BrowserContext } from "playwright";
import {
  LibCalClient,
  filterSlots,
  slotDate,
  slotStartTime,
} from "./client.js";
import type { AvailabilitySlot, BookingResult } from "./types.js";
import { SPACE_CATEGORIES } from "./constants.js";
import { cookiesAsHeader } from "../auth/session.js";
import { loadSpaceNames, resolveSpaceName } from "./spaces.js";
import { bookSpaceInBrowser } from "./browser.js";
import { addMinutesToDateTime } from "./time.js";

function pickSlot(
  slots: AvailabilitySlot[],
  options: {
    date: string;
    startTime?: string;
    itemId?: number;
    durationMinutes: number;
  },
): AvailabilitySlot | null {
  const candidates = filterSlots(slots, {
    afterTime: options.startTime,
    itemId: options.itemId,
    durationMinutes: options.durationMinutes,
  }).filter((s) => slotDate(s) === options.date);

  if (options.startTime) {
    const exact = candidates.find((s) => slotStartTime(s) === options.startTime);
    if (exact) return exact;
  }

  return candidates[0] ?? null;
}

/** Verify a multi-hour block exists before attempting browser booking. */
export async function assertSlotAvailable(
  context: BrowserContext | null,
  options: {
    categoryId: string;
    date: string;
    startTime: string;
    durationMinutes: number;
    itemId?: number;
  },
): Promise<{ itemId: number; spaceName?: string }> {
  const category = SPACE_CATEGORIES[options.categoryId];
  if (!category) {
    throw new Error(`Unknown category: ${options.categoryId}`);
  }

  const cookieHeader = context ? await cookiesAsHeader(context) : undefined;
  const client = new LibCalClient(cookieHeader);

  const slots = await client.getAvailability({
    lid: category.lid,
    gid: category.gid,
    date: options.date,
  });

  const slot = pickSlot(slots, {
    date: options.date,
    startTime: options.startTime,
    itemId: options.itemId,
    durationMinutes: options.durationMinutes,
  });

  if (!slot) {
    const available = filterSlots(slots, { durationMinutes: options.durationMinutes })
      .filter((s) => slotDate(s) === options.date)
      .slice(0, 8)
      .map((s) => `${slotStartTime(s)} (space ${s.itemId})`);

    throw new Error(
      available.length
        ? `No matching slot on ${options.date} at ${options.startTime}. Available: ${available.join(", ")}`
        : `No available slots on ${options.date} for ${category.name}`,
    );
  }

  let spaceName: string | undefined;
  if (context) {
    const page = await context.newPage();
    const spaceNames = await loadSpaceNames(page, category.path);
    spaceName = resolveSpaceName(spaceNames, slot.itemId);
    await page.close();
  }

  return { itemId: slot.itemId, spaceName };
}

export async function bookSpace(
  context: BrowserContext,
  options: {
    categoryId: string;
    date: string;
    startTime: string;
    durationMinutes?: number;
    itemId?: number;
    purpose?: string;
    groupName?: string;
  },
): Promise<BookingResult> {
  const category = SPACE_CATEGORIES[options.categoryId];
  if (!category) {
    throw new Error(`Unknown category: ${options.categoryId}. Use: ${Object.keys(SPACE_CATEGORIES).join(", ")}`);
  }

  if (!options.startTime) {
    throw new Error("startTime is required (HH:MM)");
  }

  const duration = options.durationMinutes ?? 60;
  const { itemId, spaceName } = await assertSlotAvailable(context, {
    categoryId: options.categoryId,
    date: options.date,
    startTime: options.startTime,
    durationMinutes: duration,
    itemId: options.itemId,
  });

  const page = await context.newPage();
  try {
    const result = await bookSpaceInBrowser(page, {
      category,
      date: options.date,
      startTime: options.startTime,
      durationMinutes: duration,
      purpose: options.purpose ?? "Study session",
      groupName: options.groupName,
      spaceName,
    });

    return {
      ...result,
      itemId,
      end: addMinutesToDateTime(`${options.date} ${options.startTime}:00`, duration),
    };
  } finally {
    await page.close();
  }
}

export async function listAvailability(
  context: BrowserContext | null,
  options: {
    categoryId: string;
    date: string;
    afterTime?: string;
    durationMinutes?: number;
  },
): Promise<Array<{ time: string; itemId: number; spaceName?: string }>> {
  const category = SPACE_CATEGORIES[options.categoryId];
  if (!category) throw new Error(`Unknown category: ${options.categoryId}`);

  const cookieHeader = context ? await cookiesAsHeader(context) : undefined;
  const client = new LibCalClient(cookieHeader);

  const slots = await client.getAvailability({
    lid: category.lid,
    gid: category.gid,
    date: options.date,
  });

  let spaceNames = new Map<number, string>();
  if (context) {
    const page = await context.newPage();
    spaceNames = await loadSpaceNames(page, category.path);
    await page.close();
  }

  return filterSlots(slots, {
    afterTime: options.afterTime,
    durationMinutes: options.durationMinutes ?? 60,
  })
    .filter((s) => slotDate(s) === options.date)
    .map((s) => ({
      time: slotStartTime(s),
      itemId: s.itemId,
      spaceName: spaceNames.get(s.itemId),
    }));
}
