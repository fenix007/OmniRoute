import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-oauth-management-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET ||= "oauth-management-auth-test-secret";
process.env.OMNIROUTE_DISABLE_REDIS_AUTH_CACHE = "1";
process.env.JWT_SECRET = "oauth-management-auth-jwt";
process.env.INITIAL_PASSWORD = "oauth-management-auth-password";

const core = await import("../../src/lib/db/core.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const dynamicOAuth = await import("../../src/app/api/oauth/[provider]/[action]/route.ts");
const codexImportToken = await import("../../src/app/api/oauth/codex/import-token/route.ts");
const pasteCredentials =
  await import("../../src/app/api/oauth/[provider]/paste-credentials/route.ts");
const publicRoutes = await import("../../src/shared/constants/publicApiRoutes.ts");
const authzClassify = await import("../../src/server/authz/classify.ts");
const routeGuard = await import("../../src/server/authz/routeGuard.ts");

test.before(async () => {
  await settingsDb.updateSettings({ requireLogin: true });
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

async function keys() {
  const client = await apiKeysDb.createApiKey("client", "machine-client", []);
  const manager = await apiKeysDb.createApiKey("manager", "machine-manager", ["manage"]);
  return { client: client.key, manager: manager.key };
}

function request(url: string, method: "GET" | "POST", key?: string, body?: unknown) {
  return new Request(url, {
    method,
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test("generic OAuth actions require management authorization", async () => {
  const { client, manager } = await keys();
  const params = { params: Promise.resolve({ provider: "codex", action: "authorize" }) };

  assert.equal(
    (
      await dynamicOAuth.GET(
        request("http://localhost/api/oauth/codex/authorize", "GET", client),
        params
      )
    ).status,
    403
  );
  assert.equal(
    (await dynamicOAuth.GET(request("http://localhost/api/oauth/codex/authorize", "GET"), params))
      .status,
    401
  );

  const allowed = await dynamicOAuth.GET(
    request("http://localhost/api/oauth/codex/authorize", "GET", manager),
    params
  );
  assert.equal(allowed.status, 200);
});

test("generic OAuth writes reject client keys before request validation", async () => {
  const { client, manager } = await keys();
  const params = { params: Promise.resolve({ provider: "windsurf", action: "import-token" }) };

  assert.equal(
    (
      await dynamicOAuth.POST(
        request("http://localhost/api/oauth/windsurf/import-token", "POST", client, {}),
        params
      )
    ).status,
    403
  );

  const allowed = await dynamicOAuth.POST(
    request("http://localhost/api/oauth/windsurf/import-token", "POST", manager, {}),
    params
  );
  assert.equal(allowed.status, 400);
});

test("static credential persistence routes reject client keys", async () => {
  const { client, manager } = await keys();

  assert.equal(
    (
      await codexImportToken.POST(
        request("http://localhost/api/oauth/codex/import-token", "POST", client, {})
      )
    ).status,
    403
  );
  assert.equal(
    (
      await pasteCredentials.POST(
        request("http://localhost/api/oauth/codex/paste-credentials", "POST", client, {}),
        { params: Promise.resolve({ provider: "codex" }) }
      )
    ).status,
    403
  );

  assert.equal(
    (
      await codexImportToken.POST(
        request("http://localhost/api/oauth/codex/import-token", "POST", manager, {})
      )
    ).status,
    400
  );
});

test("host credential imports reach the local-only management tier", () => {
  const paths = [
    "/api/oauth/cliproxy-import",
    "/api/oauth/cursor/auto-import",
    "/api/oauth/kiro/auto-import",
  ];

  for (const routePath of paths) {
    assert.equal(publicRoutes.isPublicApiRoute(routePath), false);
    assert.equal(authzClassify.classifyRoute(routePath, "GET").routeClass, "MANAGEMENT");
    assert.equal(routeGuard.isLocalOnlyPath(routePath), true);
  }
});
