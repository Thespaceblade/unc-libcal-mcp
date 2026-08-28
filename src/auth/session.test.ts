import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readAuthIdExpiry, sessionProbeResult } from "./session.js";
import type { Cookie } from "playwright";

describe("sessionProbeResult", () => {
  it("rejects SSO redirect", () => {
    const result = sessionProbeResult("https://sso.unc.edu/shibboleth", false);
    assert.equal(result.valid, false);
    assert.match(result.message, /npm run login/);
    assert.match(result.message, /Submit my Booking/i);
  });

  it("accepts page with Logout link", () => {
    const result = sessionProbeResult("https://calendar.lib.unc.edu/reserve/davis-cubes", true);
    assert.equal(result.valid, true);
    assert.match(result.message, /active/i);
  });

  it("rejects public page without Logout", () => {
    const result = sessionProbeResult("https://calendar.lib.unc.edu/reserve/davis-cubes", false);
    assert.equal(result.valid, false);
    assert.match(result.message, /not logged in/i);
  });
});

describe("readAuthIdExpiry", () => {
  it("reads libauth auth_id expiry", () => {
    const cookies = [
      {
        name: "auth_id",
        domain: "libauth.com",
        expires: 1_700_000_000,
      } as Cookie,
    ];
    assert.equal(readAuthIdExpiry(cookies), "2023-11-14T22:13:20.000Z");
  });
});
