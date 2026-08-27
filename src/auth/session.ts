import { chromium, type BrowserContext } from "playwright";
import { ensureDataDir, SESSION_PATH as DEFAULT_SESSION_PATH } from "../config.js";

const SESSION_PATH = process.env.SESSION_PATH ?? DEFAULT_SESSION_PATH;
import { BASE_URL } from "../libcal/constants.js";

const LOGIN_URL = `${BASE_URL}/reserve/davis-cubes`;

export async function runLoginFlow(): Promise<void> {
  ensureDataDir();

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log("\nOpening UNC LibCal login flow...");
  console.log("1. Log in with your Onyen when prompted");
  console.log("2. Wait until you see the Davis booking page logged in");
  console.log("3. Press Enter in this terminal when done\n");

  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });

  // User may need to click through to auth — wait up to 5 min for them to finish.
  await page.waitForTimeout(1000);

  await waitForEnter();

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
    await context.storageState({ path: SESSION_PATH });
    await browser.close();
  }
}

export async function checkSessionValid(): Promise<{ valid: boolean; message: string }> {
  const { existsSync } = await import("node:fs");
  if (!existsSync(SESSION_PATH)) {
    return { valid: false, message: "No session saved. Run: npm run login" };
  }

  try {
    return await withAuthenticatedContext(async (context) => {
      const page = await context.newPage();
      await page.goto(`${BASE_URL}/spaces/bookings`, { waitUntil: "networkidle" });

      const url = page.url();
      const content = await page.content();

      if (url.includes("sso.unc.edu") || content.includes("Single Sign-On")) {
        return { valid: false, message: "Session expired. Run: npm run login" };
      }

      return { valid: true, message: "Session is active" };
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
