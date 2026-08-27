#!/usr/bin/env node
/** List LibCal bookings; cancel via confirmation email links only at UNC. */
import { chromium } from "playwright";
import { SESSION_PATH } from "../config.js";
import { BASE_URL } from "../libcal/constants.js";

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: SESSION_PATH });
  const page = await context.newPage();

  await page.goto(`${BASE_URL}/spaces/bookings?lid=355&gid=750`, { waitUntil: "networkidle" });

  if (page.url().includes("sso.unc.edu")) {
    console.error("Session expired. Run: npm run login");
    process.exit(1);
  }

  const whenSelect = page.locator("select").filter({ has: page.locator("option", { hasText: /next 14 days/i }) });
  if (await whenSelect.count()) {
    const labels = await whenSelect.first().locator("option").allTextContents();
    const next14 = labels.find((l) => /next 14 days/i.test(l));
    if (next14) await whenSelect.first().selectOption({ label: next14 });
    await page.waitForTimeout(1000);
  }

  const cancelLinks = await page.locator('a[href*="cancel"]').count();
  const body = await page.content();

  console.log(
    JSON.stringify(
      {
        note:
          "UNC LibCal public bookings page lists all patrons. Personal cancel links appear in confirmation emails from alerts@mail.libcal.com — not on this page.",
        cancelLinksOnPage: cancelLinks,
        hasLogout: body.includes("Logout"),
      },
      null,
      2,
    ),
  );

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
