import assert from "node:assert/strict";
import test from "node:test";
import { parseSSEToResponsesOutput } from "../../open-sse/handlers/sseParser.ts";
import { parseNonStreamingSSEPayload } from "../../open-sse/handlers/chatCore/nonStreamingSse.ts";
import { FORMATS } from "../../open-sse/translator/formats.ts";

type Item = Record<string, unknown>;
const done: Item = {
  type: "function_call",
  id: "fc_authoritative",
  call_id: "call_weather",
  name: "weather",
  arguments: '{"city":"old"}',
};
function wire(final: Item, item: Item = done, event = "response.completed", index = 0) {
  return [
    { type: "response.output_item.done", output_index: index, item },
    {
      type: event,
      response: {
        id: "resp_1",
        status: event.slice(9),
        output: [final],
        usage: { input_tokens: 7, output_tokens: 3 },
      },
    },
  ]
    .map((value) => `data: ${JSON.stringify(value)}\n\n`)
    .join("");
}
function parse(final: Item, item: Item = done, event?: string, index?: number) {
  return parseSSEToResponsesOutput(wire(final, item, event, index), "gpt-test");
}
for (const id of [undefined, null, "", "  "]) {
  test(`terminal missing ID ${JSON.stringify(id)} is recovered from matching done item`, () => {
    const final = { ...done, id, arguments: '{"city":"final"}' };
    const result = parse(final);
    assert.equal(result.output[0].id, done.id);
    assert.equal(result.output[0].arguments, final.arguments);
    assert.equal(result.output[0].call_id, done.call_id);
    assert.deepEqual(result.usage, { input_tokens: 7, output_tokens: 3 });
    assert.equal(final.id, id);
  });
}
for (const id of ["fc_final", 0, 123]) {
  test(`terminal populated ID ${id} remains authoritative`, () => {
    assert.equal(parse({ ...done, id }).output[0].id, String(id));
  });
}
test("same index cannot borrow an ID from a different call, name or item type", () => {
  for (const item of [
    { ...done, call_id: "call_other" },
    { ...done, name: "other" },
    { ...done, type: "custom_tool_call" },
    { ...done, id: "" },
  ])
    assert.equal(parse({ ...done, id: null }, item).output[0].id, null);
});
test("an item at a different output index cannot supply the ID", () => {
  assert.equal(parse({ ...done, id: null }, done, undefined, 1).output[0].id, null);
});
test("added events and synthetic delta IDs are not authoritative done items", () => {
  const final = { ...done, id: null };
  const raw = wire(final).replace("response.output_item.done", "response.output_item.added");
  assert.equal(parseSSEToResponsesOutput(raw, "m").output[0].id, null);
});
test("buffered Responses boundary returns the recovered ID on success and incomplete endings", () => {
  for (const event of ["response.completed", "response.incomplete", "response.failed"]) {
    const result = parseNonStreamingSSEPayload(
      wire({ ...done, id: null }, done, event),
      FORMATS.OPENAI_RESPONSES,
      "m"
    );
    assert.equal(result.body.output[0].id, done.id);
    assert.equal(result.body.status, event.slice(9));
  }
});
test("only IDs are hydrated; final output order, body and existing message preference survive", () => {
  const message = {
    type: "message",
    role: "assistant",
    id: "msg_original",
    content: [{ type: "output_text", text: "done" }],
  };
  const raw = wire({ ...done, id: null }).replace(
    '"output":[',
    `"output":[${JSON.stringify(message)},`
  );
  const result = parseSSEToResponsesOutput(raw, "m");
  assert.deepEqual(result.output[0].content, message.content);
  assert.equal(result.output[0].id, message.id);
  assert.equal(result.output[1].id, null, "index mismatch is deliberately not guessed");
});

test("unindexed done items never reuse the first ID for several output items", () => {
  const raw = [
    { type: "response.output_item.done", item: done },
    {
      type: "response.completed",
      response: {
        output: [
          { ...done, id: null },
          { ...done, id: null },
        ],
      },
    },
  ]
    .map((value) => `data: ${JSON.stringify(value)}\n\n`)
    .join("");
  assert.deepEqual(
    parseSSEToResponsesOutput(raw, "m").output.map((item) => item.id),
    [null, null]
  );
});

test("several calls recover their own IDs without borrowing another item's final fields", () => {
  const second = { ...done, id: "fc_second", call_id: "call_second", name: "other" };
  const raw = [
    { type: "response.output_item.done", output_index: 1, item: second },
    { type: "response.output_item.done", output_index: 0, item: done },
    {
      type: "response.completed",
      response: {
        output: [
          { ...done, id: null, arguments: "final one" },
          { ...second, id: null, arguments: "final two" },
        ],
      },
    },
  ]
    .map((value) => `data: ${JSON.stringify(value)}\n\n`)
    .join("");
  const result = parseSSEToResponsesOutput(raw, "m");
  assert.deepEqual(
    result.output.map((item) => item.id),
    [done.id, second.id]
  );
  assert.deepEqual(
    result.output.map((item) => item.arguments),
    ["final one", "final two"]
  );
});

test("real Codex HTTP-to-JSON pipeline retains the authoritative function item ID", async () => {
  const originalFetch = globalThis.fetch;
  const { handleChatCore } = await import("../../open-sse/handlers/chatCore.ts");
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return new Response(wire({ ...done, id: null }), {
      headers: { "Content-Type": "text/event-stream" },
    });
  };
  try {
    const body = { model: "codex/gpt-6-astra", stream: false, input: "call weather" };
    const result = await handleChatCore({
      body,
      modelInfo: { provider: "codex", model: "gpt-6-astra" },
      credentials: { apiKey: "test-only", providerSpecificData: {} },
      clientRawRequest: {
        endpoint: "/v1/responses",
        body,
        headers: new Headers({ accept: "application/json" }),
      },
      log: { debug() {}, info() {}, warn() {}, error() {} },
    });
    assert.equal(result.success, true);
    const response = await result.response.json();
    assert.equal(response.output[0].id, done.id);
    assert.equal(response.output[0].call_id, done.call_id);
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
