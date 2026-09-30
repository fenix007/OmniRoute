import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-reauth-expiry-"));
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
const core = await import("../../src/lib/db/core.ts");
const db = await import("../../src/lib/db/providers.ts");
const settings = await import("../../src/lib/db/settings.ts");
const { persistOAuthConnection } = await import("../../src/lib/oauth/connectionPersistence.ts");
const { checkConnection } = await import("../../src/lib/tokenHealthCheck.ts");
const { getProvider } = await import("../../src/lib/oauth/providers.ts");
const route = await import("../../src/app/api/oauth/[provider]/[action]/route.ts");
const staleExpiry = "2020-01-01T00:00:00.000Z";

async function seed(provider: string, suffix = "a") {
  const row = await db.createProviderConnection({
    provider,
    authType: "oauth",
    email: `${suffix}@example.com`,
    accessToken: `old-access-${suffix}`,
    refreshToken: `old-refresh-${suffix}`,
    expiresAt: staleExpiry,
    isActive: false,
    testStatus: "expired",
    providerSpecificData: { chatgptUserId: `user-${suffix}`, workspaceId: `workspace-${suffix}` },
  });
  await db.updateProviderConnection(row.id, {
    tokenExpiresAt: staleExpiry,
    lastError: "Old token rejected",
    lastErrorAt: staleExpiry,
    lastErrorType: "unrecoverable_refresh_error",
    lastErrorSource: "oauth",
    errorCode: "invalid_grant",
  });
  return (await db.getProviderConnectionById(row.id))!;
}
function grant(suffix = "a", expiresIn: number | null = 864000) {
  return {
    email: `${suffix}@example.com`,
    accessToken: `fresh-access-${suffix}`,
    refreshToken: `fresh-refresh-${suffix}`,
    expiresIn,
    providerSpecificData: { chatgptUserId: `user-${suffix}`, workspaceId: `workspace-${suffix}` },
  };
}
async function assertFresh(id: string, suffix = "a", known = true) {
  const row = (await db.getProviderConnectionById(id))!;
  assert.equal(row.accessToken, `fresh-access-${suffix}`);
  assert.equal(row.refreshToken, `fresh-refresh-${suffix}`);
  assert.equal(row.tokenExpiresAt, row.expiresAt);
  if (known) assert.ok(Date.parse(row.expiresAt as string) > Date.now() + 3600000);
  else assert.equal(row.tokenExpiresAt ?? null, null);
  for (const key of ["lastError", "lastErrorAt", "lastErrorType", "lastErrorSource", "errorCode"]) {
    assert.equal(row[key] ?? null, null, key);
  }
  assert.equal(row.isActive, true);
  assert.equal(row.testStatus, "active");
  return row;
}
test.beforeEach(async () => {
  core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir);
  await settings.updateSettings({ requireLogin: false });
});
test.after(() => {
  core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

for (const provider of ["codex", "kiro", "gemini"]) {
  test(`${provider}: reauthentication replaces expiry and prevents premature health refresh`, async (t) => {
    const row = await seed(provider);
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      calls++;
      return Response.json({ error: "invalid_grant" }, { status: 401 });
    });
    const updated = await persistOAuthConnection(provider, grant(), row.id);
    assert.equal(updated.id, row.id);
    const fresh = await assertFresh(row.id);
    await checkConnection(fresh);
    assert.equal(calls, 0);
    await assertFresh(row.id);
  });
  test(`${provider}: unknown reauthentication expiry clears both previous clocks`, async () => {
    const row = await seed(provider);
    await persistOAuthConnection(provider, grant("a", null), row.id);
    await assertFresh(row.id, "a", false);
  });
}

for (const [provider, action] of [
  ["codex", "exchange"],
  ["codex", "poll-callback"],
  ["kiro", "poll"],
  ["windsurf", "import-token"],
]) {
  test(`HTTP ${provider}/${action} resets existing token lifetime and errors`, async (t) => {
    const row = await seed(provider);
    const config = getProvider(provider);
    t.mock.method(config, "mapTokens", () => grant());
    if (config.postExchange) t.mock.method(config, "postExchange", async () => ({}));
    if (config.exchangeToken)
      t.mock.method(config, "exchangeToken", async () => ({ access_token: "fake" }));
    if (config.pollToken)
      t.mock.method(config, "pollToken", async () => ({
        ok: true,
        data: { access_token: "fake" },
      }));
    let closed = false;
    if (action === "poll-callback") {
      globalThis.__pkceCallbackStates[provider] = {
        callbackParams: { code: "code", state: "state" },
        state: "state",
        codeVerifier: "verifier",
        redirectUri: "http://localhost/callback",
        close: () => {
          closed = true;
        },
      };
      t.after(() => {
        delete globalThis.__pkceCallbackStates[provider];
      });
    }
    const response = await route.POST(
      new Request(`http://localhost/api/oauth/${provider}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          connectionId: row.id,
          code: "code",
          codeVerifier: "verifier",
          redirectUri: "http://localhost/callback",
          deviceCode: "device",
          token: "test-import-token-long-enough",
        }),
      }),
      { params: Promise.resolve({ provider, action }) }
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.success, true, JSON.stringify(body));
    assert.equal(body.connection.id, row.id);
    await assertFresh(row.id);
    if (action === "poll-callback") assert.equal(closed, true);
  });
}

test("concurrent reauthentication keeps accounts and unknown expiry isolated", async () => {
  const a = await seed("codex", "a");
  const b = await seed("codex", "b");
  await Promise.all([
    persistOAuthConnection("codex", grant("a"), a.id),
    persistOAuthConnection("codex", grant("b", null), b.id),
  ]);
  await assertFresh(a.id);
  await assertFresh(b.id, "b", false);
  assert.equal((await db.getProviderConnections({ provider: "codex" })).length, 2);
});

test("public ticket mode keeps implicit accounts separate and resets only the bound account", async () => {
  const row = await seed("codex");
  const created = await persistOAuthConnection("codex", grant(), undefined, {
    allowImplicitMatch: false,
  });
  assert.notEqual(created.id, row.id);
  assert.equal((await db.getProviderConnectionById(row.id))!.tokenExpiresAt, staleExpiry);
  await persistOAuthConnection("codex", grant(), row.id, { allowImplicitMatch: false });
  await assertFresh(row.id);
  assert.equal((await db.getProviderConnections({ provider: "codex" })).length, 2);
});

test("reauthentication survives a terminal result from an already-running health refresh", async (t) => {
  const row = await seed("codex", "race");
  await db.updateProviderConnection(row.id, { isActive: true, testStatus: "active" });
  const staleSnapshot = (await db.getProviderConnectionById(row.id))!;
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    // A new sign-in completes while the old grant is still in flight.
    await persistOAuthConnection("codex", grant("race"), row.id);
    return Response.json(
      { error: "invalid_grant", code: "refresh_token_invalidated" },
      { status: 400 }
    );
  });
  await checkConnection(staleSnapshot);
  assert.equal(calls, 1);
  await assertFresh(row.id, "race");
});
