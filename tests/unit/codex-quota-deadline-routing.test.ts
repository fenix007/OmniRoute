import test from "node:test";
import assert from "node:assert/strict";

const quotaCache = await import("../../src/domain/quotaCache.ts");
const routing = await import("../../src/sse/services/codexQuotaDeadlineRouting.ts");

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

test("weekly reset pressure remains additive when the subscription deadline is later", () => {
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
  assert.equal(fast.deadlineAt, "2026-10-16T12:00:00.000Z");
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
