import test from "node:test";
import assert from "node:assert/strict";

const quotaCache = await import("../../src/domain/quotaCache.ts");
const routing = await import("../../src/sse/services/codexQuotaDeadlineRouting.ts");
const credits = await import("../../src/lib/usage/codexResetCredits.ts");

test.beforeEach(() => {
  quotaCache.__clearForTests();
});

function connection(id: string, activeUntil: string | null, lastUsedAt: string | null = null) {
  return {
    id,
    priority: 1,
    lastUsedAt,
    providerSpecificData: activeUntil ? { subscriptionActiveUntil: activeUntil } : {},
  };
}

test("subscription deadline increases routing pressure", () => {
  const now = Date.parse("2026-09-16T12:00:00Z");
  quotaCache.setQuotaCache("soon", "codex", {
    session: { remainingPercentage: 60, resetAt: "2026-09-16T17:00:00Z" },
    weekly: { remainingPercentage: 80, resetAt: "2026-09-23T12:00:00Z" },
  });
  quotaCache.setQuotaCache("later", "codex", {
    session: { remainingPercentage: 60, resetAt: "2026-09-16T17:00:00Z" },
    weekly: { remainingPercentage: 80, resetAt: "2026-09-23T12:00:00Z" },
  });

  const soon = routing.scoreCodexDeadlineConnection(
    connection("soon", "2026-09-18T12:00:00Z"),
    now
  );
  const later = routing.scoreCodexDeadlineConnection(
    connection("later", "2026-10-16T12:00:00Z"),
    now
  );

  assert.ok(soon.weight > later.weight);
  assert.equal(soon.deadlineAt, "2026-09-18T12:00:00.000Z");
});

test("weekly reset drives the deadline when the subscription ends later", () => {
  const now = Date.parse("2026-09-16T12:00:00Z");
  quotaCache.setQuotaCache("fast-reset", "codex", {
    session: { remainingPercentage: 60, resetAt: "2026-09-16T17:00:00Z" },
    weekly: { remainingPercentage: 80, resetAt: "2026-09-17T12:00:00Z" },
  });
  quotaCache.setQuotaCache("slow-reset", "codex", {
    session: { remainingPercentage: 60, resetAt: "2026-09-16T17:00:00Z" },
    weekly: { remainingPercentage: 80, resetAt: "2026-09-23T12:00:00Z" },
  });

  const fast = routing.scoreCodexDeadlineConnection(
    connection("fast-reset", "2026-10-16T12:00:00Z"),
    now
  );
  const slow = routing.scoreCodexDeadlineConnection(
    connection("slow-reset", "2026-10-16T12:00:00Z"),
    now
  );

  assert.ok(fast.weight > slow.weight);
  // The weekly quota is lost at the weekly reset, long before the subscription
  // ends, so the reset — not the subscription date — is the binding deadline.
  assert.equal(fast.deadlineAt, "2026-09-17T12:00:00.000Z");
  assert.equal(slow.deadlineAt, "2026-09-23T12:00:00.000Z");
});

test("a distant subscription date never lowers the urgency of a near weekly reset", () => {
  const now = Date.parse("2026-09-16T12:00:00Z");
  for (const id of ["with-subscription", "without-subscription"]) {
    quotaCache.setQuotaCache(id, "codex", {
      session: { remainingPercentage: 60, resetAt: "2026-09-16T17:00:00Z" },
      weekly: { remainingPercentage: 80, resetAt: "2026-09-17T12:00:00Z" },
    });
  }

  const withSubscription = routing.scoreCodexDeadlineConnection(
    connection("with-subscription", "2026-12-16T12:00:00Z"),
    now
  );
  const withoutSubscription = routing.scoreCodexDeadlineConnection(
    connection("without-subscription", null),
    now
  );

  assert.equal(withSubscription.weight, withoutSubscription.weight);
});

test("a subscription ending before the weekly reset shortens the deadline", () => {
  const now = Date.parse("2026-09-16T12:00:00Z");
  quotaCache.setQuotaCache("expiring", "codex", {
    session: { remainingPercentage: 60, resetAt: "2026-09-16T17:00:00Z" },
    weekly: { remainingPercentage: 80, resetAt: "2026-09-23T12:00:00Z" },
  });

  const score = routing.scoreCodexDeadlineConnection(
    connection("expiring", "2026-09-17T12:00:00Z"),
    now
  );

  assert.equal(score.deadlineAt, "2026-09-17T12:00:00.000Z");
  assert.equal(score.subscriptionExpired, false);
});

test("an expired subscription is reported instead of silently vanishing", () => {
  const now = Date.parse("2026-09-16T12:00:00Z");
  quotaCache.setQuotaCache("lapsed", "codex", {
    session: { remainingPercentage: 60, resetAt: "2026-09-16T17:00:00Z" },
    weekly: { remainingPercentage: 80, resetAt: "2026-09-23T12:00:00Z" },
  });

  const score = routing.scoreCodexDeadlineConnection(
    connection("lapsed", "2026-09-10T12:00:00Z"),
    now
  );

  assert.equal(score.subscriptionExpired, true);
  assert.equal(score.deadlineAt, "2026-09-23T12:00:00.000Z");
});

test("an unknown weekly window takes the pool's urgency instead of the minimum", () => {
  const now = Date.parse("2026-09-16T12:00:00Z");
  quotaCache.setQuotaCache("known-busy", "codex", {
    session: { remainingPercentage: 90, resetAt: "2026-09-16T17:00:00Z" },
    weekly: { remainingPercentage: 90, resetAt: "2026-09-17T12:00:00Z" },
  });
  quotaCache.setQuotaCache("unknown-weekly", "codex", {
    session: { remainingPercentage: 90, resetAt: "2026-09-16T17:00:00Z" },
  });

  // Measured alone, the unknown account would weigh 1 and lose despite being
  // idle longer; at the pool's median weight its longer idle time wins.
  const unknown = routing.scoreCodexDeadlineConnection(
    connection("unknown-weekly", null, "2026-09-16T11:49:00Z"),
    now
  );
  assert.equal(unknown.weeklyKnown, false);
  assert.equal(unknown.weight, 1);

  const selected = routing.selectCodexDeadlineConnection(
    [
      connection("known-busy", null, "2026-09-16T11:50:00Z"),
      connection("unknown-weekly", null, "2026-09-16T11:49:00Z"),
    ],
    now
  );

  assert.equal(selected?.connection.id, "unknown-weekly");
  assert.equal(selected?.score.weightSource, "pool-median");
  assert.ok(selected!.score.weight > 1);
});

test("an exhausted session without a usable reset stays eligible but sorts last", () => {
  const now = Date.parse("2026-09-16T12:00:00Z");
  quotaCache.setQuotaCache("stale-empty", "codex", {
    session: { remainingPercentage: 0, resetAt: null },
    weekly: { remainingPercentage: 90, resetAt: "2026-09-17T12:00:00Z" },
  });
  quotaCache.setQuotaCache("healthy", "codex", {
    session: { remainingPercentage: 40, resetAt: "2026-09-16T17:00:00Z" },
    weekly: { remainingPercentage: 20, resetAt: "2026-09-23T12:00:00Z" },
  });

  const stale = routing.scoreCodexDeadlineConnection(
    connection("stale-empty", null, "2026-09-15T12:00:00Z"),
    now
  );
  assert.equal(stale.sessionBlocked, false);
  assert.equal(stale.sessionDepleted, true);

  const selected = routing.selectCodexDeadlineConnection(
    [
      connection("stale-empty", null, "2026-09-15T12:00:00Z"),
      connection("healthy", null, "2026-09-16T11:59:00Z"),
    ],
    now
  );

  assert.equal(selected?.connection.id, "healthy");
});

test("credits are burned against their own expiry, not the weekly reset", () => {
  const now = Date.parse("2026-09-16T12:00:00Z");
  for (const id of ["banked", "plain"]) {
    quotaCache.setQuotaCache(id, "codex", {
      session: { remainingPercentage: 60, resetAt: "2026-09-16T17:00:00Z" },
      weekly: { remainingPercentage: 20, resetAt: "2026-09-23T12:00:00Z" },
    });
  }
  credits.__setCachedCodexResetCreditsForTests("banked", {
    availableCount: 3,
    credits: [
      { expiresAt: "2026-09-18T12:00:00Z" },
      { expiresAt: "2026-10-18T12:00:00Z" },
      { expiresAt: "2026-10-18T12:00:00Z" },
    ],
  });

  const plain = routing.scoreCodexDeadlineConnection(connection("plain", null), now);
  assert.equal(plain.requiredWeeklyBurn, 15);
  assert.equal(plain.deadlineAt, "2026-09-23T12:00:00.000Z");

  // Two spendable credits (the first is held in reserve) worth 95 points each,
  // due at the earliest credit expiry two days out — far more urgent than the
  // 15 points of weekly headroom due in a week.
  const banked = routing.scoreCodexDeadlineConnection(connection("banked", null), now);
  assert.equal(banked.requiredWeeklyBurn, 15 + 190);
  assert.equal(banked.deadlineAt, "2026-09-18T12:00:00.000Z");
  assert.ok(banked.weight > plain.weight);
});

test("numeric garbage never produces a NaN weight or burn", () => {
  const now = Date.parse("2026-09-16T12:00:00Z");
  quotaCache.setQuotaCache("garbage", "codex", {
    session: { remainingPercentage: Number.NaN, resetAt: "2026-09-16T17:00:00Z" },
    weekly: { remainingPercentage: Number.NaN, resetAt: "2026-09-23T12:00:00Z" },
  });
  // The credit cache is filled straight from an upstream payload, so unlike the
  // quota cache it hands the scorer unsanitized numbers.
  credits.__setCachedCodexResetCreditsForTests("garbage", {
    availableCount: Number.NaN,
    credits: [{ expiresAt: "not-a-date" }],
  });

  const score = routing.scoreCodexDeadlineConnection(connection("garbage", null), now);

  assert.ok(Number.isFinite(score.weight));
  assert.ok(Number.isFinite(score.requiredWeeklyBurn));
});

test("missing subscription date stays neutral and session zero is blocked", () => {
  const now = Date.parse("2026-09-16T12:00:00Z");
  quotaCache.setQuotaCache("blocked", "codex", {
    session: { remainingPercentage: 0, resetAt: "2026-09-16T17:00:00Z" },
    weekly: { remainingPercentage: 80, resetAt: "2026-09-23T12:00:00Z" },
  });
  quotaCache.setQuotaCache("neutral", "codex", {
    session: { remainingPercentage: 50, resetAt: "2026-09-16T17:00:00Z" },
    weekly: { remainingPercentage: 20, resetAt: "2026-09-23T12:00:00Z" },
  });

  const selected = routing.selectCodexDeadlineConnection(
    [connection("blocked", "2026-09-18T12:00:00Z"), connection("neutral", null)],
    now
  );

  assert.equal(selected?.connection.id, "neutral");
  assert.equal(selected?.score.sessionBlocked, false);
});

test("weighted least-recently-used keeps low-pressure accounts in rotation", () => {
  const now = Date.parse("2026-09-16T12:00:00Z");
  for (const id of ["urgent", "fair"]) {
    quotaCache.setQuotaCache(id, "codex", {
      session: { remainingPercentage: 50, resetAt: "2026-09-16T17:00:00Z" },
      weekly: { remainingPercentage: 80, resetAt: "2026-09-23T12:00:00Z" },
    });
  }

  const selected = routing.selectCodexDeadlineConnection(
    [
      connection("urgent", "2026-09-18T12:00:00Z", "2026-09-16T11:59:00Z"),
      connection("fair", "2026-10-16T12:00:00Z", "2026-09-16T10:00:00Z"),
    ],
    now
  );

  assert.equal(selected?.connection.id, "fair");
});
