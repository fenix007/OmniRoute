import test from "node:test";
import assert from "node:assert/strict";
import { createChatPipelineHarness } from "../integration/_chatPipelineHarness.ts";

// Force the real dispatch guard to shed without allocating a dangerous heap.
process.env.HEAP_PRESSURE_THRESHOLD_MB = "1";
const harness = await createChatPipelineHarness("chat-heap-pressure");
const { getProviderConnectionById } = await import("../../src/lib/db/providers.ts");
const { getAllModelLockouts } = await import("../../open-sse/services/accountFallback.ts");
const { getCircuitBreaker } = await import("../../src/shared/utils/circuitBreaker.ts");
const { executeChatWithBreaker } = await import("../../src/sse/handlers/chatHelpers.ts");

test.after(() => harness.cleanup());

test("real chat heap shedding keeps both accounts healthy and never calls upstream", async () => {
  await harness.resetStorage();
  const a = await harness.seedConnection("openai", { name: "account-a" });
  const b = await harness.seedConnection("openai", { name: "account-b" });
  const snapshots = await Promise.all([a, b].map((c) => getProviderConnectionById(c.id)));
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    return harness.buildOpenAIResponse("unexpected upstream call");
  };
  // Repeated requests previously poisoned every account and opened the provider breaker.
  for (let i = 0; i < 12; i++) {
    const response = await harness.handleChat(
      harness.buildRequest({
        body: {
          model: "openai/gpt-4.1",
          stream: false,
          messages: [{ role: "user", content: "hello" }],
        },
      })
    );
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("Retry-After"), "5");
    assert.equal((await response.json()).error.code, "heap_pressure");
  }
  assert.equal(fetchCalls, 0);
  for (const original of snapshots) {
    const current = await getProviderConnectionById(original.id);
    assert.equal(current.testStatus, original.testStatus);
    assert.equal(current.rateLimitedUntil, original.rateLimitedUntil);
    assert.equal(current.lastError, original.lastError);
    assert.equal(current.backoffLevel, original.backoffLevel);
  }
  assert.equal(getCircuitBreaker("openai").getStatus().failureCount, 0);
  assert.deepEqual(getAllModelLockouts(), []);
});

test("local shedding does not count as a successful provider probe", async () => {
  const breaker = getCircuitBreaker("heap-pressure-existing-failure");
  breaker._onFailure();
  const before = breaker.getStatus().failureCount;
  const { result } = await executeChatWithBreaker({ breaker } as unknown as Parameters<
    typeof executeChatWithBreaker
  >[0]);
  assert.equal(result.errorCode, "heap_pressure");
  assert.equal(breaker.getStatus().failureCount, before);
});

test("chat combo propagates heap pressure without invoking configured global fallback", async () => {
  await harness.resetStorage();
  await harness.seedConnection("openai");
  await harness.seedConnection("claude");
  await harness.seedConnection("gemini");
  await harness.combosDb.createCombo({
    name: "local-heap-combo",
    strategy: "priority",
    models: ["openai/gpt-4.1", "claude/claude-sonnet-4", "gemini/gemini-2.5-pro"],
    config: { maxRetries: 3, fallbackDelayMs: 0 },
  });
  await harness.settingsDb.updateSettings({ globalFallbackModel: "openai/gpt-4.1" });
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    return harness.buildOpenAIResponse("unexpected fallback call");
  };
  const response = await harness.handleChat(
    harness.buildRequest({
      body: {
        model: "local-heap-combo",
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      },
    })
  );
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Retry-After"), "5");
  assert.equal((await response.json()).error.code, "heap_pressure");
  assert.equal(fetchCalls, 0);
  assert.deepEqual(getAllModelLockouts(), []);
});

test("heap pressure appearing inside dispatch does not reset degraded health or consume half-open probe", async () => {
  for (const halfOpen of [false, true]) {
    const breaker = getCircuitBreaker(`heap-pressure-late-${halfOpen}`);
    breaker._onFailure();
    if (halfOpen) {
      breaker.state = "HALF_OPEN";
      breaker.halfOpenAllowed = 1;
    }
    const before = breaker.getStatus().failureCount;
    const originalMemoryUsage = process.memoryUsage;
    let samples = 0;
    process.memoryUsage = Object.assign(
      () => ({
        ...originalMemoryUsage(),
        heapUsed: samples++ === 0 ? 0 : 4 * 1024 * 1024,
      }),
      originalMemoryUsage
    );
    try {
      const { result } = await executeChatWithBreaker({
        breaker,
        body: {},
        provider: "openai",
        model: "gpt-4.1",
        credentials: { connectionId: "test-late-pressure" },
        refreshedCredentials: {},
        proxyInfo: null,
      } as unknown as Parameters<typeof executeChatWithBreaker>[0]);
      assert.equal(result.errorCode, "heap_pressure");
      assert.equal(breaker.getStatus().failureCount, before);
      if (halfOpen) {
        assert.equal(breaker.state, "HALF_OPEN");
        assert.equal(breaker.halfOpenAllowed, 1);
      }
    } finally {
      process.memoryUsage = originalMemoryUsage;
    }
  }
});
