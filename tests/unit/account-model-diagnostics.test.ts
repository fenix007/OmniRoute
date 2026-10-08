import test from "node:test";
import assert from "node:assert/strict";
import {
  auth,
  core,
  cleanupStorage,
  resetStorage,
  seedConnection,
  settingsDb,
} from "./_fixtures/sseAuthHarness";
import {
  getAccountModelSupport,
  saveAccountModelSupport,
  publicModelSupport,
} from "../../src/lib/db/accountModelSupport";
import {
  classifyModelSupportError,
  diagnoseAccountModel,
} from "../../src/sse/services/accountModelDiagnostics";
import { POST } from "../../src/app/api/providers/[id]/diagnose-models/route";

const originalFetch = globalThis.fetch;
const missingModel = "The model `gpt-5.5` does not exist or you do not have access to it.";
const completed = () =>
  new Response('data: {"type":"response.completed","response":{"status":"completed"}}\n\n');
test.beforeEach(async () => {
  globalThis.fetch = originalFetch;
  await resetStorage();
});
test.after(() => {
  globalThis.fetch = originalFetch;
  cleanupStorage();
});

test("persists account support across DB reopen, normalizes effort aliases and expires 404 evidence", async () => {
  const account = await seedConnection("codex", { accessToken: "test-token" });
  const result = saveAccountModelSupport("codex", account, "gpt-5.5-medium", {
    status: "unsupported",
    reason: "account_model_unsupported",
    httpStatus: 404,
  });
  core.resetDbInstance();
  assert.equal(getAccountModelSupport("codex", account, "gpt-5.5-high")?.status, "unsupported");
  assert.equal(getAccountModelSupport("cx", account, "codex/gpt-5.5")?.model, "gpt-5.5");
  assert.equal(getAccountModelSupport("codex", account, "gpt-6-sol"), null);
  assert.equal(getAccountModelSupport("codex", account, "gpt-5.5", result.expiresAt), null);
  assert.equal("identity" in publicModelSupport(result), false);
});

test("credential, workspace and plan changes invalidate account evidence", async () => {
  const account = await seedConnection("codex", {
    accessToken: "old-token",
    providerSpecificData: { workspaceId: "one", workspacePlanType: "free" },
  });
  saveAccountModelSupport("codex", account, "gpt-5.5", {
    status: "unsupported",
    reason: "account_model_unsupported",
    httpStatus: 400,
  });
  for (const changed of [
    { ...account, accessToken: "new-token" },
    { ...account, providerSpecificData: { workspaceId: "two", workspacePlanType: "free" } },
    { ...account, providerSpecificData: { workspaceId: "one", workspacePlanType: "plus" } },
  ])
    assert.equal(getAccountModelSupport("codex", changed, "gpt-5.5"), null);
});

test("auth, quota, server, generic 404 and route errors never blacklist a model", () => {
  for (const [status, message] of [
    [401, missingModel],
    [403, missingModel],
    [429, missingModel],
    [500, missingModel],
    [404, "Route not found"],
    [404, "The model does not exist"],
    [404, `Invalid API key: ${missingModel}`],
  ] as const) {
    assert.equal(classifyModelSupportError(status, message).status, "unknown");
  }
  assert.equal(classifyModelSupportError(404, missingModel).status, "unsupported");
});

test("single flight sends a synthetic wire-model prompt and reuses cached evidence", async () => {
  const account = await seedConnection("codex", {
    accessToken: "test-token",
    providerSpecificData: { workspaceId: "workspace-one" },
  });
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls++;
    const body = JSON.parse(options!.body as string);
    assert.equal(body.model, "gpt-5.5");
    assert.equal(body.input[0].content[0].text, "Reply OK.");
    assert.equal(body.store, false);
    assert.equal(new Headers(options!.headers).get("chatgpt-account-id"), "workspace-one");
    return completed();
  };
  const results = await Promise.all([
    diagnoseAccountModel("codex", account, "gpt-5.5-low"),
    diagnoseAccountModel("codex", account, "gpt-5.5-high"),
  ]);
  assert.ok(results.every((r) => r?.status === "supported"));
  assert.equal((await diagnoseAccountModel("codex", account, "gpt-5.5"))?.status, "supported");
  assert.equal(calls, 1);
});

test("preflight reuses explicit diagnosis and skips denied accounts without probing, including quota bypass", async () => {
  const denied = await seedConnection("codex", { accessToken: "denied-token", priority: 1 });
  const allowed = await seedConnection("codex", { accessToken: "allowed-token", priority: 2 });
  const calls: string[] = [];
  globalThis.fetch = async (_url, options) => {
    const bearer = new Headers(options!.headers).get("authorization")!;
    calls.push(bearer);
    return bearer.includes("denied-token")
      ? Response.json({ error: { message: missingModel } }, { status: 404 })
      : completed();
  };
  await diagnoseAccountModel("codex", denied, "gpt-5.5-medium");
  await diagnoseAccountModel("codex", allowed, "gpt-5.5-medium");
  assert.deepEqual(calls, ["Bearer denied-token", "Bearer allowed-token"]);
  calls.length = 0;
  const credentials = await auth.getProviderCredentialsWithQuotaPreflight(
    "codex",
    null,
    null,
    "gpt-5.5-medium",
    { bypassQuotaPolicy: true }
  );
  assert.equal(credentials?.connectionId, allowed.id);
  assert.deepEqual(calls, []);
  assert.equal(await auth.getProviderCredentials("codex", null, [denied.id], "gpt-5.5-high"), null);
  assert.equal(
    await auth.getProviderCredentials("codex", null, null, "gpt-5.5", {
      forcedConnectionId: denied.id,
    }),
    null
  );
  assert.equal(
    (await auth.getProviderCredentials("codex", null, [denied.id], "gpt-6-sol"))?.connectionId,
    denied.id
  );
});

test("unknown probe outcome leaves normal routing eligible", async () => {
  const account = await seedConnection("codex", { accessToken: "test-token" });
  globalThis.fetch = async () =>
    Response.json({ error: { message: "token_revoked" } }, { status: 401 });
  assert.equal((await diagnoseAccountModel("codex", account, "gpt-5.5"))?.status, "unknown");
  assert.equal(
    (await auth.getProviderCredentials("codex", null, null, "gpt-5.5"))?.connectionId,
    account.id
  );
});

test("failed SSE, split chunks, empty streams and oversized responses are classified conservatively", async () => {
  const account = await seedConnection("codex", { accessToken: "test-token" });
  const event = `data: ${JSON.stringify({ type: "response.failed", response: { error: { message: missingModel } } })}\n\n`;
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(event.slice(0, 17)));
          controller.enqueue(new TextEncoder().encode(event.slice(17)));
          controller.close();
        },
      })
    );
  assert.equal((await diagnoseAccountModel("codex", account, "gpt-5.5"))?.status, "unsupported");
  for (const body of [
    "",
    "x".repeat(65537),
    'data: {"type":"response.completed","response":{"status":"failed"}}\n\n',
  ]) {
    globalThis.fetch = async () => new Response(body);
    assert.equal(
      (await diagnoseAccountModel("codex", account, "gpt-5.5", { refresh: true }))?.status,
      "unknown"
    );
  }
});

test("uncached routing dispatches without a synthetic LLM call or invented support evidence", async () => {
  const account = await seedConnection("codex", { accessToken: "test-token" });
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("network unavailable");
  };
  const selected = await auth.getProviderCredentialsWithQuotaPreflight(
    "codex",
    null,
    null,
    "gpt-5.5",
    { bypassQuotaPolicy: true }
  );
  assert.equal(selected?.connectionId, account.id);
  assert.equal(calls, 0);
  assert.equal(getAccountModelSupport("codex", account, "gpt-5.5"), null);
});

test("concurrent probes are capped, and cache write failure does not lose the result", async () => {
  const accounts = await Promise.all(
    Array.from({ length: 5 }, () =>
      seedConnection("codex", { accessToken: `test-${Math.random()}` })
    )
  );
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    await wait;
    return completed();
  };
  const firstFour = accounts
    .slice(0, 4)
    .map((account) => diagnoseAccountModel("codex", account, "gpt-5.5"));
  assert.equal(await diagnoseAccountModel("codex", accounts[4], "gpt-5.5"), null);
  release();
  assert.ok((await Promise.all(firstFour)).every((result) => result?.status === "supported"));
  assert.equal(calls, 4);
  core.getDbInstance().exec("DROP TABLE key_value");
  assert.equal(
    saveAccountModelSupport("codex", accounts[4], "gpt-5.5", {
      status: "unsupported",
      reason: "account_model_unsupported",
      httpStatus: 404,
    }).status,
    "unsupported"
  );
});

test("aborted body read returns unknown rather than poisoning model eligibility", async () => {
  const account = await seedConnection("codex", { accessToken: "test-token" });
  const controller = new AbortController();
  globalThis.fetch = async (_url, options) =>
    new Response(
      new ReadableStream({
        start(stream) {
          options!.signal!.addEventListener("abort", () => stream.error(new Error("aborted")), {
            once: true,
          });
          controller.abort();
        },
      })
    );
  const result = await diagnoseAccountModel("codex", account, "gpt-5.5", {
    signal: controller.signal,
  });
  assert.equal(result?.status, "unknown");
  assert.equal(result?.reason, "probe_timeout_or_cancelled");
});

test("diagnostic management endpoint rejects unauthenticated requests and validates input", async () => {
  await settingsDb.updateSettings({ requireLogin: true, password: "test-password" });
  const account = await seedConnection("codex", { accessToken: "test-token" });
  const context = { params: Promise.resolve({ id: account.id }) };
  const url = `http://localhost/api/providers/${account.id}/diagnose-models`;
  const unauthorized = await POST(new Request(url, { method: "POST", body: "{}" }), context);
  assert.equal(unauthorized.status, 401);
  await settingsDb.updateSettings({ requireLogin: false, password: null });
  const invalid = await POST(
    new Request(url, { method: "POST", body: JSON.stringify({ models: [], extra: true }) }),
    context
  );
  assert.equal(invalid.status, 400);
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return completed();
  };
  const response = await POST(
    new Request(url, {
      method: "POST",
      body: JSON.stringify({ models: ["gpt-5.5-low", "gpt-5.5-high"] }),
    }),
    context
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(calls, 1);
  assert.equal(body.diagnostics.length, 1);
  assert.equal(body.diagnostics[0].status, "supported");
  assert.equal("identity" in body.diagnostics[0], false);
  assert.equal(JSON.stringify(body).includes("test-token"), false);
});
