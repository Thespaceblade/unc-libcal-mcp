import { chromium, type BrowserContext } from "playwright";
import { ensureDataDir, SESSION_PATH as DEFAULT_SESSION_PATH } from "../config.js";

const SESSION_PATH = process.env.SESSION_PATH ?? DEFAULT_SESSION_PATH;
import { BASE_URL } from "../libcal/constants.js";

const LOGIN_URL = `${BASE_URL}/reserve/davis-cubes`;

/** Pure helper for session probe results (unit-tested). */
export function sessionProbeResult(
  url: string,
  hasLogoutLink: boolean,
): { valid: boolean; message: string } {
  if (url.includes("sso.unc.edu")) {
    return { valid: false, message: "Session expired. Run: npm run login" };
  }
  if (hasLogoutLink) {
    return { valid: true, message: "Session is active" };
  }
  return {
    valid: false,
    message:
      "Not logged in. Run: npm run login — complete Onyen + Duo, wait for Logout in the browser, then press Enter",
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

  console.log("\nOpening UNC LibCal login flow...");
  console.log("1. Log in with your Onyen when prompted (+ Duo if asked)");
  console.log("2. Wait until the Davis booking page shows a Logout link");
  console.log("3. Press Enter in this terminal only after you see Logout\n");

  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);

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
  console.log("You can now use the MCP to book spaces.\n");
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
    return { valid: false, message: "No session saved. Run: npm run login" };
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
