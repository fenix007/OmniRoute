import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-combo-heap-"));
process.env.DATA_DIR = dataDir;
process.env.API_KEY_SECRET = "combo-heap-pressure-test-secret";
const { handleComboChat } = await import("../../open-sse/services/combo.ts");
const { getComboMetrics } = await import("../../open-sse/services/comboMetrics.ts");
const { checkHeapPressureGuard } = await import("../../open-sse/utils/heapPressure.ts");
const { getAllModelLockouts, clearAllModelLockouts } =
  await import("../../open-sse/services/accountFallback.ts");
const { getAllCircuitBreakerStatuses, resetAllCircuitBreakers } =
  await import("../../src/shared/utils/circuitBreaker.ts");
const noop = () => {};
const log = { info: noop, warn: noop, debug: noop, error: noop };

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
for (const strategy of ["priority", "round-robin"]) {
  test(`${strategy}: heap pressure stops three-provider fallback without poisoning health`, async () => {
    clearAllModelLockouts();
    resetAllCircuitBreakers();
    let calls = 0;
    const result = await handleComboChat({
      body: { model: "test", messages: [{ role: "user", content: "hi" }] },
      combo: {
        name: `heap-${strategy}`,
        strategy,
        models: ["openai/gpt-4.1", "claude/claude-sonnet-4", "gemini/gemini-2.5-pro"],
        config: { maxRetries: 3, fallbackDelayMs: 0 },
      },
      handleSingleModel: async () => {
        calls++;
        return checkHeapPressureGuard(500, 400)!.response;
      },
      log,
      settings: {},
      allCombos: [],
    });
    assert.equal(result.status, 503);
    assert.equal(result.headers.get("Retry-After"), "5");
    assert.equal((await result.json()).error.code, "heap_pressure");
    assert.equal(calls, 1, "local pressure must not retry accounts, providers or whole sets");
    assert.deepEqual(getAllModelLockouts(), []);
    const metrics = getComboMetrics(`heap-${strategy}`);
    assert.deepEqual(metrics.byModel, {});
    assert.deepEqual(metrics.byTarget, {});
    assert.ok(getAllCircuitBreakerStatuses().every((b) => b.failureCount === 0));
  });
}

test("an upstream 503 still falls back to another provider", async () => {
  resetAllCircuitBreakers();
  clearAllModelLockouts();
  let calls = 0;
  const result = await handleComboChat({
    body: { model: "test", messages: [{ role: "user", content: "hi" }] },
    combo: {
      name: "heap-upstream-control",
      strategy: "priority",
      models: ["openai/gpt-4.1", "claude/claude-sonnet-4"],
      config: { maxRetries: 0, fallbackDelayMs: 0 },
    },
    handleSingleModel: async () => {
      calls++;
      return calls === 1
        ? new Response(JSON.stringify({ error: { code: "overloaded" } }), {
            status: 503,
            headers: { "Content-Type": "application/json" },
          })
        : Response.json({ choices: [{ message: { content: "recovered" } }] });
    },
    log,
    settings: {},
    allCombos: [],
  });
  assert.equal(result.status, 200);
  assert.equal(calls, 2);
});
