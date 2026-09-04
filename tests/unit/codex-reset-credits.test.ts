import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeManagementSessionRequest } from "../helpers/managementSession.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-codex-reset-credits-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "test-codex-reset-credits-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const resetCredits = await import("../../src/lib/usage/codexResetCredits.ts");
const resetCreditsRoute =
  await import("../../src/app/api/usage/[connectionId]/codex-reset-credits/route.ts");
const consumeResetCreditRoute = await import("../../src/app/api/usage/codex-reset-credit/route.ts");

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const originalFetch = globalThis.fetch;
const originalInitialPassword = process.env.INITIAL_PASSWORD;
const originalJwtSecret = process.env.JWT_SECRET;
const originalRequireApiKey = process.env.REQUIRE_API_KEY;
type QuotaUsageRecord = Record<string, { used?: unknown } | undefined>;

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function createCodexConnection(overrides: Record<string, unknown> = {}) {
  return providersDb.createProviderConnection({
    provider: "codex",
    authType: "oauth",
    name: `Codex Reset ${Date.now()} ${Math.random()}`,
    email: `codex-${Date.now()}-${Math.random()}@example.test`,
    accessToken: "codex-access-token",
    refreshToken: "codex-refresh-token",
    providerSpecificData: { workspaceId: "workspace-123" },
    ...overrides,
  });
}

test.beforeEach(async () => {
  globalThis.fetch = originalFetch;
  delete process.env.INITIAL_PASSWORD;
  delete process.env.REQUIRE_API_KEY;
  await resetStorage();
});

test.after(async () => {
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });

  if (originalInitialPassword === undefined) delete process.env.INITIAL_PASSWORD;
  else process.env.INITIAL_PASSWORD = originalInitialPassword;
  if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalJwtSecret;
  if (originalRequireApiKey === undefined) delete process.env.REQUIRE_API_KEY;
  else process.env.REQUIRE_API_KEY = originalRequireApiKey;
});

test("consumeCodexResetCredit selects the earliest-expiring credit, then refreshes usage", async () => {
  const connection = (await createCodexConnection()) as { id: string };
  const calls: Array<{ url: string; init: RequestInit }> = [];

  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });

    if (String(url).endsWith("/rate-limit-reset-credits")) {
      assert.equal(init.method, "GET");
      assert.equal((init.headers as Record<string, string>)["chatgpt-account-id"], "workspace-123");
      return new Response(
        JSON.stringify({
          credits: [
            { id: "credit-unknown", status: "available" },
            {
              id: "credit-later",
              status: "available",
              expires_at: "2099-10-04T04:18:25Z",
            },
            {
              id: "credit-earliest",
              status: "available",
              expires_at: "2099-09-21T02:16:00Z",
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      );
    }

    if (String(url).includes("/rate-limit-reset-credits/consume")) {
      assert.equal((init.headers as Record<string, string>)["chatgpt-account-id"], "workspace-123");
      assert.deepEqual(JSON.parse(String(init.body)), {
        redeem_request_id: "redeem-1",
        credit_id: "credit-earliest",
      });
      return new Response(JSON.stringify({ code: "reset" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (String(url).includes("/backend-api/wham/usage")) {
      return new Response(
        JSON.stringify({
          plan_type: "plus",
          rate_limit: {
            primary_window: { used_percent: 0 },
            secondary_window: { used_percent: 40 },
          },
          rate_limit_reset_credits: { available_count: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    return new Response("unexpected", { status: 500 });
  };

  const result = await resetCredits.consumeCodexResetCredit(connection.id, "redeem-1");
  const refreshedQuotas = result.usage.quotas as QuotaUsageRecord;

  assert.equal(result.outcome, "reset");
  assert.equal(result.usage.plan, "plus");
  assert.equal(refreshedQuotas.weekly?.used, 40);
  assert.equal(
    calls.some((call) => call.url.endsWith("/rate-limit-reset-credits")),
    true
  );
  assert.equal(
    calls.some((call) => call.url.includes("/rate-limit-reset-credits/consume")),
    true
  );
});

test("consumeCodexResetCredit accepts alreadyRedeemed as success", async () => {
  const connection = (await createCodexConnection()) as { id: string };

  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/rate-limit-reset-credits")) {
      return new Response(JSON.stringify({ credits: [{ credit_id: "credit-456" }] }), {
        status: 200,
      });
    }
    if (String(url).includes("/rate-limit-reset-credits/consume")) {
      return new Response(JSON.stringify({ code: "alreadyRedeemed" }), { status: 200 });
    }
    if (String(url).includes("/backend-api/wham/usage")) {
      return new Response(
        JSON.stringify({
          rate_limit: { primary_window: { used_percent: 5 } },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response("unexpected", { status: 500 });
  };

  const result = await resetCredits.consumeCodexResetCredit(connection.id, "redeem-2");
  assert.equal(result.outcome, "alreadyRedeemed");
});

test("consumeCodexResetCredit refuses to spend a replacement credit", async () => {
  const connection = (await createCodexConnection()) as { id: string };
  const calls: Array<{ url: string; init: RequestInit }> = [];

  globalThis.fetch = (async (input, init = {}) => {
    calls.push({ url: String(input), init });
    return new Response(
      JSON.stringify({
        credits: [
          {
            id: "replacement-credit",
            status: "available",
            expires_at: "2099-10-04T04:18:25Z",
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  await assert.rejects(
    () =>
      resetCredits.consumeCodexResetCredit(
        connection.id,
        "redeem-stale-selection",
        "2099-09-21T02:16:00.000Z"
      ),
    (error: unknown) =>
      error instanceof resetCredits.CodexResetCreditError &&
      error.status === 409 &&
      error.code === "credit_changed"
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.init.method, "GET");
});

test("listCodexResetCredits returns only redeemable credits with normalized expiries", async () => {
  const connection = (await createCodexConnection()) as { id: string };

  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/rate-limit-reset-credits")) {
      return new Response(
        JSON.stringify({
          available_count: 99,
          credits: [
            {
              id: "credit-snake-case",
              status: "available",
              expires_at: "2099-10-04T04:18:25+03:00",
              title: "must not leak",
              profile: { email: "secret@example.test" },
            },
            {
              creditId: "credit-camel-case",
              available: true,
              expiresAt: "2099-09-21T02:16:00.000Z",
              token: "must not leak",
            },
            {
              id: "credit-redeemed",
              status: "redeemed",
              expires_at: "2099-11-01T00:00:00Z",
            },
            {
              id: "credit-expired",
              status: "available",
              expires_at: "2020-01-01T00:00:00Z",
            },
            {
              id: "credit-invalid-expiry",
              status: "available",
              expires_at: "not-a-date",
            },
            { status: "available", expires_at: "2099-12-01T00:00:00Z" },
          ],
        }),
        { status: 200 }
      );
    }
    return new Response("unexpected", { status: 500 });
  };

  const result = await resetCredits.listCodexResetCredits(connection.id);

  assert.deepEqual(result, {
    availableCount: 3,
    credits: [
      { expiresAt: "2099-09-21T02:16:00.000Z" },
      { expiresAt: "2099-10-04T01:18:25.000Z" },
      { expiresAt: null },
    ],
  });
  assert.equal(JSON.stringify(result).includes("credit-"), false);
  assert.equal(JSON.stringify(result).includes("secret@example.test"), false);
  assert.equal(JSON.stringify(result).includes("must not leak"), false);
});

test("listCodexResetCredits rejects non-Codex connections and sanitizes upstream failures", async () => {
  const wrongProvider = (await createCodexConnection({
    provider: "claude",
    providerSpecificData: {},
  })) as { id: string };

  await assert.rejects(
    () => resetCredits.listCodexResetCredits(wrongProvider.id),
    (error: unknown) =>
      error instanceof resetCredits.CodexResetCreditError &&
      error.status === 400 &&
      error.code === "codex_provider_required"
  );

  const codex = (await createCodexConnection()) as { id: string };
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ token: "upstream-secret", error: "sensitive detail" }), {
      status: 429,
    });

  await assert.rejects(
    () => resetCredits.listCodexResetCredits(codex.id),
    (error: unknown) =>
      error instanceof resetCredits.CodexResetCreditError &&
      error.status === 502 &&
      error.code === "codex_reset_credit_upstream_error" &&
      error.message === "Codex reset-credit API request failed."
  );
});

test("Codex reset-credit expiry route returns only the public response contract", async () => {
  const connection = (await createCodexConnection()) as { id: string };

  globalThis.fetch = async () =>
    Response.json({
      credits: [
        {
          id: "private-credit-id",
          status: "available",
          expires_at: "2099-10-04T04:18:25Z",
          title: "private-title",
        },
      ],
    });

  const response = await resetCreditsRoute.GET(
    new Request(`http://localhost/api/usage/${connection.id}/codex-reset-credits`),
    { params: Promise.resolve({ connectionId: connection.id }) }
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    availableCount: 1,
    credits: [{ expiresAt: "2099-10-04T04:18:25.000Z" }],
  });
});

test("Codex reset-credit expiry route authenticates before reading connection params", () => {
  const routePath = path.join(
    repoRoot,
    "src/app/api/usage/[connectionId]/codex-reset-credits/route.ts"
  );
  const source = fs.readFileSync(routePath, "utf8");
  const authIndex = source.indexOf("requireManagementAuth(request)");
  const paramsIndex = source.indexOf("await params");

  assert.match(source, /from "@\/lib\/api\/requireManagementAuth"/);
  assert.ok(authIndex >= 0, "GET route must enforce management auth");
  assert.ok(paramsIndex >= 0, "GET route must validate the dynamic connection id");
  assert.ok(
    authIndex < paramsIndex,
    "GET route must authenticate before reading connection params"
  );
});

test("Codex reset-credit POST rejects unauthenticated malformed requests before reading JSON", async () => {
  process.env.INITIAL_PASSWORD = "bootstrap-password";

  const response = await consumeResetCreditRoute.POST(
    new Request("http://localhost/api/usage/codex-reset-credit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{malformed-json",
    })
  );
  const body = (await response.json()) as { error?: { message?: string } };

  assert.equal(response.status, 401);
  assert.equal(body.error?.message, "Authentication required");
});

test("Codex reset-credit POST authenticates before body parsing and rejects unknown fields", async () => {
  const routePath = path.join(repoRoot, "src/app/api/usage/codex-reset-credit/route.ts");
  const source = fs.readFileSync(routePath, "utf8");
  const authIndex = source.indexOf("requireManagementAuth(request)");
  const bodyIndex = source.indexOf("request.json()");

  assert.ok(authIndex >= 0, "POST route must enforce management auth");
  assert.ok(bodyIndex >= 0, "POST route must parse its JSON body");
  assert.ok(authIndex < bodyIndex, "POST route must authenticate before reading its JSON body");

  process.env.INITIAL_PASSWORD = "bootstrap-password";
  const request = await makeManagementSessionRequest(
    "http://localhost/api/usage/codex-reset-credit",
    {
      method: "POST",
      body: {
        connectionId: "connection-123",
        idempotencyKey: "redeem-123",
        unexpected: true,
      },
    }
  );
  const response = await consumeResetCreditRoute.POST(request);

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    ok: false,
    code: "invalid_request_body",
    error: "Invalid request body.",
  });
});

for (const code of ["noCredit", "nothingToReset"]) {
  test(`consumeCodexResetCredit maps ${code} to 409`, async () => {
    const connection = (await createCodexConnection()) as { id: string };

    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/rate-limit-reset-credits")) {
        return new Response(JSON.stringify({ credits: [{ id: "credit-error" }] }), {
          status: 200,
        });
      }
      if (String(url).includes("/rate-limit-reset-credits/consume")) {
        return new Response(JSON.stringify({ code }), { status: 200 });
      }
      return new Response("unexpected", { status: 500 });
    };

    await assert.rejects(
      () => resetCredits.consumeCodexResetCredit(connection.id, `redeem-${code}`),
      (error: unknown) =>
        error instanceof resetCredits.CodexResetCreditError &&
        error.status === 409 &&
        error.code === (code === "noCredit" ? "no_credit" : "nothing_to_reset")
    );
  });
}

test("consumeCodexResetCredit rejects when the credits endpoint has no redeemable id", async () => {
  const connection = (await createCodexConnection()) as { id: string };

  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/rate-limit-reset-credits")) {
      return new Response(
        JSON.stringify({ credits: [{ id: "used-credit", status: "redeemed" }] }),
        {
          status: 200,
        }
      );
    }
    return new Response("unexpected", { status: 500 });
  };

  await assert.rejects(
    () => resetCredits.consumeCodexResetCredit(connection.id, "redeem-no-credit-id"),
    (error: unknown) =>
      error instanceof resetCredits.CodexResetCreditError &&
      error.status === 409 &&
      error.code === "no_credit"
  );
});

test("consumeCodexResetCredit rejects non-Codex and missing connections", async () => {
  await assert.rejects(
    () => resetCredits.consumeCodexResetCredit("missing", "redeem-missing"),
    (error: unknown) =>
      error instanceof resetCredits.CodexResetCreditError &&
      error.status === 404 &&
      error.code === "connection_not_found"
  );

  const connection = (await createCodexConnection({
    provider: "claude",
    providerSpecificData: {},
  })) as { id: string };

  await assert.rejects(
    () => resetCredits.consumeCodexResetCredit(connection.id, "redeem-wrong-provider"),
    (error: unknown) =>
      error instanceof resetCredits.CodexResetCreditError &&
      error.status === 400 &&
      error.code === "codex_provider_required"
  );
});
