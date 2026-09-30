import test from "node:test";
import assert from "node:assert/strict";
import {
  auth,
  cleanupStorage,
  fallback,
  providersDb,
  resetStorage,
  seedConnection,
} from "./_fixtures/sseAuthHarness";

const missingModel = "[404]: The model `gpt-5.5` does not exist or you do not have access to it.";

test.beforeEach(resetStorage);
test.after(cleanupStorage);

test("classifies model-or-account 404, but not route, auth or generic missing-model errors", () => {
  for (const [status, message, expected] of [
    [404, missingModel, true],
    [400, missingModel, false],
    [401, missingModel, false],
    [429, missingModel, false],
    [404, "Route not found", false],
    [404, "The model gpt-5.5 does not exist", false],
    [404, `Invalid API key: ${missingModel}`, false],
  ] as const) {
    assert.equal(fallback.isAccountScopedModelUnavailable404(status, message), expected);
  }
});

test("404 rotates accounts and skips every effort alias on the denied account before dispatch", async () => {
  const denied = await seedConnection("codex", { name: "denied", priority: 1 });
  const allowed = await seedConnection("codex", { name: "allowed", priority: 2 });
  assert.equal(
    (await auth.getProviderCredentials("codex", null, null, "gpt-5.5-medium"))?.connectionId,
    denied.id
  );
  const result = await auth.markAccountUnavailable(
    denied.id,
    404,
    missingModel,
    "codex",
    "gpt-5.5-medium"
  );
  assert.equal(result.shouldFallback, true);
  assert.equal(result.cooldownMs, 0);
  for (const model of ["gpt-5.5", "gpt-5.5-low", "gpt-5.5-xhigh"]) {
    assert.equal(
      (await auth.getProviderCredentials("codex", null, null, model))?.connectionId,
      allowed.id
    );
  }
  // Never escape a caller's account allowlist or an explicitly pinned account.
  assert.equal(await auth.getProviderCredentials("codex", null, [denied.id], "gpt-5.5"), null);
  assert.equal(
    await auth.getProviderCredentials("codex", null, null, "gpt-5.5", {
      forcedConnectionId: denied.id,
    }),
    null
  );
  assert.equal(
    (await auth.getProviderCredentials("codex", null, [denied.id], "gpt-6-sol-medium"))
      ?.connectionId,
    denied.id
  );
  const stored = await providersDb.getProviderConnectionById(denied.id);
  assert.ok(!stored.rateLimitedUntil);
  assert.notEqual(stored.testStatus, "unavailable");
  assert.equal(fallback.isModelLocked("codex", denied.id, "gpt-6-sol-medium"), false);
  assert.equal(fallback.isProviderInCooldown("codex"), false);
});

test("all denied accounts stop selection without affecting their other models", async () => {
  const connection = await seedConnection("codex");
  await auth.markAccountUnavailable(connection.id, 404, missingModel, "codex", "gpt-5.5");
  assert.equal(await auth.getProviderCredentials("codex", null, null, "gpt-5.5-medium"), null);
  assert.equal(
    (await auth.getProviderCredentials("codex", null, null, "gpt-6-astra"))?.connectionId,
    connection.id
  );
});

test("Codex lock identity follows wire aliases without broadening to other models or providers", () => {
  fallback.lockUnsupportedAccountModel("cx", "alias-account", "codex/gpt-5.6-sol-ultra");
  assert.equal(
    fallback.isAccountModelUnsupported("codex", "alias-account", "gpt-5.6-sol-medium"),
    true
  );
  assert.equal(
    fallback.isAccountModelUnsupported("codex", "alias-account", "gpt-6-sol-medium"),
    false
  );
  assert.equal(fallback.isAccountModelUnsupported("codex", "other-account", "gpt-5.6-sol"), false);
  assert.equal(
    fallback.isAccountModelUnsupported("openai", "alias-account", "gpt-5.6-sol-medium"),
    false
  );
  fallback.lockUnsupportedAccountModel("codex", "max-account", "gpt-5.1-codex-max");
  assert.equal(fallback.isAccountModelUnsupported("codex", "max-account", "gpt-5.1-codex"), false);
});

test("ambiguous 404 is re-probed at the deadline, without a permanent blacklist", async (t) => {
  let now = 1_900_000_000_000;
  t.mock.method(Date, "now", () => now);
  const connection = await seedConnection("codex");
  await auth.markAccountUnavailable(connection.id, 404, missingModel, "codex", "gpt-5.5");
  now += fallback.ACCOUNT_MODEL_UNAVAILABLE_LOCK_MS - 1;
  assert.equal(fallback.isAccountModelUnsupported("codex", connection.id, "gpt-5.5-low"), true);
  now++;
  assert.equal(fallback.isAccountModelUnsupported("codex", connection.id, "gpt-5.5-low"), false);
  assert.equal(
    (await auth.getProviderCredentials("codex", null, null, "gpt-5.5-low"))?.connectionId,
    connection.id
  );
});

test("account/model cache is bounded and invalid TTLs cannot create immortal entries", () => {
  for (let index = 0; index <= 10_000; index++) {
    fallback.lockUnsupportedAccountModel("codex", `bounded-${index}`, "gpt-5.5");
  }
  assert.equal(fallback.isAccountModelUnsupported("codex", "bounded-0", "gpt-5.5"), false);
  assert.equal(fallback.isAccountModelUnsupported("codex", "bounded-10000", "gpt-5.5"), true);
  for (const ttl of [NaN, Infinity, -1, 0]) {
    fallback.lockUnsupportedAccountModel("codex", "invalid-ttl", "gpt-5.5", ttl);
    assert.equal(fallback.isAccountModelUnsupported("codex", "invalid-ttl", "gpt-5.5"), false);
  }
});
