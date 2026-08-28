import { existsSync, readFileSync } from "node:fs";
import { chromium, type BrowserContext, type Cookie } from "playwright";
import {
  BROWSER_PROFILE_DIR,
  ensureDataDir,
  SESSION_PATH as DEFAULT_SESSION_PATH,
} from "../config.js";

const SESSION_PATH = process.env.SESSION_PATH ?? DEFAULT_SESSION_PATH;
import { BASE_URL } from "../libcal/constants.js";
import { abandonHeldBookings, isBookingConfirmed } from "../libcal/browser.js";

const LOGIN_URL = `${BASE_URL}/reserve/davis-cubes`;
const VIEWPORT = { width: 1400, height: 900 };

/** Shown to users and agents when login is required. */
export const LOGIN_SETUP_HINT =
  "Run `npm run login` in the unc-libcal-mcp project. In the browser: click any open slot → Submit Times → sign in with Onyen (+ Duo). " +
  "Do NOT click Submit my Booking on the checkout page — press Enter in the terminal once you see Logout.";

let sharedContext: BrowserContext | null = null;
let contextQueue: Promise<void> = Promise.resolve();

function withContextLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = contextQueue.then(fn, fn);
  contextQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function profileExists(): boolean {
  return existsSync(BROWSER_PROFILE_DIR);
}

/** One-time import of legacy storage-state.json cookies into the browser profile. */
async function migrateLegacySession(): Promise<void> {
  if (profileExists() || !existsSync(SESSION_PATH)) return;

  ensureDataDir();
  const state = JSON.parse(readFileSync(SESSION_PATH, "utf8")) as { cookies?: Cookie[] };
  const context = await chromium.launchPersistentContext(BROWSER_PROFILE_DIR, {
    headless: true,
    viewport: VIEWPORT,
  });
  try {
    if (state.cookies?.length) {
      await context.addCookies(state.cookies);
    }
    await exportSessionBackup(context);
  } finally {
    await context.close();
    sharedContext = null;
  }
}

async function exportSessionBackup(context: BrowserContext): Promise<void> {
  await context.storageState({ path: SESSION_PATH });
}

export function readAuthIdExpiry(cookies: Cookie[]): string | undefined {
  const authId = cookies.find((cookie) => cookie.domain.includes("libauth.com") && cookie.name === "auth_id");
  if (!authId || authId.expires <= 0) return undefined;
  return new Date(authId.expires * 1000).toISOString();
}

async function openPersistentContext(headless: boolean): Promise<BrowserContext> {
  await migrateLegacySession();
  if (!profileExists()) {
    throw new Error(`No saved session. ${LOGIN_SETUP_HINT}`);
  }

  if (sharedContext) {
    const browser = sharedContext.browser();
    if (browser?.isConnected()) {
      return sharedContext;
    }
    await sharedContext.close().catch(() => undefined);
    sharedContext = null;
  }

  sharedContext = await chromium.launchPersistentContext(BROWSER_PROFILE_DIR, {
    headless,
    viewport: VIEWPORT,
  });
  return sharedContext;
}

/** Open LibCal and report whether the user still needs to sign in manually. */
export async function prepareLoginPage(page: import("playwright").Page): Promise<"logged-in" | "needs-sso"> {
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
  if ((await page.getByRole("link", { name: /logout/i }).count()) > 0) {
    return "logged-in";
  }
  return "needs-sso";
}

/** Pure helper for session probe results (unit-tested). */
export function sessionProbeResult(
  url: string,
  hasLogoutLink: boolean,
): { valid: boolean; message: string } {
  if (url.includes("sso.unc.edu")) {
    return { valid: false, message: `Session expired. ${LOGIN_SETUP_HINT}` };
  }
  if (hasLogoutLink) {
    return { valid: true, message: "Session is active" };
  }
  return {
    valid: false,
    message: `Not logged in. ${LOGIN_SETUP_HINT}`,
  };
}

export async function probeAuthenticatedContext(
  context: BrowserContext,
): Promise<{ valid: boolean; message: string; authIdExpires?: string }> {
  const page = await context.newPage();
  try {
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000);
    const hasLogout = (await page.getByRole("link", { name: /logout/i }).count()) > 0;
    const authIdExpires = readAuthIdExpiry(await context.cookies());
    return { ...sessionProbeResult(page.url(), hasLogout), authIdExpires };
  } finally {
    await page.close();
  }
}

export async function runLoginFlow(): Promise<void> {
  ensureDataDir();

  const context = await chromium.launchPersistentContext(BROWSER_PROFILE_DIR, {
    headless: false,
    viewport: VIEWPORT,
  });
  const page = context.pages()[0] ?? (await context.newPage());

  console.log("\nOpening UNC LibCal...");
  console.log("The Davis cubes page is public — Onyen only appears after you start a booking step.\n");

  const state = await prepareLoginPage(page).catch(() => "needs-sso" as const);

  if (state === "logged-in") {
    console.log("Already logged in to LibCal. Press Enter to save this session.\n");
  } else {
    console.log("Sign in manually:");
    console.log("  1. Click any open slot on the calendar");
    console.log("  2. Pick an end time → click Submit Times");
    console.log("  3. Sign in with Onyen (+ Duo) on the UNC page");
    console.log("  4. When you see Logout on LibCal, come back here");
    console.log("\n  ⚠ Do NOT click \"Submit my Booking\" on the checkout page — that books the slot.\n");
  }

  console.log("Press Enter once Logout is visible (or you are clearly logged in).\n");

  await waitForEnter();

  const removed = await abandonHeldBookings(page).catch(() => 0);
  if (removed > 0) {
    console.log(`Cleared ${removed} held slot(s) from the checkout cart.`);
  }

  const body = await page.content();
  if (isBookingConfirmed(body)) {
    console.error(
      "\n⚠ A booking was completed in the browser during login. Check alerts@mail.libcal.com to cancel if unintended.\n",
    );
  }

  const status = await probeAuthenticatedContext(context);
  if (!status.valid) {
    await context.close();
    sharedContext = null;
    console.error(`\nLogin not saved: ${status.message}\n`);
    process.exit(1);
  }

  await exportSessionBackup(context);
  await context.close();
  sharedContext = null;

  console.log(`\nSession saved to ${BROWSER_PROFILE_DIR}`);
  if (status.authIdExpires) {
    console.log(`LibCal auth token expires around: ${status.authIdExpires}`);
  }
  console.log("Verified: Session is active. You can now book via the MCP.\n");
}

function waitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", () => {
      process.stdin.pause();
      resolve();
    });
  });
}

export async function withAuthenticatedContext<T>(
  fn: (context: BrowserContext) => Promise<T>,
  options?: { persistSession?: boolean },
): Promise<T> {
  return withContextLock(async () => {
    const context = await openPersistentContext(true);
    try {
      const result = await fn(context);
      if (options?.persistSession !== false) {
        await exportSessionBackup(context);
      }
      return result;
    } catch (error) {
      // If the browser crashed, drop the cached context so the next call relaunches.
      if (!context.browser()?.isConnected()) {
        sharedContext = null;
      }
      throw error;
    }
  });
}

export async function checkSessionValid(): Promise<{
  valid: boolean;
  message: string;
  authIdExpires?: string;
  note?: string;
}> {
  if (!profileExists() && !existsSync(SESSION_PATH)) {
    return { valid: false, message: `No session saved. ${LOGIN_SETUP_HINT}` };
  }

  try {
    const status = await withAuthenticatedContext((context) => probeAuthenticatedContext(context));
    return {
      ...status,
      note:
        "UNC SSO sessions can expire after inactivity. Re-run `npm run login` when booking fails with a redirect to SSO.",
    };
  } catch (error) {
    return {
      valid: false,
      message: `Session check failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function cookiesAsHeader(context: BrowserContext): Promise<string> {
  const cookies = await context.cookies(BASE_URL);
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}
