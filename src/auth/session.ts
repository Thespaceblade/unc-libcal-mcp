import { chromium, type BrowserContext } from "playwright";
import { ensureDataDir, SESSION_PATH as DEFAULT_SESSION_PATH } from "../config.js";

const SESSION_PATH = process.env.SESSION_PATH ?? DEFAULT_SESSION_PATH;
import { BASE_URL } from "../libcal/constants.js";

const LOGIN_URL = `${BASE_URL}/reserve/davis-cubes`;
const BOOKING_FORM_SELECTOR = "#s-lc-eq-form-times select";

/** Shown to users and agents when login is required. */
export const LOGIN_SETUP_HINT =
  "Run `npm run login` in the unc-libcal-mcp project. The browser opens to the public Davis cubes page (normal). " +
  "The script auto-triggers UNC Onyen login. Sign in (+ Duo), wait for Logout on LibCal, then press Enter in the terminal.";

/** Click a slot and submit times to reach UNC SSO (LibCal does not prompt on page load). */
export async function triggerLibCalLogin(page: import("playwright").Page): Promise<boolean> {
  await page.goto(LOGIN_URL, { waitUntil: "networkidle" });

  if ((await page.getByRole("link", { name: /logout/i }).count()) > 0) {
    return true;
  }

  await page.locator("button.fc-next-button").first().click();
  await page.waitForTimeout(800);

  const clicked = await page.evaluate(() => {
    const slot = document.querySelector("a.s-lc-eq-avail");
    if (!slot) return false;
    (slot as HTMLElement).click();
    return true;
  });
  if (!clicked) return false;

  await page.waitForSelector(BOOKING_FORM_SELECTOR, { timeout: 10_000 });
  const select = page.locator(BOOKING_FORM_SELECTOR).first();
  if ((await select.locator("option").count()) > 1) {
    await select.selectOption({ index: 1 });
  }

  await page.locator('button:has-text("Submit Times")').click();
  await page.waitForTimeout(2000);
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
  const page = await context.newPage();
  try {
    await page.goto(LOGIN_URL, { waitUntil: "networkidle" });
    const hasLogout = (await page.getByRole("link", { name: /logout/i }).count()) > 0;
    return sessionProbeResult(page.url(), hasLogout);
  } finally {
    await page.close();
  }
}

export async function runLoginFlow(): Promise<void> {
  ensureDataDir();

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log("\nOpening UNC LibCal...");
  console.log("The Davis cubes page is public — you won't see Onyen until we trigger a booking step.\n");

  const triggered = await triggerLibCalLogin(page).catch(() => false);

  if ((await page.getByRole("link", { name: /logout/i }).count()) > 0) {
    console.log("Already logged in to LibCal. Press Enter to save this session.\n");
  } else if (page.url().includes("sso.unc.edu")) {
    console.log("UNC SSO is open — log in with your Onyen (+ Duo if asked).");
  } else if (!triggered) {
    console.log("Could not auto-start login. Manually: click any open slot → Submit Times.");
  } else {
    console.log("If you are not on the UNC login page yet, click a slot → Submit Times.");
  }

  console.log("\nAfter login, you should land back on LibCal with a Logout link visible.");
  console.log("Press Enter here only once you see Logout (or you are clearly logged in).\n");

  await waitForEnter();

  const status = await probeAuthenticatedContext(context);
  if (!status.valid) {
    await browser.close();
    console.error(`\nLogin not saved: ${status.message}\n`);
    process.exit(1);
  }

  await context.storageState({ path: SESSION_PATH });
  await browser.close();

  console.log(`\nSession saved to ${SESSION_PATH}`);
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
    throw new Error(
      "No saved session. Run: npm run login — then log in with your Onyen.",
    );
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: SESSION_PATH });

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
