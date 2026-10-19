import test from "node:test";
import assert from "node:assert/strict";

const health = await import("../../open-sse/services/codexConnectionHealth.ts");
const routing = await import("../../src/sse/services/codexQuotaDeadlineRouting.ts");
const quotaCache = await import("../../src/domain/quotaCache.ts");

const NOW = Date.parse("2026-10-19T12:00:00Z");
const MIN = 60_000;

test.beforeEach(() => {
  health.resetCodexConnectionHealth();
  quotaCache.__clearForTests();
});

test("a connection without events is fully healthy", () => {
  assert.equal(health.codexConnectionHealthFactor("a", ["a", "b"], NOW), 1);
});

test("recent overloads demote a connection and the penalty decays", () => {
  health.recordCodexOverload("a", NOW - MIN);
  health.recordCodexOverload("a", NOW - MIN);
  const fresh = health.codexConnectionHealthFactor("a", ["a", "b"], NOW);
  const later = health.codexConnectionHealthFactor("a", ["a", "b"], NOW + 8 * MIN);
  const expired = health.codexConnectionHealthFactor("a", ["a", "b"], NOW + 20 * MIN);

  assert.ok(fresh < 0.5, `fresh=${fresh}`);
  assert.ok(later > fresh && later < 1, `later=${later}`);
  assert.equal(expired, 1, "events outside the window no longer count");
});

test("TTFT is judged against peers, not in absolute terms", () => {
  for (let i = 0; i < 5; i++) {
    health.recordCodexTtft("slow", 8000, NOW - i * 1000);
    health.recordCodexTtft("fast", 3500, NOW - i * 1000);
  }
  const slow = health.codexConnectionHealthFactor("slow", ["slow", "fast"], NOW);
  assert.ok(Math.abs(slow - 3500 / 8000) < 1e-9, `slow=${slow}`);
  assert.equal(health.codexConnectionHealthFactor("fast", ["slow", "fast"], NOW), 1);

  // A uniformly slow pool demotes nobody.
  for (let i = 0; i < 5; i++) health.recordCodexTtft("other", 8000, NOW - i * 1000);
  assert.equal(health.codexConnectionHealthFactor("slow", ["slow", "other"], NOW), 1);
});

test("too few TTFT samples are not trusted", () => {
  for (let i = 0; i < 4; i++) health.recordCodexTtft("slow", 9000, NOW - i * 1000);
  for (let i = 0; i < 5; i++) health.recordCodexTtft("fast", 3000, NOW - i * 1000);
  assert.equal(health.codexConnectionHealthFactor("slow", ["slow", "fast"], NOW), 1);
});

test("only overload responses count as overload failures", () => {
  assert.ok(
    health.isCodexOverloadFailure(
      502,
      "Our servers are currently overloaded. Please try again later"
    )
  );
  assert.ok(health.isCodexOverloadFailure(503, "server_is_overloaded"));
  assert.ok(!health.isCodexOverloadFailure(429, "Our servers are currently overloaded"));
  assert.ok(!health.isCodexOverloadFailure(502, "upstream connect error"));
  assert.ok(!health.isCodexOverloadFailure(401, "unauthorized"));
});

function connection(id: string) {
  return {
    id,
    priority: 1,
    lastUsedAt: new Date(NOW - 10 * MIN).toISOString(),
    providerSpecificData: {},
  };
}

test("quota-deadline sends a new session to the healthy account when quota is equal", () => {
  for (const id of ["throttled", "healthy"]) {
    quotaCache.setQuotaCache(id, "codex", {
      session: { remainingPercentage: 60, resetAt: "2026-10-19T17:00:00Z" },
      weekly: { remainingPercentage: 80, resetAt: "2026-10-23T12:00:00Z" },
    });
  }
  health.recordCodexOverload("throttled", NOW - MIN);

  const picked = routing.selectCodexDeadlineConnection(
    [connection("throttled"), connection("healthy")],
    NOW
  );
  assert.equal(picked?.connection.id, "healthy");
  assert.equal(picked?.score.healthFactor, 1);
});

test("a demoted account still wins when its quota is far more urgent", () => {
  quotaCache.setQuotaCache("urgent", "codex", {
    session: { remainingPercentage: 60, resetAt: "2026-10-19T17:00:00Z" },
    weekly: { remainingPercentage: 95, resetAt: "2026-10-19T18:00:00Z" },
  });
  quotaCache.setQuotaCache("relaxed", "codex", {
    session: { remainingPercentage: 60, resetAt: "2026-10-19T17:00:00Z" },
    weekly: { remainingPercentage: 10, resetAt: "2026-10-26T12:00:00Z" },
  });

  const picked = routing.selectCodexDeadlineConnection(
    [connection("urgent"), connection("relaxed")],
    NOW,
    (id) => (id === "urgent" ? 0.5 : 1)
  );
  assert.equal(picked?.connection.id, "urgent");
});
