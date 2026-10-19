// The transient-error peek must hand the stream back at the first post-handshake
// event (reasoning, tool-call arguments, output items), not hold it until the
// first text delta — tool-call and reasoning streams otherwise lose their TTFT.
// Native Codex also sends X-Codex-Routing-Hint on ChatGPT-backend requests.
import test from "node:test";
import assert from "node:assert/strict";

import {
  CodexExecutor,
  buildCodexRoutingHint,
  peekCodexSseTransientError,
} from "../../open-sse/executors/codex.ts";

const encoder = new TextEncoder();

function sse(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// Emits `head` immediately, then never sends more until the test reads past the peek.
function stalledAfter(head: string[]): { response: Response; pulls: () => number } {
  let index = 0;
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      if (index < head.length) controller.enqueue(encoder.encode(head[index++]));
      // After the head: stay silent, like an upstream still generating.
    },
  });
  return {
    response: new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    pulls: () => pulls,
  };
}

const handshake = [
  sse("response.created", {
    type: "response.created",
    response: { id: "r1", status: "in_progress" },
  }),
  sse("response.in_progress", { type: "response.in_progress", response: { id: "r1" } }),
];

for (const [name, event] of [
  [
    "function-call arguments",
    sse("response.function_call_arguments.delta", {
      type: "response.function_call_arguments.delta",
      delta: '{"',
    }),
  ],
  [
    "reasoning output item",
    sse("response.output_item.added", {
      type: "response.output_item.added",
      item: { type: "reasoning" },
    }),
  ],
] as const) {
  test(`peek releases the stream at the first ${name} event`, { timeout: 5000 }, async () => {
    const { response } = stalledAfter([...handshake, event]);
    const peek = await peekCodexSseTransientError(response, 1000);

    assert.equal(peek.matched, null);
    assert.equal(peek.timedOut, undefined);
    assert.ok(peek.replacementBody, "stream must be handed back without waiting for a text delta");
    const reader = peek.replacementBody.getReader();
    let text = "";
    while (!text.includes(event)) {
      const { value } = await reader.read();
      text += new TextDecoder().decode(value);
    }
    assert.ok(text.startsWith(handshake[0]), "peeked prefix is replayed byte-for-byte");
    await reader.cancel();
  });
}

test("peek still converts an overload error that follows the handshake", async () => {
  const { response } = stalledAfter([
    ...handshake,
    sse("response.failed", {
      type: "response.failed",
      response: { error: { code: "server_is_overloaded", message: "busy" } },
    }),
  ]);
  const peek = await peekCodexSseTransientError(response, 1000);
  assert.equal(peek.matched, "server_is_overloaded");
  assert.equal(peek.message, "busy");
});

test("peek keeps waiting through handshake-only events", { timeout: 5000 }, async () => {
  const { response } = stalledAfter(handshake);
  const peek = await peekCodexSseTransientError(response, 150);
  assert.equal(peek.timedOut, true);
});

test("routing hint names the base model and the account's service tier", () => {
  assert.equal(buildCodexRoutingHint("gpt-6.1-sol", { accessToken: "t" }), "model=gpt-6.1-sol");
  assert.equal(
    buildCodexRoutingHint("gpt-6.1-sol", {
      accessToken: "t",
      providerSpecificData: { requestDefaults: { serviceTier: "fast" } },
    }),
    "model=gpt-6.1-sol;tier=priority"
  );
  assert.equal(buildCodexRoutingHint("gpt-6.1-sol", { apiKey: "sk-x" }), null);
  assert.equal(buildCodexRoutingHint(undefined, { accessToken: "t" }), null);
});

test("Codex HTTP headers carry the routing hint", () => {
  const headers = new CodexExecutor().buildHeaders({ accessToken: "t" }, true, null, "gpt-6-luna");
  assert.equal(headers["X-Codex-Routing-Hint"], "model=gpt-6-luna");
});
