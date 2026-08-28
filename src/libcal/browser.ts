import type { BrowserContext, Page } from "playwright";
import { BASE_URL, type SpaceCategory } from "./constants.js";
import type { BookingResult } from "./types.js";
import {
  addMinutesToDateTime,
  calendarHeadingForDate,
  dayDiff,
  parse12HourLabelPrefix,
  parseCalendarHeading,
  timeDiffMinutes,
  timeTo12HourLabel,
} from "./time.js";

export const SLOT_MATCH_TOLERANCE_PX = 24;
export const CALENDAR_MAX_ADVANCE_CLICKS = 14;
export const BOOKING_FORM_SELECTOR = "#s-lc-eq-form-times select";

/** LibCal rows use data-resource-id like "eid_29085"; API itemId is 29085. */
export function parseResourceItemId(resourceId: string | undefined): number | null {
  if (!resourceId) return null;
  const prefixed = resourceId.match(/^eid_(\d+)$/);
  if (prefixed) return Number(prefixed[1]);
  const plain = Number(resourceId);
  return Number.isNaN(plain) ? null : plain;
}

export interface SlotHeader {
  label: string;
  centerX: number;
}

export interface SlotTarget {
  centerX: number;
  room?: string;
}

/** Detect LibCal booking confirmation in page HTML. */
export function isBookingConfirmed(content: string): boolean {
  return (
    /booking\s+confirmed/i.test(content) ||
    /your booking has been submitted/i.test(content) ||
    /booking confirmation/i.test(content) ||
    /successfully booked/i.test(content) ||
    /booking complete/i.test(content)
  );
}

/** Drop held slots from a login/checkout page so npm run login cannot accidentally book. */
export async function abandonHeldBookings(page: Page): Promise<number> {
  let removed = 0;
  const removeButtons = page.getByRole("button", { name: /^Remove$/i });
  while ((await removeButtons.count()) > 0) {
    await removeButtons.first().click();
    await page.waitForTimeout(500);
    removed++;
  }

  for (const name of ["lc_ebcart", "lc_ea_po"]) {
    await page.context().clearCookies({ name });
  }

  return removed;
}

/** Map timeline header labels to horizontal centers (for slot matching). */
export function buildSlotHeaders(
  labels: string[],
  getCenterX: (index: number) => number,
): SlotHeader[] {
  return labels
    .map((label, index) => ({ label: label.trim(), centerX: getCenterX(index) }))
    .filter((h) => h.label.length > 0);
}

/** Pick first available slot whose center aligns with a start-time header. */
export function findSlotAtTime(
  headers: SlotHeader[],
  slots: SlotTarget[],
  startLabel: string,
  tolerancePx = SLOT_MATCH_TOLERANCE_PX,
): SlotTarget | null {
  const target = headers.find((h) => h.label.toLowerCase() === startLabel.toLowerCase());
  if (!target) return null;

  for (const slot of slots) {
    if (Math.abs(slot.centerX - target.centerX) <= tolerancePx) {
      return slot;
    }
  }
  return null;
}

/** Pick dropdown option text that ends at the requested wall-clock time. */
export function pickEndTimeOption(options: string[], endLabel: string): string | null {
  const endLower = endLabel.toLowerCase();
  return options.find((option) => option.trim().toLowerCase().startsWith(endLower)) ?? null;
}

/** True when a LibCal dropdown option begins with the requested end time. */
export function optionMatchesEndTime(optionText: string, endLabel: string): boolean {
  return optionText.trim().toLowerCase().startsWith(endLabel.toLowerCase());
}

/** Parse booked start/end times from LibCal confirmation HTML. */
export function parseBookingTimesFromHtml(html: string): { start?: string; end?: string } {
  const fromTo = html.match(
    /from[:\s]*(\d{1,2}:\d{2}\s*(?:am|pm))[\s\S]{0,300}?to[:\s]*(\d{1,2}:\d{2}\s*(?:am|pm))/i,
  );
  if (fromTo) {
    return {
      start: parse12HourLabelPrefix(fromTo[1]) ?? undefined,
      end: parse12HourLabelPrefix(fromTo[2]) ?? undefined,
    };
  }

  const labels = [...html.matchAll(/(\d{1,2}:\d{2}\s*(?:am|pm))/gi)].map((match) => match[1]);
  if (labels.length >= 2) {
    return {
      start: parse12HourLabelPrefix(labels[0]) ?? undefined,
      end: parse12HourLabelPrefix(labels[1]) ?? undefined,
    };
  }

  return {};
}

export const CALENDAR_NEXT_BUTTON = "button.fc-next-button";
export const CALENDAR_PREV_BUTTON = "button.fc-prev-button";

/** Decide how to move the LibCal day picker toward the target date. */
export function calendarStepDirection(
  currentDate: string | null,
  targetDate: string,
): "done" | "next" | "prev" | "unknown" {
  if (!currentDate) return "unknown";
  const diff = dayDiff(currentDate, targetDate);
  if (diff === 0) return "done";
  return diff > 0 ? "next" : "prev";
}

export async function readVisibleCalendarDate(page: Page): Promise<string | null> {
  const headings = await page.locator("h2").allTextContents();
  for (const raw of headings) {
    const parsed = parseCalendarHeading(raw.trim());
    if (parsed) return parsed;
  }
  return null;
}

export async function advanceToDate(page: Page, targetDate: string): Promise<void> {
  for (let i = 0; i < CALENDAR_MAX_ADVANCE_CLICKS; i++) {
    const current = await readVisibleCalendarDate(page);
    const step = calendarStepDirection(current, targetDate);
    if (step === "done") return;
    if (step === "unknown") {
      throw new Error(
        `Could not read LibCal calendar date while navigating to ${calendarHeadingForDate(targetDate)}`,
      );
    }

    const selector = step === "next" ? CALENDAR_NEXT_BUTTON : CALENDAR_PREV_BUTTON;
    const button = page.locator(selector).first();
    if (!(await button.isVisible().catch(() => false))) {
      throw new Error(
        `Calendar ${step} button unavailable at ${current ?? "unknown date"} (want ${targetDate})`,
      );
    }

    await button.click();
    await page.waitForTimeout(800);

    const next = await readVisibleCalendarDate(page);
    if (next === current) {
      throw new Error(`Calendar did not advance from ${current ?? "unknown date"}`);
    }
  }

  const stuck = await readVisibleCalendarDate(page);
  throw new Error(
    `Could not navigate calendar to ${calendarHeadingForDate(targetDate)} (stopped at ${stuck ?? "unknown date"})`,
  );
}

export async function selectSlotByTimeLabel(
  page: Page,
  startLabel: string,
  itemId?: number,
): Promise<string> {
  const clicked = await page.evaluate(
    ({ label, tolerance, itemId }) => {
      const headers = [...document.querySelectorAll(".fc-timeline-slot-cushion, .fc-slot-label")];
      const targetHeader = headers.find((h) => h.textContent?.trim().toLowerCase() === label.toLowerCase());
      if (!targetHeader) return { ok: false as const, reason: "no header" };

      const targetX =
        targetHeader.getBoundingClientRect().left + targetHeader.getBoundingClientRect().width / 2;

      for (const row of [...document.querySelectorAll("[data-resource-id]")]) {
        const resourceId = (row as HTMLElement).dataset.resourceId ?? "";
        const rowItemId = /^eid_(\d+)$/.exec(resourceId)?.[1];
        const parsedId = rowItemId ? Number(rowItemId) : Number(resourceId);
        if (itemId && parsedId !== itemId) continue;

        for (const slot of [...row.querySelectorAll(".s-lc-eq-avail")]) {
          const rect = slot.getBoundingClientRect();
          if (rect.width === 0) continue;
          const cx = rect.left + rect.width / 2;
          if (Math.abs(cx - targetX) <= tolerance) {
            (slot as HTMLElement).click();
            const namedRow = [...document.querySelectorAll("[data-resource-id]")].find(
              (candidate) =>
                candidate.getAttribute("data-resource-id") === resourceId &&
                candidate.querySelector(".fc-datagrid-cell-main"),
            );
            return {
              ok: true as const,
              room:
                namedRow?.querySelector(".fc-datagrid-cell-main")?.textContent?.trim() ?? "space",
            };
          }
        }
      }
      return {
        ok: false as const,
        reason: itemId ? `no slot for room ${itemId}` : "no matching slot",
      };
    },
    { label: startLabel, tolerance: SLOT_MATCH_TOLERANCE_PX, itemId: itemId ?? null },
  );

  if (!clicked.ok) {
    throw new Error(`Could not click ${startLabel} slot: ${JSON.stringify(clicked)}`);
  }
  return clicked.room;
}

export async function readSelectedEndOption(page: Page): Promise<string | null> {
  const control = page.locator(BOOKING_FORM_SELECTOR).first();
  if ((await control.count()) === 0) return null;

  return control.evaluate((element) => {
    const select = element as HTMLSelectElement;
    return select.options[select.selectedIndex]?.textContent?.trim() ?? null;
  });
}

export async function setBookingEndTime(page: Page, endLabel: string): Promise<void> {
  const control = page.locator(
    `${BOOKING_FORM_SELECTOR}, [role='region'][aria-label*='booking form' i] select, [role='region'][aria-label*='booking form' i] [role='combobox']`,
  ).first();

  if ((await control.count()) === 0) {
    throw new Error("Booking end-time dropdown not found");
  }

  const tag = await control.evaluate((el) => el.tagName.toLowerCase());
  if (tag === "select") {
    for (let attempt = 0; attempt < 20; attempt++) {
      const options = await control.locator("option").allTextContents();
      const match = pickEndTimeOption(options, endLabel);
      if (match) {
        await control.selectOption({ label: match });
        await control.evaluate((element) => {
          element.dispatchEvent(new Event("change", { bubbles: true }));
        });
        await page.waitForTimeout(200);

        const selected = await readSelectedEndOption(page);
        if (selected && optionMatchesEndTime(selected, endLabel)) {
          return;
        }
      }
      await page.waitForTimeout(150);
    }

    const options = await control.locator("option").allTextContents();
    const selected = await readSelectedEndOption(page);
    throw new Error(
      `Failed to set booking end time to ${endLabel}. Selected: ${selected ?? "none"}. Options: ${options.join(" | ")}`,
    );
  }

  await control.click({ force: true });
  const escaped = endLabel.replace(":", "\\:");
  const option = page.getByRole("option", { name: new RegExp(`^${escaped}`, "i") }).first();
  if (await option.isVisible().catch(() => false)) {
    await option.click();
    return;
  }

  const options = await page.getByRole("option").allTextContents();
  const match = pickEndTimeOption(options, endLabel);
  if (!match) throw new Error(`End time ${endLabel} not in options: ${options.join(" | ")}`);
  await page.getByRole("option", { name: match }).click();
}

export async function completeCheckout(
  page: Page,
  options: { purpose: string; groupName?: string },
): Promise<void> {
  if (page.url().includes("sso.unc.edu")) {
    throw new Error("Redirected to SSO during checkout — session expired. Run: npm run login");
  }

  const unavailable = page.locator(".alert, [role='alert']").filter({ hasText: /unavailable|issue with completing/i });
  if (await unavailable.isVisible().catch(() => false)) {
    const msg = (await unavailable.first().textContent())?.trim();
    throw new Error(msg || "Selected times became unavailable");
  }

  const continueBtn = page.locator('button:has-text("Continue to Complete Your Booking")').first();
  if (await continueBtn.isVisible().catch(() => false)) {
    await continueBtn.click();
    await page.waitForTimeout(1000);
  }

  const groupField = page.getByLabel(/course or group name/i);
  const purposeField = page.getByLabel(/using the room for/i);
  const genericText = page.locator("form textarea, form input[type='text'][required]").first();

  if (await groupField.isVisible().catch(() => false)) {
    await groupField.fill(options.groupName ?? options.purpose);
  } else if (await purposeField.isVisible().catch(() => false)) {
    await purposeField.fill(options.purpose);
  } else if (await genericText.isVisible().catch(() => false)) {
    await genericText.fill(options.purpose);
  }

  const submit = page
    .locator(
      'button:has-text("Submit my Booking"), button:has-text("Submit Booking"), button:has-text("Submit"), input[type="submit"]',
    )
    .first();

  await submit.click();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(2000);

  const limitError = page.locator("body").filter({ hasText: /180 minute per day limit/i });
  if (await limitError.isVisible().catch(() => false)) {
    throw new Error(
      "LibCal daily limit reached (3 hours per day at Davis). Cancel an existing booking via your confirmation email before booking more.",
    );
  }
}

/** LibCal cart cookies from browsing the grid can block slot selection — clear before booking. */
export async function clearBookingCartCookies(context: BrowserContext): Promise<void> {
  for (const name of ["lc_ebcart", "lc_ea_po"]) {
    await context.clearCookies({ name });
  }
}

export async function bookSpaceInBrowser(
  page: Page,
  params: {
    category: SpaceCategory;
    date: string;
    startTime: string;
    durationMinutes: number;
    purpose: string;
    groupName?: string;
    spaceName?: string;
    itemId?: number;
  },
): Promise<BookingResult> {
  const startLabel = timeTo12HourLabel(params.startTime);
  const endTime = addMinutesToDateTime(`${params.date} ${params.startTime}:00`, params.durationMinutes);
  const endLabel = timeTo12HourLabel(endTime.split(" ")[1]?.slice(0, 5) ?? "");

  await page.goto(`${BASE_URL}${params.category.path}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await advanceToDate(page, params.date);
  await page.waitForSelector(".s-lc-eq-avail", { timeout: 15_000 });

  const room = await selectSlotByTimeLabel(page, startLabel, params.itemId);
  await page.waitForSelector(BOOKING_FORM_SELECTOR, { timeout: 10_000 });
  await setBookingEndTime(page, endLabel);

  const selectedEnd = await readSelectedEndOption(page);
  const selectedEndHhmm = selectedEnd ? parse12HourLabelPrefix(selectedEnd) : null;
  const expectedEndHhmm = endTime.split(" ")[1]?.slice(0, 5) ?? "";
  if (!selectedEndHhmm || selectedEndHhmm !== expectedEndHhmm) {
    throw new Error(
      `End time verification failed before submit. Wanted ${endLabel} (${expectedEndHhmm}), form has ${selectedEnd ?? "nothing"}.`,
    );
  }

  await page.locator('button:has-text("Submit Times")').click();
  await page.waitForURL(/\/spaces\/auth|sso\.unc\.edu/, { timeout: 15_000 }).catch(() => undefined);
  await page.waitForTimeout(1000);

  // LibCal redirects to /spaces/auth after submit when authenticated.
  if (!page.url().includes("/spaces/auth") && !page.url().includes("sso.unc.edu")) {
    const alert = await page.locator(".alert-danger, .alert-warning, [role='alert']").first().textContent().catch(() => null);
    if (alert) throw new Error(alert.trim());
    throw new Error(`Booking did not reach checkout (stuck at ${page.url()})`);
  }

  await completeCheckout(page, {
    purpose: params.purpose,
    groupName: params.groupName,
  });

  const body = await page.content();
  const confirmed = isBookingConfirmed(body);
  const parsedTimes = parseBookingTimesFromHtml(body);
  const bookedStartHhmm = parsedTimes.start ?? params.startTime;
  const bookedEndHhmm = parsedTimes.end ?? selectedEndHhmm ?? expectedEndHhmm;
  const bookedStart = `${params.date} ${bookedStartHhmm}:00`;
  const bookedEnd = `${params.date} ${bookedEndHhmm}:00`;
  const bookedMinutes = timeDiffMinutes(bookedStartHhmm, bookedEndHhmm);

  if (bookedMinutes < params.durationMinutes) {
    return {
      success: false,
      spaceName: params.spaceName ?? room,
      itemId: params.itemId ?? 0,
      start: bookedStart,
      end: bookedEnd,
      location: `Davis Library — ${params.category.name}`,
      confirmationUrl: page.url(),
      message:
        `Booked only ${bookedMinutes} minutes (${bookedStartHhmm}–${bookedEndHhmm}), ` +
        `not the requested ${params.durationMinutes} minutes. Cancel via your LibCal confirmation email and retry.`,
    };
  }

  return {
    success: confirmed,
    spaceName: params.spaceName ?? room,
    itemId: params.itemId ?? 0,
    start: bookedStart,
    end: bookedEnd,
    location: `Davis Library — ${params.category.name}`,
    confirmationUrl: page.url(),
    message: confirmed
      ? `Booking confirmed (${bookedStartHhmm}–${bookedEndHhmm})`
      : "Booking may be pending — check LibCal or your email",
  };
}
