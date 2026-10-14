import "../_setup/isolateDataDir.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import * as manager from "../../open-sse/services/rateLimitManager.ts";
import { __setProviderDefaultRateLimitsForTests } from "../../open-sse/services/providerDefaultRateLimit.ts";
import { closeDbInstance } from "../../src/lib/db/core.ts";
let seq = 0;
function connection() {
  const id = `abort-dispatch-${++seq}`;
  manager.enableRateLimitProtection(id);
  manager.refreshConnectionRateLimits(id, { maxConcurrent: 1, minTime: 0 });
  return id;
}
async function until(fn: () => boolean) {
  for (let i = 0; i < 1000; i++) {
    if (fn()) return;
    await delay(5);
  }
  assert.fail("limiter did not reach expected state");
}
test.afterEach(async () => {
  __setProviderDefaultRateLimitsForTests(null);
  await manager.__resetRateLimitManagerForTests();
});
test.after(() => closeDbInstance());
for (const provider of ["codex", "kiro", "gemini"]) {
  test(`${provider}: abort in provider-slot await never schedules callback`, async () => {
    const id = connection();
    const c = new AbortController();
    let calls = 0;
    const pending = manager.withRateLimit(
      provider,
      id,
      null,
      async () => {
        calls++;
      },
      c.signal
    );
    c.abort();
    await assert.rejects(pending, (e) => e === c.signal.reason);
    await delay(30);
    assert.equal(calls, 0);
    assert.equal(manager.getRateLimitStatus(provider, id).active, false);
    assert.equal(getEventListeners(c.signal, "abort").length, 0);
  });
}
for (const reason of [new Error("disconnect"), Object.freeze(new Error("frozen")), "cancel", 42]) {
  test(`queued abort preserves immutable reason: ${String(reason)}`, async () => {
    const id = connection();
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const held = manager.withRateLimit("kiro", id, null, async () => {
      entered.resolve();
      await gate.promise;
    });
    await entered.promise;
    const c = new AbortController();
    let calls = 0;
    const pending = manager.withRateLimit(
      "kiro",
      id,
      null,
      async () => {
        calls++;
      },
      c.signal
    );
    const assertion = assert.rejects(pending, (e) => {
      if (reason instanceof Error) return e === reason && e.name === "Error";
      return e instanceof Error && e.name === "AbortError" && e.cause === reason;
    });
    try {
      await until(() => manager.getRateLimitStatus("kiro", id).queued === 1);
      c.abort(reason);
      await assertion;
    } finally {
      gate.resolve();
      await held;
    }
    await until(
      () =>
        manager.getRateLimitStatus("kiro", id).running === 0 &&
        manager.getRateLimitStatus("kiro", id).queued === 0
    );
    assert.equal(calls, 0);
    assert.equal(getEventListeners(c.signal, "abort").length, 0);
  });
}
test("provider-default wait preserves frozen abort reason and cleans listener", async () => {
  __setProviderDefaultRateLimitsForTests({ kiro: { requests: 1, windowMs: 1000 } });
  const id = connection();
  await manager.withRateLimit("kiro", id, null, async () => {});
  const c = new AbortController();
  const reason = Object.freeze(new Error("window cancel"));
  let calls = 0;
  const p = manager.withRateLimit(
    "kiro",
    id,
    null,
    async () => {
      calls++;
    },
    c.signal
  );
  c.abort(reason);
  await assert.rejects(p, (e) => e === reason);
  assert.equal(calls, 0);
  assert.equal(getEventListeners(c.signal, "abort").length, 0);
});

for (const timeout of [false, true]) {
  test(`queued default/timeout DOMException rejects without listener exception (${timeout})`, async () => {
    const id = connection();
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const held = manager.withRateLimit("codex", id, null, async () => {
      entered.resolve();
      await gate.promise;
    });
    await entered.promise;
    const c = new AbortController();
    const signal = timeout ? AbortSignal.timeout(2000) : c.signal;
    let calls = 0;
    const pending = manager.withRateLimit(
      "codex",
      id,
      null,
      async () => {
        calls++;
      },
      signal
    );
    const assertion = assert.rejects(pending, (e) => e === signal.reason);
    try {
      await until(() => manager.getRateLimitStatus("codex", id).queued === 1);
      if (!timeout) c.abort();
      await assertion;
    } finally {
      gate.resolve();
      await held;
    }
    await until(
      () =>
        manager.getRateLimitStatus("codex", id).running === 0 &&
        manager.getRateLimitStatus("codex", id).queued === 0
    );
    assert.equal(calls, 0);
    assert.equal(getEventListeners(signal, "abort").length, 0);
  });
}

test("already running work retains cooperative abort and releases slot", async () => {
  const id = connection();
  const c = new AbortController();
  const entered = Promise.withResolvers<void>();
  const pending = manager.withRateLimit(
    "gemini",
    id,
    null,
    () =>
      new Promise((_, reject) => {
        c.signal.addEventListener("abort", () => reject(c.signal.reason), { once: true });
        entered.resolve();
      }),
    c.signal
  );
  const reason = Object.freeze(new Error("running disconnect"));
  const assertion = assert.rejects(pending, (e) => e === reason);
  await entered.promise;
  c.abort(reason);
  await assertion;
  await until(() => manager.getRateLimitStatus("gemini", id).running === 0);
  assert.equal(getEventListeners(c.signal, "abort").length, 0);
  assert.equal(await manager.withRateLimit("gemini", id, null, async () => "next"), "next");
});

test("original aborted Error reason is classified as local cancellation", async () => {
  const { classifyLocalAbortFailure } = await import("../../src/sse/handlers/chatPredicates.ts");
  for (const reason of [
    Object.freeze(new Error("disconnect")),
    new DOMException("deadline", "TimeoutError"),
    new DOMException("aborted", "AbortError"),
  ]) {
    assert.deepEqual(classifyLocalAbortFailure(reason, true, reason), {
      status: 499,
      message: "Request aborted",
    });
    if (reason.name !== "AbortError")
      assert.equal(classifyLocalAbortFailure(reason, false, reason), null);
  }
  assert.equal(
    classifyLocalAbortFailure(new Error("upstream failure"), true, new Error("other")),
    null
  );
});
