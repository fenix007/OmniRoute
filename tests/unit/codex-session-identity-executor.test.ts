import assert from "node:assert/strict";
import test from "node:test";

import {
  __setCodexWebSocketTransportForTesting,
  CodexExecutor,
} from "../../open-sse/executors/codex.ts";

type MockCodexWebSocket = {
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: { message?: string }) => void) | null;
  onclose: (() => void) | null;
};

test.afterEach(() => {
  __setCodexWebSocketTransportForTesting(undefined);
});

test("Codex HTTP uses header-only identity and preserves an explicit cache key", async () => {
  const executor = new CodexExecutor();
  const originalFetch = globalThis.fetch;
  const captured: {
    body: Record<string, unknown> | null;
    headers: Headers | null;
  } = { body: null, headers: null };

  globalThis.fetch = async (_url, init) => {
    captured.headers = new Headers(init?.headers as HeadersInit);
    captured.body = JSON.parse(String(init?.body || "{}"));
    return new Response(JSON.stringify({ id: "resp_identity", object: "response" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    await executor.execute({
      model: "gpt-5.5",
      body: {
        model: "gpt-5.5",
        prompt_cache_key: "client-cache-key",
        input: [{ role: "user", content: "hello" }],
      },
      stream: true,
      credentials: {
        accessToken: "codex-token",
        providerSpecificData: { workspaceId: "workspace-1" },
      },
      clientHeaders: { "x-omniroute-session-id": "header-session-http" },
    });

    assert.equal(captured.headers?.get("session_id"), "header-session-http");
    assert.equal(captured.headers?.get("x-client-request-id"), "header-session-http");
    assert.equal(captured.body?.prompt_cache_key, "client-cache-key");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Codex HTTP does not use account workspace as a session fallback", async () => {
  const executor = new CodexExecutor();
  const originalFetch = globalThis.fetch;
  const captured: {
    body: Record<string, unknown> | null;
    headers: Headers | null;
  } = { body: null, headers: null };

  globalThis.fetch = async (_url, init) => {
    captured.headers = new Headers(init?.headers as HeadersInit);
    captured.body = JSON.parse(String(init?.body || "{}"));
    return new Response(JSON.stringify({ id: "resp_identity", object: "response" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    await executor.execute({
      model: "gpt-5.5",
      body: { model: "gpt-5.5", input: [{ role: "user", content: "hello" }] },
      stream: true,
      credentials: {
        accessToken: "codex-token",
        providerSpecificData: { workspaceId: "workspace-1" },
      },
    });

    assert.equal(captured.headers?.get("session_id"), null);
    assert.equal(captured.headers?.get("x-client-request-id"), null);
    assert.equal(captured.body?.prompt_cache_key, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Codex WebSocket uses the same header-only identity for headers and cache", async () => {
  const executor = new CodexExecutor();
  const captured: {
    body: Record<string, unknown> | null;
    headers: Record<string, string> | null;
  } = { body: null, headers: null };
  const socket: MockCodexWebSocket = {
    send(data) {
      captured.body = JSON.parse(data);
      queueMicrotask(() => {
        socket.onmessage?.({
          data: JSON.stringify({ type: "response.completed", response: { status: "completed" } }),
        });
      });
    },
    close() {},
    onmessage: null,
    onerror: null,
    onclose: null,
  };
  __setCodexWebSocketTransportForTesting(async (_url, options) => {
    captured.headers = options?.headers as Record<string, string>;
    return socket;
  });

  const result = await executor.execute({
    model: "gpt-5.5",
    body: { model: "gpt-5.5", input: [{ role: "user", content: "hello" }] },
    stream: true,
    credentials: {
      accessToken: "codex-token",
      providerSpecificData: { codexTransport: "websocket", workspaceId: "workspace-1" },
    },
    clientHeaders: { "x-codex-session-id": "header-session-ws" },
  });
  await result.response.text();

  assert.equal(captured.body?.prompt_cache_key, "header-session-ws");
  assert.equal(captured.headers?.session_id, "header-session-ws");
  assert.equal(captured.headers?.["x-client-request-id"], "header-session-ws");
});
