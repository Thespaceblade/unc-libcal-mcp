#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { checkSessionValid, LOGIN_SETUP_HINT, withAuthenticatedContext } from "./auth/session.js";
import { bookSpace, bookPiecemeal, listAvailability } from "./libcal/book.js";
import { suggestBookingOptions } from "./libcal/planner.js";
import { SPACE_CATEGORIES, DEFAULT_CATEGORY } from "./libcal/constants.js";
import { addToAppleCalendar, listCalendars } from "./calendar/apple.js";

const server = new McpServer({
  name: "unc-libcal",
  version: "0.3.0",
});

const categoryIds = Object.keys(SPACE_CATEGORIES).join(", ");

const AGENT_BOOKING_RULES = `
BOOKING WORKFLOW (required):
1. For ANY booking request → call libcal_suggest FIRST. It compares all strategies automatically:
   single-cube in the requested window, piecemeal multi-cube, partial-window fits, and alternate times/days.
2. Pass window_start/window_end when the user gives a range (e.g. "11-1", "11am to 2pm").
3. Present the ranked options with the recommended one marked. Explain tradeoffs briefly.
4. Single-segment options → libcal_book. Multi-segment piecemeal → libcal_book_piecemeal.
5. Only book after the user picks an option. Never auto-book.
`.trim();

const AGENT_CANCELLATION_RULES = `
CANCELLATION (required):
- This server cannot cancel bookings. There is no cancel tool, API, or way to look up cancel links.
- To cancel, the user must use the link in their LibCal confirmation email from alerts@mail.libcal.com.
- If asked to cancel, direct them to search their inbox for that sender — do not attempt automation or scraping.
`.trim();

const AGENT_LOGIN_RULES = `
LOGIN SETUP (required before libcal_book):
- Booking needs a saved Onyen session from \`npm run login\` in the project directory.
- LibCal's calendar page is public — Onyen only appears after the login script triggers it (or after slot → Submit Times).
- If libcal_auth_status is invalid, walk the user through npm run login; do not attempt libcal_book.
`.trim();

server.tool(
  "libcal_auth_status",
  `Check whether the saved UNC LibCal Onyen session is valid. ${AGENT_LOGIN_RULES}`,
  {},
  async () => {
    const status = await checkSessionValid();
    const text = status.valid
      ? JSON.stringify(status, null, 2)
      : JSON.stringify({ ...status, setup: LOGIN_SETUP_HINT }, null, 2);
    return {
      content: [{ type: "text", text }],
    };
  },
);

server.tool(
  "libcal_suggest",
  `Find the best booking plan across ALL cubes and strategies (single-cube, piecemeal, partial-window, alternate times). ALWAYS use this before booking. ${AGENT_BOOKING_RULES} Categories: ${categoryIds}`,
  {
    duration_minutes: z
      .number()
      .int()
      .min(30)
      .max(180)
      .optional()
      .describe("Desired length in minutes when no window is given (default 60; use 180 for max)"),
    window_start: z
      .string()
      .optional()
      .describe('Start of requested window: HH:MM or hour like 11. Use with window_end for ranges like "11-1".'),
    window_end: z
      .string()
      .optional()
      .describe("End of requested window: HH:MM or hour like 13 / 1 (pm inferred if before start)"),
    category: z
      .string()
      .optional()
      .describe(`Space category id (default: ${DEFAULT_CATEGORY})`),
    preferred_date: z
      .string()
      .optional()
      .describe("User's preferred date YYYY-MM-DD (default today when a window is given)"),
    preferred_start_time: z
      .string()
      .optional()
      .describe("User's preferred start HH:MM (optional, boosts ranking)"),
    max_options: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .describe("How many options to return (default 5)"),
    prefer_same_day: z
      .boolean()
      .optional()
      .describe("Prioritize today if slots exist (default true)"),
  },
  async ({
    duration_minutes,
    window_start,
    window_end,
    category,
    preferred_date,
    preferred_start_time,
    max_options,
    prefer_same_day,
  }) => {
    const config = loadConfig();
    const categoryId = category ?? config.defaultCategory;
    const duration = duration_minutes ?? 60;

    const { options, message } = await suggestBookingOptions({
      categoryId,
      durationMinutes: duration,
      preferredDate: preferred_date,
      preferredStartTime: preferred_start_time,
      windowStart: window_start,
      windowEnd: window_end,
      maxOptions: max_options,
      prefs: {
        preferSameDay: prefer_same_day ?? config.preferSameDay ?? true,
        minLeadMinutes: config.minLeadMinutes ?? 30,
        searchHorizonDays: config.searchHorizonDays ?? 7,
      },
    });

    return {
      content: [{ type: "text", text: message }],
      structuredContent: { options },
    };
  },
);

server.tool(
  "libcal_analyze_window",
  `Alias for libcal_suggest with a time window on a specific date. Prefer libcal_suggest directly. ${AGENT_BOOKING_RULES} Categories: ${categoryIds}`,
  {
    date: z.string().describe("Date to check, YYYY-MM-DD"),
    window_start: z.string().describe("Window start: HH:MM (24h) or hour like 11"),
    window_end: z.string().describe("Window end: HH:MM (24h) or hour like 13 / 1 (pm inferred if before start)"),
    category: z
      .string()
      .optional()
      .describe(`Space category id (default: ${DEFAULT_CATEGORY})`),
    max_plans: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .describe("How many options to return (default 5)"),
  },
  async ({ date, window_start, window_end, category, max_plans }) => {
    const categoryId = category ?? loadConfig().defaultCategory;
    const { options, message } = await suggestBookingOptions({
      categoryId,
      durationMinutes: 120,
      preferredDate: date,
      windowStart: window_start,
      windowEnd: window_end,
      maxOptions: max_plans,
    });

    return {
      content: [{ type: "text", text: message }],
      structuredContent: { options },
    };
  },
);

server.tool(
  "libcal_check_availability",
  `Check open slots on ONE specific date. For smart ranked search across days, use libcal_suggest instead. Categories: ${categoryIds}`,
  {
    date: z.string().describe("Date to check, YYYY-MM-DD"),
    category: z
      .string()
      .optional()
      .describe(`Space category id (default: ${DEFAULT_CATEGORY})`),
    after_time: z
      .string()
      .optional()
      .describe("Only show slots at or after this time, HH:MM (24h)"),
    duration_minutes: z
      .number()
      .int()
      .min(30)
      .max(180)
      .optional()
      .describe("Desired booking length in minutes (default 60)"),
  },
  async ({ date, category, after_time, duration_minutes }) => {
    const categoryId = category ?? loadConfig().defaultCategory;
    const slots = await listAvailability(null, {
      categoryId,
      date,
      afterTime: after_time,
      durationMinutes: duration_minutes ?? 60,
    });

    const text =
      slots.length === 0
        ? `No available slots on ${date} for ${categoryId}.`
        : `Available on ${date} (${categoryId}):\n` +
          slots.map((s) => `- ${s.time} — ${s.spaceName ?? `space ${s.itemId}`}`).join("\n");

    return { content: [{ type: "text", text }] };
  },
);

server.tool(
  "libcal_book",
  `Book a specific UNC LibCal slot. ${AGENT_BOOKING_RULES} ${AGENT_LOGIN_RULES} ${AGENT_CANCELLATION_RULES} Requires user_confirmed=true. Categories: ${categoryIds}`,
  {
    date: z.string().describe("Booking date YYYY-MM-DD (from user choice or libcal_suggest option)"),
    start_time: z.string().describe("Start time HH:MM (from user choice or libcal_suggest option)"),
    duration_minutes: z
      .number()
      .int()
      .min(30)
      .max(180)
      .describe("Booking length in minutes"),
    user_confirmed: z
      .boolean()
      .describe("Must be true — confirms the user explicitly chose this slot"),
    category: z
      .string()
      .optional()
      .describe(`Space category id (default: ${DEFAULT_CATEGORY})`),
    space_id: z
      .number()
      .int()
      .optional()
      .describe("LibCal item/space id (from libcal_suggest option if available)"),
    add_to_calendar: z
      .boolean()
      .optional()
      .describe("Add to Apple Calendar after booking (default true)"),
  },
  async ({
    date,
    start_time,
    duration_minutes,
    user_confirmed,
    category,
    space_id,
    add_to_calendar,
  }) => {
    if (!user_confirmed) {
      return {
        content: [
          {
            type: "text",
            text:
              "Booking blocked: user_confirmed must be true.\n\n" +
              "Call libcal_suggest, show options to the user, and only book after they pick one.",
          },
        ],
        isError: true,
      };
    }

    const config = loadConfig();
    const categoryId = category ?? config.defaultCategory;

    const auth = await checkSessionValid();
    if (!auth.valid) {
      return {
        content: [
          {
            type: "text",
            text: `${auth.message}\n\n${LOGIN_SETUP_HINT}`,
          },
        ],
        isError: true,
      };
    }

    const result = await withAuthenticatedContext(
      (context) =>
        bookSpace(context, {
          categoryId,
          date,
          startTime: start_time,
          durationMinutes: duration_minutes,
          itemId: space_id,
          purpose: config.bookingPurpose,
        }),
      { persistSession: true },
    );

    let calendarMessage = "";
    if (add_to_calendar !== false) {
      const cal = await addToAppleCalendar({
        calendarName: config.calendarName ?? "Calendar",
        title: result.spaceName,
        start: result.start,
        end: result.end,
        location: result.location,
        notes: `UNC LibCal booking. ${result.confirmationUrl ?? ""}`.trim(),
      });
      calendarMessage = cal.message;
    }

    const summary = [
      result.success ? "Booked!" : "Booking attempted (verify in LibCal)",
      "",
      `Space: ${result.spaceName}`,
      `When: ${result.start} → ${result.end}`,
      `Where: ${result.location}`,
      result.confirmationUrl ? `URL: ${result.confirmationUrl}` : "",
      calendarMessage ? `\nCalendar: ${calendarMessage}` : "",
      "",
      "To cancel later: use the link in your confirmation email from alerts@mail.libcal.com. This server cannot cancel bookings.",
    ]
      .filter(Boolean)
      .join("\n");

    return {
      content: [{ type: "text", text: summary }],
      isError: !result.success,
    };
  },
);

server.tool(
  "libcal_book_piecemeal",
  `Book multiple cube segments that together cover a time window. Use after libcal_analyze_window when the user confirms a piecemeal plan. ${AGENT_BOOKING_RULES} ${AGENT_LOGIN_RULES} ${AGENT_CANCELLATION_RULES} Requires user_confirmed=true.`,
  {
    date: z.string().describe("Booking date YYYY-MM-DD"),
    segments: z
      .array(
        z.object({
          start_time: z.string().describe("Segment start HH:MM"),
          duration_minutes: z.number().int().min(30).max(180).describe("Segment length in minutes"),
          space_id: z.number().int().describe("LibCal item/space id for this segment"),
        }),
      )
      .min(1)
      .describe("Ordered booking segments from libcal_analyze_window plan"),
    user_confirmed: z
      .boolean()
      .describe("Must be true — confirms the user explicitly chose this piecemeal plan"),
    category: z
      .string()
      .optional()
      .describe(`Space category id (default: ${DEFAULT_CATEGORY})`),
    add_to_calendar: z
      .boolean()
      .optional()
      .describe("Add each segment to Apple Calendar after booking (default true)"),
  },
  async ({ date, segments, user_confirmed, category, add_to_calendar }) => {
    if (!user_confirmed) {
      return {
        content: [
          {
            type: "text",
            text:
              "Booking blocked: user_confirmed must be true.\n\n" +
              "Call libcal_analyze_window, show piecemeal options, and only book after the user picks one.",
          },
        ],
        isError: true,
      };
    }

    const config = loadConfig();
    const categoryId = category ?? config.defaultCategory;

    const auth = await checkSessionValid();
    if (!auth.valid) {
      return {
        content: [{ type: "text", text: `${auth.message}\n\n${LOGIN_SETUP_HINT}` }],
        isError: true,
      };
    }

    const windowSegments = segments.map((segment) => ({
      itemId: segment.space_id,
      startTime: segment.start_time,
      endTime: "",
      durationMinutes: segment.duration_minutes,
    }));

    const { results, message } = await withAuthenticatedContext(
      (context) =>
        bookPiecemeal(context, {
          categoryId,
          date,
          segments: windowSegments,
          purpose: config.bookingPurpose,
        }),
      { persistSession: true },
    );

    let calendarMessage = "";
    if (add_to_calendar !== false) {
      const notes: string[] = [];
      for (const result of results) {
        const cal = await addToAppleCalendar({
          calendarName: config.calendarName ?? "Calendar",
          title: result.spaceName,
          start: result.start,
          end: result.end,
          location: result.location,
          notes: `UNC LibCal booking. ${result.confirmationUrl ?? ""}`.trim(),
        });
        notes.push(cal.message);
      }
      calendarMessage = notes.join("\n");
    }

    const summary = [
      "Piecemeal booking complete!",
      "",
      message,
      calendarMessage ? `\nCalendar:\n${calendarMessage}` : "",
      "",
      "To cancel later: use the link in each confirmation email from alerts@mail.libcal.com.",
    ]
      .filter(Boolean)
      .join("\n");

    return {
      content: [{ type: "text", text: summary }],
      isError: false,
    };
  },
);

server.tool(
  "libcal_list_calendars",
  "List Apple Calendar calendar names (use one in ~/.unc-libcal/config.json as calendarName).",
  {},
  async () => {
    const calendars = await listCalendars();
    return {
      content: [
        {
          type: "text",
          text:
            calendars.length > 0
              ? `Apple Calendars:\n${calendars.map((c) => `- ${c}`).join("\n")}`
              : "No calendars found or Calendar access denied.",
        },
      ],
    };
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
