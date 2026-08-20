import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  recordProviderFailure,
  clearProviderFailure,
  isProviderInCooldown,
} from "../../open-sse/services/accountFallback.ts";
import { PROVIDER_PROFILES } from "../../open-sse/config/constants.ts";

// Network-layer errors and OmniRoute's own queue timeouts must NOT trip the
// provider circuit breaker. These are not provider failures — the provider never
// saw the request, so it may be perfectly healthy while only the network path is
// broken (single-model path; the combo same-provider dead-proxy case is #8376's
// contract and stays untouched).
test("chat.ts keeps network and queue-capacity codes out of the provider breaker", () => {
  // The predicate this fix guards lives inline in chat.ts on this base (upstream
  // extracted it into chatPredicates.ts in a later 3.8.50 refactor), so assert on
  // the guard at its dispatch site.
  const src = fs.readFileSync(new URL("../../src/sse/handlers/chat.ts", import.meta.url), "utf8");
  for (const code of ["proxy_unreachable", "RATE_LIMIT_QUEUE_TIMEOUT", "RATE_LIMIT_QUEUE_WEDGED"]) {
    assert.match(
      src,
      new RegExp(`result\\.errorCode !== "${code}"`),
      `${code} must be excluded from the provider-breaker trip`
    );
  }
  assert.match(
    src,
    /!isNetworkError &&\s*\n\s*!isQueueTimeout/,
    "the allRateLimited breaker trip must skip network errors and queue timeouts"
  );
});

test("queue-timeout recordProviderFailure never opens the provider breaker", () => {
  // Control first: that many real failures WOULD open the breaker — proving the
  // isQueueTimeout flag, not an inert provider, is what keeps it closed.
  const control = "test-qt-control-provider";
  clearProviderFailure(control);
  const threshold = PROVIDER_PROFILES.apikey.circuitBreakerThreshold;
  for (let i = 0; i < threshold; i++) {
    recordProviderFailure(control, undefined, undefined, null, {});
  }
  assert.equal(isProviderInCooldown(control), true, "sanity: real failures open the breaker");

  // The queue-timeout path must never reach the breaker, no matter how many fire.
  const provider = "test-qt-provider";
  clearProviderFailure(provider);
  for (let i = 0; i < threshold; i++) {
    recordProviderFailure(provider, undefined, undefined, null, { isQueueTimeout: true });
  }
  assert.equal(isProviderInCooldown(provider), false, "queue timeouts must not open the breaker");
});

test("same-provider network errors in one window dedup to a single failure", () => {
  // Several combo targets on the same provider failing one network event (a VPN blip)
  // must count once, not per target — otherwise one blip opens the provider breaker.
  const originalNow = Date.now;
  let now = 1_700_000_000_000;
  Date.now = () => now;
  try {
    const provider = "test-net-dedup-provider";
    clearProviderFailure(provider);
    const threshold = PROVIDER_PROFILES.apikey.circuitBreakerThreshold;
    for (let i = 0; i < threshold; i++) {
      recordProviderFailure(provider, undefined, undefined, null, { isNetworkError: true });
      now += 500; // every call inside the same 10s window
    }
    assert.equal(
      isProviderInCooldown(provider),
      false,
      "one transient network event must not open the breaker"
    );
  } finally {
    Date.now = originalNow;
  }
});

test("persistent dead proxy across windows still opens the breaker", () => {
  // A genuinely dead proxy keeps failing across requests (past the dedup window), so it
  // must still accumulate to the breaker threshold — the dedup must not shield real pain.
  const originalNow = Date.now;
  let now = 1_700_000_000_000;
  Date.now = () => now;
  try {
    const provider = "test-net-deadproxy-provider";
    clearProviderFailure(provider);
    const threshold = PROVIDER_PROFILES.apikey.circuitBreakerThreshold;
    for (let i = 0; i < threshold; i++) {
      recordProviderFailure(provider, undefined, undefined, null, { isNetworkError: true });
      now += 11_000; // past each 10s window
    }
    assert.equal(
      isProviderInCooldown(provider),
      true,
      "a persistent network failure must still accumulate to the threshold"
    );
  } finally {
    Date.now = originalNow;
  }
});
