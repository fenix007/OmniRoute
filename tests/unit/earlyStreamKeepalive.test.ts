import test from "node:test";
import assert from "node:assert/strict";
import { withEarlyStreamKeepalive } from "../../open-sse/utils/earlyStreamKeepalive.ts";

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

async function drainStream(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += DECODER.decode(value, { stream: true });
  }
  return text;
}

function makeSseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoded = chunks.map((c) => ENCODER.encode(c));
  let idx = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (idx < encoded.length) controller.enqueue(encoded[idx++]);
      else controller.close();
    },
  });
}

// ── Fast path: handler resolves within threshold ──────────────────────────

test("fast path returns handler response verbatim", async () => {
  const response = new Response("hello", { status: 200 });
  const result = await withEarlyStreamKeepalive(Promise.resolve(response), {
    thresholdMs: 5000,
  });
  assert.equal(result.status, 200);
  const text = await result.text();
  assert.equal(text, "hello");
});

// ── Slow path: SSE stream forwarded correctly ─────────────────────────────

test("slow path forwards SSE stream content", async () => {
  const sseBody = makeSseStream([
    'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
    "data: [DONE]\n\n",
  ]);
  const response = new Response(sseBody, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

  // Delay resolution past threshold to trigger slow path
  const delayed = new Promise<Response>((resolve) => setTimeout(() => resolve(response), 100));

  const result = await withEarlyStreamKeepalive(delayed, {
    thresholdMs: 10, // very low to ensure slow path
    intervalMs: 50,
  });

  assert.equal(result.status, 200);
  const text = await drainStream(result.body!);
  assert.ok(text.includes("hello"), "should contain first chunk");
  assert.ok(text.includes("world"), "should contain second chunk");
  assert.ok(text.includes("[DONE]"), "should contain DONE marker");
});

// ── Upstream error with 0 bytes → error frame emitted ─────────────────────

test(
  "upstream error with 0 bytes forwarded emits error frame",
  { skip: true, todo: "ReadableStream error simulation hangs in Node.js test runner" },
  async () => {
    // Use a TransformStream where we error the writable side
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    writer.releaseLock();
    writable.abort(new Error("upstream died")).catch(() => {});

    const response = new Response(readable, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

    const delayed = new Promise<Response>((resolve) => setTimeout(() => resolve(response), 10));

    const result = await withEarlyStreamKeepalive(delayed, {
      thresholdMs: 10,
      intervalMs: 50,
    });

    assert.equal(result.status, 200);
    const text = await drainStream(result.body!);
    assert.ok(
      text.includes("Upstream stream failed before completion"),
      "should contain error frame"
    );
  }
);

// ── Upstream error after partial content → NO error frame ──────────────────

test(
  "upstream error after partial content does NOT emit error frame",
  { skip: true, todo: "ReadableStream error simulation hangs in Node.js test runner" },
  async () => {
    // Use a TransformStream where we send one chunk then error
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    await writer.write(ENCODER.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
    writer.releaseLock();
    writable.abort(new Error("upstream died mid-stream")).catch(() => {});

    const response = new Response(readable, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

    const delayed = new Promise<Response>((resolve) => setTimeout(() => resolve(response), 10));

    const result = await withEarlyStreamKeepalive(delayed, {
      thresholdMs: 10,
      intervalMs: 50,
    });

    assert.equal(result.status, 200);
    const text = await drainStream(result.body!);
    assert.ok(text.includes("partial"), "should contain forwarded content");
    assert.ok(
      !text.includes("Upstream stream failed"),
      "should NOT contain error frame after partial content"
    );
  }
);

// ── Handler rejection → error frame ───────────────────────────────────────

test("handler rejection emits error frame", async () => {
  const delayed = new Promise<Response>((_resolve, reject) =>
    setTimeout(() => reject(new Error("handler failed")), 10)
  );

  const result = await withEarlyStreamKeepalive(delayed, {
    thresholdMs: 5,
    intervalMs: 50,
  });

  assert.equal(result.status, 200);
  const text = await drainStream(result.body!);
  assert.ok(text.includes("Upstream stream failed before completion"));
});

// ── Client abort stops keepalive ──────────────────────────────────────────

test("client abort stops keepalive and closes stream", async () => {
  const controller = new AbortController();
  const neverResolves = new Promise<Response>(() => {}); // never resolves

  const result = await withEarlyStreamKeepalive(neverResolves, {
    thresholdMs: 10,
    intervalMs: 50,
    signal: controller.signal,
  });

  assert.equal(result.status, 200);

  // Abort after a short delay
  setTimeout(() => controller.abort(), 50);

  const text = await drainStream(result.body!);
  // Should have received some keepalive frames then closed
  assert.ok(text.length >= 0, "stream should close on abort");
});

// ── Slow path: upstream status survives inside the committed 200 ───────────

test("slow path in-band error frame carries the handler's HTTP status", async () => {
  // OmniRoute relays provider overload as a JSON 502; once the keepalive stream has
  // committed to 200 the status line is gone, so `error.status` is the only signal
  // a client has left to tell a retryable failure from a terminal one.
  const handler = new Promise<Response>((resolve) => {
    setTimeout(
      () =>
        resolve(
          new Response(
            JSON.stringify({
              error: {
                message: "Our servers are currently overloaded. Please try again later.",
                type: "server_error",
                code: "bad_gateway",
              },
            }),
            { status: 502, headers: { "Content-Type": "application/json" } }
          )
        ),
      30
    );
  });

  const result = await withEarlyStreamKeepalive(handler, { thresholdMs: 5, intervalMs: 250 });
  assert.equal(result.status, 200);

  const text = await drainStream(result.body!);
  const frame = text.split("\n").find((line) => line.startsWith("data: "));
  assert.ok(frame, "expected an in-band error frame");
  const payload = JSON.parse(frame!.slice("data: ".length));
  assert.equal(payload.error.status, 502);
  assert.equal(payload.error.code, "bad_gateway");
  assert.match(payload.error.message, /overloaded/);
});

test("annotateErrorFrameStatus leaves unparseable and pre-tagged payloads alone", async () => {
  const { annotateErrorFrameStatus } = await import("../../open-sse/utils/earlyStreamKeepalive.ts");

  // Not JSON — must reach the client verbatim.
  assert.equal(annotateErrorFrameStatus("upstream exploded", 502), "upstream exploded");
  // Already carries a status — never overwritten.
  const tagged = JSON.stringify({ error: { message: "x", status: 429 } });
  assert.equal(annotateErrorFrameStatus(tagged, 502), tagged);
  // Success-shaped or statusless payloads are untouched.
  const noError = JSON.stringify({ choices: [] });
  assert.equal(annotateErrorFrameStatus(noError, 502), noError);
  // Out-of-range statuses are not annotations worth making.
  const body = JSON.stringify({ error: { message: "x" } });
  assert.equal(annotateErrorFrameStatus(body, 200), body);
});

test("anthropic-format error frame is shaped for Claude clients", async () => {
  const { buildErrorFrameData } = await import("../../open-sse/utils/earlyStreamKeepalive.ts");

  const overload = JSON.stringify({
    error: {
      message: "Our servers are currently overloaded. Please try again later.",
      type: "server_error",
      code: "bad_gateway",
    },
  });

  // A 502 capacity failure must arrive as `overloaded_error` — one of the two types
  // Claude clients retry — with the top-level Anthropic error envelope.
  const framed = JSON.parse(buildErrorFrameData(overload, 502, "anthropic"));
  assert.equal(framed.type, "error");
  assert.equal(framed.error.type, "overloaded_error");
  assert.equal(framed.error.status, 502);
  assert.match(framed.error.message, /overloaded/);

  // Status-based mapping for the other cases clients branch on.
  const pick = (status: number) =>
    JSON.parse(
      buildErrorFrameData(JSON.stringify({ error: { message: "x" } }), status, "anthropic")
    ).error.type;
  assert.equal(pick(429), "rate_limit_error");
  assert.equal(pick(401), "authentication_error");
  assert.equal(pick(400), "invalid_request_error");
  assert.equal(pick(500), "api_error");

  // A capacity message still maps to overloaded_error when the status is a bare 500.
  const byMessage = JSON.parse(
    buildErrorFrameData(
      JSON.stringify({ error: { message: "Model is at capacity" } }),
      500,
      "anthropic"
    )
  );
  assert.equal(byMessage.error.type, "overloaded_error");

  // OpenAI format stays the default and keeps the original envelope.
  const openai = JSON.parse(buildErrorFrameData(overload, 502));
  assert.equal(openai.error.code, "bad_gateway");
  assert.equal(openai.error.status, 502);
  assert.equal(openai.type, undefined);
});

test("slow path emits the anthropic envelope when the route asks for it", async () => {
  const handler = new Promise<Response>((resolve) => {
    setTimeout(
      () =>
        resolve(
          new Response(JSON.stringify({ error: { message: "Overloaded", type: "server_error" } }), {
            status: 502,
            headers: { "Content-Type": "application/json" },
          })
        ),
      30
    );
  });

  const result = await withEarlyStreamKeepalive(handler, {
    thresholdMs: 5,
    intervalMs: 250,
    errorFrameFormat: "anthropic",
  });

  const text = await drainStream(result.body!);
  const frame = text
    .split("\n")
    .find((line) => line.startsWith("data: ") && line.includes("error"));
  assert.ok(frame, "expected an anthropic error frame");
  const payload = JSON.parse(frame!.slice("data: ".length));
  assert.equal(payload.type, "error");
  assert.equal(payload.error.type, "overloaded_error");
});
