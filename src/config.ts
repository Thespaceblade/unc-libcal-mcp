import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { UserConfig } from "./libcal/types.js";
import { DEFAULT_CATEGORY } from "./libcal/constants.js";

export const DATA_DIR = join(homedir(), ".unc-libcal");
export const CONFIG_PATH = join(DATA_DIR, "config.json");
export const SESSION_PATH = join(DATA_DIR, "storage-state.json");
export const BROWSER_PROFILE_DIR = join(DATA_DIR, "browser-profile");

export function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function loadConfig(): Required<Pick<UserConfig, "defaultCategory">> & UserConfig {
  ensureDataDir();
  if (!existsSync(CONFIG_PATH)) {
    const defaults = {
      defaultCategory: DEFAULT_CATEGORY,
      calendarName: "Calendar",
      preferSameDay: true,
      minLeadMinutes: 30,
      searchHorizonDays: 7,
      bookingPurpose: "Study session",
    };
    writeFileSync(CONFIG_PATH, JSON.stringify(defaults, null, 2));
    return defaults;
  }
  const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as UserConfig;
  return {
    preferSameDay: true,
    minLeadMinutes: 30,
    searchHorizonDays: 7,
    bookingPurpose: "Study session",
    ...parsed,
    defaultCategory: parsed.defaultCategory ?? DEFAULT_CATEGORY,
    calendarName: parsed.calendarName ?? "Calendar",
  };
}

export function hasSession(): boolean {
  return existsSync(BROWSER_PROFILE_DIR) || existsSync(SESSION_PATH);
}
