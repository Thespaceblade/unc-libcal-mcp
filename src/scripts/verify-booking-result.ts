#!/usr/bin/env node
/** Assert a captured booking result matches the intended slot (run after live bookings). */
import { readFileSync } from "node:fs";
import { timeDiffMinutes } from "../libcal/time.js";

interface Payload {
  expected: {
    date: string;
    startTime: string;
    endTime: string;
    durationMinutes: number;
    itemId?: number;
  };
  result: {
    success: boolean;
    start: string;
    end: string;
    message: string;
  };
}

function fail(message: string): never {
  console.error(`VERIFY FAILED: ${message}`);
  process.exit(1);
}

const path = process.argv[2] ?? "/tmp/libcal-book-result.json";
const payload = JSON.parse(readFileSync(path, "utf8")) as Payload;
const { expected, result } = payload;

if (!result.success) {
  fail(`booking not successful: ${result.message}`);
}

const actualStart = result.start.split(" ")[1]?.slice(0, 5);
const actualEnd = result.end.split(" ")[1]?.slice(0, 5);
const actualDate = result.start.split(" ")[0];

if (actualDate !== expected.date) {
  fail(`date ${actualDate} !== expected ${expected.date}`);
}
if (actualStart !== expected.startTime) {
  fail(`start ${actualStart} !== expected ${expected.startTime}`);
}
if (actualEnd !== expected.endTime) {
  fail(`end ${actualEnd} !== expected ${expected.endTime}`);
}

const actualDuration = timeDiffMinutes(actualStart ?? "", actualEnd ?? "");
if (actualDuration !== expected.durationMinutes) {
  fail(`duration ${actualDuration} min !== expected ${expected.durationMinutes} min`);
}

console.log(
  `Verified booking: ${actualDate} ${actualStart}–${actualEnd} (${actualDuration} min) — not the wrong slot.`,
);
