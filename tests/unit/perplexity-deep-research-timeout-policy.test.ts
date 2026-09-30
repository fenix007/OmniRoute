import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-pplx-deep-timeout-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const resilienceSettings = await import("../../src/lib/resilience/settings.ts");
const rateLimitManager = await import("../../open-sse/services/rateLimitManager.ts");
const { PerplexityWebExecutor } = await import("../../open-sse/executors/perplexity-web.ts");
const { getExecutorTimeoutMs } =
  await import("../../open-sse/handlers/chatCore/upstreamTimeouts.ts");
const { resolveModelRequestBudgetMs } =
  await import("../../open-sse/config/modelRequestBudgets.ts");

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function useShortGlobalBudget(connectionId: string) {
  await rateLimitManager.applyRequestQueueSettings({
    ...resilienceSettings.DEFAULT_RESILIENCE_SETTINGS.requestQueue,
    autoEnableApiKeyProviders: false,
    concurrentRequests: 1,
    requestsPerMinute: 100000,
    minTimeBetweenRequestsMs: 0,
    maxWaitMs: 40,
  });
  rateLimitManager.enableRateLimitProtection(connectionId);
}

test.afterEach(async () => {
  await rateLimitManager.__resetRateLimitManagerForTests();
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("Deep Research completes beyond the ordinary request-queue budget", async () => {
  await useShortGlobalBudget("conn-deep");

  const result = await rateLimitManager.withRateLimit(
    "perplexity-web",
    "conn-deep",
    "pplx-deep-research",
    async () => {
      await wait(400);
      return "ok";
    }
  );

  assert.equal(result, "ok");
});

test("the Deep Research budget is isolated from other providers and Perplexity models", async (t) => {
  for (const [provider, model] of [
    ["perplexity-web", "pplx-auto"],
    ["openai", "pplx-deep-research"],
  ]) {
    await t.test(`${provider}/${model}`, async () => {
      const connectionId = `conn-${provider}-${model}`;
      await useShortGlobalBudget(connectionId);

      await assert.rejects(
        rateLimitManager.withRateLimit(provider, connectionId, model, async () => {
          await wait(400);
          return "late";
        }),
        (error: Error & { code?: string }) => {
          assert.equal(error.code, "RATE_LIMIT_QUEUE_TIMEOUT");
          assert.match(error.message, /scheduling\/execution budget/i);
          return true;
        }
      );
    });
  }
});

test("Deep Research keeps the exact 15-minute upstream-start budget", () => {
  const executor = new PerplexityWebExecutor();

  assert.equal(resolveModelRequestBudgetMs("perplexity-web", "pplx-deep-research", 40), 900_000);
  assert.equal(resolveModelRequestBudgetMs("perplexity-web", "pplx-auto", 40), 40);
  assert.equal(resolveModelRequestBudgetMs("openai", "pplx-deep-research", 40), 40);
  assert.equal(getExecutorTimeoutMs(executor, "pplx-deep-research"), 900_000);
  assert.equal(
    getExecutorTimeoutMs(executor, "pplx-auto"),
    getExecutorTimeoutMs({ getTimeoutMs: () => executor.getTimeoutMs() }, "pplx-auto")
  );
});

test("caller abort interrupts a Deep Research rate-limit job before its extended budget", async () => {
  await useShortGlobalBudget("conn-deep-abort");
  const controller = new AbortController();
  const abortReason = new Error("caller disconnected");
  const startedAt = Date.now();

  const request = rateLimitManager.withRateLimit(
    "perplexity-web",
    "conn-deep-abort",
    "pplx-deep-research",
    () =>
      new Promise((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
          once: true,
        });
      }),
    controller.signal
  );
  setTimeout(() => controller.abort(abortReason), 20);

  await assert.rejects(request, (error) => error === abortReason);
  assert.ok(Date.now() - startedAt < 300, "abort should not wait for the extended model budget");
});
