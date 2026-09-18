import test from "node:test";
import assert from "node:assert/strict";

import { CodexExecutor, encodeResponseSseEvent } from "../../open-sse/executors/codex.ts";

async function withEnv<T>(entries: Record<string, string | undefined>, fn: () => T | Promise<T>) {
  const previous = new Map();
  for (const [key, value] of Object.entries(entries)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("CodexExecutor.refreshCredentials refreshes OAuth tokens and returns null without a refresh token", async () => {
  const executor = new CodexExecutor();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /auth\.openai\.com\/oauth\/token$/);
    return new Response(
      JSON.stringify({
        access_token: "new-token",
        refresh_token: "new-refresh",
        expires_in: 3600,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  try {
    assert.equal(await executor.refreshCredentials({}, null), null);
    const refreshed = await executor.refreshCredentials({ refreshToken: "refresh-me" }, null);
    assert.deepEqual(refreshed, {
      accessToken: "new-token",
      refreshToken: "new-refresh",
      expiresIn: 3600,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CodexExecutor.refreshCredentials preserves unrecoverable errors for immediate retry bail-out", async () => {
  const executor = new CodexExecutor();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ error: "invalid_grant", error_description: "Refresh token expired" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );

  try {
    const result = await executor.refreshCredentials({ refreshToken: "dead-token" }, null);
    assert.deepEqual(result, {
      error: "unrecoverable_refresh_error",
      code: "invalid_grant",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CodexExecutor maps usage_limit_reached websocket failures without explicit status to 429", () => {
  const raw = JSON.stringify({
    type: "response.failed",
    response: {
      id: "resp_usage_limit",
      status: "failed",
      error: {
        code: "usage_limit_reached",
        message: "Your weekly usage limit has been reached",
      },
    },
  });

  const result = encodeResponseSseEvent(raw);
  assert.equal(result.terminal, true);

  const dataLine = result.sse.split("\n").find((line) => line.startsWith("data: "));
  assert.ok(dataLine);
  const payload = JSON.parse(dataLine.slice("data: ".length));
  assert.equal(payload.type, "response.failed");
  assert.equal(payload.response.id, "resp_usage_limit");
  assert.equal(payload.response.error.code, "usage_limit_reached");
  assert.equal(payload.response.error.status_code, 429);
});

test("Codex internal websocket bridge secret comparison handles mismatched lengths safely", async () => {
  const { bridgeSecretMatches } =
    await import("../../src/app/api/internal/codex-responses-ws/route.ts");

  assert.equal(bridgeSecretMatches("bridge-secret", "bridge-secret"), true);
  assert.equal(bridgeSecretMatches("bridge-secret", "bridge-secret-extra"), false);
  assert.equal(bridgeSecretMatches("bridge-secret", ""), false);
});

test("Codex internal websocket bridge rejects non-object JSON payloads", async () => {
  await withEnv({ OMNIROUTE_WS_BRIDGE_SECRET: "bridge-secret" }, async () => {
    const { POST } = await import("../../src/app/api/internal/codex-responses-ws/route.ts");

    const response = await POST(
      new Request("http://omniroute.local/api/internal/codex-responses-ws", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-omniroute-ws-bridge-secret": "bridge-secret",
        },
        body: JSON.stringify(["invalid"]),
      })
    );
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.error.code, "invalid_json");
    assert.match(body.error.message, /JSON object/);
  });
});
