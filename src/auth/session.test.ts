import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sessionProbeResult } from "./session.js";

describe("sessionProbeResult", () => {
  it("rejects SSO redirect", () => {
    const result = sessionProbeResult("https://sso.unc.edu/shibboleth", false);
    assert.equal(result.valid, false);
    assert.match(result.message, /npm run login/);
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
