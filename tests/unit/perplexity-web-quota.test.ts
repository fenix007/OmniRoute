// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";

const {
  parsePerplexityRateLimits,
  fetchPerplexityRateLimits,
  __resetPerplexityRateLimitCacheForTesting,
} = await import("../../open-sse/services/perplexityQuotaFetcher.ts");
const { getUsageForProvider, USAGE_FETCHER_PROVIDERS } =
  await import("../../open-sse/services/usage.ts");
const { convertUsageToQuotaInfo } = await import("../../open-sse/services/genericQuotaFetcher.ts");
const { hasPerModelQuota } = await import("../../open-sse/services/accountFallback.ts");
const { __setTlsFetchOverrideForTesting } =
  await import("../../open-sse/services/perplexityTlsClient.ts");
const { PerplexityWebExecutor } = await import("../../open-sse/executors/perplexity-web.ts");
const { parseQuotaData } =
  await import("../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/quotaParsing.ts");
const { USAGE_SUPPORTED_PROVIDERS } = await import("../../src/shared/constants/providers.ts");

// Live /rest/rate-limit/all body for a Pro account on 2026-09-29.
const LIVE = {
  model_specific_limits: {},
  remaining_agentic_research: 0,
  remaining_labs: 25,
  remaining_pro: 193,
  remaining_research: 0,
};

function mockUpstream(rateLimitBody, { onAsk } = {}) {
  const calls = [];
  __setTlsFetchOverrideForTesting(async (url, opts) => {
    calls.push({ url, opts });
    if (url.includes("/rest/rate-limit/all")) {
      return {
        status: rateLimitBody ? 200 : 403,
        headers: new Headers(),
        text: rateLimitBody ? JSON.stringify(rateLimitBody) : "<html>Just a moment...</html>",
        body: null,
      };
    }
    return onAsk(url, opts);
  });
  return calls;
}

test.beforeEach(() => __resetPerplexityRateLimitCacheForTesting());

test("parses the live rate-limit body", () => {
  const limits = parsePerplexityRateLimits(LIVE);
  assert.equal(limits.pro, 193);
  assert.equal(limits.research, 0);
  assert.equal(limits.labs, 25);
  assert.equal(limits.agenticResearch, 0);
  assert.equal(parsePerplexityRateLimits({ unrelated: 1 }), null);
});

test("fetch sends the session cookie with browser headers and caches per connection", async () => {
  const calls = mockUpstream(LIVE);
  await fetchPerplexityRateLimits("conn-1", { apiKey: "cookie" });
  await fetchPerplexityRateLimits("conn-1", { apiKey: "cookie" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.headers.Cookie, "__Secure-next-auth.session-token=cookie");
  assert.equal(calls[0].opts.headers["Sec-Fetch-Site"], "same-origin");
  await fetchPerplexityRateLimits("conn-1", { apiKey: "cookie" }, { forceRefresh: true });
  assert.equal(calls.length, 2);
});

test("Cloudflare challenge / failure fails open with null", async () => {
  mockUpstream(null);
  assert.equal(await fetchPerplexityRateLimits("conn-2", { apiKey: "cookie" }), null);
});

test("usage exposes remaining counts that the generic preflight ignores", async () => {
  assert.ok(USAGE_FETCHER_PROVIDERS.includes("perplexity-web"));
  assert.ok(USAGE_SUPPORTED_PROVIDERS.includes("perplexity-web"));
  mockUpstream(LIVE);
  const usage = await getUsageForProvider({
    id: "conn-3",
    provider: "perplexity-web",
    apiKey: "cookie",
  });
  assert.equal(usage.quotas.deep_research.remaining, 0);
  assert.equal(usage.quotas.pro_search.remaining, 193);
  assert.equal(usage.quotas.deep_research.displayName, "Deep Research");
  // No measurable windows → preflight cannot park the whole account on research=0.
  assert.equal(convertUsageToQuotaInfo(usage), null);
});

test("limits card renders the counters as whole-number counts", () => {
  const rows = parseQuotaData("perplexity-web", {
    quotas: {
      deep_research: { remaining: 0, displayName: "Deep Research", countUnit: "queries" },
      pro_search: { remaining: 193, displayName: "Pro Search", countUnit: "queries" },
    },
  });
  const research = rows.find((r) => r.name === "deep_research");
  assert.equal(research.creditCount, 0);
  assert.equal(research.countUnit, "queries");
  assert.equal(research.remainingPercentage, 0);
  assert.equal(rows.find((r) => r.name === "pro_search").creditCount, 193);
});

test("deep research on an exhausted account returns 429 without calling Perplexity", async () => {
  let asked = 0;
  mockUpstream(LIVE, {
    onAsk: () => {
      asked += 1;
      throw new Error("must not be called");
    },
  });
  const { response } = await new PerplexityWebExecutor().execute({
    model: "pplx-deep-research",
    body: { messages: [{ role: "user", content: "q" }], stream: true },
    stream: true,
    credentials: { apiKey: "cookie", connectionId: "conn-4" },
    signal: AbortSignal.timeout(5000),
    log: null,
  });
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error.code, "quota_exhausted");
  assert.equal(asked, 0);
});

test("unknown research quota fails open and reaches Perplexity", async () => {
  let asked = 0;
  mockUpstream(null, {
    onAsk: () => {
      asked += 1;
      return { status: 502, headers: new Headers(), text: "down", body: null };
    },
  });
  await new PerplexityWebExecutor().execute({
    model: "pplx-deep-research",
    body: { messages: [{ role: "user", content: "q" }], stream: false },
    stream: false,
    credentials: { apiKey: "cookie", connectionId: "conn-5" },
    signal: AbortSignal.timeout(5000),
    log: null,
  });
  assert.equal(asked, 1);
});

test("perplexity-web failures lock the model, not the connection", () => {
  assert.equal(hasPerModelQuota("perplexity-web", "pplx-deep-research"), true);
});
