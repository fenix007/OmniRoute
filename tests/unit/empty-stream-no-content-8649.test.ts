/**
 * #8649 / #8732 — a successful terminal event must not reach the client when
 * the provider produced no model content. The error has to be the first
 * terminal event because clients commonly stop reading at the success marker.
 */
import test from "node:test";
import assert from "node:assert/strict";

const { createDisconnectAwareStream, createStreamController } =
  await import("../../open-sse/utils/streamHandler.ts");
const { FORMATS } = await import("../../open-sse/translator/formats.ts");

const encoder = new TextEncoder();

function noopAbortWritable(): { getWriter: () => { abort: () => Promise<void> } } {
  return { getWriter: () => ({ abort: () => Promise.resolve() }) };
}

async function drainStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  const size = parts.reduce((total, part) => total + part.length, 0);
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.length;
  }
  return new TextDecoder().decode(merged);
}

async function runClientStream(frames: string[], format: string | null): Promise<string> {
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  const streamController = createStreamController({
    provider: "test",
    model: "test-model",
    clientResponseFormat: format,
  });
  return drainStream(
    createDisconnectAwareStream(
      { readable: upstream, writable: noopAbortWritable() },
      streamController
    )
  );
}

const chatChunk = (delta: string, finishReason: string) =>
  `data: {"id":"chatcmpl-x","object":"chat.completion.chunk","choices":[{"index":0,"delta":${delta},"finish_reason":${finishReason}}]}\n\n`;
const DONE = "data: [DONE]\n\n";

test("#8732 OpenAI empty stop is replaced before the success terminal", async () => {
  const text = await runClientStream(
    [chatChunk('{"role":"assistant"}', "null"), chatChunk("{}", '"stop"'), DONE],
    null
  );

  assert.doesNotMatch(text, /"finish_reason":"stop"/);
  assert.equal(text.match(/"finish_reason":"error"/g)?.length, 1);
  assert.equal(text.match(/data: \[DONE\]/g)?.length, 1);
  assert.match(text, /Provider returned empty content/);
});

test("#8732 Responses empty completion is replaced by response.failed", async () => {
  const text = await runClientStream(
    [
      'event: response.created\ndata: {"type":"response.created","response":{"output":[]}}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n',
    ],
    FORMATS.OPENAI_RESPONSES
  );

  assert.doesNotMatch(text, /event: response\.completed/);
  assert.match(text, /event: response\.failed/);
  assert.equal(text.match(/event: response\.failed/g)?.length, 1);
});

test("#8732 encrypted-only Responses reasoning counts as model output", async () => {
  const text = await runClientStream(
    [
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"reasoning","encrypted_content":"opaque","summary":[]}}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n',
    ],
    FORMATS.OPENAI_RESPONSES
  );

  assert.match(text, /"encrypted_content":"opaque"/);
  assert.match(text, /event: response\.completed/);
  assert.doesNotMatch(text, /response\.failed|Provider returned empty content/);
});

test("#8732 legitimate Responses incomplete reason remains the first terminal", async () => {
  const text = await runClientStream(
    [
      'event: response.incomplete\ndata: {"type":"response.incomplete","response":{"status":"incomplete","output":[],"incomplete_details":{"reason":"max_output_tokens"}}}\n\n',
    ],
    FORMATS.OPENAI_RESPONSES
  );

  assert.match(text, /event: response\.incomplete/);
  assert.doesNotMatch(text, /response\.failed|Provider returned empty content/);
});

test("#8732 unexplained empty Responses incomplete is replaced before its terminal", async () => {
  const text = await runClientStream(
    [
      'event: response.incomplete\ndata: {"type":"response.incomplete","response":{"status":"incomplete","output":[]}}\n\n',
    ],
    FORMATS.OPENAI_RESPONSES
  );

  assert.doesNotMatch(text, /event: response\.incomplete/);
  assert.match(text, /event: response\.failed/);
});

test("#8732 Claude empty stop is replaced before stop_reason and message_stop", async () => {
  const text = await runClientStream(
    [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m","content":[]}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ],
    FORMATS.CLAUDE
  );

  assert.doesNotMatch(text, /stop_reason|message_stop/);
  assert.equal(text.match(/event: error/g)?.length, 1);
  assert.match(text, /Provider returned empty content/);
});

test("#8732 healthy text and reasoning-only streams remain successful", async () => {
  const text = await runClientStream(
    [
      chatChunk('{"content":"hello"}', "null"),
      chatChunk('{"reasoning_content":"thinking"}', "null"),
      chatChunk("{}", '"stop"'),
      DONE,
    ],
    null
  );

  assert.match(text, /"content":"hello"/);
  assert.match(text, /"reasoning_content":"thinking"/);
  assert.match(text, /"finish_reason":"stop"/);
  assert.doesNotMatch(text, /Provider returned empty content/);
});

test("#8732 tool-only and length-limited streams remain legitimate", async () => {
  const toolText = await runClientStream(
    [
      chatChunk(
        '{"tool_calls":[{"index":0,"id":"c1","function":{"name":"f","arguments":"{}"}}]}',
        "null"
      ),
      chatChunk("{}", '"tool_calls"'),
      DONE,
    ],
    null
  );
  const lengthText = await runClientStream(
    [chatChunk('{"role":"assistant"}', "null"), chatChunk("{}", '"length"'), DONE],
    null
  );

  assert.match(toolText, /tool_calls/);
  assert.doesNotMatch(toolText, /Provider returned empty content/);
  assert.match(lengthText, /"finish_reason":"length"/);
  assert.doesNotMatch(lengthText, /Provider returned empty content/);
});

test("#8732 split Responses terminal marker is fully withheld and replaced", async () => {
  const text = await runClientStream(
    [
      'event: response.created\ndata: {"type":"response.created"}\n\n',
      "event: response.comp",
      'leted\ndata: {"type":"response.comp',
      'leted","response":{"output":[]}}\n\n',
    ],
    FORMATS.OPENAI_RESPONSES
  );

  assert.doesNotMatch(text, /event: response\.completed/);
  assert.match(text, /event: response\.failed/);
});

test("#8732 oversized Responses terminal with output_text remains successful", async () => {
  const outputText = "x".repeat(512 * 1024);
  const terminal = `event: response.completed\ndata: ${JSON.stringify({
    type: "response.completed",
    response: { output_text: outputText },
  })}\n\n`;
  const text = await runClientStream([terminal], FORMATS.OPENAI_RESPONSES);

  assert.match(text, /event: response\.completed/);
  assert.equal(text.includes(outputText), true);
  assert.doesNotMatch(text, /response\.failed/);
});

test("#8732 oversized split Responses terminal remains successful", async () => {
  const outputText = "y".repeat(512 * 1024);
  const payload = JSON.stringify({
    type: "response.completed",
    response: { output_text: outputText },
  });
  const text = await runClientStream(
    [
      "event: response.comp",
      `leted\ndata: ${payload.slice(0, 200_000)}`,
      `${payload.slice(200_000)}\n\n`,
    ],
    FORMATS.OPENAI_RESPONSES
  );

  assert.match(text, /event: response\.completed/);
  assert.equal(text.includes(outputText), true);
  assert.doesNotMatch(text, /response\.failed/);
});

test("#8732 complete keepalive is delivered before a later empty-terminal error", async () => {
  let upstreamController: ReadableStreamDefaultController<Uint8Array> | null = null;
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      upstreamController = controller;
      controller.enqueue(encoder.encode(": keepalive\n\n"));
    },
  });
  const streamController = createStreamController({ clientResponseFormat: null });
  const stream = createDisconnectAwareStream(
    { readable: upstream, writable: noopAbortWritable() },
    streamController
  );
  const reader = stream.getReader();

  const first = await reader.read();
  assert.equal(new TextDecoder().decode(first.value), ": keepalive\n\n");
  upstreamController?.enqueue(encoder.encode(chatChunk("{}", '"stop"')));
  upstreamController?.close();
  const rest: Uint8Array[] = [];
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    rest.push(result.value);
  }
  const tail = new TextDecoder().decode(Uint8Array.from(rest.flatMap((part) => Array.from(part))));
  assert.doesNotMatch(tail, /"finish_reason":"stop"/);
  assert.match(tail, /"finish_reason":"error"/);
});

test("#8732 non-SSE bodies and structured upstream errors are not rewritten", async () => {
  const plain = await runClientStream(["plain forwarded bytes"], null);
  const upstreamError = await runClientStream(
    [
      'event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","error":{"message":"upstream"}}}\n\n',
    ],
    FORMATS.OPENAI_RESPONSES
  );

  assert.equal(plain, "plain forwarded bytes");
  assert.equal(upstreamError.match(/response\.failed/g)?.length, 2);
  assert.match(upstreamError, /upstream/);
  assert.doesNotMatch(upstreamError, /Provider returned empty content/);
});
