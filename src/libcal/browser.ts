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
export const BOOKING_FORM_SELECTOR = "#s-lc-eq-form-times select.b-end-date";

export interface CheckoutHold {
  spaceName: string;
  fromLabel: string;
  toLabel: string;
}

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

/** Detect LibCal booking confirmation in page HTML (not the pre-submit hold page). */
export function isBookingConfirmed(content: string): boolean {
  if (/these times will be held for you/i.test(content)) return false;
  if (/continue to complete your booking/i.test(content)) return false;

  return (
    /booking\s+confirmed/i.test(content) ||
    /your booking has been submitted/i.test(content) ||
    /successfully booked/i.test(content) ||
    /booking complete/i.test(content)
  );
}

/** Drop held slots from login checkout and clear cart cookies. */
export async function abandonHeldBookings(page: Page): Promise<number> {
  let removed = 0;
  const removeLocator = page.getByRole("button", { name: /^Remove$/i }).or(
    page.getByRole("link", { name: /^Remove$/i }),
  );
  while ((await removeLocator.count()) > 0) {
    await removeLocator.first().click();
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

function timeLabelToMinutes(label: string): number | null {
  const hhmm = parse12HourLabelPrefix(label);
  if (!hhmm) return null;
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** Map a LibCal time label to a horizontal center, interpolating between hour headers. */
export function resolveTargetCenterX(headers: SlotHeader[], startLabel: string): number | null {
  const exact = headers.find((h) => h.label.toLowerCase() === startLabel.toLowerCase());
  if (exact) return exact.centerX;

  const targetMin = timeLabelToMinutes(startLabel);
  if (targetMin === null) return null;

  const sorted = headers
    .map((h) => ({ ...h, min: timeLabelToMinutes(h.label) }))
    .filter((h): h is SlotHeader & { min: number } => h.min !== null)
    .sort((a, b) => a.min - b.min);

  for (let i = 0; i < sorted.length - 1; i++) {
    const left = sorted[i];
    const right = sorted[i + 1];
    if (targetMin < left.min || targetMin > right.min) continue;

    const span = right.min - left.min;
    if (span === 0) return left.centerX;
    const fraction = (targetMin - left.min) / span;
    return left.centerX + fraction * (right.centerX - left.centerX);
  }

  return null;
}

/** Pick first available slot whose center aligns with a start-time header. */
export function findSlotAtTime(
  headers: SlotHeader[],
  slots: SlotTarget[],
  startLabel: string,
  tolerancePx = SLOT_MATCH_TOLERANCE_PX,
): SlotTarget | null {
  const targetX = resolveTargetCenterX(headers, startLabel);
  if (targetX === null) return null;

  for (const slot of slots) {
    if (Math.abs(slot.centerX - targetX) <= tolerancePx) {
      return slot;
    }
  }
  return null;
}

/** Pick dropdown option text that ends at the requested wall-clock time. */
export function pickEndTimeOption(options: string[], endLabel: string): string | null {
  const endLower = endLabel.toLowerCase();
  const exact = options.find((o) => {
    const lower = o.toLowerCase();
    return lower.startsWith(endLower) || lower.includes(` ${endLower}`);
  });
  if (exact) return exact;
  return options.find((o) => o.toLowerCase().includes(endLower)) ?? null;
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
      const headerEls = [...document.querySelectorAll(".fc-timeline-slot-cushion, .fc-slot-label")];
      const headers = headerEls.map((h) => {
        const rect = h.getBoundingClientRect();
        return {
          label: h.textContent?.trim() ?? "",
          centerX: rect.left + rect.width / 2,
        };
      });

      const parseMinutes = (value: string): number | null => {
        const match = value.trim().match(/^(\d{1,2}):(\d{2})\s*(am|pm)\b/i);
        if (!match) return null;
        let hour = Number(match[1]);
        const minute = Number(match[2]);
        const period = match[3].toLowerCase();
        if (period === "pm" && hour !== 12) hour += 12;
        if (period === "am" && hour === 12) hour = 0;
        return hour * 60 + minute;
      };

      const resolveTargetX = (startLabel: string): number | null => {
        const exact = headers.find((h) => h.label.toLowerCase() === startLabel.toLowerCase());
        if (exact) return exact.centerX;

        const targetMin = parseMinutes(startLabel);
        if (targetMin === null) return null;

        const sorted = headers
          .map((h) => ({ ...h, min: parseMinutes(h.label) }))
          .filter((h): h is typeof h & { min: number } => h.min !== null)
          .sort((a, b) => a.min - b.min);

        for (let i = 0; i < sorted.length - 1; i++) {
          const left = sorted[i];
          const right = sorted[i + 1];
          if (targetMin < left.min || targetMin > right.min) continue;
          const span = right.min - left.min;
          if (span === 0) return left.centerX;
          return left.centerX + ((targetMin - left.min) / span) * (right.centerX - left.centerX);
        }
        return null;
      };

      const targetX = resolveTargetX(label);
      if (targetX === null) return { ok: false as const, reason: "no header" };

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

async function readEndTimeControl(page: Page) {
  const control = page.locator(BOOKING_FORM_SELECTOR).first();
  if ((await control.count()) === 0) {
    throw new Error("Booking end-time dropdown not found");
  }
  return control;
}

export async function readSelectedEndLabel(page: Page): Promise<string> {
  const control = await readEndTimeControl(page);
  return control.evaluate(
    (el) => (el as HTMLSelectElement).options[(el as HTMLSelectElement).selectedIndex]?.textContent?.trim() ?? "",
  );
}

/** Wait for LibCal to populate end-time options, select the target, and verify it stuck. */
export async function setBookingEndTime(page: Page, endLabel: string): Promise<void> {
  const control = await readEndTimeControl(page);
  const tag = await control.evaluate((el) => el.tagName.toLowerCase());
  if (tag !== "select") {
    throw new Error(`Unexpected end-time control type: ${tag}`);
  }

  const deadline = Date.now() + 10_000;
  let match: string | null = null;
  let optionValue: string | null = null;

  while (Date.now() < deadline) {
    const options = await control.locator("option").evaluateAll((nodes) =>
      nodes.map((node) => ({
        label: node.textContent?.trim() ?? "",
        value: (node as HTMLOptionElement).value,
      })),
    );
    const labels = options.map((option) => option.label);
    match = pickEndTimeOption(labels, endLabel);
    if (match) {
      optionValue = options.find((option) => option.label === match)?.value ?? null;
      break;
    }
    await page.waitForTimeout(200);
  }

  if (!match || !optionValue) {
    const options = await control.locator("option").allTextContents();
    throw new Error(`End time ${endLabel} not in options: ${options.join(" | ")}`);
  }

  await control.selectOption({ value: optionValue });
  await page.waitForTimeout(150);

  const selected = await readSelectedEndLabel(page);
  if (!selected.toLowerCase().startsWith(endLabel.toLowerCase())) {
    throw new Error(`End time did not stick (wanted ${endLabel}, selected ${selected || "empty"})`);
  }
}

/** Read the held booking row shown after Submit Times. */
export async function readCheckoutHold(page: Page): Promise<CheckoutHold> {
  const hold = await page.evaluate(() => {
    const timePattern = /\d{1,2}:\d{2}\s*(am|pm)/i;

    for (const row of [...document.querySelectorAll("table tr")]) {
      const cells = [...row.querySelectorAll("td")].map((cell) => cell.textContent?.trim() ?? "");
      if (cells.length < 3) continue;

      const timeCells = cells.filter((cell) => timePattern.test(cell));
      if (timeCells.length < 2) continue;

      const fromLabel = timeCells[0];
      const toLabel = timeCells[1];
      const spaceName = cells.find((cell) => cell && !timePattern.test(cell) && !/collaboration cubes/i.test(cell)) ?? "space";

      if (spaceName && fromLabel && toLabel) {
        return { spaceName, fromLabel, toLabel };
      }
    }
    return null;
  });

  if (!hold) {
    throw new Error("Could not read held booking times from checkout page");
  }
  return hold;
}

export function assertCheckoutHoldMatches(
  hold: CheckoutHold,
  expected: { startLabel: string; endLabel: string; durationMinutes: number },
): void {
  const from = parse12HourLabelPrefix(hold.fromLabel);
  const to = parse12HourLabelPrefix(hold.toLabel);
  const expectedEnd = parse12HourLabelPrefix(expected.endLabel);

  if (!from || !to || !expectedEnd) {
    throw new Error(`Could not parse checkout hold times: ${hold.fromLabel} – ${hold.toLabel}`);
  }

  if (from !== parse12HourLabelPrefix(expected.startLabel)) {
    throw new Error(
      `Checkout start is ${hold.fromLabel}, expected ${expected.startLabel} (${hold.spaceName})`,
    );
  }

  if (to !== expectedEnd) {
    throw new Error(
      `Checkout end is ${hold.toLabel}, expected ${expected.endLabel} — booking would only be ${from}–${to}`,
    );
  }

  const actualMinutes = timeDiffMinutes(from, to);
  if (actualMinutes !== expected.durationMinutes) {
    throw new Error(
      `Checkout duration is ${actualMinutes} min (${hold.fromLabel} – ${hold.toLabel}), expected ${expected.durationMinutes} min`,
    );
  }
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

  await page.locator('button:has-text("Submit Times")').click();
  await page.waitForURL(/\/spaces\/auth|sso\.unc\.edu/, { timeout: 15_000 }).catch(() => undefined);
  await page.waitForTimeout(1000);

  // LibCal redirects to /spaces/auth after submit when authenticated.
  if (!page.url().includes("/spaces/auth") && !page.url().includes("sso.unc.edu")) {
    const alert = await page.locator(".alert-danger, .alert-warning, [role='alert']").first().textContent().catch(() => null);
    if (alert) throw new Error(alert.trim());
    throw new Error(`Booking did not reach checkout (stuck at ${page.url()})`);
  }

  const hold = await readCheckoutHold(page);
  assertCheckoutHoldMatches(hold, {
    startLabel,
    endLabel,
    durationMinutes: params.durationMinutes,
  });

  await completeCheckout(page, {
    purpose: params.purpose,
    groupName: params.groupName,
  });

  const body = await page.content();
  const confirmed = isBookingConfirmed(body);

  return {
    success: confirmed,
    spaceName: hold.spaceName || params.spaceName || room,
    itemId: 0,
    start: `${params.date} ${params.startTime}:00`,
    end: endTime,
    location: `Davis Library — ${params.category.name}`,
    confirmationUrl: page.url(),
    message: confirmed ? "Booking confirmed" : "Booking may be pending — check LibCal or your email",
  };
}
