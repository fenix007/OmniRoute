import assert from "node:assert/strict";
import test from "node:test";

const { isLocalQueueCapacityErrorBody } =
  await import("../../open-sse/services/combo/comboPredicates.ts");
const { handleComboChat } = await import("../../open-sse/services/combo.ts");

function localQueueResponse() {
  return new Response(
    JSON.stringify({
      error: {
        message: "Local rate-limit queue wait exceeded",
        code: "RATE_LIMIT_QUEUE_TIMEOUT",
        type: "local_queue_capacity",
      },
    }),
    { status: 429, headers: { "content-type": "application/json" } }
  );
}

function createLog() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

// This base has no request-scoped/connection-cooldown predicate machinery
// (isRequestScopedUpstreamFailure, shouldSkipConnDisable arrived with a later
// 3.8.50 refactor), so the ported fix covers the classifier plus the combo and
// provider-breaker legs only.
test("a local queue capacity body is classified as local capacity", () => {
  assert.equal(
    isLocalQueueCapacityErrorBody({
      error: { code: "RATE_LIMIT_QUEUE_TIMEOUT", type: "local_queue_capacity" },
    }),
    true
  );
  assert.equal(isLocalQueueCapacityErrorBody({ error: { code: "rate_limit_exceeded" } }), false);
});

test("combo returns a local queue capacity response without retrying or rotating targets", async () => {
  let calls = 0;
  const response = await handleComboChat({
    body: { model: "openai/gpt-4" },
    combo: {
      name: `local-queue-capacity-${Math.random().toString(16).slice(2)}`,
      strategy: "priority",
      models: ["openai/gpt-4", "openai/gpt-4o-mini"],
      config: { maxRetries: 2, maxSetRetries: 1, retryDelayMs: 0, fallbackDelayMs: 0 },
    },
    handleSingleModel: async () => {
      calls += 1;
      return localQueueResponse();
    },
    isModelAvailable: async () => true,
    log: createLog() as never,
    settings: {},
    allCombos: null,
  });

  assert.equal(response.status, 429);
  assert.equal(calls, 1, "a local queue limit must not amplify into retries or fallback calls");
  const body = await response.json();
  assert.equal(body.error.code, "RATE_LIMIT_QUEUE_TIMEOUT");
  assert.equal(body.error.type, "local_queue_capacity");
});
