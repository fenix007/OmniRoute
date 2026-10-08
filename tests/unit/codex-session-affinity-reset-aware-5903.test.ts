// #5903: Codex session affinity must win over a per-request reset-aware
// re-scoring. The reset-aware combo strategy (open-sse/services/combo/quotaStrategies.ts)
// recomputes its "winner" connection on every request and hands it to
// getProviderCredentials as forcedConnectionId (src/sse/handlers/chat.ts).
// Before the fix, forcedConnectionId narrowed the connection pool BEFORE
// session affinity was consulted, so a fresh quota-scoring winner silently
// evicted the existing pin (deleteSessionAccountAffinity) on every request —
// breaking "same session -> reuse pinned account".
//
// This test drives auth.getProviderCredentials directly (the same call shape
// chat.ts uses: sessionKey + forcedConnectionId together) to reproduce the
// bug without needing the full combo/quota-scoring machinery.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-codex-affinity-5903-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "codex-affinity-5903-test-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const affinityDb = await import("../../src/lib/db/sessionAccountAffinity.ts");
const auth = await import("../../src/sse/services/auth.ts");

async function resetStorage() {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function seedConnection(provider: string, overrides: any = {}) {
  const connection = await providersDb.createProviderConnection({
    provider,
    authType: overrides.authType || "oauth",
    name: overrides.name || `${provider}-${Math.random().toString(16).slice(2, 8)}`,
    accessToken: overrides.accessToken || `at-${Math.random().toString(16).slice(2, 10)}`,
    refreshToken: overrides.refreshToken,
    isActive: overrides.isActive ?? true,
    testStatus: overrides.testStatus || "active",
    priority: overrides.priority,
    providerSpecificData: overrides.providerSpecificData || {},
  });
  assert.ok(connection);
  assert.equal(typeof connection.id, "string");
  return { ...connection, id: connection.id as string };
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("codex session affinity wins over a per-request reset-aware forcedConnectionId (#5903)", async () => {
  await settingsDb.updateSettings({
    fallbackStrategy: "reset-aware",
    codexSessionAffinityTtlMs: 60_000,
  });

  const connectionA = await seedConnection("codex", { name: "codex-reset-aware-a" });
  const connectionB = await seedConnection("codex", { name: "codex-reset-aware-b" });

  // Request 1: reset-aware quota scoring picks A as the winner for session S.
  const request1 = await auth.getProviderCredentials("codex", null, null, "gpt-5.5", {
    sessionKey: "session-S",
    forcedConnectionId: connectionA.id,
  });
  assert.equal(
    request1?.connectionId,
    connectionA.id,
    "request 1 should pin to the scored winner A"
  );
  assert.equal(
    affinityDb.getSessionAccountAffinity("session-S", "codex", 60_000)?.connectionId,
    connectionA.id,
    "affinity row must be created for session-S pointing at A"
  );

  // Request 2: quota state shifted and reset-aware now scores B higher for
  // the SAME session. Without the fix, forcedConnectionId=B narrows the pool
  // to just B before affinity is checked, evicting the A pin and re-pinning
  // to B. With the fix, the existing active pin (A) must win.
  const request2 = await auth.getProviderCredentials("codex", null, null, "gpt-5.5", {
    sessionKey: "session-S",
    forcedConnectionId: connectionB.id,
  });
  assert.equal(
    request2?.connectionId,
    connectionA.id,
    "request 2 must still use the pinned connection A, not the freshly re-scored B"
  );
  assert.equal(
    affinityDb.getSessionAccountAffinity("session-S", "codex", 60_000)?.connectionId,
    connectionA.id,
    "affinity row for session-S must remain pinned to A after re-scoring"
  );

  // A brand-new session (S2) has no existing pin, so the freshly re-scored
  // winner (B) must be honored and a NEW pin created for S2.
  const request3 = await auth.getProviderCredentials("codex", null, null, "gpt-5.5", {
    sessionKey: "session-S2",
    forcedConnectionId: connectionB.id,
  });
  assert.equal(
    request3?.connectionId,
    connectionB.id,
    "a new session must honor the fresh re-scored pick"
  );
  assert.equal(
    affinityDb.getSessionAccountAffinity("session-S2", "codex", 60_000)?.connectionId,
    connectionB.id,
    "a new affinity row for session-S2 must be created pointing at B"
  );

  // Session S must remain unaffected by S2's independent pin.
  assert.equal(
    affinityDb.getSessionAccountAffinity("session-S", "codex", 60_000)?.connectionId,
    connectionA.id,
    "session-S pin must stay isolated from session-S2"
  );
});

test("reset-aware forcedConnectionId is honored when the pinned connection becomes ineligible (#5903)", async () => {
  await settingsDb.updateSettings({
    fallbackStrategy: "reset-aware",
    codexSessionAffinityTtlMs: 60_000,
  });

  const connectionA = await seedConnection("codex", { name: "codex-reset-aware-ineligible-a" });
  const connectionB = await seedConnection("codex", { name: "codex-reset-aware-ineligible-b" });

  const request1 = await auth.getProviderCredentials("codex", null, null, "gpt-5.5", {
    sessionKey: "session-failover",
    forcedConnectionId: connectionA.id,
  });
  assert.equal(request1?.connectionId, connectionA.id);

  // A becomes rate-limited (e.g. 429 handled by markAccountUnavailable in
  // production). Reset-aware re-scores and now forces B. The pin (A) is no
  // longer eligible, so the freshly forced B must be used instead of
  // failing the whole request.
  await providersDb.updateProviderConnection(connectionA.id, {
    rateLimitedUntil: new Date(Date.now() + 60_000).toISOString(),
  });

  const request2 = await auth.getProviderCredentials("codex", null, null, "gpt-5.5", {
    sessionKey: "session-failover",
    forcedConnectionId: connectionB.id,
  });
  assert.equal(
    request2?.connectionId,
    connectionB.id,
    "an ineligible pin must fall through to the freshly forced connection"
  );
});

test("no session affinity configured: reset-aware forcedConnectionId applies exactly as before (#5903)", async () => {
  await settingsDb.updateSettings({
    fallbackStrategy: "reset-aware",
    codexSessionAffinityTtlMs: 0,
  });

  const connectionA = await seedConnection("codex", { name: "codex-no-affinity-a" });
  const connectionB = await seedConnection("codex", { name: "codex-no-affinity-b" });

  const request1 = await auth.getProviderCredentials("codex", null, null, "gpt-5.5", {
    sessionKey: "session-no-ttl",
    forcedConnectionId: connectionA.id,
  });
  assert.equal(request1?.connectionId, connectionA.id);

  const request2 = await auth.getProviderCredentials("codex", null, null, "gpt-5.5", {
    sessionKey: "session-no-ttl",
    forcedConnectionId: connectionB.id,
  });
  assert.equal(
    request2?.connectionId,
    connectionB.id,
    "with affinity disabled (ttl=0) each request must honor the fresh forcedConnectionId"
  );
});

test("parallel forced candidates keep one scoped session on one account", async () => {
  await settingsDb.updateSettings({ codexSessionAffinityTtlMs: 30 * 60_000 });
  const a = await seedConnection("codex", { name: "parallel-a" });
  const b = await seedConnection("codex", { name: "parallel-b" });
  const sessionKey = auth.extractSessionAffinityKey({ session_id: "parallel" }, null, "key-one");
  const results = await Promise.all(
    [a, b].map((connection) =>
      auth.getProviderCredentials("codex", null, null, "gpt-5.5", {
        sessionKey,
        sessionSource: "session",
        forcedConnectionId: connection.id,
      })
    )
  );
  assert.ok(results[0] && "sessionRouting" in results[0]);
  assert.ok(results[1] && "sessionRouting" in results[1]);
  assert.equal(results[0]?.connectionId, a.id);
  assert.equal(results[1]?.connectionId, a.id);
  assert.equal(results[0]?.sessionRouting?.routingReason, "affinity_created");
  assert.equal(results[1]?.sessionRouting?.routingReason, "affinity_reused");
  assert.equal(
    results[0]?.sessionRouting?.sessionHash,
    sessionKey?.slice("session:sha256:".length)
  );
});

test("selection diagnostics retain expiry and failed-account reassignment", async () => {
  const ttl = 30 * 60_000;
  await settingsDb.updateSettings({ codexSessionAffinityTtlMs: ttl });
  const a = await seedConnection("codex", { name: "diagnostic-a" });
  const b = await seedConnection("codex", { name: "diagnostic-b" });
  const sessionKey = auth.extractSessionAffinityKey({ session_id: "diagnostic" }, null, "key-one")!;
  affinityDb.upsertSessionAccountAffinity(sessionKey, "codex", a.id, Date.now() - ttl - 100, ttl);
  const expired = await auth.getProviderCredentials("codex", null, null, "gpt-5.5", {
    sessionKey,
    sessionSource: "session",
    forcedConnectionId: b.id,
  });
  assert.ok(expired && "sessionRouting" in expired);
  assert.equal(expired?.connectionId, b.id);
  assert.equal(expired?.sessionRouting?.routingReason, "affinity_expired");
  assert.equal(expired?.sessionRouting?.previousConnectionId, a.id);
  affinityDb.evictSessionAccountAffinityForConnection(sessionKey, "codex", b.id);
  const fallback = await auth.getProviderCredentials("codex", b.id, null, "gpt-5.5", {
    sessionKey,
    sessionSource: "session",
  });
  assert.ok(fallback && "sessionRouting" in fallback);
  assert.equal(fallback?.connectionId, a.id);
  assert.equal(fallback?.sessionRouting?.routingReason, "affinity_reassigned");
  assert.equal(fallback?.sessionRouting?.previousConnectionId, b.id);
  assert.equal(
    expired?.sessionRouting?.routingReason,
    "affinity_expired",
    "later attempts cannot mutate prior telemetry"
  );
});
