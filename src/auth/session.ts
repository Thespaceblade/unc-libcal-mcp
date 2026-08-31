import { chromium, type BrowserContext } from "playwright";
import { ensureDataDir, SESSION_PATH as DEFAULT_SESSION_PATH } from "../config.js";

const SESSION_PATH = process.env.SESSION_PATH ?? DEFAULT_SESSION_PATH;
import { BASE_URL } from "../libcal/constants.js";
import { abandonHeldBookings, clearBookingCartCookies } from "../libcal/browser.js";

const LOGIN_URL = `${BASE_URL}/reserve/davis-cubes`;
const BOOKING_FORM_SELECTOR = "#s-lc-eq-form-times select";

/** Shown to users and agents when login is required. */
export const LOGIN_SETUP_HINT =
  "Run `npm run login` in the unc-libcal-mcp project. Sign in with Onyen (+ Duo) when SSO opens, " +
  "then press Enter — the script clears the held test slot and returns you to the calendar with Logout.";

/** Click a slot and submit times to reach UNC SSO (LibCal does not prompt on page load). */
export async function triggerLibCalLogin(page: import("playwright").Page): Promise<boolean> {
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);

  if ((await page.getByRole("link", { name: /logout/i }).count()) > 0) {
    return true;
  }

  let clicked = await page.evaluate(() => {
    const slot = document.querySelector(".s-lc-eq-avail");
    if (!slot) return false;
    (slot as HTMLElement).click();
    return true;
  });

  if (!clicked) {
    const next = page.locator("button.fc-next-button").first();
    if (await next.isVisible().catch(() => false)) {
      await next.click();
      await page.waitForTimeout(800);
      clicked = await page.evaluate(() => {
        const slot = document.querySelector(".s-lc-eq-avail");
        if (!slot) return false;
        (slot as HTMLElement).click();
        return true;
      });
    }
  }

  if (!clicked) return false;

  await page.waitForSelector(BOOKING_FORM_SELECTOR, { timeout: 10_000 });
  await page.locator('button:has-text("Submit Times")').click();
  await page.waitForURL(/\/spaces\/auth|sso\.unc\.edu/, { timeout: 15_000 }).catch(() => undefined);
  await page.waitForTimeout(1000);
  return true;
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
): Promise<{ valid: boolean; message: string }> {
  const ok = await verifyBookingSession(context);
  return ok
    ? { valid: true, message: "Session is active" }
    : { valid: false, message: `Not logged in. ${LOGIN_SETUP_HINT}` };
}

/** Submit Times on an open slot — confirms SSO cookies work for booking. */
export async function verifyBookingSession(context: BrowserContext): Promise<boolean> {
  await clearBookingCartCookies(context);
  const page = await context.newPage();
  try {
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);

    const slot = page.locator(".s-lc-eq-avail").first();
    if ((await slot.count()) === 0) return false;

    await slot.click();
    await page.waitForSelector(BOOKING_FORM_SELECTOR, { timeout: 10_000 });
    await page.locator('button:has-text("Submit Times")').click();
    await page.waitForURL(/\/spaces\/auth|sso\.unc\.edu/, { timeout: 15_000 }).catch(() => undefined);
    await page.waitForTimeout(1000);

    const ok = page.url().includes("/spaces/auth") && !page.url().includes("sso.unc.edu");
    if (ok) await abandonHeldBookings(page).catch(() => 0);
    return ok;
  } finally {
    await page.close();
  }
}

/** After Onyen on checkout: save cookies, clear test hold, return to calendar. */
export async function finishLoginOnCalendar(
  page: import("playwright").Page,
  context: BrowserContext,
): Promise<{ valid: boolean; message: string }> {
  if (page.url().includes("sso.unc.edu")) {
    return { valid: false, message: "Still on UNC SSO — finish Onyen + Duo first." };
  }
  if (!page.url().includes("calendar.lib.unc.edu")) {
    return { valid: false, message: `Expected calendar.lib.unc.edu after login (got ${page.url()}).` };
  }

  await context.storageState({ path: SESSION_PATH });

  const removed = await abandonHeldBookings(page).catch(() => 0);
  if (removed > 0) {
    console.log(`Cleared ${removed} held test slot(s) from checkout.`);
  } else {
    await clearBookingCartCookies(context);
    console.log("Cleared cart cookies from login test hold.");
  }

  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);

  const verified = await verifyBookingSession(context);
  if (verified) {
    console.log("Session verified — booking auth works.\n");
    return { valid: true, message: "Session is active" };
  }

  const hasLogout = (await page.getByRole("link", { name: /logout/i }).count()) > 0;
  return sessionProbeResult(page.url(), hasLogout);
}

export async function runLoginFlow(): Promise<void> {
  ensureDataDir();

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();

  console.log("\nOpening UNC LibCal login...");

  const triggered = await triggerLibCalLogin(page).catch(() => false);

  if ((await page.getByRole("link", { name: /logout/i }).count()) > 0) {
    console.log("Already logged in. Press Enter to save this session.\n");
  } else if (page.url().includes("sso.unc.edu")) {
    console.log("UNC SSO is open — sign in with your Onyen (+ Duo if asked).\n");
  } else if (!triggered) {
    console.log("Could not auto-start login. Manually: click any open slot → Submit Times.\n");
  } else if (page.url().includes("/spaces/auth")) {
    console.log("Onyen checkout is open — finish sign-in if you have not yet.\n");
  }

  console.log("After Onyen you may land on Booking Details (a test slot is held — that is normal).");
  console.log("Press Enter when sign-in is done. We will clear the held slot and open the calendar.\n");
  console.log("Do NOT click \"Submit my Booking\" on the checkout page.\n");

  await waitForEnter();

  const status = await finishLoginOnCalendar(page, context);
  if (!status.valid) {
    await browser.close();
    console.error(`\nLogin not saved: ${status.message}`);
    console.error(`Current page: ${page.url()}\n`);
    process.exit(1);
  }

  await context.storageState({ path: SESSION_PATH });
  await browser.close();

  console.log(`Session saved to ${SESSION_PATH}`);
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
  if (!SESSION_PATH) throw new Error("Session path not configured");

  const { existsSync } = await import("node:fs");
  if (!existsSync(SESSION_PATH)) {
    throw new Error("No saved session. Run: npm run login — then log in with your Onyen.");
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: SESSION_PATH,
    viewport: { width: 1400, height: 900 },
  });

  try {
    return await fn(context);
  } finally {
    if (options?.persistSession) {
      await context.storageState({ path: SESSION_PATH });
    }
    await browser.close();
  }
}

export async function checkSessionValid(): Promise<{ valid: boolean; message: string }> {
  const { existsSync } = await import("node:fs");
  if (!existsSync(SESSION_PATH)) {
    return { valid: false, message: `No session saved. ${LOGIN_SETUP_HINT}` };
  }

  try {
    return await withAuthenticatedContext((context) => probeAuthenticatedContext(context), {
      persistSession: false,
    });
  } catch (error) {
    return {
      valid: false,
      message: `Session check failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function cookiesAsHeader(context: BrowserContext): Promise<string> {
  const cookies = await context.cookies(BASE_URL);
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}
