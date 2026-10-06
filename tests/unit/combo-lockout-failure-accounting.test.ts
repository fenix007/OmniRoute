// A combo target whose same-model retry is skipped because of a model lockout still
// failed: it must count as an attempt and become the final error, otherwise the
// diagnostics report `attempted: 1` and blame only the first target.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-combo-lockout-accounting-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "test-combo-lockout-accounting";

const core = await import("../../src/lib/db/core.ts");
const { handleComboChat } = await import("../../open-sse/services/combo.ts");
const { clearAllModelLockouts, recordModelLockoutFailure } = await import(
  "../../open-sse/services/accountFallback.ts"
);
const { createErrorResult } = await import("../../open-sse/utils/error.ts");
const { EMPTY_RESPONSE_RETRY_EXHAUSTED } = await import(
  "../../open-sse/services/combo/emptyResponseRetryBudget.ts"
);

const log = { info() {}, warn() {}, error() {}, debug() {} };
const PRIMARY = "codex/gpt-6.1-sol-high";
const FALLBACK = "openai/gpt-6.1-sol";
const settings = {
  modelLockout: {
    enabled: true,
    errorCodes: [502],
    baseCooldownMs: 3000,
    maxCooldownMs: 60_000,
    maxBackoffSteps: 10,
    useExponentialBackoff: true,
  },
};

test.beforeEach(() => clearAllModelLockouts());
test.after(() => {
  clearAllModelLockouts();
  try {
    core.resetDbInstance();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  } catch {}
});

async function runCombo(lockFallbackDuringRequest: boolean) {
  const calls: string[] = [];
  const response = await handleComboChat({
    body: { messages: [{ role: "user", content: "hi" }] },
    combo: {
      name: "lockout-accounting",
      strategy: "priority",
      models: [PRIMARY, FALLBACK],
      config: { maxRetries: 2, retryDelayMs: 0, fallbackDelayMs: 0, failoverBeforeRetry: false },
    },
    handleSingleModel: async (_body: unknown, model: string) => {
      calls.push(model);
      if (model === PRIMARY) {
        return createErrorResult(
          502,
          `[${PRIMARY}] returned empty output on 3 attempts; stopping retries for this provider/model`,
          null,
          EMPTY_RESPONSE_RETRY_EXHAUSTED
        ).response;
      }
      // Production shape: the single-model path locks the model before returning.
      if (lockFallbackDuringRequest) {
        recordModelLockoutFailure("openai", "", "gpt-6.1-sol", "server_error", 502, 3000);
      }
      return createErrorResult(502, "Model gpt-6.1-sol server_error").response;
    },
    isModelAvailable: async () => true,
    log,
    settings,
    allCombos: [],
  });
  return { response, calls };
}

for (const [label, lockFallbackDuringRequest] of [
  ["lockout recorded by the combo loop", false],
  ["lockout already active after the attempt", true],
] as const) {
  test(`lockout-skipped fallback failure is counted in diagnostics (${label})`, async () => {
    const { response, calls } = await runCombo(lockFallbackDuringRequest);

    assert.deepEqual(calls, [PRIMARY, FALLBACK], "fallback runs once, retry skipped by lockout");
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("x-omniroute-combo-attempted"), "2");
    const body = await response.json();
    assert.equal(body.diagnostics.poolSize, 2);
    assert.equal(body.diagnostics.attempted, 2);
    assert.match(body.error.message, /gpt-6\.1-sol server_error/);
  });
}
