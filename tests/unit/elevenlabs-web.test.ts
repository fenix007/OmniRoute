import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-elevenlabs-web-"));
process.env.DATA_DIR = dataDir;

const { handleAudioSpeech } = await import("../../open-sse/handlers/audioSpeech.ts");
const { parseSpeechModel } = await import("../../open-sse/config/audioRegistry.ts");
const {
  ElevenLabsWebAuthError,
  clearElevenLabsWebTokenCache,
  getElevenLabsWebIdToken,
  parseElevenLabsWebCredential,
} = await import("../../open-sse/services/elevenlabsWebAuth.ts");
const { resolvePublicCred } = await import("../../open-sse/utils/publicCreds.ts");
const { validateProviderApiKey } = await import("../../src/lib/providers/validation.ts");
const { WEB_COOKIE_PROVIDERS } = await import("../../src/shared/constants/providers.ts");
const { getWebSessionCredentialRequirement, resolveWebSessionImportApiKey } =
  await import("../../src/shared/providers/webSessionCredentials.ts");
const { resetDbInstance } = await import("../../src/lib/db/core.ts");

test.after(() => {
  resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const REFRESH_TOKEN = "AMf-vBfakeRefreshToken_0123456789abcdef";
const AUTH_USER_JSON = JSON.stringify({
  uid: "user-1",
  email: "user@example.com",
  stsTokenManager: {
    refreshToken: REFRESH_TOKEN,
    accessToken: "stale-access-token",
    expirationTime: 0,
  },
});

type Call = { url: string; init: RequestInit };

function tokenResponse(idToken: string, expiresIn = "3600") {
  return Response.json({ id_token: idToken, refresh_token: REFRESH_TOKEN, expires_in: expiresIn });
}

function mockFetch(t: test.TestContext, handler: (call: Call, index: number) => Response) {
  const calls: Call[] = [];
  t.mock.method(globalThis, "fetch", async (url: string | URL, init: RequestInit = {}) => {
    const call = { url: String(url), init };
    calls.push(call);
    return handler(call, calls.length - 1);
  });
  return calls;
}

test.beforeEach(() => clearElevenLabsWebTokenCache());

test("elevenlabs-web credential parser accepts the Local Storage entry and raw tokens", () => {
  assert.equal(parseElevenLabsWebCredential(AUTH_USER_JSON), REFRESH_TOKEN);
  assert.equal(parseElevenLabsWebCredential(`  ${REFRESH_TOKEN}  `), REFRESH_TOKEN);
  assert.equal(parseElevenLabsWebCredential(`refreshToken=${REFRESH_TOKEN}`), REFRESH_TOKEN);
  assert.equal(parseElevenLabsWebCredential(`"${REFRESH_TOKEN}"`), REFRESH_TOKEN);
  assert.equal(parseElevenLabsWebCredential('{"stsTokenManager":{}}'), null);
  assert.equal(parseElevenLabsWebCredential("{not json"), null);
  assert.equal(parseElevenLabsWebCredential("session=abc; other=def"), null);
  assert.equal(parseElevenLabsWebCredential(""), null);
});

test("elevenlabs-web is a token-kind web-session provider with speech models", () => {
  assert.ok(WEB_COOKIE_PROVIDERS["elevenlabs-web"]);
  const requirement = getWebSessionCredentialRequirement("elevenlabs-web");
  assert.equal(requirement?.kind, "token");
  assert.equal(resolveWebSessionImportApiKey(requirement, ` ${AUTH_USER_JSON} `), AUTH_USER_JSON);
  assert.deepEqual(parseSpeechModel("elevenlabs-web/eleven_v4"), {
    provider: "elevenlabs-web",
    model: "eleven_v4",
  });
});

test("ID tokens are exchanged via Secure Token, cached and de-duplicated", async (t) => {
  const calls = mockFetch(t, () => tokenResponse("id-token-1"));

  const [first, concurrent] = await Promise.all([
    getElevenLabsWebIdToken(AUTH_USER_JSON),
    getElevenLabsWebIdToken(REFRESH_TOKEN),
  ]);
  const cached = await getElevenLabsWebIdToken(AUTH_USER_JSON);

  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, "https://securetoken.googleapis.com/v1/token");
  assert.equal(url.searchParams.get("key"), resolvePublicCred("elevenlabs_fb"));
  const form = new URLSearchParams(String(calls[0].init.body));
  assert.equal(form.get("grant_type"), "refresh_token");
  assert.equal(form.get("refresh_token"), REFRESH_TOKEN);
  assert.equal(first.idToken, "id-token-1");
  assert.equal(first.cached, false);
  assert.equal(concurrent.idToken, "id-token-1");
  assert.equal(cached.cached, true);
});

test("near-expiry and forced refreshes request a new ID token", async (t) => {
  let now = 1_000_000;
  const calls = mockFetch(t, (_call, index) => tokenResponse(`id-token-${index + 1}`, "600"));

  await getElevenLabsWebIdToken(REFRESH_TOKEN, { now: () => now });
  now += 6 * 60_000;
  const renewed = await getElevenLabsWebIdToken(REFRESH_TOKEN, { now: () => now });
  const forced = await getElevenLabsWebIdToken(REFRESH_TOKEN, {
    now: () => now,
    forceRefresh: true,
  });

  assert.equal(calls.length, 3);
  assert.equal(renewed.idToken, "id-token-2");
  assert.equal(forced.idToken, "id-token-3");
});

test("revoked sessions map to 401 and transient failures to 502", async (t) => {
  mockFetch(t, (_call, index) =>
    index === 0
      ? Response.json({ error: { message: "INVALID_REFRESH_TOKEN" } }, { status: 400 })
      : new Response("unavailable", { status: 503 })
  );

  await assert.rejects(getElevenLabsWebIdToken(REFRESH_TOKEN), (error: unknown) => {
    assert.ok(error instanceof ElevenLabsWebAuthError);
    assert.equal(error.status, 401);
    assert.match(error.message, /Re-import/);
    return true;
  });
  await assert.rejects(getElevenLabsWebIdToken(REFRESH_TOKEN), { status: 502 });
  await assert.rejects(getElevenLabsWebIdToken("bad"), { status: 401 });
});

test("elevenlabs-web speech streams audio with the Firebase ID token", async (t) => {
  const calls = mockFetch(t, (call) =>
    call.url.startsWith("https://securetoken.googleapis.com/")
      ? tokenResponse("id-token-1")
      : new Response(new Uint8Array([7, 8, 9]), { headers: { "content-type": "audio/mpeg" } })
  );

  const response = await handleAudioSpeech({
    body: {
      model: "elevenlabs-web/eleven_v4",
      input: "[whispering] Привет",
      voice: "JBFqnCBsd6RMkjVDRZzb",
      voice_settings: { stability: 0.5 },
      language_code: "ru",
    },
    credentials: { apiKey: AUTH_USER_JSON },
  });

  assert.equal(response.status, 200);
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [7, 8, 9]);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, "https://api.us.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb");
  const headers = new Headers(calls[1].init.headers);
  assert.equal(headers.get("authorization"), "Bearer id-token-1");
  assert.equal(headers.get("xi-api-key"), null);
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), {
    text: "[whispering] Привет",
    model_id: "eleven_v4",
    voice_settings: { stability: 0.5 },
    language_code: "ru",
  });
});

test("a cached ID token rejected with 401 is refreshed once", async (t) => {
  let tokenIndex = 0;
  let speechIndex = 0;
  const calls = mockFetch(t, (call) => {
    if (call.url.startsWith("https://securetoken.googleapis.com/")) {
      tokenIndex += 1;
      return tokenResponse(`id-token-${tokenIndex}`);
    }
    speechIndex += 1;
    return speechIndex === 2
      ? Response.json({ detail: { message: "token revoked" } }, { status: 401 })
      : new Response(new Uint8Array([1]), { headers: { "content-type": "audio/mpeg" } });
  });
  const request = {
    body: { model: "elevenlabs-web/eleven_v4_turbo", input: "Hello" },
    credentials: { apiKey: REFRESH_TOKEN },
  };

  assert.equal((await handleAudioSpeech(request)).status, 200);
  assert.equal((await handleAudioSpeech(request)).status, 200);

  const bearerTokens = calls
    .filter((call) => call.url.startsWith("https://api.us.elevenlabs.io/"))
    .map((call) => new Headers(call.init.headers).get("authorization"));
  assert.deepEqual(bearerTokens, ["Bearer id-token-1", "Bearer id-token-1", "Bearer id-token-2"]);
});

test("elevenlabs-web rejects invalid input before refreshing and surfaces auth failures", async (t) => {
  const calls = mockFetch(t, () =>
    Response.json({ error: { message: "TOKEN_EXPIRED" } }, { status: 400 })
  );

  const invalid = await handleAudioSpeech({
    body: { model: "elevenlabs-web/eleven_v4", input: "Hi", voice_settings: { style: 0.3 } },
    credentials: { apiKey: REFRESH_TOKEN },
  });
  assert.equal(invalid.status, 400);
  assert.equal(calls.length, 0);

  const expired = await handleAudioSpeech({
    body: { model: "elevenlabs-web/eleven_v4", input: "Hi" },
    credentials: { apiKey: REFRESH_TOKEN },
  });
  assert.equal(expired.status, 401);
  assert.match((await expired.json()).error.message, /TOKEN_EXPIRED/);
  assert.equal(calls.length, 1);
});

test("connection validation refreshes the session and probes the user endpoint", async (t) => {
  let userStatus = 200;
  const calls = mockFetch(t, (call) =>
    call.url.startsWith("https://securetoken.googleapis.com/")
      ? tokenResponse(`id-token-${calls.length}`)
      : Response.json({}, { status: userStatus })
  );

  const valid = await validateProviderApiKey({
    provider: "elevenlabs-web",
    apiKey: AUTH_USER_JSON,
  });
  assert.equal(valid.valid, true);
  const probe = calls.find((call) => call.url === "https://api.us.elevenlabs.io/v1/user");
  assert.ok(probe);
  assert.match(new Headers(probe.init.headers).get("authorization") ?? "", /^Bearer id-token-/);

  userStatus = 401;
  const expired = await validateProviderApiKey({
    provider: "elevenlabs-web",
    apiKey: AUTH_USER_JSON,
  });
  assert.equal(expired.valid, false);
  assert.equal(expired.error, "SESSION_EXPIRED");

  const malformed = await validateProviderApiKey({ provider: "elevenlabs-web", apiKey: "x" });
  assert.equal(malformed.valid, false);
  assert.equal(malformed.errorCode, "AUTH_007");
});

test("chat requests routed to elevenlabs-web are refused without any upstream call", async (t) => {
  const { getExecutor } = await import("../../open-sse/executors/index.ts");
  const calls = mockFetch(t, () => new Response("unexpected", { status: 500 }));

  const result = await getExecutor("elevenlabs-web").execute({
    model: "eleven_v4",
    body: { model: "eleven_v4", messages: [{ role: "user", content: "hi" }] },
    stream: false,
    credentials: { apiKey: AUTH_USER_JSON },
    signal: null,
  } as never);

  assert.equal(result.response.status, 400);
  assert.match((await result.response.json()).error.message, /\/v1\/audio\/speech/);
  assert.equal(calls.length, 0);
});
