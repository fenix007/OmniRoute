import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-codex-inner-failover-"));
process.env.DATA_DIR = testDataDir;
process.env.API_KEY_SECRET ||= "codex-inner-failover-test-secret";

const core = await import("../../src/lib/db/core.ts");
const providers = await import("../../src/lib/db/providers.ts");
const settings = await import("../../src/lib/db/settings.ts");
const affinity = await import("../../src/lib/db/sessionAccountAffinity.ts");
const usage = await import("../../src/lib/usage/usageHistory.ts");
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.ts");

const originalFetch = globalThis.fetch;

function responseSse(text: string): Response {
  return new Response(
    [
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}`,
      "",
      `data: ${JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_failover",
          object: "response",
          model: "gpt-5.6-sol",
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text }],
            },
          ],
          usage: { input_tokens: 8, output_tokens: 2 },
        },
      })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n"),
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );
}

async function seedCodex(name: string, priority: number) {
  const providerSpecificData = { workspaceId: `workspace-${name}` };
  const connection = await providers.createProviderConnection({
    provider: "codex",
    authType: "oauth",
    name,
    email: `${name}@example.com`,
    accessToken: `token-${name}`,
    refreshToken: `refresh-${name}`,
    isActive: true,
    testStatus: "active",
    priority,
    providerSpecificData,
  });
  if (!connection || typeof connection.id !== "string") {
    throw new Error(`Failed to seed Codex connection ${name}`);
  }
  return { ...connection, id: connection.id, providerSpecificData };
}

async function waitForUsage(sessionHash: string) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const rows = await usage.getUsageHistory({ provider: "codex" });
    const row = rows.find((candidate) => candidate.sessionHash === sessionHash);
    if (row) return row;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return null;
}

test.after(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

async function exerciseInnerFailover(stream: boolean, sessionHash: string) {
  await settings.updateSettings({
    fallbackStrategy: "fill-first",
    codexSessionAffinityTtlMs: 60_000,
  });
  const mode = stream ? "stream" : "json";
  const first = await seedCodex(`${mode}-first`, 1);
  const blocked = await seedCodex(`${mode}-blocked`, 2);
  const next = await seedCodex(`${mode}-next`, 3);
  const sessionKey = `session:sha256:${sessionHash}`;
  affinity.upsertSessionAccountAffinity(sessionKey, "codex", first.id, Date.now(), 60_000);

  const fetchTokens: string[] = [];
  globalThis.fetch = async (_url, init) => {
    const headers = new Headers(init?.headers);
    fetchTokens.push(headers.get("authorization") ?? "");
    if (fetchTokens.length === 1) {
      return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "1" },
      });
    }
    return responseSse("recovered");
  };

  const body = { model: "codex/gpt-5.6-sol", stream, input: "hello" };
  const credentials = {
    ...first,
    connectionId: first.id,
    providerSpecificData: first.providerSpecificData ?? {},
  };
  const result = await handleChatCore({
    body: structuredClone(body),
    modelInfo: { provider: "codex", model: "gpt-5.6-sol", extendedContext: false },
    credentials,
    connectionId: first.id,
    sessionRouting: {
      sessionHash,
      sessionSource: "header",
      routingReason: "affinity_reused",
      previousConnectionId: null,
    },
    allowedConnectionIds: [first.id, next.id],
    skipUpstreamRetry: true,
    apiKeyInfo: { id: "api-key", allowedConnections: [first.id, next.id] },
    clientRawRequest: {
      endpoint: "/v1/responses",
      body: structuredClone(body),
      headers: new Headers({ accept: "application/json", "x-codex-session-id": "raw-session" }),
    },
    userAgent: "unit-test",
    log: { debug() {}, info() {}, warn() {}, error() {} },
  } as Parameters<typeof handleChatCore>[0]);

  assert.ok(!(result instanceof Response));
  assert.equal(result.success, true);
  assert.ok(result.response instanceof Response);
  await result.response.text();
  assert.equal(fetchTokens.length, 2);
  assert.equal(
    credentials.connectionId,
    next.id,
    JSON.stringify({ first: first.id, blocked: blocked.id, next: next.id })
  );
  assert.equal(
    affinity.getSessionAccountAffinity(sessionKey, "codex", 60_000)?.connectionId,
    next.id
  );

  const row = await waitForUsage(sessionHash);
  assert.equal(row?.connectionId, next.id);
  assert.equal(row?.sessionHash, sessionHash);
  assert.equal(row?.routingReason, "affinity_reassigned");
  assert.equal(row?.previousConnectionId, first.id);
}

test("inner Codex 429 keeps session/account scope and persists the final account", async () => {
  await exerciseInnerFailover(false, "f".repeat(64));
});

test("streaming inner Codex 429 persists final routing after the response is drained", async () => {
  await exerciseInnerFailover(true, "e".repeat(64));
});

test("dedup waiter keeps its session identity but records the owner's execution account", async () => {
  const owner = await seedCodex("dedup-owner", 1);
  const waiter = await seedCodex("dedup-waiter", 2);
  const ownerHash = "a".repeat(64);
  const waiterHash = "b".repeat(64);
  const waiterSessionKey = `session:sha256:${waiterHash}`;
  affinity.upsertSessionAccountAffinity(waiterSessionKey, "codex", waiter.id, Date.now(), 60_000);

  let releaseFetch!: () => void;
  let signalFetchStarted!: () => void;
  const fetchStarted = new Promise<void>((resolve) => {
    signalFetchStarted = resolve;
  });
  const fetchGate = new Promise<void>((resolve) => {
    releaseFetch = resolve;
  });
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount++;
    signalFetchStarted();
    await fetchGate;
    return responseSse("shared");
  };

  const body = {
    model: "codex/gpt-5.6-sol",
    stream: false,
    temperature: 0,
    input: "deduplicate me",
  };
  const invoke = (connection: typeof owner, sessionHash: string) =>
    handleChatCore({
      body: structuredClone(body),
      modelInfo: { provider: "codex", model: "gpt-5.6-sol", extendedContext: false },
      credentials: {
        ...connection,
        connectionId: connection.id,
        providerSpecificData: connection.providerSpecificData ?? {},
      },
      connectionId: connection.id,
      sessionRouting: {
        sessionHash,
        sessionSource: "header",
        routingReason: "affinity_reused",
        previousConnectionId: null,
      },
      allowedConnectionIds: [owner.id, waiter.id],
      apiKeyInfo: { id: "dedup-api-key", allowedConnections: [owner.id, waiter.id] },
      onRequestSuccess:
        connection.id === waiter.id
          ? () => new Promise<void>((resolve) => setTimeout(resolve, 10))
          : undefined,
      clientRawRequest: {
        endpoint: "/v1/responses",
        body: structuredClone(body),
        headers: new Headers({
          accept: "application/json",
          "x-codex-session-id": sessionHash,
        }),
      },
      userAgent: "unit-test",
      log: { debug() {}, info() {}, warn() {}, error() {} },
    } as Parameters<typeof handleChatCore>[0]);

  const ownerResultPromise = invoke(owner, ownerHash);
  await fetchStarted;
  await new Promise((resolve) => setTimeout(resolve, 5));
  const waiterResultPromise = invoke(waiter, waiterHash);
  await new Promise((resolve) => setTimeout(resolve, 20));
  releaseFetch();

  const [ownerResult, waiterResult] = await Promise.all([ownerResultPromise, waiterResultPromise]);
  assert.ok(!(ownerResult instanceof Response));
  assert.ok(!(waiterResult instanceof Response));
  assert.equal(ownerResult.success, true);
  assert.equal(waiterResult.success, true);
  assert.equal(fetchCount, 1);

  const ownerRow = await waitForUsage(ownerHash);
  const waiterRow = await waitForUsage(waiterHash);
  assert.equal(ownerRow?.connectionId, owner.id);
  assert.equal(waiterRow?.connectionId, owner.id);
  assert.equal(waiterRow?.sessionSource, "header");
  assert.equal(waiterRow?.routingReason, "deduplicated");
  assert.equal(waiterRow?.previousConnectionId, waiter.id);
  assert.equal(
    affinity.getSessionAccountAffinity(waiterSessionKey, "codex", 60_000)?.connectionId,
    waiter.id
  );
});

test("inner Codex 429 cannot leave a scope restricted to the selected connection", async () => {
  for (const stream of [false, true]) {
    const selected = await seedCodex(`fixed-${stream}`, 1);
    await seedCodex(`fixed-spare-${stream}`, 2);
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "1" },
      });
    };
    const body = { model: "codex/gpt-5.6-sol", stream, input: `fixed account ${stream}` };
    const result = await handleChatCore({
      body,
      modelInfo: { provider: "codex", model: "gpt-5.6-sol", extendedContext: false },
      credentials: { ...selected, connectionId: selected.id },
      connectionId: selected.id,
      allowedConnectionIds: [selected.id],
      skipUpstreamRetry: true,
      apiKeyInfo: { id: "fixed-key" },
      clientRawRequest: { endpoint: "/v1/responses", body, headers: new Headers() },
      log: { debug() {}, info() {}, warn() {}, error() {} },
    } as Parameters<typeof handleChatCore>[0]);
    assert.ok(!(result instanceof Response));
    assert.equal(result.success, false);
    assert.equal(result.status, 429);
    await result.response?.text();
    assert.equal(calls, 1, "the spare account must not be used");
  }
});
