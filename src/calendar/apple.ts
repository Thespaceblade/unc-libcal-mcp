import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function escapeAppleScript(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function toAppleScriptDate(isoDateTime: string): string {
  // "2026-08-28 14:00:00" -> AppleScript date
  const d = new Date(isoDateTime.replace(" ", "T"));
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  return `date "${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}:00"`;
}

export async function addToAppleCalendar(options: {
  calendarName: string;
  title: string;
  start: string;
  end: string;
  location: string;
  notes?: string;
}): Promise<{ success: boolean; message: string }> {
  const script = `
    tell application "Calendar"
      tell calendar "${escapeAppleScript(options.calendarName)}"
        set newEvent to make new event with properties {summary:"${escapeAppleScript(options.title)}", start date:${toAppleScriptDate(options.start)}, end date:${toAppleScriptDate(options.end)}, location:"${escapeAppleScript(options.location)}"${options.notes ? `, description:"${escapeAppleScript(options.notes)}"` : ""}}
        return uid of newEvent
      end tell
    end tell
  `;

  try {
    const { stdout } = await execFileAsync("osascript", ["-e", script]);
    return {
      success: true,
      message: `Added to Apple Calendar (${options.calendarName}). Event uid: ${stdout.trim()}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Calendar got an error") || message.includes("(-1743)")) {
      return {
        success: false,
        message:
          "Calendar access denied. Grant Automation permission: System Settings → Privacy & Security → Automation → allow your terminal/Cursor to control Calendar.",
      };
    }
    if (message.includes("Can’t get calendar")) {
      return {
        success: false,
        message: `Calendar "${options.calendarName}" not found. Update calendarName in ~/.unc-libcal/config.json`,
      };
    }
    return { success: false, message };
  }
}

export async function listCalendars(): Promise<string[]> {
  const script = `
    tell application "Calendar"
      set names to {}
      repeat with c in calendars
        set end of names to name of c
      end repeat
      return names
    end tell
  `;

  const { stdout } = await execFileAsync("osascript", ["-e", script]);
  return stdout
    .trim()
    .split(", ")
    .map((s) => s.trim())
    .filter(Boolean);
}
