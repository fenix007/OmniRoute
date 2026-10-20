// #7536: Codex non-stream chat 502'd with "Response body is already used".
//
// Root cause (confirmed live on the VPS via fs-instrumentation): the Codex HTTP
// transport uses the wreq-js TLS-fingerprint client, whose Response is backed by
// a native body handle. On that response, merely *accessing* `response.body`
// disturbs the handle so a later `.text()` throws
// `TypeError: Response body is already used`. The Codex non-stream upstream
// response arrives with an EMPTY content-type, so `peekCodexSseTransientError`
// early-returns — but its guard evaluated `!response.body` (touching `.body`)
// BEFORE the content-type check. That single `.body` access consumed the body,
// and chatCore's `readNonStreamingResponseBody` → `.text()` then 502'd. Streaming
// was unaffected because the peek genuinely wants the body for SSE responses.
//
// The fix reorders the guard so the content-type is checked before `.body` is
// touched. A typed non-SSE response must still never have `.body` accessed.
//
// Untyped responses are peeked since the backend's SSE streams also arrive with
// no content-type; the executor then always serves the peek's replacement body,
// so the consumed original is never read again.
import test from "node:test";
import assert from "node:assert/strict";

import { peekCodexSseTransientError } from "../../open-sse/executors/codex.ts";

/**
 * Mimic a wreq-js native-handle Response: reading `.body` is destructive — once
 * accessed, `.text()` throws exactly like the live 502. This is what the real
 * bug looked like end-to-end.
 */
function makeDestructiveBodyResponse(contentType: string) {
  let bodyAccessCount = 0;
  let disturbed = false;
  const response = {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers(contentType ? { "content-type": contentType } : {}),
    get body() {
      bodyAccessCount += 1;
      disturbed = true; // native handle is now consumed
      return new ReadableStream<Uint8Array>();
    },
    async text() {
      if (disturbed) throw new TypeError("Response body is already used");
      return "downstream still works";
    },
  } as unknown as Response;
  return { response, bodyAccessCount: () => bodyAccessCount };
}

/**
 * A wreq-js-like Response with a real stream body: reading `.body` works, but the
 * native handle is then consumed, so `.text()` on the original would throw.
 */
function makeUntypedStreamResponse(text: string) {
  let disturbed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers(),
    get body() {
      disturbed = true;
      return stream;
    },
    async text() {
      if (disturbed) throw new TypeError("Response body is already used");
      return text;
    },
  } as unknown as Response;
}

async function drain(body: ReadableStream<Uint8Array> | null): Promise<string> {
  assert.ok(body, "a replacement body must be handed downstream");
  return new Response(body).text();
}

test("an untyped JSON reply is replayed whole through the replacement body (#7536)", async () => {
  // The Codex backend's replies arrive without content-type through wreq. The
  // peek may read them, but the executor must then serve the replacement body,
  // never the consumed original.
  const json = '{"id":"resp_1","output":[{"text":"servers are currently overloaded"}]}';
  const result = await peekCodexSseTransientError(makeUntypedStreamResponse(json));

  assert.equal(result.matched, null, "JSON text is not scanned for SSE error patterns");
  assert.equal(await drain(result.replacementBody), json);
});

test("an untyped SSE stream carrying an overload error is still caught", async () => {
  const sse =
    'event: response.created\ndata: {"type":"response.created"}\n\n' +
    'event: error\ndata: {"type":"error","error":{"code":"server_is_overloaded","message":"Our servers are currently overloaded. Please try again later."}}\n\n';
  const result = await peekCodexSseTransientError(makeUntypedStreamResponse(sse));

  assert.ok(result.matched, "the transient error must be detected");
  assert.match(result.message ?? "", /overloaded/i);
});

test("an untyped healthy SSE stream is replayed unchanged", async () => {
  const sse =
    'event: response.created\ndata: {"type":"response.created"}\n\n' +
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"OK"}\n\n';
  const result = await peekCodexSseTransientError(makeUntypedStreamResponse(sse));

  assert.equal(result.matched, null);
  assert.equal(await drain(result.replacementBody), sse);
});

test("peekCodexSseTransientError does not touch response.body for a non-SSE (application/json) response (#7536)", async () => {
  const { response, bodyAccessCount } = makeDestructiveBodyResponse("application/json");

  const result = await peekCodexSseTransientError(response);

  assert.equal(result.matched, null);
  assert.equal(result.replacementBody, null);
  assert.equal(bodyAccessCount(), 0, "non-SSE content-type must short-circuit before .body");
  assert.equal(await response.text(), "downstream still works");
});
