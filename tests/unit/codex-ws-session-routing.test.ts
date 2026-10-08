import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-codex-ws-session-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "codex-ws-session-api-key-secret";
process.env.OMNIROUTE_WS_BRIDGE_SECRET = "codex-ws-session-bridge-secret";

const coreDb = await import("../../src/lib/db/core.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const costRules = await import("../../src/domain/costRules.ts");
const rateLimiter = await import("../../src/shared/utils/rateLimiter.ts");
const { resolveSessionIdentity } = await import("../../open-sse/services/sessionIdentity.ts");
const route = await import("../../src/app/api/internal/codex-responses-ws/route.ts");

rateLimiter.setRateLimiterTestMode(true);

function getFsErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const { code } = error as { code?: unknown };
  return typeof code === "string" ? code : undefined;
}

async function resetStorage() {
  apiKeysDb.resetApiKeyState();
  costRules.resetCostData();
  coreDb.resetDbInstance();

  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      if (fs.existsSync(TEST_DATA_DIR)) {
        fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
      }
      break;
    } catch (error: unknown) {
      const code = getFsErrorCode(error);
      if ((code === "EBUSY" || code === "EPERM") && attempt < 9) {
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      } else {
        throw error;
      }
    }
  }

  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

function buildBridgeRequest(payload: Record<string, unknown>): Request {
  return new Request("http://localhost/api/internal/codex-responses-ws", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-omniroute-ws-bridge-secret": process.env.OMNIROUTE_WS_BRIDGE_SECRET as string,
    },
    body: JSON.stringify(payload),
  });
}

type PrepareResponse = {
  connectionId?: string;
  headers?: Record<string, unknown>;
  response?: Record<string, unknown>;
  sessionRouting?: {
    sessionHash?: string | null;
    sessionSource?: string;
    routingReason?: string;
    previousConnectionId?: string | null;
  };
};

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  apiKeysDb.resetApiKeyState();
  costRules.resetCostData();
  coreDb.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("WS prepare scopes a stable session to the authenticated API key and reuses its pin", async () => {
  await settingsDb.updateSettings({ codexSessionAffinityTtlMs: 30 * 60 * 1000 });
  const apiKey = await apiKeysDb.createApiKey("WS session key", "codex-ws-session-key");
  const connection = await providersDb.createProviderConnection({
    provider: "codex",
    authType: "oauth",
    email: "codex-ws-session@example.com",
    accessToken: "test-access-token",
    providerSpecificData: { workspaceId: "workspace-ws-session" },
  });
  assert.ok(connection);
  assert.equal(typeof connection.id, "string");
  const responseBody = {
    model: "gpt-5.5",
    input: [{ role: "user", content: "hello" }],
    prompt_cache_key: "client-cache-key",
  };
  const sessionId = "conversation-42";
  const expectedIdentity = resolveSessionIdentity(
    responseBody,
    { "x-codex-session-id": sessionId },
    apiKey.id
  );
  const payload = {
    action: "prepare",
    requestUrl: `/api/v1/responses?api_key=${encodeURIComponent(apiKey.key)}`,
    headers: { "x-codex-session-id": sessionId },
    response: responseBody,
  };

  const firstResponse = await route.POST(buildBridgeRequest(payload));
  const first = (await firstResponse.json()) as PrepareResponse;
  const secondResponse = await route.POST(buildBridgeRequest(payload));
  const second = (await secondResponse.json()) as PrepareResponse;

  assert.equal(firstResponse.status, 200, JSON.stringify(first));
  assert.equal(secondResponse.status, 200, JSON.stringify(second));
  assert.equal(first.connectionId, connection.id);
  assert.equal(second.connectionId, connection.id);
  assert.deepEqual(first.sessionRouting, {
    sessionHash: expectedIdentity.key?.slice("session:sha256:".length),
    sessionSource: "header",
    routingReason: "affinity_created",
    previousConnectionId: null,
  });
  assert.equal(second.sessionRouting?.sessionHash, first.sessionRouting?.sessionHash);
  assert.equal(second.sessionRouting?.sessionSource, "header");
  assert.equal(second.sessionRouting?.routingReason, "affinity_reused");
  assert.equal(second.sessionRouting?.previousConnectionId, connection.id);
  assert.equal(first.headers?.session_id, sessionId);
  assert.equal(first.response?.prompt_cache_key, "client-cache-key");
  assert.equal(JSON.stringify(first.sessionRouting).includes(sessionId), false);
});

test("WS log rejects client-shaped routing metadata and does not use duration as TTFT", async () => {
  const apiKey = await apiKeysDb.createApiKey("WS log key", "codex-ws-log-key");
  const response = await route.POST(
    buildBridgeRequest({
      action: "log",
      requestUrl: `/api/v1/responses?api_key=${encodeURIComponent(apiKey.key)}`,
      startedAt: new Date().toISOString(),
      durationMs: 456,
      status: 200,
      success: true,
      provider: "codex",
      model: "gpt-5.5",
      clientRequest: { model: "gpt-5.5", input: "hello" },
      responseBody: {
        model: "gpt-5.5",
        usage: { input_tokens: 10, output_tokens: 2 },
      },
      sessionRouting: {
        sessionHash: "raw-client-session-id",
        sessionSource: "header",
        routingReason: "affinity_reused",
      },
    })
  );

  assert.equal(response.status, 200, await response.text());
  const row = coreDb
    .getDbInstance()
    .prepare(
      `SELECT latency_ms, ttft_ms, session_hash, session_source, routing_reason
       FROM usage_history ORDER BY id DESC LIMIT 1`
    )
    .get() as Record<string, unknown>;

  assert.equal(row.latency_ms, 456);
  assert.equal(row.ttft_ms, 0);
  assert.equal(row.session_hash, null);
  assert.equal(row.session_source, null);
  assert.equal(row.routing_reason, null);
});
