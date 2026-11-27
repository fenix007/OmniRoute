import assert from "node:assert/strict";
import test, { after } from "node:test";
import { openaiToGeminiRequest } from "../../open-sse/translator/request/openai-to-gemini.ts";
import { storeGeminiThoughtSignature } from "../../open-sse/services/geminiThoughtSignatureStore.ts";
import { closeDbInstance } from "../../src/lib/db/core.ts";

after(() => {
  closeDbInstance();
});

const calls = ["first", "unsigned", "last"];
const messages = [
  { role: "user", content: "Call the tools" },
  {
    role: "assistant",
    content: null,
    tool_calls: calls.map((name) => ({
      id: name,
      type: "function",
      function: { name, arguments: "{}" },
    })),
  },
  ...calls.map((name) => ({
    role: "tool",
    tool_call_id: name,
    content: JSON.stringify({ name }),
  })),
];

function translate(model: string, provider: string, signed: string[]) {
  const namespace = [model, provider, ...signed].join("-");
  for (const id of signed) storeGeminiThoughtSignature(`${namespace}:${id}`, "CkYAc2ln");

  const input = { messages: structuredClone(messages) };
  const result = openaiToGeminiRequest(
    model,
    input,
    true,
    { _provider: provider, _signatureNamespace: namespace },
    { signaturelessToolCallMode: "context" }
  );
  assert.deepEqual(input.messages, messages);
  const turn = result.contents?.at(-1);
  assert.equal(turn?.role, "user");
  return turn?.parts ?? [];
}

function partOrder(parts: Record<string, unknown>[]) {
  return parts.map(
    (part) => (part.functionResponse as { name: string } | undefined)?.name ?? "text"
  );
}

test("Vertex Gemini puts historical text before both signed tool results", () => {
  const parts = translate("gemini-3.8-flash", "vertex", ["first", "last"]);
  assert.deepEqual(partOrder(parts), ["text", "first", "last"]);
  assert.match(String(parts[0].text), /unsigned/);
  assert.deepEqual(parts[1].functionResponse, {
    name: "first",
    response: { result: { name: "first" } },
  });
});

test("Vertex Gemini preserves all-native and all-text batches", () => {
  assert.deepEqual(partOrder(translate("gemini-3.8-flash", "vertex", calls)), calls);
  assert.deepEqual(partOrder(translate("gemini-3.8-flash", "vertex", [])), [
    "text",
    "text",
    "text",
    "text",
  ]);
});

test("Claude and the direct Gemini API retain the existing mixed turn order", () => {
  assert.deepEqual(partOrder(translate("claude-sonnet-5", "vertex", ["first", "last"])), [
    "first",
    "last",
    "text",
  ]);
  assert.deepEqual(partOrder(translate("gemini-3.8-flash", "gemini", ["first", "last"])), [
    "first",
    "last",
    "text",
  ]);
});
