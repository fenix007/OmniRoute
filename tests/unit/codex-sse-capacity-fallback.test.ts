// Sub-bug #3 of upstream decolua/9router#2452 (@ryanngit): Codex sometimes answers
// with HTTP 200 and a text/event-stream body whose payload carries a transient
// "model at capacity" / overloaded error mid-stream. Left unhandled, the 200
// status makes this look like a successful response — no retry, no circuit
// breaker, no combo/account fallback engages, so the client either hangs or gets
// a truncated stream while a healthy account sits idle. This must be detected and
// converted into a real error Response (503) so accountFallback.ts / combo
// routing rotates to another account.
import test from "node:test";
import assert from "node:assert/strict";

import {
  CodexExecutor,
  __setCodexWebSocketTransportForTesting,
  peekCodexSseTransientError,
} from "../../open-sse/executors/codex.ts";

test.afterEach(() => {
  __setCodexWebSocketTransportForTesting(undefined);
});

function sseStreamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[i]));
      i++;
    },
  });
}

const overloadMessage = "Our servers are currently overloaded. Please try again later.";
const overloadData = JSON.stringify({
  type: "response.failed",
  response: { status: "failed", error: { code: "server_error", message: overloadMessage } },
});
const overloadEvent = `event: response.failed\r\ndata: ${overloadData}\r\n\r\n`;

test("a fragmented headerless Codex overload returns 503 and cancels the upstream body", async (t) => {
  const chunks = [
    "ev",
    'ent: response.created\r\ndata: {"type":"response.created"}\r\n\r\n',
    "event: response.failed\r\ndata: {\r\n",
    `data: ${overloadData.slice(1, -1)}`,
    "\r\ndata: }\r\n\r",
    "\n",
  ];
  let cancelled = false;
  let chunkIndex = 0;
  const encoder = new TextEncoder();
  t.mock.method(globalThis, "fetch", async () => {
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (chunkIndex < chunks.length) controller.enqueue(encoder.encode(chunks[chunkIndex++]));
        },
        cancel() {
          cancelled = true;
        },
      })
    );
  });
  const { response } = await new CodexExecutor().execute({
    model: "gpt-5.5",
    body: { input: [{ role: "user", content: "hello" }] },
    stream: true,
    credentials: { accessToken: "codex-token" },
  });

  try {
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.message, overloadMessage);
    assert.equal(cancelled, true);
  } finally {
    await response.body?.cancel().catch(() => {});
  }
});

test("Codex recognizes the overload phrase only in an error frame before output", async () => {
  const validError = await peekCodexSseTransientError(
    new Response(overloadEvent, { headers: { "content-type": "text/event-stream" } })
  );
  assert.equal(validError.matched, "currently overloaded");
  assert.equal(validError.message, overloadMessage);

  const output = `data: ${JSON.stringify({
    type: "response.output_text.delta",
    delta: `${overloadMessage} server_is_overloaded service_unavailable_error`,
  })}\n\n`;
  for (const payload of [
    output,
    output + overloadEvent,
    ": selected model is at capacity\n\n" + output,
    `event: error\ndata: {"type":"error","code":"invalid_request","message":"Other error"}\n\n${overloadEvent}`,
    `event: response.failed\ndata: {"type":"response.failed","error":"${overloadMessage}\n\n`,
  ]) {
    const peek = await peekCodexSseTransientError(
      new Response(payload, { headers: { "content-type": "text/event-stream" } })
    );
    assert.equal(peek.matched, null);
    assert.equal(await new Response(peek.replacementBody).text(), payload);
  }
});

test("Codex replays an error outside the peek byte budget unchanged", async () => {
  const payload = `:${" ".repeat(8192)}\n\n${overloadEvent}`;
  const peek = await peekCodexSseTransientError(new Response(sseStreamFromChunks([payload])));
  assert.equal(peek.matched, null);
  assert.equal(await new Response(peek.replacementBody).text(), payload);
});

test("a headerless compact JSON body is replayed unchanged", async () => {
  const chunks = [" ", JSON.stringify({ error: { message: overloadMessage } })];
  const peek = await peekCodexSseTransientError(new Response(sseStreamFromChunks(chunks)));
  assert.equal(peek.matched, null);
  assert.equal(await new Response(peek.replacementBody).text(), chunks.join(""));
});

test("CodexExecutor.execute converts a 200-OK SSE stream carrying a model-at-capacity error into a 503 Response", async () => {
  const executor = new CodexExecutor();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () =>
    new Response(
      sseStreamFromChunks([
        'event: error\ndata: {"error":{"message":"Selected model is at capacity. Please try a different model."}}\n\n',
      ]),
      {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }
    );

  try {
    const result = await executor.execute({
      model: "gpt-5.5",
      body: { model: "gpt-5.5", input: [{ role: "user", content: "hello" }] },
      stream: true,
      credentials: { accessToken: "codex-token" },
    });

    assert.notEqual(result.response.status, 200);
    assert.equal(result.response.status, 503);
    const body = await result.response.json();
    assert.match(body.error.message, /at capacity/i);
    // Hard Rule #12: never leak raw stack/paths in the sanitized error body.
    assert.equal(body.error.message.includes("at /"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CodexExecutor.execute converts server_is_overloaded / service_unavailable_error SSE payloads into a 503 Response", async () => {
  const executor = new CodexExecutor();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () =>
    new Response(
      sseStreamFromChunks([
        'event: error\ndata: {"error":{"type":"server_is_overloaded","message":"The server is overloaded. Please retry later."}}\n\n',
      ]),
      {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }
    );

  try {
    const result = await executor.execute({
      model: "gpt-5.5",
      body: { model: "gpt-5.5", input: [{ role: "user", content: "hello" }] },
      stream: true,
      credentials: { accessToken: "codex-token" },
    });

    assert.equal(result.response.status, 503);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CodexExecutor.execute reassembles a normal 200-OK SSE stream byte-intact after peeking for transient errors", async () => {
  const executor = new CodexExecutor();
  const originalFetch = globalThis.fetch;

  const normalSse =
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello"}\n\n' +
    'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n';

  globalThis.fetch = async () =>
    new Response(sseStreamFromChunks([normalSse]), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

  try {
    const result = await executor.execute({
      model: "gpt-5.5",
      body: { model: "gpt-5.5", input: [{ role: "user", content: "hello" }] },
      stream: true,
      credentials: { accessToken: "codex-token" },
    });

    assert.equal(result.response.status, 200);
    const text = await result.response.text();
    assert.equal(text, normalSse);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CodexExecutor.execute reassembles a normal SSE stream split across multiple network chunks", async () => {
  const executor = new CodexExecutor();
  const originalFetch = globalThis.fetch;

  const chunks = [
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hel',
    'lo"}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
  ];
  const expected = chunks.join("");

  globalThis.fetch = async () =>
    new Response(sseStreamFromChunks(chunks), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

  try {
    const result = await executor.execute({
      model: "gpt-5.5",
      body: { model: "gpt-5.5", input: [{ role: "user", content: "hello" }] },
      stream: true,
      credentials: { accessToken: "codex-token" },
    });

    assert.equal(result.response.status, 200);
    const text = await result.response.text();
    assert.equal(text, expected);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
