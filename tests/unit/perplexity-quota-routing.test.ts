import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pplx-quota-routing-"));
process.env.DATA_DIR = dataDir;
process.env.API_KEY_SECRET = "pplx-quota-routing-test";

const core = await import("../../src/lib/db/core.ts");
const db = await import("../../src/lib/db/providers.ts");
const quotaCache = await import("../../src/domain/quotaCache.ts");
const { getProviderCredentials } = await import("../../src/sse/services/auth.ts");
const { __setTlsFetchOverrideForTesting } =
  await import("../../open-sse/services/perplexityTlsClient.ts");
const { __resetPerplexityRateLimitCacheForTesting, invalidatePerplexityRateLimits } =
  await import("../../open-sse/services/perplexityQuotaFetcher.ts");

const limits = new Map<string, { research: number | null; pro: number }>();
let quotaFetches = 0;

test.beforeEach(() => {
  core.resetDbInstance();
  quotaCache.__clearForTests();
  __resetPerplexityRateLimitCacheForTesting();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  limits.clear();
  quotaFetches = 0;
  __setTlsFetchOverrideForTesting(async (url, options) => {
    assert.ok(url.includes("/rest/rate-limit/all"), "selection must not run a research query");
    quotaFetches++;
    const key = options.headers.Cookie?.split("=")[1];
    const quota = limits.get(key);
    return {
      status: quota ? 200 : 503,
      headers: new Headers(),
      text: quota
        ? JSON.stringify({
            remaining_research: quota.research,
            remaining_pro: quota.pro,
            remaining_labs: 25,
            remaining_agentic_research: 0,
          })
        : "unavailable",
      body: null,
    };
  });
});

test.after(() => {
  __setTlsFetchOverrideForTesting(null);
  core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function account(priority: number, research: number | null, pro = 100) {
  const key = `test-cookie-${priority}`;
  limits.set(key, { research, pro });
  return (await db.createProviderConnection({
    provider: "perplexity-web",
    authType: "apikey",
    name: `test-${priority}`,
    apiKey: key,
    priority,
    isActive: true,
    testStatus: "active",
  })) as { id: string };
}

const select = (model = "pplx-deep-research") =>
  getProviderCredentials("perplexity-web", null, null, model);

test("first selection skips four exhausted accounts and picks the fifth with Deep Research quota", async () => {
  for (let i = 1; i <= 4; i++) await account(i, 0);
  const ready = await account(5, 1, 0);
  assert.equal((await select()).connectionId, ready.id);
  assert.equal(quotaFetches, 5);
  assert.equal((await select()).connectionId, ready.id);
  assert.equal(quotaFetches, 5, "fresh counters are shared with subsequent selections");
});

test("Deep Research exhaustion does not exclude an account from Pro Search", async () => {
  const pro = await account(1, 0, 100);
  const research = await account(2, 3, 0);
  assert.equal((await select()).connectionId, research.id);
  assert.equal((await select("pplx-auto")).connectionId, pro.id);
  assert.equal((await select("pplx-sonar")).connectionId, pro.id);
});

test("known available quota takes priority over an unknown counter", async () => {
  await account(1, null);
  const ready = await account(2, 1);
  assert.equal((await select()).connectionId, ready.id);
});

test("unavailable quota endpoint remains a fallback when no known account can serve", async () => {
  const unknown = await account(1, 0);
  limits.delete("test-cookie-1");
  await account(2, 0);
  assert.equal((await select()).connectionId, unknown.id);
});

test("all exhausted returns model-scoped 429 without disabling accounts", async () => {
  const first = await account(1, 0);
  await account(2, 0);
  const result = await select();
  assert.equal(result.allRateLimited, true);
  assert.equal(result.lastErrorCode, 429);
  assert.equal(result.cooldownScope, "model");
  assert.equal(result.cooldownModel, "pplx-deep-research");
  assert.match(result.lastError, /pplx-deep-research/);
  assert.equal((await select("pplx-auto")).connectionId, first.id);
  assert.ok(
    (await db.getProviderConnections({ provider: "perplexity-web" })).every((c) => c.isActive)
  );
});

test("reset counters are refreshed after the short cache TTL", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const recovered = await account(1, 0);
  assert.equal((await select()).allRateLimited, true);
  limits.set("test-cookie-1", { research: 2, pro: 100 });
  t.mock.timers.tick(60_001);
  assert.equal((await select()).connectionId, recovered.id);
  assert.equal(quotaFetches, 2);
});

test("consumption invalidation makes the next selection use another account", async () => {
  const first = await account(1, 1);
  const second = await account(2, 2);
  assert.equal((await select()).connectionId, first.id);
  limits.set("test-cookie-1", { research: 0, pro: 100 });
  invalidatePerplexityRateLimits(first.id);
  assert.equal((await select()).connectionId, second.id);
});

test("stale aggregate snapshots cannot veto fresh model availability", async () => {
  const ready = await account(1, 1, 0);
  quotaCache.markAccountExhaustedFrom429(ready.id, "perplexity-web");
  assert.equal((await select()).connectionId, ready.id);
});

test("model quota never bypasses API-key connection restrictions or forced account", async () => {
  const exhausted = await account(1, 0);
  await account(2, 5);
  const restricted = await getProviderCredentials(
    "perplexity-web",
    null,
    [exhausted.id],
    "pplx-deep-research"
  );
  assert.equal(restricted.allRateLimited, true);
  assert.equal(quotaFetches, 1);
  const forced = await getProviderCredentials("perplexity-web", null, null, "pplx-deep-research", {
    forcedConnectionId: exhausted.id,
  });
  assert.equal(forced.allRateLimited, true);
});

test("unknown models keep existing routing without querying unrelated quota", async () => {
  const ready = await account(1, 0, 0);
  assert.equal((await select("custom-model")).connectionId, ready.id);
  assert.equal(quotaFetches, 0);
});
