import test from "node:test";
import assert from "node:assert/strict";

import { generateSignature, requestVariantOf } from "../../src/lib/semanticCache.ts";
import { storeSemanticCacheResponse } from "../../open-sse/handlers/chatCore/semanticCacheStore.ts";
import { storeStreamingSemanticCacheResponse } from "../../open-sse/handlers/chatCore/streamingSemanticCacheStore.ts";

const MESSAGES = [{ role: "user", content: "Describe a red bicycle." }];

function signature(body: Record<string, unknown>, context?: Record<string, unknown>) {
  return generateSignature(
    "model",
    body.messages ?? body.input,
    body.temperature,
    body.top_p,
    "key",
    requestVariantOf(body, context)
  );
}

test("output schemas, tools, and generation controls cannot collide", () => {
  const base = { messages: MESSAGES, temperature: 0 };
  const variants = [
    base,
    { ...base, response_format: { type: "json_object" } },
    { ...base, text: { format: { type: "json_schema", schema: { type: "object" } } } },
    { ...base, tools: [{ type: "function", function: { name: "lookup" } }] },
    { ...base, tool_choice: "required" },
    { ...base, max_completion_tokens: 100 },
    { ...base, seed: 42 },
    { ...base, stop: ["DONE"] },
    { ...base, reasoning: { effort: "high" } },
  ];

  assert.equal(new Set(variants.map((body) => signature(body))).size, variants.length);
});

test("protocol identity is part of the key while streaming transport is not", () => {
  const base = { messages: MESSAGES, temperature: 0 };
  const chat = signature(base, { endpoint: "/v1/chat/completions", sourceFormat: "openai" });
  const claude = signature(base, { endpoint: "/v1/messages", sourceFormat: "claude" });
  assert.notEqual(chat, claude);
  assert.equal(
    signature(base),
    signature({ ...base, stream: true, stream_options: { include_usage: true } })
  );
});

test("resolved provider identity is part of the key", () => {
  const base = { messages: MESSAGES, temperature: 0 };
  assert.notEqual(signature(base, { provider: "codex" }), signature(base, { provider: "openai" }));
});

test("nested object key order is canonicalized", () => {
  const first = {
    messages: MESSAGES,
    temperature: 0,
    response_format: { type: "json_schema", json_schema: { strict: true, name: "answer" } },
  };
  const second = {
    temperature: 0,
    messages: MESSAGES,
    response_format: { json_schema: { name: "answer", strict: true }, type: "json_schema" },
  };
  assert.equal(signature(first), signature(second));
});

test("conversation tool-call fields are preserved in the key", () => {
  const withFirstCall = [
    ...MESSAGES,
    { role: "assistant", content: null, tool_calls: [{ id: "call-1", function: { name: "a" } }] },
  ];
  const withSecondCall = [
    ...MESSAGES,
    { role: "assistant", content: null, tool_calls: [{ id: "call-2", function: { name: "b" } }] },
  ];
  assert.notEqual(
    generateSignature("model", withFirstCall, 0, 1, "key"),
    generateSignature("model", withSecondCall, 0, 1, "key")
  );
});

test("conversation content types cannot collide", () => {
  assert.notEqual(
    generateSignature("model", [{ role: "assistant", content: null }], 0, 1, "key"),
    generateSignature("model", [{ role: "assistant", content: "null" }], 0, 1, "key")
  );
});

function recordingDeps() {
  const generated: unknown[][] = [];
  const stored: unknown[][] = [];
  return {
    generated,
    stored,
    deps: {
      isCacheableForWrite: () => true,
      isSmallEnoughForSemanticCache: () => true,
      generateSignature: (...args: unknown[]) => {
        generated.push(args);
        return "generated";
      },
      setCachedResponse: (...args: unknown[]) => stored.push(args),
    },
  };
}

test("precomputed identity is reused by non-streaming and streaming writes", () => {
  const body = { messages: MESSAGES, temperature: 0, response_format: { type: "json_object" } };
  const nonStreaming = recordingDeps();
  storeSemanticCacheResponse(
    {
      enabled: true,
      body,
      headers: {},
      translatedResponse: { ok: true },
      model: "model",
      signature: "captured-before-mutation",
    },
    nonStreaming.deps as never
  );
  assert.equal(nonStreaming.generated.length, 0);
  assert.equal(nonStreaming.stored[0][0], "captured-before-mutation");

  const streaming = recordingDeps();
  storeStreamingSemanticCacheResponse(
    {
      enabled: true,
      streamStatus: 200,
      streamResponseBody: { ok: true },
      body,
      headers: {},
      model: "model",
      signature: "captured-before-mutation",
    },
    streaming.deps as never
  );
  assert.equal(streaming.generated.length, 0);
  assert.equal(streaming.stored[0][0], "captured-before-mutation");
});
