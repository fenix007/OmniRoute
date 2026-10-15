import test from "node:test";
import assert from "node:assert/strict";
import {
  auth,
  providersDb,
  seedConnection,
  resetStorage,
  cleanupStorage,
  flushWrites,
} from "./_fixtures/sseAuthHarness";

test.beforeEach(resetStorage);
test.after(cleanupStorage);

test("5xx history survives cooldown expiry and escalates a failed probe", async () => {
  const bad = await seedConnection("codex", {
    authType: "oauth",
    accessToken: "bad-token",
    name: "overloaded",
  });
  const good = await seedConnection("codex", {
    authType: "oauth",
    accessToken: "good-token",
    name: "healthy",
  });
  await auth.markAccountUnavailable(bad.id, 502, "Servers overloaded", "codex", "gpt-6.1-sol");
  assert.equal((await auth.getProviderCredentials("codex")).connectionId, good.id);
  const before = await providersDb.getProviderConnectionById(bad.id);
  assert.equal(before.backoffLevel, 1);
  await providersDb.updateProviderConnection(bad.id, {
    rateLimitedUntil: new Date(Date.now() - 1).toISOString(),
  });
  const probe = await auth.getProviderCredentials("codex", good.id);
  assert.equal(probe.connectionId, bad.id);
  await flushWrites();
  assert.equal((await providersDb.getProviderConnectionById(bad.id)).backoffLevel, 1);
  await auth.markAccountUnavailable(bad.id, 502, "Servers overloaded", "codex", "gpt-6.1-sol");
  const after = await providersDb.getProviderConnectionById(bad.id);
  assert.equal(after.backoffLevel, 2);
  assert.ok(Date.parse(after.rateLimitedUntil) - Date.now() > 8000);
});

test("old 5xx history decays so recovered accounts can be probed", async () => {
  const account = await seedConnection("codex", {
    authType: "oauth",
    errorCode: 502,
    lastError: "old overload",
    backoffLevel: 4,
    rateLimitedUntil: new Date(Date.now() - 301000).toISOString(),
  });
  await providersDb.updateProviderConnection(account.id, { backoffLevel: 4 });
  assert.equal((await auth.getProviderCredentials("codex")).connectionId, account.id);
  await flushWrites();
  assert.equal((await providersDb.getProviderConnectionById(account.id)).backoffLevel, 0);
});

test("older successful request cannot erase a newer failure", async () => {
  const account = await seedConnection("codex", {
    authType: "oauth",
    errorCode: 502,
    lastError: "overload",
    backoffLevel: 2,
    rateLimitedUntil: new Date(Date.now() - 1).toISOString(),
  });
  await providersDb.updateProviderConnection(account.id, { backoffLevel: 2 });
  const snapshot = await auth.getProviderCredentials("codex");
  await auth.markAccountUnavailable(account.id, 502, "New overload", "codex", "gpt-6.1-sol");
  await auth.clearAccountError(account.id, snapshot);
  const failed = await providersDb.getProviderConnectionById(account.id);
  assert.equal(failed.testStatus, "unavailable");
  assert.equal(failed.backoffLevel, 3);
  // A successful probe of exactly that failure state does clear the history.
  await auth.clearAccountError(account.id, { ...failed, connectionId: account.id });
  assert.equal((await providersDb.getProviderConnectionById(account.id)).backoffLevel, 0);
});
