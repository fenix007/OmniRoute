// Creating a session pin is a *first* selection, so it must obey the provider's
// configured account strategy. It did not: `selectSessionAffinityConnection`
// always minted new pins with its own LRU comparator, so on production every
// codex selection came from affinity (pin reuse or LRU pin creation) and the
// configured `quota-deadline` strategy effectively never ran.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-affinity-new-pin-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "affinity-new-pin-test-secret";

const core = await import("../../src/lib/db/core.ts");
const affinityDb = await import("../../src/lib/db/sessionAccountAffinity.ts");
const pin = await import("../../src/sse/services/sessionAffinityPin.ts");

const PROVIDER = "codex";
const TTL = 30 * 60_000;

const LRU_WINNER = {
  id: "conn-idle-longest",
  lastUsedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
  consecutiveUseCount: 1,
  priority: 1,
};
const STRATEGY_WINNER = {
  id: "conn-deadline-urgent",
  lastUsedAt: new Date(Date.now() - 60_000).toISOString(),
  consecutiveUseCount: 1,
  priority: 2,
};
const POOL = [LRU_WINNER, STRATEGY_WINNER];

test.beforeEach(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("a new pin comes from the strategy, not the LRU fallback", async () => {
  const selected = await pin.selectSessionAffinityConnection(
    PROVIDER,
    "session-new-pin",
    POOL,
    TTL,
    (candidates) => candidates.find((candidate) => candidate.id === STRATEGY_WINNER.id) ?? null
  );

  assert.equal(selected?.id, STRATEGY_WINNER.id);
  assert.equal(
    affinityDb.getSessionAccountAffinity("session-new-pin", PROVIDER, TTL)?.connectionId,
    STRATEGY_WINNER.id,
    "the pin must record the strategy's pick so the session keeps following it"
  );
});

test("without a strategy the LRU fallback still mints the pin", async () => {
  const selected = await pin.selectSessionAffinityConnection(
    PROVIDER,
    "session-lru-pin",
    POOL,
    TTL
  );

  assert.equal(selected?.id, LRU_WINNER.id);
});

test("a strategy that rejects the whole pool creates no pin", async () => {
  const selected = await pin.selectSessionAffinityConnection(
    PROVIDER,
    "session-rejected",
    POOL,
    TTL,
    () => null
  );

  assert.equal(selected, null, "the caller must surface the strategy's own error");
  assert.equal(
    affinityDb.getSessionAccountAffinity("session-rejected", PROVIDER, TTL),
    null,
    "a rejected pool must not leave a pin behind"
  );
});

test("an existing pin is still reused without consulting the strategy", async () => {
  affinityDb.upsertSessionAccountAffinity(
    "session-pinned",
    PROVIDER,
    LRU_WINNER.id,
    Date.now(),
    TTL
  );

  let strategyCalls = 0;
  const selected = await pin.selectSessionAffinityConnection(
    PROVIDER,
    "session-pinned",
    POOL,
    TTL,
    (candidates) => {
      strategyCalls += 1;
      return candidates.find((candidate) => candidate.id === STRATEGY_WINNER.id) ?? null;
    }
  );

  assert.equal(selected?.id, LRU_WINNER.id);
  assert.equal(strategyCalls, 0, "pin reuse must stay a cheap lookup");
});
