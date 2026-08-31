import type { BrowserContext } from "playwright";
import { LibCalClient, filterSlots, slotDate, slotStartTime } from "./client.js";
import type { BookingResult } from "./types.js";
import { SPACE_CATEGORIES } from "./constants.js";
import { cookiesAsHeader } from "../auth/session.js";
import { loadSpaceNames } from "./spaces.js";
import { bookSpaceInBrowser, clearBookingCartCookies } from "./browser.js";
import { findDurationBlocks } from "./planner.js";
import {
  analyzeWindowCoverage,
  findPiecemealPlans,
  formatWindowCoverageReport,
  parseTimeWindow,
  type PiecemealPlan,
  type WindowSegment,
} from "./coverage.js";

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

  const blocks = findDurationBlocks(
    slots,
    options.date,
    options.durationMinutes,
    options.startTime,
  );

  const block = blocks.find(
    (candidate) =>
      candidate.startTime === options.startTime &&
      (!options.itemId || candidate.itemId === options.itemId),
  );

  if (!block) {
    const available = blocks
      .slice(0, 8)
      .map((candidate) => `${candidate.startTime}–${candidate.endTime} (space ${candidate.itemId})`);

    throw new Error(
      available.length
        ? `No ${options.durationMinutes}-minute block on ${options.date} at ${options.startTime}. Available: ${available.join(", ")}`
        : `No ${options.durationMinutes}-minute blocks on ${options.date} for ${category.name}`,
    );
  }

  // Do not open the LibCal UI here — visiting the page sets lc_ebcart and breaks booking.
  return { itemId: block.itemId };
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
  const { itemId } = await assertSlotAvailable(context, {
    categoryId: options.categoryId,
    date: options.date,
    startTime: options.startTime,
    durationMinutes: duration,
    itemId: options.itemId,
  });

  const page = await context.newPage();
  try {
    await clearBookingCartCookies(context);
    return await bookSpaceInBrowser(page, {
      category,
      date: options.date,
      startTime: options.startTime,
      durationMinutes: duration,
      purpose: options.purpose ?? "Study session",
      groupName: options.groupName,
      itemId,
    });
  } finally {
    await page.close();
  }
}

export async function bookPiecemeal(
  context: BrowserContext,
  options: {
    categoryId: string;
    segments: WindowSegment[];
    date: string;
    purpose?: string;
    groupName?: string;
  },
): Promise<{ results: BookingResult[]; message: string }> {
  if (options.segments.length === 0) {
    throw new Error("No booking segments provided");
  }

  const results: BookingResult[] = [];
  for (const [index, segment] of options.segments.entries()) {
    const result = await bookSpace(context, {
      categoryId: options.categoryId,
      date: options.date,
      startTime: segment.startTime,
      durationMinutes: segment.durationMinutes,
      itemId: segment.itemId,
      purpose: options.purpose,
      groupName: options.groupName,
    });

    results.push(result);
    if (!result.success) {
      throw new Error(
        `Segment ${index + 1}/${options.segments.length} (${segment.startTime}–${segment.endTime}) failed: ${result.message}`,
      );
    }
  }

  const summary = results
    .map((result, index) => `${index + 1}. ${result.spaceName}: ${result.start} → ${result.end}`)
    .join("\n");

  return {
    results,
    message: `Booked ${results.length} segment(s):\n${summary}`,
  };
}

export async function analyzeWindowAvailability(
  context: BrowserContext | null,
  options: {
    categoryId: string;
    date: string;
    windowStart: string;
    windowEnd: string;
    maxPlans?: number;
  },
): Promise<{ coverage: ReturnType<typeof analyzeWindowCoverage>; plans: PiecemealPlan[]; message: string }> {
  const category = SPACE_CATEGORIES[options.categoryId];
  if (!category) throw new Error(`Unknown category: ${options.categoryId}`);

  const { windowStart, windowEnd } = parseTimeWindow(options.windowStart, options.windowEnd);
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

  const coverage = analyzeWindowCoverage(slots, options.date, windowStart, windowEnd, spaceNames).map(
    (cube) => ({
      ...cube,
      spaceName: cube.spaceName ?? spaceNames.get(cube.itemId),
    }),
  );
  const plans = findPiecemealPlans(
    slots,
    options.date,
    windowStart,
    windowEnd,
    spaceNames,
    options.maxPlans ?? 5,
  ).map((plan) => ({
    ...plan,
    segments: plan.segments.map((segment) => ({
      ...segment,
    })),
  }));

  const message = formatWindowCoverageReport({
    date: options.date,
    windowStart,
    windowEnd,
    coverage,
    plans,
  });

  return { coverage, plans, message };
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

  const duration = options.durationMinutes ?? 60;
  if (duration > 30) {
    return findDurationBlocks(slots, options.date, duration, options.afterTime).map((block) => ({
      time: block.startTime,
      itemId: block.itemId,
      spaceName: spaceNames.get(block.itemId),
    }));
  }

  return filterSlots(slots, {
    afterTime: options.afterTime,
    durationMinutes: duration,
  })
    .filter((slot) => slotDate(slot) === options.date)
    .map((slot) => ({
      time: slotStartTime(slot),
      itemId: slot.itemId,
      spaceName: spaceNames.get(slot.itemId),
    }));
}
