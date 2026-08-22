import test from "node:test";
import assert from "node:assert/strict";

import {
  createDisconnectAwareStream,
  createNoopAbortWritable,
  createStreamController,
} from "../../open-sse/utils/streamHandler.ts";
import { FORMATS } from "../../open-sse/translator/formats.ts";

/**
 * A stream that already delivered its terminal SSE event must be finalized as a
 * success even though the client then closes the socket. Split out of
 * stream-handler.test.ts to keep both files under the test-size cap.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function readStreamText(stream) {
  const reader = stream.getReader();
  const chunks = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  return decoder.decode(
    chunks.length === 1 ? chunks[0] : Uint8Array.from(chunks.flatMap((chunk) => Array.from(chunk)))
  );
}

test("createDisconnectAwareStream treats errors after OpenAI DONE as successful completion", async () => {
  let pullCount = 0;
  let errorHandled = false;
  const transformStream = {
    readable: new ReadableStream({
      pull(controller) {
        pullCount += 1;
        if (pullCount === 1) {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          return;
        }
        controller.error(new Error("terminated"));
      },
    }),
    writable: {
      getWriter() {
        return {
          abort() {},
        };
      },
    },
  };

  const stream = createDisconnectAwareStream(
    transformStream,
    createStreamController({
      onError() {
        errorHandled = true;
      },
    })
  );
  const text = await readStreamText(stream);

  assert.equal(text, "data: [DONE]\n\n");
  assert.equal(errorHandled, false);
  assert.doesNotMatch(text, /finish_reason/);
  assert.doesNotMatch(text, /terminated/);
});

test("createDisconnectAwareStream treats cancel after OpenAI DONE as successful completion", async () => {
  let disconnectHandled = false;
  const transformStream = {
    readable: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      },
    }),
    writable: {
      getWriter() {
        return {
          abort() {},
        };
      },
    },
  };

  const stream = createDisconnectAwareStream(
    transformStream,
    createStreamController({
      onDisconnect() {
        disconnectHandled = true;
      },
    })
  );
  const reader = stream.getReader();
  const first = await reader.read();
  assert.equal(decoder.decode(first.value), "data: [DONE]\n\n");
  await reader.cancel("request_signal_aborted");

  assert.equal(disconnectHandled, false);
});

test("createDisconnectAwareStream treats cancel after Responses completed as successful completion", async () => {
  let disconnectHandled = false;
  const transformStream = {
    readable: new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode('event: response.completed\ndata: {"type":"response.completed"}\n\n')
        );
      },
    }),
    writable: {
      getWriter() {
        return {
          abort() {},
        };
      },
    },
  };

  const stream = createDisconnectAwareStream(
    transformStream,
    createStreamController({
      clientResponseFormat: FORMATS.OPENAI_RESPONSES,
      onDisconnect() {
        disconnectHandled = true;
      },
    })
  );
  const reader = stream.getReader();
  const first = await reader.read();
  assert.match(decoder.decode(first.value), /response\.completed/);
  await reader.cancel("request_signal_aborted");

  assert.equal(disconnectHandled, false);
});

test("createDisconnectAwareStream treats cancel after an oversized Responses completed event as successful completion", async () => {
  // The terminal event carries the whole response, so its payload routinely runs
  // to tens of KB. Scanning only a small trailing window used to slice the
  // marker away and report a fully delivered stream as a client disconnect.
  const hugeCompleted = `event: response.completed\ndata: ${JSON.stringify({
    type: "response.completed",
    response: { output_text: "y".repeat(64 * 1024) },
  })}\n\n`;

  let disconnectHandled = false;
  const transformStream = {
    readable: new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode('event: response.created\ndata: {"type":"response.created"}\n\n')
        );
        controller.enqueue(encoder.encode(hugeCompleted));
      },
    }),
    writable: createNoopAbortWritable(),
  };

  const stream = createDisconnectAwareStream(
    transformStream,
    createStreamController({
      clientResponseFormat: FORMATS.OPENAI_RESPONSES,
      onDisconnect() {
        disconnectHandled = true;
      },
    })
  );
  const reader = stream.getReader();
  await reader.read();
  const terminal = await reader.read();
  assert.match(decoder.decode(terminal.value), /response\.completed/);
  await reader.cancel("request_signal_aborted");

  assert.equal(disconnectHandled, false);
});

test("createDisconnectAwareStream detects a Responses terminal marker split across chunks", async () => {
  let disconnectHandled = false;
  const transformStream = {
    readable: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("event: response.comp"));
        controller.enqueue(encoder.encode('leted\ndata: {"type":"x"}\n\n'));
      },
    }),
    writable: createNoopAbortWritable(),
  };

  const stream = createDisconnectAwareStream(
    transformStream,
    createStreamController({
      clientResponseFormat: FORMATS.OPENAI_RESPONSES,
      onDisconnect() {
        disconnectHandled = true;
      },
    })
  );
  const reader = stream.getReader();
  await reader.read();
  await reader.read();
  await reader.cancel("request_signal_aborted");

  assert.equal(disconnectHandled, false);
});

test("createDisconnectAwareStream still reports a disconnect when no terminal marker arrived", async () => {
  let disconnectReason = null;
  const transformStream = {
    readable: new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `event: response.output_text.delta\ndata: {"delta":"${"x".repeat(8192)}"}\n\n`
          )
        );
      },
    }),
    writable: createNoopAbortWritable(),
  };

  const stream = createDisconnectAwareStream(
    transformStream,
    createStreamController({
      clientResponseFormat: FORMATS.OPENAI_RESPONSES,
      onDisconnect(event) {
        disconnectReason = event.reason;
      },
    })
  );
  const reader = stream.getReader();
  await reader.read();
  await reader.cancel("request_signal_aborted");

  assert.equal(disconnectReason, "request_signal_aborted");
});
