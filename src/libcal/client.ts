import type { AvailabilitySlot, PendingBooking } from "./types.js";
import { BASE_URL } from "./constants.js";

const DEFAULT_HEADERS = {
  Accept: "application/json, text/javascript, */*; q=0.01",
  "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
  "X-Requested-With": "XMLHttpRequest",
  Referer: `${BASE_URL}/reserve/davis-cubes`,
};

export function isSlotAvailable(className?: string): boolean {
  if (!className) return true;
  if (className.includes("s-lc-eq-checkout")) return false;
  if (className.includes("s-lc-eq-unavail")) return false;
  return true;
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function parseAvailabilitySlots(raw: Array<Record<string, unknown>>): AvailabilitySlot[] {
  return raw.map((slot) => {
    const className = slot.className as string | undefined;
    return {
      start: String(slot.start),
      end: String(slot.end),
      itemId: Number(slot.itemId),
      checksum: String(slot.checksum),
      className,
      available: isSlotAvailable(className),
    };
  });
}

export class LibCalClient {
  constructor(private readonly cookieHeader?: string) {}

  private async post(path: string, body: Record<string, string>): Promise<unknown> {
    const headers: Record<string, string> = { ...DEFAULT_HEADERS };
    if (this.cookieHeader) headers.Cookie = this.cookieHeader;

    const response = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers,
      body: new URLSearchParams(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`LibCal ${path} failed (${response.status}): ${text.slice(0, 300)}`);
    }

    return response.json();
  }

  async getAvailability(params: {
    lid: number;
    gid: number;
    date: string;
  }): Promise<AvailabilitySlot[]> {
    const start = new Date(`${params.date}T12:00:00`);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);

    const data = (await this.post("/spaces/availability/grid", {
      lid: String(params.lid),
      gid: String(params.gid),
      eid: "-1",
      seat: "0",
      seatId: "0",
      zone: "0",
      start: formatDate(start),
      end: formatDate(end),
      pageIndex: "0",
      pageSize: "18",
    })) as { slots?: Array<Record<string, unknown>> };

    return parseAvailabilitySlots(data.slots ?? []);
  }

  async addToCart(params: {
    lid: number;
    gid: number;
    itemId: number;
    checksum: string;
    start: string;
    date: string;
  }): Promise<PendingBooking> {
    const dayEnd = new Date(`${params.date}T12:00:00`);
    dayEnd.setDate(dayEnd.getDate() + 1);

    const data = (await this.post("/spaces/availability/booking/add", {
      "add[eid]": String(params.itemId),
      "add[gid]": String(params.gid),
      "add[lid]": String(params.lid),
      "add[start]": params.start,
      "add[checksum]": params.checksum,
      lid: String(params.lid),
      gid: String(params.gid),
      start: params.date,
      end: formatDate(dayEnd),
    })) as { bookings?: PendingBooking[] };

    const booking = data.bookings?.[0];
    if (!booking) throw new Error("LibCal did not return a pending booking");
    return booking;
  }

  async submitTimes(params: {
    returnPath: string;
    booking: PendingBooking;
  }): Promise<{ cookies: string[]; body: unknown }> {
    const headers: Record<string, string> = { ...DEFAULT_HEADERS };
    if (this.cookieHeader) headers.Cookie = this.cookieHeader;

    const body = {
      patron: "",
      patronHash: "",
      returnUrl: params.returnPath,
      "bookings[0][id]": String(params.booking.id),
      "bookings[0][eid]": String(params.booking.eid),
      "bookings[0][seat_id]": String(params.booking.seat_id),
      "bookings[0][gid]": String(params.booking.gid),
      "bookings[0][lid]": String(params.booking.lid),
      "bookings[0][start]": params.booking.start.replace(" ", "+").slice(0, 16),
      "bookings[0][end]": params.booking.end.replace(" ", "+").slice(0, 16),
      "bookings[0][checksum]": params.booking.checksum,
      method: "11",
    };

    const response = await fetch(`${BASE_URL}/ajax/space/times`, {
      method: "POST",
      headers,
      body: new URLSearchParams(body),
    });

    const setCookies = response.headers.getSetCookie?.() ?? [];
    const json = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(`Submit times failed (${response.status}): ${JSON.stringify(json)}`);
    }

    return { cookies: setCookies, body: json };
  }
}

export function filterSlots(
  slots: AvailabilitySlot[],
  options: {
    afterTime?: string;
    beforeTime?: string;
    durationMinutes?: number;
    itemId?: number;
  },
): AvailabilitySlot[] {
  const duration = options.durationMinutes ?? 60;
  const available = slots.filter((s) => s.available);

  return available.filter((slot) => {
    if (options.itemId && slot.itemId !== options.itemId) return false;

    const start = new Date(slot.start.replace(" ", "T"));
    const end = new Date(slot.end.replace(" ", "T"));
    const slotMinutes = (end.getTime() - start.getTime()) / 60000;
    if (slotMinutes < 30) return false;

    const time = slot.start.split(" ")[1]?.slice(0, 5);
    if (options.afterTime && time && time < options.afterTime) return false;
    if (options.beforeTime && time && time >= options.beforeTime) return false;

  // For multi-hour bookings, caller chains consecutive slots; we return start slots.
    void duration;
    return true;
  });
}

export function slotStartTime(slot: AvailabilitySlot): string {
  return slot.start.split(" ")[1]?.slice(0, 5) ?? "";
}

export function slotDate(slot: AvailabilitySlot): string {
  return slot.start.split(" ")[0] ?? "";
}
