# UNC LibCal MCP

MCP server for booking [UNC Davis Library](https://calendar.lib.unc.edu) study spaces from Claude, Cursor, Codex, or any MCP client — with optional Apple Calendar integration.

Built for UNC students, faculty, and staff with a valid **Onyen**. Not affiliated with or endorsed by UNC Libraries.

## What it does

Ask your agent:

> Book me a Davis cube tomorrow at 2pm

The server will:

1. Check LibCal availability (public API — no login needed)
2. Suggest ranked options (`libcal_suggest`) or book a slot you confirm (`libcal_book`)
3. Complete the reservation in your browser session (Playwright + saved Onyen login)
4. Optionally add the event to Apple Calendar (macOS only)

## Requirements

- **Node.js 20+**
- **UNC Onyen** (for booking; availability checks work without login)
- **macOS** for Apple Calendar sync (optional)
- **Chromium** (installed automatically via Playwright)

## Quick start

### 1. Clone and install

```bash
git clone https://github.com/Thespaceblade/unc-libcal-mcp.git
cd unc-libcal-mcp
npm install
npx playwright install chromium
npm run build
npm test
```

### 2. Log in to LibCal

```bash
npm run login
```

A browser opens → sign in with your **Onyen** (+ Duo if prompted) → when the Davis LibCal page loads, press **Enter** in the terminal.

Your session is saved to `~/.unc-libcal/storage-state.json` (never commit this file).

### 3. Configure (optional)

On first run, `~/.unc-libcal/config.json` is created with defaults:

```json
{
  "defaultCategory": "davis-cubes",
  "calendarName": "Calendar",
  "preferSameDay": true,
  "minLeadMinutes": 30,
  "searchHorizonDays": 7,
  "bookingPurpose": "Study session"
}
```

Ask the agent to run `libcal_list_calendars`, then set `calendarName` to your preferred Apple Calendar. Grant **Automation** permission when macOS prompts (Terminal or Cursor → Calendar).

### 4. Connect your MCP client

Every client needs the **absolute path** to `dist/index.js`. From inside the repo:

```bash
pwd   # e.g. /Users/you/projects/unc-libcal-mcp
# Use: <that-path>/dist/index.js
```

Or one-liner:

```bash
node -e "const p=require('path'); console.log(p.join(process.cwd(),'dist/index.js'))"
```

All clients below run the same stdio server:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/unc-libcal-mcp/dist/index.js"]
}
```

Restart the client after editing config.

#### Claude Desktop

File: `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "unc-libcal": {
      "command": "node",
      "args": ["/absolute/path/to/unc-libcal-mcp/dist/index.js"]
    }
  }
}
```

Fully quit and reopen Claude Desktop.

#### Cursor

**Option A — UI:** Settings → **MCP** → Add server → paste the JSON block above.

**Option B — project file:** `.cursor/mcp.json` in this repo (good for sharing with teammates):

```json
{
  "mcpServers": {
    "unc-libcal": {
      "command": "node",
      "args": ["./dist/index.js"]
    }
  }
}
```

Use `./dist/index.js` only if Cursor's MCP cwd is the project root; otherwise use the absolute path.

#### OpenAI Codex (CLI)

Codex uses **TOML**, not JSON. File: `~/.codex/config.toml` (or `.codex/config.toml` in a trusted project).

```toml
[mcp_servers.unc-libcal]
command = "node"
args = ["/absolute/path/to/unc-libcal-mcp/dist/index.js"]
```

Or via CLI:

```bash
codex mcp add unc-libcal -- node /absolute/path/to/unc-libcal-mcp/dist/index.js
codex mcp list   # verify it appears
```

If servers don't show up, confirm the project is **trusted** (`codex trust` in the repo) when using a project-local `.codex/config.toml`.

#### Claude Code (CLI)

File: `~/.claude.json` (global) or `.mcp.json` in the project:

```json
{
  "mcpServers": {
    "unc-libcal": {
      "command": "node",
      "args": ["/absolute/path/to/unc-libcal-mcp/dist/index.js"]
    }
  }
}
```

In a Claude Code session, run `/mcp` to confirm tools are loaded.

#### Other MCP clients

Any client that supports **stdio MCP** can use the same `command` + `args`. Point it at `dist/index.js` after `npm run build`.

### 5. Verify it works

In your agent, try:

```
Check libcal auth status
```

Then:

```
Suggest Davis cubes for 2 hours tomorrow
```

You should see `libcal_auth_status`, `libcal_suggest`, `libcal_check_availability`, `libcal_book`, and `libcal_list_calendars` available once the server is connected.

## MCP tools

| Tool | Login required | Purpose |
|---|---|---|
| `libcal_suggest` | No | Ranked booking options; same-day priority unless you specify a date |
| `libcal_check_availability` | No | Open slots on one date |
| `libcal_book` | Yes | Book a confirmed slot + optional Apple Calendar event |
| `libcal_auth_status` | Yes | Check if saved session is still valid |
| `libcal_list_calendars` | No | List Apple Calendar names (macOS) |

### Booking workflow

1. For open-ended requests (“book a cube”, “max hours”) → agent calls **`libcal_suggest`** first
2. Agent shows numbered options; you pick one
3. Agent calls **`libcal_book`** with `user_confirmed: true` and the chosen date/time

`libcal_book` will not run without explicit confirmation.

## Space categories

| ID | Description |
|---|---|
| `davis-cubes` | Davis Collaboration Cubes (default) |
| `davis-study-rooms` | Davis group study rooms |
| `davis-computers` | Data Services lab computers |

## Example prompts

```
Book me a study room for as long as possible
→ libcal_suggest shows TODAY vs later; you pick; then libcal_book

Book me a Davis cube tomorrow 11am–1pm
→ libcal_suggest or direct libcal_book with your exact time

Any study rooms free Friday afternoon?
→ libcal_check_availability or libcal_suggest
```

## How it works

- **Availability** — reverse-engineered LibCal grid API (`/spaces/availability/grid`)
- **Booking** — Playwright drives the real LibCal UI: select slot → submit times → `/spaces/auth` checkout → confirm form
- **Calendar** — AppleScript → Calendar.app (macOS Automation permission required)

Sessions expire periodically. Run `npm run login` again when `libcal_auth_status` reports expired.

## CLI scripts

```bash
# Refresh Onyen session
npm run login

# Run unit tests (38 tests)
npm test

# Book via CLI (uses saved session)
node dist/scripts/run-task.js --date 2026-09-01 --start 14:00 --duration 120

# Check public bookings page / cancel-link availability
node dist/scripts/list-bookings.js
```

## Cancelling bookings

UNC LibCal does **not** expose a “my bookings” cancel page in the web UI. Cancel via the link in your confirmation email from `alerts@mail.libcal.com`.

## LibCal limits (UNC Davis)

- Up to **3 hours per day**, in **30-minute / 1-hour segments**
- Popular slots can be taken between suggest and book
- Cubes may require a “course or group name” on the checkout form (defaults to `bookingPurpose` in config)

## Development

```bash
npm run build    # compile TypeScript → dist/
npm test         # unit + integration tests
npm run dev      # build and start MCP server on stdio
```

## Caveats

- Personal automation tool — use responsibly and follow UNC Library policies
- Only tested against `calendar.lib.unc.edu` (UNC Chapel Hill)
- Other LibCal institutions would need different `lid`/`gid` constants in `src/libcal/constants.ts`

## License

MIT — see [LICENSE](./LICENSE).
