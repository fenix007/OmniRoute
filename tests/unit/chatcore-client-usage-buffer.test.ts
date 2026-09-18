// Characterization of applyClientUsageBuffer — the non-streaming usage buffer/estimate block
// extracted from handleChatCore (chatCore god-file decomposition, #3501). Deps are injected so the
// buffer-vs-estimate branch and the in-place mutation of translatedResponse.usage are observable.
// Locks: usage present → buffer+filter; usage absent → estimate from content length; empty content
// (length 2 from JSON.stringify("")) still estimates; the mutation target is translatedResponse.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FORMATS } from "../../open-sse/translator/formats.ts";

const { applyClientUsageBuffer } =
  await import("../../open-sse/handlers/chatCore/clientUsageBuffer.ts");
const { invalidateBufferTokensCache, setBufferTokensCache } =
  await import("../../open-sse/utils/usageTracking.ts");

function makeDeps(overrides: Record<string, unknown> = {}) {
  const calls = { buffer: [] as unknown[], estimate: [] as unknown[], filter: [] as unknown[] };
  const deps = {
    addBufferToUsage: (u: unknown) => {
      calls.buffer.push(u);
      return { ...(u as object), _buffered: true };
    },
    estimateUsage: (...a: unknown[]) => {
      calls.estimate.push(a);
      return { _estimated: true };
    },
    filterUsageForFormat: (u: unknown, _fmt: unknown) => {
      calls.filter.push(u);
      return { ...(u as object), _filtered: true };
    },
    ...overrides,
  } as Parameters<typeof applyClientUsageBuffer>[3];
  return { deps, calls };
}

test("usage present → buffer then filter, mutates in place", () => {
  const { deps, calls } = makeDeps();
  const resp: Record<string, unknown> = { usage: { prompt_tokens: 5 } };
  applyClientUsageBuffer(resp, { messages: [] }, "openai", deps);
  assert.equal(calls.buffer.length, 1);
  assert.equal(calls.estimate.length, 0);
  assert.equal((resp.usage as Record<string, unknown>)._buffered, true);
  assert.equal((resp.usage as Record<string, unknown>)._filtered, true);
});

for (const format of [FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI_RESPONSE]) {
  test(`${format} usage present → preserve raw usage and filter without buffer`, () => {
    const { deps, calls } = makeDeps();
    const usage = { input_tokens: 5, output_tokens: 3, total_tokens: 8 };
    const resp: Record<string, unknown> = { usage };

    applyClientUsageBuffer(resp, { input: "hello" }, format, deps);

    assert.equal(calls.buffer.length, 0);
    assert.equal(calls.filter.length, 1);
    assert.equal(calls.filter[0], usage);
    assert.equal((resp.usage as Record<string, unknown>)._buffered, undefined);
    assert.equal((resp.usage as Record<string, unknown>)._filtered, true);
  });
}

test("Responses API keeps provider input_tokens with the real configured buffer", () => {
  setBufferTokensCache(2000);
  const resp: Record<string, unknown> = {
    usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
  };

  applyClientUsageBuffer(resp, { input: "hello" }, FORMATS.OPENAI_RESPONSES);

  assert.equal((resp.usage as Record<string, unknown>).input_tokens, 5);
  assert.equal((resp.usage as Record<string, unknown>).output_tokens, 3);
  invalidateBufferTokensCache();
});

test("no usage but content present → estimate then filter", () => {
  const { deps, calls } = makeDeps();
  const resp: Record<string, unknown> = {
    choices: [{ message: { content: "hello world" } }],
  };
  applyClientUsageBuffer(resp, { messages: [] }, "openai", deps);
  assert.equal(calls.buffer.length, 0);
  assert.equal(calls.estimate.length, 1);
  assert.equal((resp.usage as Record<string, unknown>)._estimated, true);
  assert.equal((resp.usage as Record<string, unknown>)._filtered, true);
  // estimateUsage receives (body, contentLength, format)
  const args = calls.estimate[0] as unknown[];
  assert.equal(args[2], "openai");
  assert.equal(typeof args[1], "number");
});

test("empty content → JSON.stringify('') length 2 > 0 still estimates", () => {
  const { deps, calls } = makeDeps();
  const resp: Record<string, unknown> = {};
  applyClientUsageBuffer(resp, {}, "claude", deps);
  // content "" → JSON.stringify("") = '""' length 2 → contentLength 2 > 0
  assert.equal(calls.estimate.length, 1);
  const args = calls.estimate[0] as unknown[];
  assert.equal(args[1], 2);
});

test("content length is computed from choices[0].message.content", () => {
  const { deps, calls } = makeDeps();
  const resp: Record<string, unknown> = {
    choices: [{ message: { content: "abc" } }],
  };
  applyClientUsageBuffer(resp, {}, "openai", deps);
  // JSON.stringify("abc") = '"abc"' → length 5
  const args = calls.estimate[0] as unknown[];
  assert.equal(args[1], 5);
});
