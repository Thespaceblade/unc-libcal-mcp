# Contributing to UNC LibCal MCP

Thanks for helping improve this project. Contributions of all sizes are welcome — bug reports, docs fixes, tests, and features.

## Quick setup

```bash
git clone https://github.com/Thespaceblade/unc-libcal-mcp.git
cd unc-libcal-mcp
npm install
npx playwright install chromium
npm run build
npm test
```

You need **Node.js 20+**. Booking against live LibCal also needs a UNC Onyen (`npm run login`); most unit tests do not.

Private session files live in `~/.unc-libcal/` and must never be committed.

## Development loop

| Command | What it does |
|---|---|
| `npm run build` | Compile TypeScript → `dist/` |
| `npm test` | Unit tests (mocked LibCal; no login) |
| `npm run test:integration` | Hits live availability APIs where applicable |
| `npm run login` | Save an Onyen browser session for booking |
| `npm run dev` | Build and start the MCP server on stdio |

Point your MCP client at `dist/index.js` (see the README) while iterating.

## Project layout

```
src/
  index.ts          MCP tool registration / server entry
  login.ts          CLI entry for Onyen login
  config.ts         ~/.unc-libcal/config.json helpers
  auth/             Saved Playwright session helpers
  libcal/           Availability, planner, browser booking
  calendar/         Optional Apple Calendar integration
  scripts/          One-off CLI helpers
```

## Pull requests

1. Open an [issue](https://github.com/Thespaceblade/unc-libcal-mcp/issues) first for larger changes so we can align on approach.
2. Branch from `main`.
3. Keep PRs focused — one concern per PR when possible.
4. Add or update tests for behavior changes under `src/**/*.test.ts`.
5. Run `npm test` locally before opening the PR.
6. Fill out the PR template (what / why / how tested).

### Good first contributions

- Docs clarity (especially install / MCP client config)
- More unit coverage around planner scoring and time windows
- Hardening Playwright booking selectors when LibCal UI shifts
- Support notes for additional Davis space categories

## Reporting bugs

Use a bug report issue and include:

- Node version (`node -v`)
- OS
- MCP client (Claude Desktop, Cursor, Codex, …)
- Steps to reproduce
- Relevant tool output (`libcal_auth_status`, suggest/book errors)
- Whether `npm run login` was re-run recently

**Do not paste** Onyen credentials, Duo codes, or the contents of `~/.unc-libcal/storage-state.json`.

## Code style

- TypeScript, ESM (`"type": "module"`), NodeNext resolution
- Prefer small, testable functions in `src/libcal/`
- Avoid committing secrets, screenshots of logged-in sessions, or personal booking data

## License

By contributing, you agree your work is licensed under the MIT License (see [LICENSE](./LICENSE)).
