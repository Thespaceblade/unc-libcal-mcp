import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { UserConfig } from "./libcal/types.js";
import { DEFAULT_CATEGORY } from "./libcal/constants.js";

export const DATA_DIR = join(homedir(), ".unc-libcal");
export const CONFIG_PATH = join(DATA_DIR, "config.json");
export const SESSION_PATH = join(DATA_DIR, "storage-state.json");
export const BROWSER_PROFILE_DIR = join(DATA_DIR, "browser-profile");

/**
 * The data dir holds live UNC SSO cookies, so it must not be world-readable.
 * Existing installs are tightened too — they were created 0755 before this.
 */
export function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    return;
  }
  try {
    chmodSync(DATA_DIR, 0o700);
  } catch {
    // Non-fatal: a dir we cannot chmod is still usable, just less private.
  }
}

/** Restrict a file holding session credentials to the owner (0600). */
export function secureFile(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {
    // Non-fatal: the file may not exist yet, or live on a filesystem
    // without POSIX modes. Never let this mask the caller's real work.
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
