#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { checkSessionValid, withAuthenticatedContext } from "./auth/session.js";
import { bookSpace, listAvailability } from "./libcal/book.js";
import { suggestBookingOptions, formatDurationHint } from "./libcal/planner.js";
import { SPACE_CATEGORIES, DEFAULT_CATEGORY } from "./libcal/constants.js";
import { addToAppleCalendar, listCalendars } from "./calendar/apple.js";

const server = new McpServer({
  name: "unc-libcal",
  version: "0.3.0",
});

const categoryIds = Object.keys(SPACE_CATEGORIES).join(", ");

const AGENT_BOOKING_RULES = `
BOOKING WORKFLOW (required):
1. For open-ended requests ("book a room", "max hours", "soonest available") → call libcal_suggest FIRST.
2. Present numbered options to the user. Explain the recommended option (usually same-day if available).
3. Only call libcal_book after the user picks an option (or gives explicit date+time).
4. Never auto-book a far-future date when sooner options exist.
`.trim();

const AGENT_CANCELLATION_RULES = `
CANCELLATION (required):
- This server cannot cancel bookings. There is no cancel tool, API, or way to look up cancel links.
- To cancel, the user must use the link in their LibCal confirmation email from alerts@mail.libcal.com.
- If asked to cancel, direct them to search their inbox for that sender — do not attempt automation or scraping.
`.trim();

server.tool(
  "libcal_auth_status",
  "Check whether your saved UNC LibCal login session is still valid. Run `npm run login` in the unc-libcal-mcp project if expired.",
  {},
  async () => {
    const status = await checkSessionValid();
    return {
      content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
    };
  },
);

server.tool(
  "libcal_suggest",
  `Find ranked booking options with same-day priority. Use BEFORE booking when the user has not given an exact date+time. ${AGENT_BOOKING_RULES} Categories: ${categoryIds}`,
  {
    duration_minutes: z
      .number()
      .int()
      .min(30)
      .max(180)
      .optional()
      .describe("Desired length in minutes (default 60; use 180 for max/LibCal limit)"),
    category: z
      .string()
      .optional()
      .describe(`Space category id (default: ${DEFAULT_CATEGORY})`),
    preferred_date: z
      .string()
      .optional()
      .describe("User's preferred date YYYY-MM-DD (optional, boosts ranking)"),
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
      maxOptions: max_options,
      prefs: {
        preferSameDay: prefer_same_day ?? config.preferSameDay ?? true,
        minLeadMinutes: config.minLeadMinutes ?? 30,
        searchHorizonDays: config.searchHorizonDays ?? 7,
      },
    });

    return {
      content: [
        {
          type: "text",
          text: message + `\n\n(Duration: ${formatDurationHint(duration)})`,
        },
      ],
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
  `Book a specific UNC LibCal slot. ${AGENT_BOOKING_RULES} ${AGENT_CANCELLATION_RULES} Requires user_confirmed=true. Categories: ${categoryIds}`,
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
            text: `${auth.message}\n\nRun this once in the project directory:\n  npm run login`,
          },
        ],
        isError: true,
      };
    }

    const result = await withAuthenticatedContext((context) =>
      bookSpace(context, {
        categoryId,
        date,
        startTime: start_time,
        durationMinutes: duration_minutes,
        itemId: space_id,
        purpose: config.bookingPurpose,
      }),
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
