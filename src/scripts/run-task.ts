#!/usr/bin/env node
/** Thin CLI wrapper around the hardened browser booking module. */
import { loadConfig } from "../config.js";
import { withAuthenticatedContext } from "../auth/session.js";
import { bookSpace } from "../libcal/book.js";
import { SPACE_CATEGORIES } from "../libcal/constants.js";
import { timeTo12HourLabel } from "../libcal/time.js";

function usage(): never {
  console.error(`Usage: run-task --date YYYY-MM-DD --start HH:MM --duration MINUTES [--category davis-cubes]`);
  process.exit(1);
}

function parseArgs(): {
  date: string;
  start: string;
  duration: number;
  categoryId: string;
} {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };

  const date = get("--date");
  const start = get("--start");
  const duration = Number(get("--duration") ?? "60");
  const categoryId = get("--category") ?? "davis-cubes";

  if (!date || !start || Number.isNaN(duration)) usage();
  return { date, start, duration, categoryId };
}

async function main(): Promise<void> {
  const { date, start, duration, categoryId } = parseArgs();
  const category = SPACE_CATEGORIES[categoryId];
  if (!category) throw new Error(`Unknown category: ${categoryId}`);

  const config = loadConfig();

  console.log(
    `Booking ${category.name} ${date} ${timeTo12HourLabel(start)} (${duration} min)...`,
  );

  const result = await withAuthenticatedContext((context) =>
    bookSpace(context, {
      categoryId,
      date,
      startTime: start,
      durationMinutes: duration,
      purpose: config.bookingPurpose ?? "Study session",
    }),
  );

  console.log(JSON.stringify(result, null, 2));

  if (!result.success) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
