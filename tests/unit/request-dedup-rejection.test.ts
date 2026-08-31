import test from "node:test";
import assert from "node:assert/strict";

import {
  clearInflight,
  computeRequestHash,
  deduplicate,
} from "../../open-sse/services/requestDedup.ts";

test.afterEach(() => clearInflight());

test("waiters execute independently when the shared request rejects", async () => {
  let calls = 0;
  const execute = async () => {
    const callNumber = ++calls;
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (callNumber === 1) throw new Error("upstream transport failed");
    return `response-${callNumber}`;
  };

  const results = await Promise.allSettled(
    Array.from({ length: 3 }, () => deduplicate("shared-rejection", execute))
  );

  assert.equal(calls, 3);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 2);
});

test("Codex Responses prompts and strict schemas are part of the dedup hash", () => {
  const base = {
    model: "codex/gpt-5.6-sol",
    stream: false,
    input: [{ role: "user", content: [{ type: "input_text", text: "first prompt" }] }],
    text: {
      format: {
        type: "json_schema",
        name: "profile",
        strict: true,
        schema: { type: "object", properties: { first: { type: "string" } } },
      },
    },
  };

  const differentPrompt = {
    ...base,
    input: [{ role: "user", content: [{ type: "input_text", text: "second prompt" }] }],
  };
  const differentSchema = {
    ...base,
    text: {
      format: {
        ...base.text.format,
        schema: { type: "object", properties: { second: { type: "number" } } },
      },
    },
  };

  assert.notEqual(computeRequestHash(base), computeRequestHash(differentPrompt));
  assert.notEqual(computeRequestHash(base), computeRequestHash(differentSchema));
});

test("dedup hashes are stable across key order and isolated by API key", () => {
  const first = {
    model: "openai/gpt-4o-mini",
    messages: [{ role: "user", content: "same prompt" }],
    temperature: 0,
    stream: false,
  };
  const reordered = {
    temperature: 0,
    messages: [{ content: "same prompt", role: "user" }],
    stream: true,
    model: "openai/gpt-4o-mini",
  };

  assert.equal(computeRequestHash(first, "key-a"), computeRequestHash(reordered, "key-a"));
  assert.notEqual(computeRequestHash(first, "key-a"), computeRequestHash(first, "key-b"));
});
