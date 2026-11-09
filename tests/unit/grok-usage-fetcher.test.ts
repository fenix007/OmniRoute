import test from "node:test";
import assert from "node:assert/strict";
import { buildGrokQuotas, getGrokUsage } from "../../open-sse/services/usage/grok.ts";
import { parseQuotaData } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/quotaParsing.ts";
import { shouldShowQuotaUsageCount } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.tsx";
import { USAGE_SUPPORTED_PROVIDERS } from "../../src/shared/constants/providers.ts";
import { getUsageForProvider, USAGE_FETCHER_PROVIDERS } from "../../open-sse/services/usage.ts";

const now = Date.parse("2026-11-09T12:00:00Z");
const period = {
  type: "USAGE_PERIOD_TYPE_WEEKLY",
  start: "2026-11-08T09:57:06Z",
  end: "2026-11-15T09:57:06Z",
};
const originalFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

for (const used of [0, 42.5, 100]) {
  test(`Grok weekly quota: ${used}% used`, () => {
    const q = buildGrokQuotas(
      { config: { creditUsagePercent: used, currentPeriod: period } },
      now
    ).weekly;
    assert.equal(q.remainingPercentage, 100 - used);
    assert.equal(q.resetAt, "2026-11-15T09:57:06.000Z");
    assert.equal(q.unlimited, false);
  });
}
test("protobuf omitted zero requires an active weekly period", () => {
  for (const value of [undefined, null]) {
    assert.equal(
      buildGrokQuotas({ config: { creditUsagePercent: value, currentPeriod: period } }, now).weekly
        .remainingPercentage,
      100
    );
  }
  for (const config of [
    {},
    { currentPeriod: { ...period, type: "MONTHLY" } },
    { currentPeriod: { ...period, start: "invalid" } },
    { currentPeriod: { ...period, end: "2026-11-09T00:00:00Z" } },
    { currentPeriod: { ...period, start: "2026-11-10T00:00:00Z" } },
    ...[-1, 101, "50"].map((creditUsagePercent) => ({ currentPeriod: period, creditUsagePercent })),
  ]) {
    assert.deepEqual(buildGrokQuotas({ config }, now), {});
  }
});
test("Grok quota UI uses a percentage, never a fabricated request count", () => {
  const quotas = buildGrokQuotas(
    { config: { currentPeriod: period, creditUsagePercent: 25 } },
    now
  );
  for (const provider of ["xai-oauth", "grok-cli"]) {
    const parsed = parseQuotaData(provider, { quotas });
    // Keep reset in the future regardless of when this regression runs.
    const row = parseQuotaData(provider, {
      quotas: { weekly: { ...quotas.weekly, resetAt: null } },
    })[0];
    assert.equal(parsed.length, 1);
    assert.equal(row.remainingPercentage, 75);
    assert.equal(row.isPercentageOnly, true);
    assert.equal(shouldShowQuotaUsageCount(row), false);
    assert.ok(USAGE_SUPPORTED_PROVIDERS.includes(provider));
    assert.ok(USAGE_FETCHER_PROVIDERS.includes(provider as "xai-oauth"));
  }
});
test("OAuth dispatcher uses CLI billing and preserves quota if settings fail", async () => {
  const calls: string[] = [];
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-token");
    assert.equal(new Headers(init?.headers).get("X-XAI-Token-Auth"), "xai-grok-cli");
    if (String(url).endsWith("/settings")) throw new Error("offline");
    return Response.json({
      config: {
        currentPeriod: {
          ...period,
          start: new Date(Date.now() - 1000).toISOString(),
          end: new Date(Date.now() + 100000).toISOString(),
        },
        creditUsagePercent: 30,
      },
    });
  };
  const result = await getUsageForProvider({ provider: "xai-oauth", accessToken: "test-token" });
  assert.equal(
    (result as { quotas: { weekly: { remainingPercentage: number } } }).quotas.weekly
      .remainingPercentage,
    70
  );
  assert.equal(calls[0], "https://cli-chat-proxy.grok.com/v1/billing?format=credits");
});
test("Grok failures return safe unavailable messages without secrets", async () => {
  for (const status of [401, 403, 429, 500]) {
    globalThis.fetch = async () => new Response("secret upstream body", { status });
    const result = await getGrokUsage("secret-token");
    assert.ok(result.message);
    assert.equal(JSON.stringify(result).includes("secret"), false);
    assert.equal("quotas" in result, false);
  }
  globalThis.fetch = async () => {
    throw new Error("secret-token");
  };
  assert.equal(JSON.stringify(await getGrokUsage("secret-token")).includes("secret"), false);
  globalThis.fetch = async () => Response.json({ config: {} });
  const result = await getGrokUsage("test-token");
  assert.deepEqual(result.quotas, {});
  assert.ok(result.message);
});
