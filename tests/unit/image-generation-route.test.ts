import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-image-route-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "image-route-test-api-key-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const imageRoute = await import("../../src/app/api/v1/images/generations/route.ts");
const providerImageRoute =
  await import("../../src/app/api/v1/providers/[provider]/images/generations/route.ts");
const imageEditRoute = await import("../../src/app/api/v1/images/edits/route.ts");
const v1ModelsCatalog = await import("../../src/app/api/v1/models/catalog.ts");

const originalFetch = globalThis.fetch;

async function resetStorage() {
  globalThis.fetch = originalFetch;
  apiKeysDb.resetApiKeyState();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  // #6303 moved this route onto the shared unified catalog (getUnifiedModelsResponse),
  // which #6408 wrapped in a 1.5s TTL response cache keyed only by (prefix, isCodex
  // client, apiKey) — NOT by DB state. Without clearing it between test cases, a test
  // running within the TTL window of a previous one gets served the previous test's
  // stale serialized catalog instead of a fresh build reflecting this test's DB state.
  v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
}

async function seedConnection(
  provider: string,
  overrides: {
    authType?: string;
    apiKey?: string | null;
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: string;
    projectId?: string;
    priority?: number;
    providerSpecificData?: Record<string, unknown>;
  } = {}
) {
  const authType = overrides.authType ?? "apikey";
  return providersDb.createProviderConnection({
    provider,
    authType,
    name: `${provider}-${Math.random().toString(16).slice(2, 8)}`,
    ...(authType === "apikey" ? { apiKey: overrides.apiKey ?? "test-key" } : {}),
    ...(overrides.accessToken ? { accessToken: overrides.accessToken } : {}),
    ...(overrides.refreshToken ? { refreshToken: overrides.refreshToken } : {}),
    ...(overrides.expiresAt ? { expiresAt: overrides.expiresAt } : {}),
    ...(overrides.projectId ? { projectId: overrides.projectId } : {}),
    ...(overrides.priority ? { priority: overrides.priority } : {}),
    isActive: true,
    testStatus: "active",
    providerSpecificData: overrides.providerSpecificData ?? {},
  });
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(() => {
  globalThis.fetch = originalFetch;
  apiKeysDb.resetApiKeyState();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("image routes expose CORS preflight handlers", async () => {
  const responses = await Promise.all([
    imageRoute.OPTIONS(),
    providerImageRoute.OPTIONS(),
    imageEditRoute.OPTIONS(),
  ]);

  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.match(response.headers.get("Access-Control-Allow-Methods") ?? "", /POST/);
    assert.equal(response.headers.get("Access-Control-Allow-Headers"), "*");
  }
});

test("v1 image models GET exposes image-only modalities for credential-backed image-only models", async () => {
  await seedConnection("topaz", { apiKey: "topaz-key" });
  await seedConnection("stability-ai", { apiKey: "stability-key" });

  const response = await imageRoute.GET();
  const body = (await response.json()) as any;
  const byId = new Map(body.data.map((item: { id: string }) => [item.id, item]));

  assert.equal(response.status, 200);
  assert.deepEqual((byId.get("topaz/topaz-enhance") as any).input_modalities, ["image"]);
  assert.deepEqual((byId.get("stability-ai/remove-background") as any).input_modalities, ["image"]);
  assert.deepEqual((byId.get("stability-ai/fast") as any).input_modalities, ["image"]);
});

test("v1 image models GET exposes current Codex image models and hides inactive providers", async () => {
  await seedConnection("codex", { apiKey: "codex-key" });

  const response = await imageRoute.GET();
  const body = (await response.json()) as { data: Array<{ id: string }> };
  const ids = body.data.map((item) => item.id);

  assert.equal(response.status, 200);
  assert.deepEqual(
    ids.filter((id) => id.startsWith("codex/")),
    ["codex/gpt-5.6-sol", "codex/gpt-5.6-terra", "codex/gpt-5.6-luna"]
  );
  assert.ok(!ids.includes("codex/gpt-5.5"));
  assert.ok(!ids.includes("openai/gpt-image-2"));
  assert.ok(!ids.some((id: string) => id.startsWith("xai/")));
});

test("v1 image generation POST accepts promptless requests for image-only models", async () => {
  await seedConnection("topaz", { apiKey: "topaz-key" });

  globalThis.fetch = async (url, options = {}) => {
    const stringUrl = String(url);
    if (stringUrl === "https://example.com/topaz-input.png") {
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }

    if (stringUrl === "https://api.topazlabs.com/image/v1/enhance") {
      const formData = options.body as FormData;
      assert.ok(formData.get("image") instanceof File);
      return new Response(new Uint8Array([7, 7, 7]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }

    throw new Error(`Unexpected URL: ${stringUrl}`);
  };

  const response = await imageRoute.POST(
    new Request("http://localhost/api/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "topaz/topaz-enhance",
        image_url: "https://example.com/topaz-input.png",
        size: "2048x2048",
        response_format: "b64_json",
      }),
    })
  );
  const body = (await response.json()) as any;

  assert.equal(response.status, 200);
  assert.equal(body.data[0].b64_json, "BwcH");
});

test("v1 image generation POST still requires prompts for text-input models", async () => {
  const response = await imageRoute.POST(
    new Request("http://localhost/api/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-image-2",
        image_url: "https://example.com/source.png",
      }),
    })
  );
  const body = (await response.json()) as any;

  assert.equal(response.status, 400);
  assert.match(body.error.message, /Prompt is required for image model: openai\/gpt-image-2/);
});

test("v1 image edit POST enforces disabled API key policy", async () => {
  const createdKey = await apiKeysDb.createApiKey("Disabled image edit key", "machine-image-edit");
  await apiKeysDb.updateApiKeyPermissions(createdKey.id, { isActive: false });

  const formData = new FormData();
  formData.set("prompt", "make the background lighter");
  formData.set("model", "cgpt-web/gpt-5.5");
  formData.set("image", new File([new Uint8Array([1, 2, 3])], "source.png", { type: "image/png" }));

  const response = await imageEditRoute.POST(
    new Request("http://localhost/api/v1/images/edits", {
      method: "POST",
      headers: { Authorization: `Bearer ${createdKey.key}` },
      body: formData,
    })
  );
  const body = (await response.json()) as any;

  assert.equal(response.status, 403);
  assert.match(body.error.message, /disabled/);
});

test("v1 image generation POST resolves proxy and executes with proxy context when credentials.connectionId exists", async () => {
  // Create a connection — it gets an auto-generated id used as credentials.connectionId
  const connection = await seedConnection("openai", { apiKey: "image-proxy-key" });

  // Set a key-level proxy for this specific connection (id = connectionId)
  await settingsDb.setProxyForLevel("key", (connection as any).id, {
    type: "http",
    host: "127.0.0.1",
    port: 1, // intentionally unreachable — proves proxy path was taken
  });

  globalThis.fetch = async () => {
    throw new Error("fetch should not be called — proxy fast-fail should trigger first");
  };

  const response = await imageRoute.POST(
    new Request("http://localhost/api/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-image-2",
        prompt: "proxy test image",
      }),
    })
  );

  assert.equal(response.status, 503);
  const body = (await response.json()) as any;
  assert.match(body.error.message, /unreachable/i);
});

test("v1 image generation POST executes directly when proxy resolution fails gracefully", async () => {
  const connection = await seedConnection("openai", { apiKey: "image-proxy-fail-key" });

  const db = core.getDbInstance();
  db.prepare(
    "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('proxyConfig', 'keys', 'corrupt-json')"
  ).run();

  globalThis.fetch = async (url) => {
    const stringUrl = String(url);
    if (stringUrl === "https://api.openai.com/v1/images/generations") {
      return new Response(
        JSON.stringify({ created: 123, data: [{ url: "https://cdn.example.com/proxy-fail.png" }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    throw new Error(`Unexpected URL: ${stringUrl}`);
  };

  const response = await imageRoute.POST(
    new Request("http://localhost/api/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-image-2",
        prompt: "proxy failover image",
      }),
    })
  );

  const body = (await response.json()) as any;
  assert.equal(response.status, 200);
  assert.equal(body.data[0].url, "https://cdn.example.com/proxy-fail.png");
});

test("v1 image generation POST executes directly when credentials.connectionId is absent (authType: none)", async () => {
  globalThis.fetch = async (url) => {
    const stringUrl = String(url);
    if (stringUrl === "http://localhost:7860/sdapi/v1/txt2img") {
      return new Response(JSON.stringify({ images: ["YmFzZTY0LWltYWdl"] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`Unexpected URL: ${stringUrl}`);
  };

  const response = await imageRoute.POST(
    new Request("http://localhost/api/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "sdwebui/stable-diffusion-v1-5",
        prompt: "no credentials test",
      }),
    })
  );

  const body = (await response.json()) as any;
  assert.equal(response.status, 200);
  assert.ok(body.data, "should have image data");
});

test("v1 image generation POST rotates to the next account after an upstream 401", async () => {
  await seedConnection("openai", { apiKey: "expired-image-key", priority: 1 });
  await seedConnection("openai", { apiKey: "healthy-image-key", priority: 2 });
  const authorizationHeaders: string[] = [];

  globalThis.fetch = async (url, options: RequestInit = {}) => {
    assert.equal(String(url), "https://api.openai.com/v1/images/generations");
    const authorization = new Headers(options.headers).get("authorization") ?? "";
    authorizationHeaders.push(authorization);
    if (authorization === "Bearer expired-image-key") {
      return new Response(JSON.stringify({ error: { message: "expired access token" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
    assert.equal(authorization, "Bearer healthy-image-key");
    return new Response(
      JSON.stringify({ created: 123, data: [{ url: "https://cdn.example.com/rotated.png" }] }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  const response = await imageRoute.POST(
    new Request("http://localhost/api/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-image-2", prompt: "rotate image account" }),
    })
  );
  const body = (await response.json()) as ImageResponseBody;

  assert.equal(response.status, 200);
  assert.equal(body.data[0].url, "https://cdn.example.com/rotated.png");
  assert.deepEqual(authorizationHeaders, ["Bearer expired-image-key", "Bearer healthy-image-key"]);
});

test("provider-scoped image generation POST uses the shared 401 account fallback", async () => {
  await seedConnection("openai", { apiKey: "provider-expired-key", priority: 1 });
  await seedConnection("openai", { apiKey: "provider-healthy-key", priority: 2 });
  const authorizationHeaders: string[] = [];

  globalThis.fetch = async (_url, options: RequestInit = {}) => {
    const authorization = new Headers(options.headers).get("authorization") ?? "";
    authorizationHeaders.push(authorization);
    if (authorization === "Bearer provider-expired-key") {
      return new Response(JSON.stringify({ error: { message: "expired access token" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({ created: 123, data: [{ url: "https://cdn.example.com/provider.png" }] }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  const response = await providerImageRoute.POST(
    new Request("http://localhost/api/v1/providers/openai/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-image-2", prompt: "provider route rotation" }),
    }),
    { params: Promise.resolve({ provider: "openai" }) }
  );

  assert.equal(response.status, 200);
  assert.deepEqual(authorizationHeaders, [
    "Bearer provider-expired-key",
    "Bearer provider-healthy-key",
  ]);
});

test("v1 image generation POST refreshes an expired Antigravity token before dispatch", async () => {
  await seedConnection("antigravity", {
    authType: "oauth",
    accessToken: "expired-antigravity-token",
    refreshToken: "valid-antigravity-refresh-token",
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
    projectId: "test-cloud-code-project",
  });
  const calls: Array<{ url: string; authorization: string }> = [];

  globalThis.fetch = async (url, options: RequestInit = {}) => {
    const stringUrl = String(url);
    const authorization = new Headers(options.headers).get("authorization") ?? "";
    calls.push({ url: stringUrl, authorization });

    if (stringUrl.includes("oauth2.googleapis.com/token")) {
      return new Response(
        JSON.stringify({
          access_token: "fresh-antigravity-token",
          expires_in: 3600,
          token_type: "Bearer",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    assert.equal(stringUrl, "https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent");
    assert.equal(authorization, "Bearer fresh-antigravity-token");
    return new Response(
      JSON.stringify({
        response: {
          candidates: [
            {
              content: {
                parts: [{ inlineData: { mimeType: "image/jpeg", data: "ZnJlc2gtaW1hZ2U=" } }],
              },
            },
          ],
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  const response = await imageRoute.POST(
    new Request("http://localhost/api/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "antigravity/gemini-3.1-flash-image",
        prompt: "refresh before image generation",
      }),
    })
  );
  const body = (await response.json()) as ImageResponseBody;

  assert.equal(response.status, 200);
  assert.equal(body.data[0].b64_json, "ZnJlc2gtaW1hZ2U=");
  assert.equal(calls.filter((call) => call.url.includes("oauth2.googleapis.com/token")).length, 1);
});
