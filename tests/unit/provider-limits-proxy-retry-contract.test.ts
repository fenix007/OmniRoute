import assert from "node:assert/strict";
import test from "node:test";
import { fetchQuotaWithProxyRetry } from "../../src/lib/usage/providerLimits/proxyRetry.ts";

const connection = Object.freeze({ id: "quota-contract", provider: "claude", authType: "oauth" });
const proxy = Object.freeze({ host: "proxy.invalid", port: 8080 });

test("successful quota fetch preserves the result and supplied proxy", async () => {
  const result = { usage: { quotas: { session: { remaining: 3 } } } };
  const seen: unknown[] = [];
  const actual = await fetchQuotaWithProxyRetry(connection, { proxy }, true, async (config) => {
    seen.push(config);
    return result;
  });
  assert.equal(actual, result);
  assert.deepEqual(seen, [proxy]);
});

for (const failure of [
  new Error("fetch failed"),
  Object.freeze({ code: "PROXY_UNREACHABLE", message: "proxy unavailable" }),
  { cause: { code: "ECONNREFUSED" } },
]) {
  test(`account proxy preserves thrown network error identity: ${JSON.stringify(failure)}`, async () => {
    const seen: unknown[] = [];
    await assert.rejects(
      fetchQuotaWithProxyRetry(connection, { proxy }, true, async (config) => {
        seen.push(config);
        throw failure;
      }),
      (error) => error === failure
    );
    assert.deepEqual(seen, [proxy]);
  });
}

test("shared proxy retries a thrown network failure directly once", async () => {
  const seen: unknown[] = [];
  const result = { usage: { plan: "pro" } };
  assert.equal(
    await fetchQuotaWithProxyRetry(connection, { proxy }, false, async (config) => {
      seen.push(config);
      if (config) throw new Error("fetch failed");
      return result;
    }),
    result
  );
  assert.deepEqual(seen, [proxy, null]);
});

test("account proxy rejects a returned network error with 503 and no direct request", async () => {
  const seen: unknown[] = [];
  await assert.rejects(
    fetchQuotaWithProxyRetry(connection, { proxy }, true, async (config) => {
      seen.push(config);
      return { usage: { message: "fetch failed" } };
    }),
    (error: Error & { status: number }) => error.status === 503 && error.message === "fetch failed"
  );
  assert.deepEqual(seen, [proxy]);
});

test("shared proxy retries a returned network error and preserves direct failure", async () => {
  const seen: unknown[] = [];
  const failure = Object.freeze(new Error("direct unavailable"));
  await assert.rejects(
    fetchQuotaWithProxyRetry(connection, { proxy }, false, async (config) => {
      seen.push(config);
      if (config) return { usage: { message: "ECONNREFUSED" } };
      throw failure;
    }),
    (error) => error === failure
  );
  assert.deepEqual(seen, [proxy, null]);
});

for (const suppliedProxy of [null, { proxy }]) {
  test(`non-network failures are not retried: proxy=${Boolean(suppliedProxy)}`, async () => {
    const failure = Object.freeze(new Error("upstream unauthorized"));
    let calls = 0;
    await assert.rejects(
      fetchQuotaWithProxyRetry(connection, suppliedProxy, false, async () => {
        calls++;
        throw failure;
      }),
      (error) => error === failure
    );
    assert.equal(calls, 1);
  });
}
