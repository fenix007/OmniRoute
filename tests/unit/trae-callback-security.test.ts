import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SignJWT } from "jose";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-trae-callback-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "trae-callback-test-secret";
process.env.JWT_SECRET = "trae-callback-jwt-secret";
process.env.INITIAL_PASSWORD = "trae-callback-initial-password";

const core = await import("../../src/lib/db/core.ts");
const providers = await import("../../src/lib/db/providers.ts");
const settings = await import("../../src/lib/db/settings.ts");
const callbackState = await import("../../src/lib/oauth/traeCallbackState.ts");
const { parseTraeCallbackQuery } = await import("../../src/app/authorize/parseCallback.ts");
const callbackRoute = await import("../../src/app/authorize/route.ts");
const callbackStateRoute = await import("../../src/app/api/oauth/trae/callback-state/route.ts");
const importRoute = await import("../../src/app/api/oauth/trae/import/route.ts");

function callbackUrl(state?: string, host = "https://api-us-east.trae.ai"): string {
  const userJwt = JSON.stringify({
    ClientID: "en1oxy7wnw8j9n",
    Token: "TEST_ACCESS_TOKEN",
    RefreshToken: "TEST_REFRESH_TOKEN",
  });
  const params = new URLSearchParams({ userJwt, host });
  if (state) params.set("loginTraceID", state);
  return `http://127.0.0.1:20128/authorize?${params.toString()}`;
}

async function traeConnectionCount(): Promise<number> {
  return (await providers.getProviderConnections({ provider: "trae" })).length;
}

async function dashboardCookie(): Promise<string> {
  const token = await new SignJWT({ authenticated: true })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  return `auth_token=${token}`;
}

test.beforeEach(async () => {
  core.resetDbInstance();
  callbackState.resetTraeCallbackStatesForTests();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  await settings.updateSettings({ requireLogin: true });
});

test.after(() => {
  core.resetDbInstance();
  callbackState.resetTraeCallbackStatesForTests();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("Trae callback does not persist credentials without an issued state", async () => {
  const response = await callbackRoute.GET(new Request(callbackUrl()));
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /Invalid or expired callback state/);
  assert.equal(await traeConnectionCount(), 0);
});

test("Trae callback state issuance requires management authentication", async () => {
  const anonymous = await callbackStateRoute.POST(
    new Request("http://localhost/api/oauth/trae/callback-state", { method: "POST" })
  );
  assert.equal(anonymous.status, 401);

  const authenticated = await callbackStateRoute.POST(
    new Request("http://localhost/api/oauth/trae/callback-state", {
      method: "POST",
      headers: { cookie: await dashboardCookie() },
    })
  );
  const body = await authenticated.json();
  assert.equal(authenticated.status, 200);
  assert.equal(authenticated.headers.get("cache-control"), "no-store");
  assert.match(body.state, /^[0-9a-f-]{36}$/);
});

test("Trae token import requires management authentication", async () => {
  const response = await importRoute.POST(
    new Request("http://localhost/api/oauth/trae/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accessToken: "TEST_ACCESS_TOKEN" }),
    })
  );

  assert.equal(response.status, 401);
  assert.equal(await traeConnectionCount(), 0);
});

test("Trae callback persists once and rejects replay of the same state", async () => {
  const { state } = callbackState.issueTraeCallbackState();

  const first = await callbackRoute.GET(new Request(callbackUrl(state)));
  assert.match(await first.text(), /Trae authorization ✓/);
  assert.equal(await traeConnectionCount(), 1);

  const replay = await callbackRoute.GET(new Request(callbackUrl(state)));
  assert.match(await replay.text(), /Invalid or expired callback state/);
  assert.equal(await traeConnectionCount(), 1);
});

test("Trae callback rejects a loopback upstream host before persistence", async () => {
  const { state } = callbackState.issueTraeCallbackState();
  const response = await callbackRoute.GET(new Request(callbackUrl(state, "http://127.0.0.1:1")));

  assert.match(await response.text(), /Invalid Trae API host/);
  assert.equal(await traeConnectionCount(), 0);
});

test("Trae callback parser rejects non-Trae and non-HTTPS API hosts", () => {
  const userJwt = JSON.stringify({ ClientID: "en1oxy7wnw8j9n", Token: "T" });
  for (const host of [
    "http://127.0.0.1:1",
    "https://api-us-east.trae.ai.evil.example",
    "http://api-us-east.trae.ai",
  ]) {
    const result = parseTraeCallbackQuery(new URLSearchParams({ userJwt, host }));
    assert.deepEqual(result, { ok: false, error: "Invalid Trae API host" });
  }
});

test("Trae callback parser rejects malformed userInfo instead of silently accepting it", () => {
  const userJwt = JSON.stringify({ ClientID: "en1oxy7wnw8j9n", Token: "T" });
  const result = parseTraeCallbackQuery(new URLSearchParams({ userJwt, userInfo: "not-json{{{" }));
  assert.deepEqual(result, { ok: false, error: "Malformed userInfo payload" });
});
