import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

process.env.NODE_ENV = "test";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-kiro-rejection-"));
process.env.API_KEY_SECRET = "kiro-rejection-test-secret";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.OAUTH_REFRESH_SPACING_MS = "0";

const core = await import("../../src/lib/db/core.ts");
const providers = await import("../../src/lib/db/providers.ts");
const caches = await import("../../src/lib/db/providerLimits.ts");
const limits = await import("../../src/lib/usage/providerLimits.ts");
const { refreshKiroToken, refreshWithRetry } =
  await import("../../open-sse/services/tokenRefresh.ts");
const { getExecutor } = await import("../../open-sse/executors/index.ts");
const { checkConnection, stopTokenHealthCheck } = await import("../../src/lib/tokenHealthCheck.ts");
const originalFetch = globalThis.fetch;
const originalInfo = console.info;
const originalError = console.error;
const events: Array<Record<string, unknown>> = [];
const errorLogs: unknown[][] = [];
let fetchCalls = 0;

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function connection(patch: Record<string, unknown> = {}) {
  return providers.createProviderConnection({
    provider: "kiro",
    authType: "oauth",
    name: `fixture-${Date.now()}-${Math.random()}`,
    accessToken: "fixture-access",
    refreshToken: `fixture-refresh-${Math.random()}`,
    tokenExpiresAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
    providerSpecificData: { authMethod: "imported" },
    isActive: true,
    testStatus: "active",
    ...patch,
  }) as Promise<Record<string, unknown>>;
}

test.beforeEach(() => {
  events.length = 0;
  errorLogs.length = 0;
  fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    return response({ message: "Bad credentials", refreshToken: "fixture-sensitive-echo" }, 401);
  }) as typeof fetch;
  console.info = (...args) => {
    if (args[0] === "TOKEN_REFRESH_DIAGNOSTIC") events.push(JSON.parse(String(args[1])));
  };
  console.error = (...args) => {
    errorLogs.push(args);
  };
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  console.info = originalInfo;
  console.error = originalError;
});
test.after(() => {
  stopTokenHealthCheck();
  core.resetDbInstance();
  fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
});

test("Kiro social 401 stops retry, redacts upstream payload, and hashes the connection", async () => {
  const context = { connectionId: "fixture-connection", source: "quota" as const };
  const result = await refreshWithRetry(
    () => refreshKiroToken("fixture-dead-retry", null, console, null, context),
    3,
    null,
    "kiro-test"
  );
  assert.deepEqual(result, { error: "unrecoverable_refresh_error", code: "unauthorized" });
  assert.equal(fetchCalls, 1);
  assert.deepEqual(events, [
    {
      provider: "kiro",
      connectionHash: createHash("sha256").update(context.connectionId).digest("hex"),
      source: "quota",
      outcome: "reauth_required",
      statusCode: 401,
    },
  ]);
  assert.ok(!JSON.stringify([...events, ...errorLogs]).includes("fixture-sensitive-echo"));
  assert.ok(!JSON.stringify(events).includes(context.connectionId));
});

test("a known rejected refresh is skipped, while a new token may refresh", async () => {
  await refreshKiroToken("fixture-cached-dead", null, console);
  await refreshKiroToken("fixture-cached-dead", null, console);
  globalThis.fetch = (async () => {
    fetchCalls++;
    return response({
      accessToken: "fixture-fresh-access",
      refreshToken: "fixture-rotated",
      expiresIn: 3600,
    });
  }) as typeof fetch;
  const result = await refreshKiroToken("fixture-new-after-reauth", null, console);
  assert.equal(fetchCalls, 2);
  assert.equal(result.accessToken, "fixture-fresh-access");
  assert.deepEqual(
    events.map((e) => e.outcome),
    ["reauth_required", "skipped", "success"]
  );
});

test("transient 503 and client configuration errors are not remembered as dead credentials", async () => {
  globalThis.fetch = (async () => {
    fetchCalls++;
    return response({ error: "invalid_client" }, fetchCalls <= 2 ? 503 : 400);
  }) as typeof fetch;
  for (let i = 0; i < 4; i++)
    assert.equal(await refreshKiroToken("fixture-transient-config", null, console), null);
  assert.equal(fetchCalls, 4);
});

test("disabled and terminal quota reads serve prior cache without touching upstream or cache age", async () => {
  for (const patch of [
    { isActive: false },
    { testStatus: "banned" },
    { testStatus: "expired" },
    { testStatus: "deactivated" },
  ]) {
    const conn = await connection(patch);
    const cached = {
      quotas: { monthly: { remaining: 17 } },
      plan: "fixture",
      message: null,
      fetchedAt: "2026-11-08T12:00:00.000Z",
      source: "manual",
    };
    caches.setProviderLimitsCache(String(conn.id), cached);
    const result = await limits.fetchAndPersistProviderLimits(String(conn.id), "manual", {
      allowRotatingRefresh: true,
    });
    assert.equal(result.usage._refreshSkipped, true);
    assert.deepEqual(result.usage.quotas, cached.quotas);
    assert.equal(result.cache.fetchedAt, cached.fetchedAt);
    assert.equal(caches.getProviderLimitsCache(String(conn.id))?.fetchedAt, cached.fetchedAt);
    assert.equal(
      (
        await limits.refreshAndUpdateCredentials(conn as never, {
          allowRotatingRefresh: true,
          force: true,
        })
      ).refreshed,
      false
    );
  }
  assert.equal(fetchCalls, 0);
  assert.ok(events.every((e) => e.outcome === "skipped" && e.source === "quota"));
});

test("terminal rejection marks an expired account for reauth and the next quota read does not retry", async () => {
  const conn = await connection();
  await assert.rejects(
    () =>
      limits.fetchAndPersistProviderLimits(String(conn.id), "manual", {
        allowRotatingRefresh: true,
      }),
    /Please re-authenticate/
  );
  assert.equal(fetchCalls, 1);
  const current = await providers.getProviderConnectionById(String(conn.id));
  assert.equal(current.isActive, false);
  assert.equal(current.testStatus, "expired");
  assert.equal(current.lastErrorType, "unrecoverable_refresh_error");
  await limits.fetchAndPersistProviderLimits(String(conn.id), "manual", {
    allowRotatingRefresh: true,
  });
  assert.equal(fetchCalls, 1);
});

test("terminal rejection preserves a still-valid access token and suppresses another refresh", async () => {
  const expiry = new Date(Date.now() + 120_000).toISOString();
  const conn = await connection({ expiresAt: expiry, tokenExpiresAt: expiry });
  const result = await limits.refreshAndUpdateCredentials(conn as never, {
    allowRotatingRefresh: true,
    force: true,
  });
  assert.equal(result.refreshed, false);
  assert.equal(result.reauthRequired, true);
  const current = await providers.getProviderConnectionById(String(conn.id));
  assert.equal(current.isActive, true);
  assert.equal(current.accessToken, conn.accessToken);
  assert.equal(current.tokenExpiresAt || current.expiresAt, expiry);
  await limits.refreshAndUpdateCredentials(current as never, {
    allowRotatingRefresh: true,
    force: true,
  });
  assert.equal(fetchCalls, 1);
});

test("rejection of stale credentials never deactivates a concurrent reauthorization", async () => {
  const conn = await connection();
  globalThis.fetch = (async () => {
    fetchCalls++;
    await providers.updateProviderConnection(String(conn.id), {
      accessToken: "concurrent-access",
      refreshToken: "concurrent-refresh",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      tokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    return response({ message: "Bad credentials" }, 401);
  }) as typeof fetch;
  const result = await limits.refreshAndUpdateCredentials(conn as never, {
    allowRotatingRefresh: true,
  });
  assert.equal(result.connection.accessToken, "concurrent-access");
  const current = await providers.getProviderConnectionById(String(conn.id));
  assert.equal(current.isActive, true);
  assert.equal(current.refreshToken, "concurrent-refresh");
  assert.notEqual(current.lastErrorType, "unrecoverable_refresh_error");
});

test("conditional rejection update refuses a changed database snapshot", async () => {
  const conn = await connection();
  assert.equal(
    providers.markConnectionRefreshRejectedIfUnchanged(
      String(conn.id),
      "1999-01-01T00:00:00Z",
      false
    ),
    false
  );
  assert.equal((await providers.getProviderConnectionById(String(conn.id))).isActive, true);
});

test("request and healthcheck refresh events retain their source and connection attribution", async () => {
  const requestConn = await connection();
  await getExecutor("kiro").refreshCredentials(
    { connectionId: String(requestConn.id), refreshToken: String(requestConn.refreshToken) },
    console
  );
  const healthConn = await connection();
  globalThis.fetch = (async () =>
    response({
      accessToken: "health-fresh",
      refreshToken: "health-rotated",
      expiresIn: 3600,
    })) as typeof fetch;
  await checkConnection(healthConn);
  assert.ok(events.some((e) => e.source === "request" && e.outcome === "reauth_required"));
  assert.ok(events.some((e) => e.source === "healthcheck" && e.outcome === "success"));
  assert.ok(events.every((e) => typeof e.connectionHash === "string"));
});

test("healthcheck keeps a valid access token active when its refresh credential is rejected", async () => {
  const expiry = new Date(Date.now() + 120_000).toISOString();
  const conn = await connection({ expiresAt: expiry, tokenExpiresAt: expiry });
  await checkConnection(conn);
  const current = await providers.getProviderConnectionById(String(conn.id));
  assert.equal(current.isActive, true);
  assert.equal(current.accessToken, conn.accessToken);
  assert.equal(current.lastErrorType, "unrecoverable_refresh_error");
});

test("stored AWS region cannot redirect refresh credentials to an injected host", async () => {
  const result = await refreshKiroToken(
    "fixture-region-secret",
    {
      clientId: "fixture-client",
      clientSecret: "fixture-secret",
      region: "us-east-1.amazonaws.com@evil.invalid",
    },
    console
  );
  assert.equal(result, null);
  assert.equal(fetchCalls, 0);
  assert.ok(!JSON.stringify(errorLogs).includes("evil.invalid"));
});

test("a stale active quota snapshot cannot refresh an account disabled before its turn", async () => {
  const conn = await connection();
  await providers.updateProviderConnection(String(conn.id), { isActive: false });
  const result = await limits.refreshAndUpdateCredentials(conn as never, {
    allowRotatingRefresh: true,
  });
  assert.equal(result.connection.isActive, false);
  assert.equal(fetchCalls, 0);
});

test("a ban written while the refresh is in flight is preserved", async () => {
  const conn = await connection();
  globalThis.fetch = (async () => {
    fetchCalls++;
    await providers.updateProviderConnection(String(conn.id), {
      isActive: false,
      testStatus: "banned",
    });
    return response({ message: "Bad credentials" }, 401);
  }) as typeof fetch;
  const result = await limits.refreshAndUpdateCredentials(conn as never, {
    allowRotatingRefresh: true,
  });
  assert.equal(result.connection.testStatus, "banned");
  const current = await providers.getProviderConnectionById(String(conn.id));
  assert.equal(current.testStatus, "banned");
});

test("a deleted connection fails closed before submitting its stored refresh credential", async () => {
  const conn = await connection();
  await providers.deleteProviderConnection(String(conn.id));
  await assert.rejects(
    () => limits.refreshAndUpdateCredentials(conn as never, { allowRotatingRefresh: true }),
    { status: 404 }
  );
  assert.equal(fetchCalls, 0);
});

test("usable quota from a valid access token cannot clear a rejected-refresh warning", async () => {
  const expiry = new Date(Date.now() + 120_000).toISOString();
  const conn = await connection({ expiresAt: expiry, tokenExpiresAt: expiry });
  const rejected = await limits.refreshAndUpdateCredentials(conn as never, {
    allowRotatingRefresh: true,
    force: true,
  });
  const usage = { quotas: { monthly: { remaining: 25 } } };
  const recovered = await limits.maybeClearRecoveredQuotaState(rejected.connection as never, usage);
  assert.equal(recovered.lastErrorType, "unrecoverable_refresh_error");
  assert.equal(
    (await providers.getProviderConnectionById(String(conn.id))).lastErrorType,
    "unrecoverable_refresh_error"
  );
  await limits.refreshAndUpdateCredentials(recovered as never, {
    allowRotatingRefresh: true,
    force: true,
  });
  assert.equal(fetchCalls, 1);
});

test("external IdP invalid_client remains a configuration failure, not a dead account", async () => {
  globalThis.fetch = (async () => {
    fetchCalls++;
    return response({ error: "invalid_client" }, 400);
  }) as typeof fetch;
  const config = {
    authMethod: "external_idp",
    clientId: "fixture-client",
    tokenEndpoint: "https://login.microsoftonline.com/fixture/oauth2/v2.0/token",
    scopes: "offline_access",
  };
  assert.equal(await refreshKiroToken("fixture-external-config", config, console), null);
  assert.equal(await refreshKiroToken("fixture-external-config", config, console), null);
  assert.equal(fetchCalls, 2);
  assert.ok(events.every((e) => e.outcome === "failure"));
});

test("quota terminal handling does not deactivate accounts for OAuth client configuration errors", async () => {
  const executor = getExecutor("kiro");
  const original = executor.refreshCredentials;
  try {
    for (const code of ["invalid_client", "unauthorized_client", "invalid_scope"]) {
      const conn = await connection();
      executor.refreshCredentials = async () => ({ error: "unrecoverable_refresh_error", code });
      const result = await limits.refreshAndUpdateCredentials(conn as never, {
        allowRotatingRefresh: true,
      });
      assert.equal(result.refreshed, false);
      const current = await providers.getProviderConnectionById(String(conn.id));
      assert.equal(current.isActive, true);
      assert.notEqual(current.lastErrorType, "unrecoverable_refresh_error");
    }
  } finally {
    executor.refreshCredentials = original;
  }
});
