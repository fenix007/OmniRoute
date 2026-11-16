import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-provider-model-routes-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const modelsDb = await import("../../src/lib/db/models.ts");
const providerModelsRoute = await import("../../src/app/api/providers/[id]/models/route.ts");
const antigravityVersion = await import("../../open-sse/services/antigravityVersion.ts");
const providerRegistry = await import("../../open-sse/config/providerRegistry.ts");

const originalFetch = globalThis.fetch;
const originalAllowPrivateProviderUrls = process.env.OMNIROUTE_ALLOW_PRIVATE_PROVIDER_URLS;

async function resetStorage() {
  globalThis.fetch = originalFetch;
  if (originalAllowPrivateProviderUrls === undefined) {
    delete process.env.OMNIROUTE_ALLOW_PRIVATE_PROVIDER_URLS;
  } else {
    process.env.OMNIROUTE_ALLOW_PRIVATE_PROVIDER_URLS = originalAllowPrivateProviderUrls;
  }
  antigravityVersion.clearAntigravityVersionCache();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function seedConnection(provider, overrides = {}) {
  return providersDb.createProviderConnection({
    provider,
    authType: overrides.authType || "apikey",
    name: overrides.name || `${provider}-${Math.random().toString(16).slice(2, 8)}`,
    apiKey: overrides.apiKey,
    accessToken: overrides.accessToken,
    projectId: overrides.projectId,
    isActive: overrides.isActive ?? true,
    testStatus: overrides.testStatus || "active",
    providerSpecificData: overrides.providerSpecificData || {},
  });
}

async function callRoute(connectionId, search = "") {
  return providerModelsRoute.GET(
    new Request(`http://localhost/api/providers/${connectionId}/models${search}`),
    { params: { id: connectionId } }
  );
}

test.beforeEach(async () => {
  await resetStorage();
});

test("xAI OAuth discovers the live catalog with its access token instead of the static fallback", async () => {
  const connection = await seedConnection("xai-oauth", {
    authType: "oauth",
    accessToken: "test-xai-oauth-token",
  });
  const calls: Array<{ url: string; authorization: string | null }> = [];
  globalThis.fetch = async (url, init) => {
    calls.push({
      url: String(url),
      authorization: new Headers(init?.headers).get("Authorization"),
    });
    return Response.json({
      data: [
        { id: "grok-4.6", owned_by: "xai" },
        { id: "grok-4.7", owned_by: "xai" },
        { id: "grok-imagine-image", owned_by: "xai" },
      ],
    });
  };

  const response = await callRoute(connection.id, "?refresh=true");
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.source, "api");
  assert.equal(body.warning, undefined);
  assert.deepEqual(calls, [
    {
      url: "https://api.x.ai/v1/models",
      authorization: "Bearer test-xai-oauth-token",
    },
  ]);
  assert.deepEqual(
    body.models.map((model) => model.id),
    ["grok-4.6", "grok-4.7", "grok-imagine-image"]
  );
  const cached = await modelsDb.getSyncedAvailableModels("xai-oauth");
  assert.ok(cached.some((model) => model.id === "grok-4.7"));
});

test.after(async () => {
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});
