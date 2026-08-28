/** Pure date/time helpers for LibCal booking (no I/O). */

const PAD = (n: number) => String(n).padStart(2, "0");

/** YYYY-MM-DD for a local calendar date. */
export function localDateString(d: Date = new Date()): string {
  return `${d.getFullYear()}-${PAD(d.getMonth() + 1)}-${PAD(d.getDate())}`;
}

/** HH:MM for a local clock time. */
export function localTimeString(d: Date = new Date()): string {
  return `${PAD(d.getHours())}:${PAD(d.getMinutes())}`;
}

/** Add minutes to HH:MM, wraps at midnight. */
export function addMinutesToTime(time: string, minutes: number): string {
  const [h, m] = time.split(":").map(Number);
  const total = h * 60 + m + minutes;
  const nh = Math.floor(total / 60) % 24;
  const nm = ((total % 60) + 60) % 60;
  return `${PAD(nh)}:${PAD(nm)}`;
}

/** "2026-08-28 14:00:00" + minutes → same format. */
export function addMinutesToDateTime(isoDateTime: string, minutes: number): string {
  const d = new Date(isoDateTime.replace(" ", "T"));
  d.setMinutes(d.getMinutes() + minutes);
  return `${d.getFullYear()}-${PAD(d.getMonth() + 1)}-${PAD(d.getDate())} ${PAD(d.getHours())}:${PAD(d.getMinutes())}:00`;
}

/** LibCal form start: "2026-08-28 14:00:00" → "2026-08-28+14:00". */
export function toFormStart(isoDateTime: string): string {
  const [date, time] = isoDateTime.split(" ");
  return `${date}+${time.slice(0, 5)}`;
}

/** HH:MM (24h) → LibCal UI label like "11:00am" or "1:00pm". */
export function timeTo12HourLabel(hhmm: string): string {
  const [hStr, mStr] = hhmm.split(":");
  const h = Number(hStr);
  const m = Number(mStr);
  if (Number.isNaN(h) || Number.isNaN(m) || m < 0 || m > 59 || h < 0 || h > 23) {
    throw new Error(`Invalid time (expected HH:MM): ${hhmm}`);
  }
  const period = h >= 12 ? "pm" : "am";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${PAD(m)}${period}`;
}

/** LibCal calendar h2 heading for a YYYY-MM-DD date. */
export function calendarHeadingForDate(date: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

/** Parse LibCal heading back to YYYY-MM-DD, or null if unrecognized. */
export function parseCalendarHeading(heading: string): string | null {
  const parsed = Date.parse(heading);
  if (Number.isNaN(parsed)) return null;
  return localDateString(new Date(parsed));
}

/** Days between two YYYY-MM-DD strings (b can be before a). */
export function dayDiff(a: string, b: string): number {
  return Math.round(
    (new Date(`${b}T12:00:00`).getTime() - new Date(`${a}T12:00:00`).getTime()) / 86400000,
  );
}

/** "1:00pm Tuesday, September 1, 2026" → "13:00". */
export function parse12HourLabelPrefix(label: string): string | null {
  const match = label.trim().match(/^(\d{1,2}):(\d{2})\s*(am|pm)\b/i);
  if (!match) return null;

  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const period = match[3].toLowerCase();
  if (period === "pm" && hour !== 12) hour += 12;
  if (period === "am" && hour === 12) hour = 0;
  return `${PAD(hour)}:${PAD(minute)}`;
}

/** Minutes from start HH:MM to end HH:MM on the same calendar day. */
export function timeDiffMinutes(startHhmm: string, endHhmm: string): number {
  const [sh, sm] = startHhmm.split(":").map(Number);
  const [eh, em] = endHhmm.split(":").map(Number);
  return eh * 60 + em - (sh * 60 + sm);
}
