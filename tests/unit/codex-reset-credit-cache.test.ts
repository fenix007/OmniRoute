import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getCachedCodexResetCredits,
  setCachedCodexResetCredits,
} from "../../src/lib/usage/codexResetCreditCache.ts";

test("reset-credit snapshots expire exactly at the 15-minute TTL", (t) => {
  const startedAt = Date.parse("2026-09-18T12:00:00Z");
  t.mock.timers.enable({ apis: ["Date"], now: startedAt });
  t.after(() => setCachedCodexResetCredits("ttl-test", null));
  const snapshot = { availableCount: 1, credits: [{ expiresAt: null }] };
  setCachedCodexResetCredits("ttl-test", snapshot);
  t.mock.timers.setTime(startedAt + 15 * 60_000 - 1);
  assert.equal(getCachedCodexResetCredits("ttl-test"), snapshot);
  t.mock.timers.setTime(startedAt + 15 * 60_000);
  assert.equal(getCachedCodexResetCredits("ttl-test"), null);
  setCachedCodexResetCredits("ttl-test", snapshot);
  assert.equal(getCachedCodexResetCredits("ttl-test"), snapshot);
});

test("clearing or replacing one account preserves other cached accounts", (t) => {
  for (const id of ["credit-a", "credit-b"]) t.after(() => setCachedCodexResetCredits(id, null));
  const empty = { availableCount: 0, credits: [] };
  const full = { availableCount: 1, credits: [{ expiresAt: "2026-09-19T00:00:00Z" }] };
  setCachedCodexResetCredits("credit-a", empty);
  setCachedCodexResetCredits("credit-b", full);
  assert.equal(getCachedCodexResetCredits("credit-a"), empty);
  setCachedCodexResetCredits("credit-a", full);
  assert.equal(getCachedCodexResetCredits("credit-a"), full);
  setCachedCodexResetCredits("credit-a", null);
  assert.equal(getCachedCodexResetCredits("credit-a"), null);
  assert.equal(getCachedCodexResetCredits("credit-b"), full);
});
